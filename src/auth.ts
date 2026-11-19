// App gate: password login, HMAC-signed session cookie, failed-login rate limit.

import type { Env } from "./env";
import { hmacSign, hmacVerify, timingSafeEqualStrings } from "./crypto";

export const SESSION_COOKIE = "pb_session";
const SESSION_MAX_AGE = 2_592_000; // 30 days, seconds
const MAX_FAILURES = 5;
const FAIL_WINDOW_SECONDS = 900; // 15 minutes

export const TOO_MANY_ATTEMPTS = "Too many attempts. Try again in 15 minutes.";

function cookieAttrs(maxAge: number): string {
  return `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export async function createSessionCookie(env: Env, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const expiry = String(nowSeconds + SESSION_MAX_AGE);
  const sig = await hmacSign(expiry, env.SESSION_SECRET);
  return `${SESSION_COOKIE}=${expiry}.${sig}; ${cookieAttrs(SESSION_MAX_AGE)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(0)}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function hasValidSession(request: Request, env: Env): Promise<boolean> {
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expiry = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(expiry)) return false;
  if (!(await hmacVerify(expiry, sig, env.SESSION_SECRET))) return false;
  return Number(expiry) > Math.floor(Date.now() / 1000);
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export type LoginResult =
  | { status: 204; cookie: string }
  | { status: 401; error: string }
  | { status: 429; error: string }
  | { status: 400; error: string };

export async function login(request: Request, env: Env): Promise<LoginResult> {
  const failKey = `login_fail:${clientIp(request)}`;
  const failures = Number((await env.KV.get(failKey)) ?? "0");
  if (failures >= MAX_FAILURES) return { status: 429, error: TOO_MANY_ATTEMPTS };

  let password = "";
  try {
    const body = await request.json<any>();
    if (typeof body?.password === "string") password = body.password;
  } catch {
    return { status: 400, error: "Something's off with that request." };
  }

  if (password && env.APP_PASSWORD && (await timingSafeEqualStrings(password, env.APP_PASSWORD))) {
    await env.KV.delete(failKey);
    return { status: 204, cookie: await createSessionCookie(env) };
  }

  await env.KV.put(failKey, String(failures + 1), { expirationTtl: FAIL_WINDOW_SECONDS });
  return { status: 401, error: "That's not the password." };
}
