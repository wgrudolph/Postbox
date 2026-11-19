import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ORIGIN, sessionCookieHeader, testEnv } from "./helpers";

function login(password: string, ip = "203.0.113.7") {
  return worker.fetch(
    new Request(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ password }),
    }),
    testEnv,
  );
}

function status(cookie?: string) {
  return worker.fetch(new Request(`${ORIGIN}/api/status`, { headers: cookie ? { Cookie: cookie } : {} }), testEnv);
}

describe("login", () => {
  it("rejects a wrong password with 401", async () => {
    expect((await login("nope")).status).toBe(401);
  });

  it("rate-limits: the 6th failure gets 429", async () => {
    for (let i = 0; i < 5; i++) expect((await login("wrong", "198.51.100.1")).status).toBe(401);
    const sixth = await login("wrong", "198.51.100.1");
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: "Too many attempts. Try again in 15 minutes." });
    // Even the right password is refused while locked out.
    expect((await login("correct horse battery staple", "198.51.100.1")).status).toBe(429);
  });

  it("sets a hardened session cookie on success", async () => {
    const res = await login("correct horse battery staple");
    expect(res.status).toBe(204);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^pb_session=\d+\.[A-Za-z0-9_-]+;/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) expect(cookie).toContain(attr);

    const s = await status(cookie.split(";")[0]);
    expect(await s.json()).toMatchObject({ authenticated: true });
  });

  it("accepts a valid cookie and rejects a tampered one", async () => {
    const good = await sessionCookieHeader();
    expect(await (await status(good)).json()).toMatchObject({ authenticated: true });

    const [name, value] = good.split("=");
    const [expiry, sig] = value.split(".");
    const tamperedExpiry = `${name}=${Number(expiry) + 1}.${sig}`;
    const tamperedSig = `${name}=${expiry}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    for (const bad of [tamperedExpiry, tamperedSig, `${name}=garbage`]) {
      expect(await (await status(bad)).json()).toMatchObject({ authenticated: false, handle: null });
    }
  });

  it("logout clears the cookie", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/logout`, { method: "POST", headers: { Origin: ORIGIN, Cookie: await sessionCookieHeader() } }),
      testEnv,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("route protection", () => {
  const postBody = () => {
    const f = new FormData();
    f.set("posts", JSON.stringify([{ text: "hi", images: 0 }]));
    return f;
  };

  it("/api/post without a session is 401", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/post`, { method: "POST", headers: { Origin: ORIGIN }, body: postBody() }), testEnv);
    expect(res.status).toBe(401);
  });

  it("/api/post from a foreign Origin is 403, even with a session", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/post`, {
        method: "POST",
        headers: { Origin: "https://evil.example", Cookie: await sessionCookieHeader() },
        body: postBody(),
      }),
      testEnv,
    );
    expect(res.status).toBe(403);
  });

  it("API responses are no-store and carry security headers", async () => {
    const res = await status();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
