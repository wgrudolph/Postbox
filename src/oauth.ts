// X OAuth 2.0 Authorization Code + PKCE (confidential client): start, callback,
// token refresh, revoke. Tokens are AES-GCM encrypted in KV and never leave the server.

import type { Env } from "./env";
import { publicUrl } from "./env";
import { decryptString, encryptString, pkceChallenge, pkceVerifier, randomBase64Url } from "./crypto";
import { NotConnectedError, XApiError } from "./errors";
import { xFetch } from "./x";

// docs.x.com (Nov 2026) shows https://x.com/i/oauth2/authorize for the user-facing step.
export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_SCOPES = "tweet.read tweet.write users.read offline.access media.write";

const TOKENS_KEY = "x_tokens";
const HANDLE_KEY = "x_handle";
const STATE_TTL_SECONDS = 600;

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms since epoch
}

function redirectUri(env: Env): string {
  return `${publicUrl(env)}/auth/x/callback`;
}

function basicAuth(env: Env): string {
  return `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`;
}

// ---------- storage ----------

export async function saveTokens(env: Env, tokens: StoredTokens): Promise<void> {
  await env.KV.put(TOKENS_KEY, await encryptString(JSON.stringify(tokens), env.TOKEN_ENC_KEY));
}

export async function loadTokens(env: Env): Promise<StoredTokens | null> {
  const raw = await env.KV.get(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(await decryptString(raw, env.TOKEN_ENC_KEY)) as StoredTokens;
  } catch {
    // Wrong key or corrupted value: treat as not connected.
    return null;
  }
}

export async function forgetTokens(env: Env): Promise<void> {
  await env.KV.delete(TOKENS_KEY);
}

export async function isConnected(env: Env): Promise<boolean> {
  return (await env.KV.get(TOKENS_KEY)) !== null;
}

export async function getHandle(env: Env): Promise<string | null> {
  return env.KV.get(HANDLE_KEY);
}

function tokensFromResponse(json: any, previousRefresh?: string): StoredTokens {
  if (typeof json?.access_token !== "string") throw new XApiError(502, "other", "token");
  const expiresIn = Number(json.expires_in) || 7200;
  return {
    access_token: json.access_token,
    // X rotates refresh tokens; fall back to the old one only if none is returned.
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : (previousRefresh ?? ""),
    expires_at: Date.now() + expiresIn * 1000,
  };
}

// ---------- start ----------

export async function startOAuth(env: Env): Promise<Response> {
  const state = randomBase64Url(32);
  const verifier = pkceVerifier(64);
  await env.KV.put(`oauth:${state}`, verifier, { expirationTtl: STATE_TTL_SECONDS });

  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.X_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(env));
  url.searchParams.set("scope", X_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(url.toString(), 302);
}

// ---------- callback ----------

export type CallbackOutcome = { ok: true } | { ok: false; message: string };

export async function handleCallback(env: Env, url: URL): Promise<CallbackOutcome> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  const verifier = state ? await env.KV.get(`oauth:${state}`) : null;
  if (state) await env.KV.delete(`oauth:${state}`);
  if (!verifier) return { ok: false, message: "This sign-in link expired. Try again." };
  if (url.searchParams.get("error") || !code) {
    return { ok: false, message: "X didn't connect. You can try again whenever you like." };
  }

  // docs.x.com: confidential clients authenticate with Basic auth; client_id in the body is not required.
  const res = await xFetch("POST", "/2/oauth2/token", {
    headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env),
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, message: "X didn't accept the connection. Try again." };
  }
  const tokens = tokensFromResponse(await res.json());
  await saveTokens(env, tokens);

  // Learn the handle once. No user.fields, no expansions: data.username only.
  try {
    const me = await xFetch("GET", "/2/users/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (me.ok) {
      const username = (await me.json<any>())?.data?.username;
      if (typeof username === "string") await env.KV.put(HANDLE_KEY, username);
    } else {
      await me.body?.cancel();
    }
  } catch {
    // The handle is cosmetic; posting still works without it.
  }
  return { ok: true };
}

// ---------- access token ----------

/** Returns a valid access token, refreshing (and persisting the rotated refresh token) if needed. */
export async function getAccessToken(env: Env): Promise<string> {
  const tokens = await loadTokens(env);
  if (!tokens) {
    // Missing, or undecryptable (e.g. TOKEN_ENC_KEY was rotated): clear it so the UI shows Connect.
    await forgetTokens(env);
    throw new NotConnectedError();
  }
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;

  if (!tokens.refresh_token) {
    await forgetTokens(env);
    throw new NotConnectedError();
  }

  const res = await xFetch("POST", "/2/oauth2/token", {
    headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }).toString(),
  });

  if (!res.ok) {
    let err = "";
    try {
      err = String((await res.json<any>())?.error ?? "");
    } catch {}
    // X answers a dead refresh token with invalid_grant, or sometimes 400 invalid_request.
    if (res.status === 401 || res.status === 400 || err === "invalid_grant") {
      await forgetTokens(env);
      throw new NotConnectedError();
    }
    throw new XApiError(res.status, "other", "token");
  }

  const fresh = tokensFromResponse(await res.json(), tokens.refresh_token);
  // Save immediately: the old refresh token is now dead.
  await saveTokens(env, fresh);
  return fresh.access_token;
}

// ---------- disconnect ----------

export async function disconnect(env: Env): Promise<void> {
  const tokens = await loadTokens(env);
  if (tokens?.refresh_token) {
    try {
      // Revoke body per RFC 7009 (token, token_type_hint); docs.x.com doesn't spell it out.
      const res = await xFetch("POST", "/2/oauth2/revoke", {
        headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: "refresh_token" }).toString(),
      });
      await res.body?.cancel();
    } catch {
      // Ignored by design.
    }
  }
  await env.KV.delete(TOKENS_KEY);
  await env.KV.delete(HANDLE_KEY);
}
