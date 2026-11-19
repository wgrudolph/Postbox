import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { xFetch, xConfig, postThread, DisallowedXCallError } from "../src/x";
import { weightedLength } from "../public/counter.js";
import { ORIGIN, PNG, JPEG, connect, jsonRes, mockX, sessionCookieHeader, testEnv } from "./helpers";

beforeEach(() => {
  xConfig.retryDelayMs = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("xFetch allow-list", () => {
  it.each([
    ["GET", "/2/tweets/123"],
    ["GET", "/2/users/me?user.fields=public_metrics"],
    ["GET", "/2/users/123/tweets"],
    ["GET", "/2/tweets/search/recent"],
    ["DELETE", "/2/tweets/123"],
    ["GET", "/2/tweets"],
    ["POST", "/2/users/me"],
  ])("throws before sending for %s %s", async (method, path) => {
    const { calls } = mockX(() => jsonRes({}));
    await expect(xFetch(method, path)).rejects.toBeInstanceOf(DisallowedXCallError);
    expect(calls).toHaveLength(0);
  });

  it("allows the listed calls", async () => {
    const { calls } = mockX(() => jsonRes({ data: {} }));
    for (const [m, p] of [
      ["POST", "/2/oauth2/token"],
      ["POST", "/2/oauth2/revoke"],
      ["GET", "/2/users/me"],
      ["POST", "/2/media/upload"],
      ["POST", "/2/tweets"],
    ]) {
      await xFetch(m, p);
    }
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.x.com/2/oauth2/token",
      "POST https://api.x.com/2/oauth2/revoke",
      "GET https://api.x.com/2/users/me",
      "POST https://api.x.com/2/media/upload",
      "POST https://api.x.com/2/tweets",
    ]);
  });

  it("retries once on 429/5xx but never on a network error", async () => {
    let { calls } = mockX((_r, n) => (n === 1 ? new Response("", { status: 503 }) : jsonRes({ data: { id: "1" } }, 201)));
    expect((await xFetch("POST", "/2/tweets")).status).toBe(201);
    expect(calls).toHaveLength(2);
    vi.restoreAllMocks();

    ({ calls } = mockX(() => {
      throw new TypeError("network down");
    }));
    await expect(xFetch("POST", "/2/tweets")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("source scan", () => {
  // Bundled at test time by Vite; covers every text file in src/ and public/.
  const files = {
    ...import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
    ...import.meta.glob("../public/**/*.{js,html,css,webmanifest}", { query: "?raw", import: "default", eager: true }),
  } as Record<string, string>;

  it("found the source files", () => {
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["../src/x.ts", "../src/index.ts", "../public/app.js", "../public/index.html"]),
    );
  });

  // Built from pieces so this file doesn't trip any similar scan of its own.
  const banned = ["public", "organic", "non_public"].map((p) => `${p}_metrics`).concat(["/time" + "lines"]);
  for (const word of banned) {
    it(`never mentions ${word}`, () => {
      const hits = Object.entries(files).filter(([, src]) => src.includes(word)).map(([f]) => f);
      expect(hits).toEqual([]);
    });
  }

  it("never links to x.com in the frontend", () => {
    const hits = Object.entries(files)
      .filter(([f]) => f.startsWith("../public/"))
      .filter(([, src]) => /(?:https?:)?\/\/(?:www\.)?(?:x|twitter)\.com/i.test(src))
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });
});

describe("postThread", () => {
  it("chains a 3-post thread and returns no IDs", async () => {
    await connect();
    let next = 100;
    const { calls } = mockX((req) => {
      if (req.path === "/2/media/upload") return jsonRes({ data: { id: "media-1", media_key: "3_1" } });
      if (req.path === "/2/tweets") return jsonRes({ data: { id: String(next++), text: "x" } }, 201);
      return jsonRes({}, 404);
    });

    const form = new FormData();
    form.set("posts", JSON.stringify([{ text: "one", images: 1 }, { text: "two", images: 0 }, { text: "three", images: 0 }]));
    form.set("image_0_0", new File([PNG], "a.png", { type: "image/png" }));
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/post`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: await sessionCookieHeader() },
        body: form,
      }),
      testEnv,
    );

    const bodyText = await res.text();
    expect(JSON.parse(bodyText)).toEqual({ ok: true, sent: 3 });
    expect(bodyText).not.toMatch(/10[0-2]|media-1/);

    const tweets = calls.filter((c) => c.path === "/2/tweets").map((c) => JSON.parse(c.body as string));
    expect(tweets).toHaveLength(3);
    expect(tweets[0]).toEqual({ text: "one", media: { media_ids: ["media-1"] } });
    expect(tweets[0].reply).toBeUndefined();
    expect(tweets[1].reply).toEqual({ in_reply_to_tweet_id: "100" });
    expect(tweets[2].reply).toEqual({ in_reply_to_tweet_id: "101" });

    const upload = calls.find((c) => c.path === "/2/media/upload")!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get("media_category")).toBe("tweet_image");
    expect(upload.headers.get("Authorization")).toBe("Bearer access-1");
  });

  it("stops at a failure on post 2 of 3", async () => {
    await connect();
    const { calls } = mockX((req, n) => {
      const tweetCalls = calls.filter((c) => c.path === "/2/tweets").length;
      if (tweetCalls === 2) return jsonRes({ title: "Forbidden", detail: "nope", status: 403 }, 403);
      return jsonRes({ data: { id: `id-${n}`, text: "x" } }, 201);
    });

    const result = await postThread(testEnv, [
      { text: "a", images: [] },
      { text: "b", images: [] },
      { text: "c", images: [] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(1);
    expect(calls.filter((c) => c.path === "/2/tweets")).toHaveLength(2);
    expect(calls.some((c) => (c.body as string)?.includes('"c"'))).toBe(false);
  });

  it("maps a duplicate-content 403 to the friendly message", async () => {
    await connect();
    mockX(() => jsonRes({ title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content.", status: 403 }, 403));
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/post`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: await sessionCookieHeader() },
        body: (() => {
          const f = new FormData();
          f.set("posts", JSON.stringify([{ text: "same again", images: 0 }]));
          return f;
        })(),
      }),
      testEnv,
    );
    const body = await res.json<any>();
    expect(body).toEqual({ ok: false, sent: 0, error: "X rejected this as a duplicate of a recent post." });
  });
});

