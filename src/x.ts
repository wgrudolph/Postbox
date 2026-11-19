// The only module that talks to X. Every outbound request goes through xFetch,
// which refuses anything not on the allow-list (Hard rule 2).

import type { Env } from "./env";
import { NotConnectedError, XApiError, XNetworkError, classifyXError } from "./errors";
import { forgetTokens, getAccessToken } from "./oauth";

export const X_API_BASE = "https://api.x.com";

/** The complete list of X calls Postbox may make. Exact matches only: no query strings. */
export const ALLOWED_X_CALLS: ReadonlySet<string> = new Set([
  "POST /2/oauth2/token",
  "POST /2/oauth2/revoke",
  "GET /2/users/me", // once, at connect time, with no user.fields
  "POST /2/media/upload",
  "POST /2/tweets",
]);

/** Tunables, exported so tests can shorten the retry wait. */
export const xConfig = {
  retryDelayMs: 2000,
  timeoutMs: 25_000,
};

export class DisallowedXCallError extends Error {
  constructor(method: string, path: string) {
    super(`Blocked X call: ${method} ${path}`);
    this.name = "DisallowedXCallError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends one request to X if (method, path) is allow-listed; throws before
 * sending otherwise. Retries once after 2s on 429 or 5xx. A network error or
 * timeout (no response at all) is never retried, so a post can't be doubled.
 * Logs only method, path and status.
 */
export async function xFetch(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const m = method.toUpperCase();
  if (!ALLOWED_X_CALLS.has(`${m} ${path}`)) throw new DisallowedXCallError(m, path);

  const send = async () => {
    try {
      return await fetch(X_API_BASE + path, {
        ...init,
        method: m,
        signal: AbortSignal.timeout(xConfig.timeoutMs),
      });
    } catch {
      console.log(`x ${m} ${path} -> network_error`);
      throw new XNetworkError();
    }
  };

  let res = await send();
  console.log(`x ${m} ${path} -> ${res.status}`);
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    await sleep(xConfig.retryDelayMs);
    res = await send();
    console.log(`x ${m} ${path} -> ${res.status} (retry)`);
  }
  return res;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Turns a non-2xx X response into an XApiError (or NotConnectedError on 401). */
async function failFrom(env: Env, res: Response, stage: "upload" | "post"): Promise<never> {
  const body = await readJson(res);
  if (res.status === 401) {
    // The token was revoked from X's side. Forget it so the UI shows Connect.
    await forgetTokens(env);
    throw new NotConnectedError();
  }
  throw new XApiError(res.status, classifyXError(res.status, body), stage);
}

/**
 * One-shot image upload (POST /2/media/upload, multipart, media_category=tweet_image).
 * docs.x.com: the simple upload returns { data: { id, media_key, ... } }; the
 * media id is data.id (not media_id_string as in the old v1.1 endpoint).
 */
export async function uploadImage(env: Env, accessToken: string, file: Blob): Promise<string> {
  const form = new FormData();
  form.append("media", file);
  form.append("media_category", "tweet_image");
  const res = await xFetch("POST", "/2/media/upload", {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!res.ok) return failFrom(env, res, "upload");
  const json = await readJson(res);
  const id = json?.data?.id ?? json?.media_id_string;
  if (typeof id !== "string" || !id) throw new XApiError(res.status, "other", "upload");
  return id;
}

export interface TweetBody {
  text: string;
  media?: { media_ids: string[] };
  reply?: { in_reply_to_tweet_id: string };
}

/** POST /2/tweets. Returns the new post's id, for chaining only. */
export async function createPost(env: Env, accessToken: string, body: TweetBody): Promise<string> {
  const res = await xFetch("POST", "/2/tweets", {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failFrom(env, res, "post");
  const json = await readJson(res);
  const id = json?.data?.id;
  if (typeof id !== "string" || !id) throw new XApiError(res.status, "other", "post");
  return id;
}

export interface OutgoingPost {
  text: string;
  images: Blob[];
}

export type ThreadResult = { ok: true; sent: number } | { ok: false; sent: number; error: unknown };

/**
 * Sends posts in order as a reply chain. Post IDs live only in this function's
 * local variable and are dropped when it returns. Stops at the first failure.
 */
export async function postThread(env: Env, posts: OutgoingPost[]): Promise<ThreadResult> {
  let prevId: string | null = null;
  let sent = 0;
  for (const post of posts) {
    try {
      const token = await getAccessToken(env);
      const mediaIds: string[] = [];
      for (const img of post.images) mediaIds.push(await uploadImage(env, token, img)); // sequential
      const body: TweetBody = { text: post.text };
      if (mediaIds.length) body.media = { media_ids: mediaIds };
      if (prevId) body.reply = { in_reply_to_tweet_id: prevId };
      prevId = await createPost(env, token, body);
      sent++;
    } catch (error) {
      return { ok: false, sent, error };
    }
  }
  return { ok: true, sent };
}
