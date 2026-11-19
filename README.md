<p align="center">
  <img src="public/icons/icon-192.png" width="96" height="96" alt="Postbox icon: an envelope dropping into a slot">
</p>

<h1 align="center">Postbox</h1>

<p align="center">A calm, send-only composer for Twitter—sorry, X.</p>

You type, optionally add images or a thread, press **Send**, see "Sent.", and the page goes blank again. Postbox never shows anything from X. You will never interact with the algorithm.

You run your own copy. It's one Cloudflare Worker (frontend + a small API) and one Workers KV namespace. Cloudflare's free plan covers it; the only cost is X's API credits. You deploy it with one command.

## What you get

- A single quiet screen to write on, installable on your phone's home screen
- Posts up to 280 characters (configurable), with up to 4 images each
- Threads: add more posts below the first and they go out as a reply chain
- Your unsent draft survives a refresh
- A password, so only you can use it

## What it will never do

- Show a feed, likes, views, replies, follower counts or any other numbers
- Request engagement data from X. The code can only make five specific X API calls, and tests enforce that (see [How it works](#how-it-works))
- Send your X tokens to the browser. They stay encrypted on your Worker

---

## Before you start

You'll need:

- [ ] An **X account** to post from
- [ ] An **X developer account** with **$5–10 of pay-per-use credits**. A plain post costs about $0.015; a post with a link about $0.20.
- [ ] A free **Cloudflare account**
- [ ] **Node.js 20 or newer** (from [nodejs.org](https://nodejs.org), or `brew install node` on a Mac) and **git**

Set-up takes about 20 minutes. Steps 2 and 3 happen in a web browser; the rest is in a terminal.

## Setup

### 1. Get the code

**Fork** this repository (button at the top right of GitHub), then clone your fork. You'll edit `wrangler.toml` during setup, and a fork lets you commit that. The values you put there are not secret; secrets never go in the repo.

```bash
git clone https://github.com/<your-username>/Postbox.git
```

```bash
cd Postbox
```

```bash
npm install
```

To try it without a fork, clone `https://github.com/wgrudolph/Postbox.git` instead.

### 2. Create an X app

1. Go to [developer.x.com](https://developer.x.com) and sign in with the X account you want to post from.
2. Create a **Project**, then an **App** inside it.
3. Open the app's **User authentication settings** and choose **Set up**:
   - **App permissions:** Read and write
   - **Type of App:** Web App, Automated App or Bot
   - **Callback URI / Redirect URL:** `https://postbox.<your-subdomain>.workers.dev/auth/x/callback`
   - **Website URL:** `https://postbox.<your-subdomain>.workers.dev`
   - Save.

   You won't know your exact Worker address until step 7. Put your best guess here now and correct it then.
4. Go to **Keys and tokens** and copy the **OAuth 2.0 Client ID** and **Client Secret**. Keep them handy for step 6.
5. Add pay-per-use credits in the developer console.

### 3. Connect Wrangler to Cloudflare

Wrangler is Cloudflare's command-line tool. `npm install` already installed it.

```bash
npx wrangler login
```

This opens a browser so you can let Wrangler use your Cloudflare account.

### 4. Create the storage

```bash
npx wrangler kv namespace create KV
```

It prints an `id`. Open `wrangler.toml` and paste it in place of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 5. Deploy once to get your address

```bash
npx wrangler deploy
```

It prints your Worker's address, like `https://postbox.yourname.workers.dev`. Postbox won't work yet; this step just creates the Worker so you know its address.

### 6. Set your secrets

Run each command. Each one asks you to paste a value. Secrets are stored by Cloudflare, never in this repo.

```bash
npx wrangler secret put X_CLIENT_ID
```
Paste the OAuth 2.0 Client ID from step 2.

```bash
npx wrangler secret put X_CLIENT_SECRET
```
Paste the OAuth 2.0 Client Secret from step 2.

```bash
npx wrangler secret put APP_PASSWORD
```
Type the password you'll use to open Postbox. Make it long: anyone with it can post as you.

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

### 7. Set your address and deploy again

1. Open `wrangler.toml` and set `PUBLIC_URL` to the address from step 5, exactly, with no slash at the end.
2. Deploy:

```bash
npx wrangler deploy
```

3. Back at developer.x.com, make sure the **Callback URI** is that address followed by `/auth/x/callback`, and the **Website URL** is the address itself.
4. If you forked, commit your `wrangler.toml` changes.

### 8. Try it

Open your address, enter your password, press **Connect X**, approve on X, and send a test post.

### 9. Put it on your phone

Open the same address on your phone:

- **iPhone (Safari):** tap Share, then **Add to Home Screen**.
- **Android (Chrome):** tap ⋮, then **Install app** or **Add to Home screen**.

It opens full-screen, like an app.

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| X says something went wrong after you approve, or won't show the approval page | The Callback URI at developer.x.com must match `PUBLIC_URL` + `/auth/x/callback` exactly (https, no trailing slash). Also check that **Type of App** is "Web App, Automated App or Bot". |
| "X didn't accept the connection" | The Client ID or Client Secret is wrong. Run `npx wrangler secret put` for both again. Use the OAuth **2.0** keys, not the API Key/Secret. |
| "Forbidden." when logging in | You opened Postbox at an address that isn't `PUBLIC_URL`. Use that exact address, or change `PUBLIC_URL` and deploy again. |
| `wrangler deploy` complains about the KV namespace | Step 4 isn't done. Paste the namespace `id` into `wrangler.toml`. |
| "This sign-in link expired" | More than 10 minutes passed, or the page was reloaded. Press **Connect X** again. |
| "Your X connection expired" keeps coming back | Check that **App permissions** are **Read and write**. If you changed permissions after connecting, open Settings, press **Disconnect X**, then connect again. |
| "Your X API credits have run out" | Top up in the X developer console. |
| "Too many attempts" | Five wrong passwords lock that network out for 15 minutes. Wait it out. |
| An update you deployed isn't showing | Reload the page twice. The app caches itself so it opens fast, and fetches the new version in the background. |

To see the Worker's logs (status codes only; post text and tokens are never logged):

```bash
npx wrangler tail
```

## Everyday changes

**Change your password:** run `npx wrangler secret put APP_PASSWORD` again.

**Sign out every device:** run `npx wrangler secret put SESSION_SECRET` with a fresh `openssl rand -base64 32` value.

**Rotate the token encryption key:** run `npx wrangler secret put TOKEN_ENC_KEY` with a fresh value. Postbox will ask you to connect X again.

**Allow longer posts** (if your X account supports them): change `MAX_CHARS` in `wrangler.toml` and deploy.

## Updating

Pull the latest code and deploy. If you forked, first press **Sync fork** on your fork's GitHub page.

```bash
git pull
```

```bash
npm install
```

```bash
npx wrangler deploy
```

Your secrets, connection and password stay as they are.

## Uninstalling

1. In Postbox, open **Settings** and press **Disconnect X**. This revokes Postbox's access on X.
2. Delete the Worker:
   ```bash
   npx wrangler delete
   ```
3. Delete the storage, using the `id` from `wrangler.toml`:
   ```bash
   npx wrangler kv namespace delete --namespace-id <id>
   ```
4. Optionally delete the app at developer.x.com.

---

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill it in. Keep `PUBLIC_URL=http://127.0.0.1:8787`. `.dev.vars` is git-ignored.
2. In your X app settings, add a **second** Callback URI: `http://127.0.0.1:8787/auth/x/callback`.
3. Run:

```bash
npm run dev
```

4. Open http://127.0.0.1:8787. Use `127.0.0.1`, not `localhost`, so the OAuth callback matches. Chrome and Firefox accept the `Secure` session cookie on `127.0.0.1` over plain HTTP; Safari may not.

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

<details>
<summary><strong>Design decisions</strong> (where the build spec was silent, contradicted itself, or differed from current docs)</summary>

1. **OAuth callback is authenticated by `state`, not the session cookie.** The session cookie is `SameSite=Strict`, so browsers don't send it on the redirect back from x.com. A cookie check on the callback would always fail. Instead, the callback requires a valid single-use `state` (32 random bytes, 10-minute TTL). Only a logged-in session can create one, through `/auth/x/start`.
2. **Counter at exactly 0.** The spec says the counter turns amber at 0 *and* Send disables at 0, but also allows posts of up to `MAX_CHARS`. Postbox turns the counter amber at 0 and disables Send only below 0, so a full 280-character post can be sent.
3. **Test tooling.** `@cloudflare/vitest-pool-workers` is deprecated and was renamed to `@cloudflare/vitest-plugin`. Postbox uses the new package (same runtime, same features) with Vitest 4.
4. **Media upload response.** docs.x.com documents the media id at `data.id` for `POST /2/media/upload`, not `media_id_string`. The code reads `data.id` and falls back to `media_id_string`.
5. **Token and revoke details.** docs.x.com says confidential clients don't need `client_id` in the body when they send Basic auth, so it isn't sent. The revoke body (`token`, `token_type_hint=refresh_token`) follows RFC 7009, because docs.x.com doesn't spell it out.
6. **Refresh failures.** X sometimes answers a dead refresh token with `400 invalid_request` rather than `invalid_grant`. Any 400 or 401 on refresh is treated as "not connected": tokens are deleted and the Connect screen appears.
7. **A 401 on posting** (access revoked on X's side) also deletes the tokens and shows the Connect screen. So do stored tokens that can't be decrypted (for example after rotating `TOKEN_ENC_KEY`).
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

</details>

## Not built yet

Unsend/cooling period, drafts list, scheduling, local archive, reply-audience setting, alt text, video/GIF, link-cost notice, multiple accounts, other networks. Most would slot into `postThread` (`src/x.ts`) and the composer state in `public/app.js`.