describe("/api/post validation", () => {
  async function send(posts: unknown, files: Record<string, File> = {}) {
    const f = new FormData();
    f.set("posts", JSON.stringify(posts));
    for (const [k, v] of Object.entries(files)) f.set(k, v);
    return worker.fetch(
      new Request(`${ORIGIN}/api/post`, { method: "POST", headers: { Origin: ORIGIN, Cookie: await sessionCookieHeader() }, body: f }),
      testEnv,
    );
  }

  it("rejects empty posts, over-long posts and non-images", async () => {
    const { calls } = mockX(() => jsonRes({}));
    expect((await send([{ text: "   ", images: 0 }])).status).toBe(400);
    expect((await send([{ text: "a".repeat(281), images: 0 }])).status).toBe(400);
    expect((await send([{ text: "hi", images: 5 }])).status).toBe(400);
    const fake = new File([new TextEncoder().encode("GIF89a.........")], "a.png", { type: "image/png" });
    const r = await send([{ text: "", images: 1 }], { image_0_0: fake });
    expect(r.status).toBe(400);
    expect((await r.json<any>()).error).toMatch(/JPEG, PNG or WebP/);
    expect(calls).toHaveLength(0);
  });

  it("accepts a 280-character post and image-only posts", async () => {
    await connect();
    mockX((req) => (req.path === "/2/media/upload" ? jsonRes({ data: { id: "m" } }) : jsonRes({ data: { id: "1", text: "" } }, 201)));
    expect((await send([{ text: "a".repeat(280), images: 0 }])).status).toBe(200);
    expect((await send([{ text: "", images: 1 }], { image_0_0: new File([JPEG], "a.jpg") })).status).toBe(200);
  });
});

describe("counter", () => {
  it("counts a URL as 23", () => {
    expect(weightedLength("https://example.com/a/very/long/path?with=query&and=more")).toBe(23);
    expect(weightedLength("see http://a.co")).toBe(4 + 23);
  });
  it("counts a CJK character as 2", () => {
    expect(weightedLength("漢")).toBe(2);
    expect(weightedLength("日本語")).toBe(6);
  });
  it("counts an emoji as 2, including ZWJ sequences", () => {
    expect(weightedLength("😀")).toBe(2);
    expect(weightedLength("👩‍👩‍👧")).toBe(2);
    expect(weightedLength("❤️")).toBe(2);
  });
  it("counts Latin text and typographic punctuation as 1", () => {
    expect(weightedLength("Héllo — “ok”")).toBe(12);
  });
});
