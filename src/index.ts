// Router: JSON API under /api/*, OAuth under /auth/*, static assets for everything else.

import type { Env } from "./env";
import { maxChars, publicUrl } from "./env";
import { clearSessionCookie, hasValidSession, login } from "./auth";
import { NotConnectedError, ValidationError, friendlyMessage } from "./errors";
import { disconnect, getHandle, handleCallback, isConnected, startOAuth } from "./oauth";
import { parsePostForm } from "./validate";
import { postThread } from "./x";

export type { Env } from "./env";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res); // copy so headers are mutable
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

function empty(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

function htmlMessage(message: string, status = 400): Response {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Postbox</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><main class="screen notice"><p class="wordmark">Postbox</p><p>${esc}</p><p><a class="quiet-link" href="/">Back to Postbox</a></p></main></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && origin === new URL(publicUrl(env)).origin;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const isApi = pathname.startsWith("/api/");
  const isAuth = pathname.startsWith("/auth/");
  if (!isApi && !isAuth) return env.ASSETS.fetch(request);

  // State-changing routes must come from our own origin.
  if (method !== "GET" && method !== "HEAD" && !originAllowed(request, env)) {
    return json({ error: "Forbidden." }, 403);
  }

  // ---- public routes ----
  if (pathname === "/api/status" && method === "GET") {
    const authenticated = await hasValidSession(request, env);
    return json({
      authenticated,
      xConnected: await isConnected(env),
      handle: authenticated ? await getHandle(env) : null,
      maxChars: maxChars(env),
    });
  }

  if (pathname === "/api/login" && method === "POST") {
    const result = await login(request, env);
    if (result.status === 204) return empty(204, { "Set-Cookie": result.cookie });
    return json({ error: result.error }, result.status);
  }

  // The OAuth callback is authenticated by its single-use `state`, which only a
  // logged-in session can create (see /auth/x/start). The SameSite=Strict
  // session cookie is not sent on the cross-site redirect back from x.com.
  if (pathname === "/auth/x/callback" && method === "GET") {
    const outcome = await handleCallback(env, url);
    if (!outcome.ok) return htmlMessage(outcome.message);
    return new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store" } });
  }

  // ---- everything below requires a session ----
  if (!(await hasValidSession(request, env))) {
    return isAuth ? Response.redirect(`${publicUrl(env)}/`, 302) : json({ error: "Not logged in." }, 401);
  }

  if (pathname === "/auth/x/start" && method === "GET") return startOAuth(env);

  if (pathname === "/api/logout" && method === "POST") {
    return empty(204, { "Set-Cookie": clearSessionCookie() });
  }

  if (pathname === "/api/disconnect" && method === "POST") {
    await disconnect(env);
    return empty(204);
  }

  if (pathname === "/api/post" && method === "POST") return handlePost(request, env);

  return json({ error: "Not found." }, 404);
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  let posts;
  try {
    posts = await parsePostForm(await request.formData(), maxChars(env));
  } catch (err) {
    const message = err instanceof ValidationError ? err.userMessage : "Something's off with that request. Try again.";
    return json({ ok: false, sent: 0, error: message }, 400);
  }

  const result = await postThread(env, posts);
  if (result.ok) return json({ ok: true, sent: result.sent });

  const err = result.error;
  console.log(`post failed: ${err instanceof Error ? err.name : "unknown"} after ${result.sent}`);
  return json(
    {
      ok: false,
      sent: result.sent,
      error: friendlyMessage(err, result.sent),
      ...(err instanceof NotConnectedError ? { reconnect: true } : {}),
    },
    502,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let res: Response;
    try {
      res = await route(request, env);
    } catch (err) {
      console.log(`unhandled: ${err instanceof Error ? err.name : "unknown"}`);
      res = json({ ok: false, error: "Something went wrong. Try again." }, 500);
    }
    return withSecurityHeaders(res);
  },
} satisfies ExportedHandler<Env>;
