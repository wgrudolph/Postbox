import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { NotConnectedError } from "../src/errors";
import { getAccessToken, loadTokens, saveTokens, X_SCOPES } from "../src/oauth";
import { postThread, xConfig } from "../src/x";
import { ORIGIN, connect, jsonRes, mockX, sessionCookieHeader, testEnv } from "./helpers";

beforeEach(() => {
  xConfig.retryDelayMs = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("token refresh", () => {
  it("refreshes an expired token and persists the new refresh token before posting", async () => {
    await connect(-1000, "refresh-old");
    let storedAtPostTime: string | undefined;
    const { calls } = mockX(async (req) => {
      if (req.path === "/2/oauth2/token") {
        return jsonRes({ token_type: "bearer", access_token: "access-new", refresh_token: "refresh-new", expires_in: 7200 });
      }
      if (req.path === "/2/tweets") {
        storedAtPostTime = (await loadTokens(testEnv))?.refresh_token;
        return jsonRes({ data: { id: "1", text: "hi" } }, 201);
      }
      return jsonRes({}, 404);
    });

    const result = await postThread(testEnv, [{ text: "hi", images: [] }]);
    expect(result).toEqual({ ok: true, sent: 1 });

    const tokenCall = calls[0];
    expect(tokenCall.path).toBe("/2/oauth2/token");
    const form = new URLSearchParams(tokenCall.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-old");
    expect(tokenCall.headers.get("Authorization")).toBe(`Basic ${btoa("test-client-id:test-client-secret")}`);

    expect(storedAtPostTime).toBe("refresh-new");
    expect(calls[1].headers.get("Authorization")).toBe("Bearer access-new");
  });

  it("forgets tokens and reports not-connected on invalid_grant", async () => {
    await connect(-1000);
    mockX(() => jsonRes({ error: "invalid_grant", error_description: "bad" }, 400));
    await expect(getAccessToken(testEnv)).rejects.toBeInstanceOf(NotConnectedError);
    expect(await testEnv.KV.get("x_tokens")).toBeNull();
  });

  it("surfaces not-connected through /api/post", async () => {
    await connect(-1000);
    mockX(() => jsonRes({ error: "invalid_grant" }, 400));
    const f = new FormData();
    f.set("posts", JSON.stringify([{ text: "hi", images: 0 }]));
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/post`, { method: "POST", headers: { Origin: ORIGIN, Cookie: await sessionCookieHeader() }, body: f }),
      testEnv,
    );
    expect(await res.json()).toEqual({
      ok: false,
      sent: 0,
      error: "Your X connection expired. Reconnect to keep posting.",
      reconnect: true,
    });
  });

  it("treats tokens it can't decrypt as not connected and clears them", async () => {
    await testEnv.KV.put("x_tokens", "bm90LWEtdmFsaWQtY2lwaGVydGV4dC1hdC1hbGw=");
    await expect(getAccessToken(testEnv)).rejects.toBeInstanceOf(NotConnectedError);
    expect(await testEnv.KV.get("x_tokens")).toBeNull();
  });

  it("stores tokens encrypted, never in plain text", async () => {
    await saveTokens(testEnv, { access_token: "secret-access", refresh_token: "secret-refresh", expires_at: 1 });
    const raw = (await testEnv.KV.get("x_tokens"))!;
    expect(raw).not.toContain("secret");
    expect((await loadTokens(testEnv))?.access_token).toBe("secret-access");
  });
});

describe("connect flow", () => {
  it("start redirects to X with PKCE and stores state", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/auth/x/start`, { headers: { Cookie: await sessionCookieHeader() } }),
      testEnv,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(loc.searchParams.get("scope")).toBe(X_SCOPES);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/x/callback`);
    const verifier = await testEnv.KV.get(`oauth:${loc.searchParams.get("state")}`);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
  });

  it("start without a session does not reach X", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/x/start`), testEnv);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/`);
  });

  it("callback exchanges the code, saves tokens and the handle, then redirects home", async () => {
    await testEnv.KV.put("oauth:abc", "verifier-xyz");
    const { calls } = mockX((req) => {
      if (req.path === "/2/oauth2/token") return jsonRes({ access_token: "a", refresh_token: "r", expires_in: 7200 });
      if (req.path === "/2/users/me") return jsonRes({ data: { id: "42", name: "Me", username: "postboxer" } });
      return jsonRes({}, 404);
    });
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/x/callback?code=c0de&state=abc`), testEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(await testEnv.KV.get("oauth:abc")).toBeNull();
    expect(await testEnv.KV.get("x_handle")).toBe("postboxer");
    expect((await loadTokens(testEnv))?.refresh_token).toBe("r");

    const form = new URLSearchParams(calls[0].body as string);
    expect(form.get("code_verifier")).toBe("verifier-xyz");
    expect(calls[1].url).toBe("https://api.x.com/2/users/me"); // no query string, no fields
  });

  it("callback with an unknown state shows the expired message", async () => {
    const { calls } = mockX(() => jsonRes({}));
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/x/callback?code=c&state=nope`), testEnv);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This sign-in link expired. Try again.");
    expect(calls).toHaveLength(0);
  });

  it("disconnect revokes and forgets everything", async () => {
    await connect();
    await testEnv.KV.put("x_handle", "postboxer");
    const { calls } = mockX(() => new Response("", { status: 200 }));
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/disconnect`, { method: "POST", headers: { Origin: ORIGIN, Cookie: await sessionCookieHeader() } }),
      testEnv,
    );
    expect(res.status).toBe(204);
    expect(calls[0].path).toBe("/2/oauth2/revoke");
    expect(new URLSearchParams(calls[0].body as string).get("token")).toBe("refresh-1");
    expect(await testEnv.KV.get("x_tokens")).toBeNull();
    expect(await testEnv.KV.get("x_handle")).toBeNull();
  });
});
