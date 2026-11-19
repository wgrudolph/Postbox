import { vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { saveTokens } from "../src/oauth";
import { createSessionCookie } from "../src/auth";

export const testEnv = env as unknown as Env;
export const ORIGIN = "https://postbox.test";

export interface Captured {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  body: string | FormData | null;
}

type Handler = (req: Captured, n: number) => Response | Promise<Response>;

/** Replaces global fetch. Every call is recorded; the handler decides the reply. */
export function mockX(handler: Handler) {
  const calls: Captured[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init.body instanceof FormData ? init.body : init.body == null ? null : String(init.body);
    const req: Captured = {
      method: (init.method ?? "GET").toUpperCase(),
      url,
      path: new URL(url).pathname,
      headers: new Headers(init.headers),
      body,
    };
    calls.push(req);
    return handler(req, calls.length);
  });
  return { calls, spy };
}

export const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export async function connect(expiresInMs = 3_600_000, refresh = "refresh-1") {
  await saveTokens(testEnv, { access_token: "access-1", refresh_token: refresh, expires_at: Date.now() + expiresInMs });
}

export async function sessionCookieHeader(): Promise<string> {
  return (await createSessionCookie(testEnv)).split(";")[0];
}

// Minimal valid image headers.
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
