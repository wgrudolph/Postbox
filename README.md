# Postbox

A calm, send-only composer for Twitter-sorry, X. You type, optionally add images or a thread, press **Send**, see "Sent.", and the page goes blank again. Postbox never shows anything from X. You will never interact with the algorithm.

Design: one Cloudflare Worker (frontend + a small API) and one Workers KV namespace. It's free (except for X API credits) and you deploy it with one command.

---

## Deploy it (step by step)

You'll need about 20 minutes. You do steps 1–2 in a web browser and the rest in a terminal.

### 1. Create an X app

1. Go to **developer.x.com** and sign in with the X account you want to post from.
2. Create a **Project**, then an **App** inside it.
3. Open the app's **User authentication settings** and choose **Set up**:
   - **App permissions:** Read and write
   - **Type of App:** Web App, Automated App or Bot (this makes it a "confidential client")
   - **Callback URI / Redirect URL:** `https://postbox.<your-subdomain>.workers.dev/auth/x/callback`
     (you'll learn your exact Worker address in step 6. You can put a guess here now and come back to fix it)
   - **Website URL:** `https://postbox.<your-subdomain>.workers.dev`
   - Save.
4. Go to **Keys and tokens** and copy the **OAuth 2.0 Client ID** and **Client Secret**. Keep them somewhere safe for step 5.
5. Add **$5–10 of pay-per-use credits** in the developer console. A plain post costs about $0.015; a post with a link about $0.20.

### 2. Get Cloudflare and Node

1. Create a free account at **dash.cloudflare.com**.
2. Install **Node.js 20 or newer** from **nodejs.org** (or `brew install node` on a Mac).

### 3. Install

Open a terminal in this folder and run:

```bash
npm install
```

```bash
npx wrangler login
```

The second command opens a browser so you can let Wrangler use your Cloudflare account.

### 4. Create the storage

```bash
npx wrangler kv namespace create KV
```

It prints an `id`. Open `wrangler.toml` and paste it in place of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 5. Set your secrets

Run each command. Each one asks you to paste a value.

```bash
npx wrangler secret put X_CLIENT_ID
```
Paste the OAuth 2.0 Client ID from step 1.

```bash
npx wrangler secret put X_CLIENT_SECRET
```
Paste the OAuth 2.0 Client Secret from step 1.

```bash
npx wrangler secret put APP_PASSWORD
```
Type the password you'll use to open Postbox. Make it long; anyone with it can post as you.

```bash
npx wrangler secret put SESSION_SECRET
```
Paste a random value. Generate one with:
```bash
openssl rand -base64 32
```

```bash
npx wrangler secret put TOKEN_ENC_KEY
```
Paste a *different* random value from the same command:
```bash
openssl rand -base64 32
```

> If Wrangler says the Worker doesn't exist yet, answer **yes** when it offers to create it.

### 6. Set your address and deploy

1. Run `npx wrangler deploy` once. It prints your Worker's address, like `https://postbox.yourname.workers.dev`.
2. Open `wrangler.toml` and set `PUBLIC_URL` to that address exactly (no slash at the end).
3. Deploy again:

```bash
npx wrangler deploy
```

4. If the address differs from what you entered at developer.x.com, fix the **Callback URI** and **Website URL** there now.

### 7. Try it

Open your address, enter your password, press **Connect X**, approve on X, and send a test post.

### 8. Put it on your phone

Open the same address on your phone:

- **iPhone (Safari):** tap Share, then **Add to Home Screen**.
- **Android (Chrome):** tap ⋮, then **Install app** or **Add to Home screen**.

It opens full-screen, like an app.

---

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill it in. Keep `PUBLIC_URL=http://127.0.0.1:8787`.
2. In your X app settings, add a **second** Callback URI: `http://127.0.0.1:8787/auth/x/callback`.
3. Run:

```bash
npm run dev
```

4. Open http://127.0.0.1:8787. Use `127.0.0.1`, not `localhost`, so the OAuth callback matches. Chrome and Firefox accept the `Secure` session cookie on `127.0.0.1` over plain HTTP; Safari may not.

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Runs the test suite inside the Workers runtime (all X calls mocked) |
| `npm run typecheck` | TypeScript check |
| `npm run icons` | Regenerates the PWA icons in `public/icons/` |
| `npm run deploy` | Same as `npx wrangler deploy` |

---

## How it works

```
Browser ──(same origin)──▶ Worker ──▶ api.x.com   (only 5 allow-listed calls)
  public/*  static shell     │
  app.js    composer         └──▶ Workers KV: encrypted tokens, OAuth state, login-failure counters, handle
```

| File | Role |
| --- | --- |
| `src/index.ts` | Router, security headers, Origin check, `/api/post` handler |
| `src/auth.ts` | Password check (constant time), signed session cookie, login rate limit |
| `src/oauth.ts` | X OAuth 2.0 + PKCE: start, callback, refresh (with rotation), revoke |
| `src/x.ts` | `xFetch` allow-list, image upload, create post, thread sending |
| `src/crypto.ts` | AES-GCM, HMAC-SHA256, PKCE helpers (Web Crypto only) |
| `src/errors.ts` | Maps X failures to friendly messages |
| `src/validate.ts` | Parses and validates the multipart post body (magic-byte image checks) |
| `public/counter.js` | Weighted character counter, shared by browser and server |

### The hard rules, and where they're enforced

1. **No engagement data.** `xFetch` in `src/x.ts` refuses everything except `POST /2/oauth2/token`, `POST /2/oauth2/revoke`, `GET /2/users/me`, `POST /2/media/upload` and `POST /2/tweets`. It requires an exact path match, so query strings like `?user.fields=…` are refused too. A test scans `src/` and `public/` for metrics field names.
2. **Nothing from X reaches the browser** except success/failure, a friendly reason, and your handle. Post IDs exist only in a local variable while a thread is being sent.
3. **No links to x.com** in the UI. A test checks `public/` for this.
4. **No red, badges or counts.** The only number is the character counter, which appears when 20 characters remain.
5. **Tokens stay on the server**, AES-GCM encrypted in KV. Logs contain only method, path, status code and error type.

---

## Decisions

Places where the spec was silent, contradicted itself, or differed from the current X or Cloudflare docs:

1. **OAuth callback is authenticated by `state`, not the session cookie.** The session cookie is `SameSite=Strict`, so browsers don't send it on the redirect back from x.com. A cookie check on the callback would always fail. Instead, the callback requires a valid single-use `state` (32 random bytes, 10-minute TTL). Only a logged-in session can create one, through `/auth/x/start`.
2. **Counter at exactly 0.** The spec says the counter turns amber at 0 *and* Send disables at 0, but also allows posts of up to `MAX_CHARS`. Postbox turns the counter amber at 0 and disables Send only below 0, so a full 280-character post can be sent.
3. **Test tooling.** `@cloudflare/vitest-pool-workers` is deprecated and was renamed to `@cloudflare/vitest-plugin`. Postbox uses the new package (same runtime, same features) with Vitest 4.
4. **Media upload response.** docs.x.com documents the media id at `data.id` for `POST /2/media/upload`, not `media_id_string`. The code reads `data.id` and falls back to `media_id_string`.
5. **Token and revoke details.** docs.x.com says confidential clients don't need `client_id` in the body when they send Basic auth, so it isn't sent. The revoke body (`token`, `token_type_hint=refresh_token`) follows RFC 7009, because docs.x.com doesn't spell it out.
6. **Refresh failures.** X sometimes answers a dead refresh token with `400 invalid_request` rather than `invalid_grant`. Any 400 or 401 on refresh is treated as "not connected": tokens are deleted and the Connect screen appears.
7. **A 401 on posting** (access revoked on X's side) also deletes the tokens and shows the Connect screen.
8. **`/api/post` response details.** Validation errors return `400`; X failures return `502` with `{ ok: false, sent, error }`. A not-connected failure adds `reconnect: true` so the UI can switch screens. That flag is Postbox's own, not data from X.
9. **`/api/status` also returns `maxChars`** (from the `MAX_CHARS` var) so the browser counter matches the server.
10. **Partial thread failure message.** When some posts were already sent, the error ends with "Retrying sends the rest as a new thread."
11. **Origin check.** It applies to every non-GET route, including `/api/login`. Requests with no `Origin` header are rejected.
12. **Worker runs first for every request** (`run_worker_first = true`), so security headers also cover static files. Non-API paths go to the assets binding.
13. **Two extra source files**, `src/env.ts` (bindings type) and `src/validate.ts` (request parsing), keep `index.ts` small.
14. **Draft safety.** Besides the 500 ms debounced save, the draft is also saved when the page is hidden or closed, so a fast refresh doesn't lose the last keystrokes. A pending save is cancelled after a successful send so it can't bring the sent text back.
15. **Service worker** uses stale-while-revalidate for the static shell. After a deploy, the new version shows on the second load.
16. **Fonts.** Newsreader regular and italic (Latin subset, WOFF2) are self-hosted from `@fontsource/newsreader` under the SIL Open Font License (`public/fonts/OFL.txt`). Inter isn't bundled; the stack falls back to the system UI font.
17. **Icons** are generated by `scripts/make-icons.mjs` (an envelope dropping into a slot). Maskable versions keep the mark inside the safe zone.
18. **Login rate limit** counts failures per IP (`CF-Connecting-IP`). The window restarts at 15 minutes after the latest failure. While locked out, even the correct password gets `429`.
19. **Retries.** `xFetch` retries once after 2 s on `429` or `5xx`, as specified. A network error or timeout (25 s) is never retried, so a post can't be sent twice.

## Out of scope (for later)

Unsend/cooling period, drafts list, scheduling, local archive, reply-audience setting, alt text, video/GIF, link-cost notice, multiple accounts, other networks. Most would slot into `postThread` (`src/x.ts`) and the composer state in `public/app.js`.
