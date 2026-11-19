// Postbox frontend. One screen at a time, driven by GET /api/status.

import { weightedLength } from "./counter.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DRAFT_KEY = "postbox.draft.v1";
const COUNTER_THRESHOLD = 20;

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const screens = { locked: $("screen-locked"), connect: $("screen-connect"), compose: $("screen-compose") };

const state = {
  maxChars: 280,
  handle: null,
  /** @type {{ text: string, images: { file: File, url: string }[] }[]} */
  posts: [{ text: "", images: [] }],
  sending: false,
};

// ---------- utilities ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  let body = null;
  if (res.status !== 204) {
    try {
      body = await res.json();
    } catch {}
  }
  return { status: res.status, body };
}

function debounce(fn, ms) {
  let t = 0;
  const debounced = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = 0;
      fn();
    }, ms);
  };
  debounced.cancel = () => {
    clearTimeout(t);
    t = 0;
  };
  debounced.flush = () => {
    if (t) {
      debounced.cancel();
      fn();
    }
  };
  return debounced;
}

// ---------- screens ----------

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  if (name !== "compose") closeSheet(true);
  if (name === "locked") setTimeout(() => $("password").focus(), 0);
  if (name === "compose") setTimeout(() => focusBlock(0), 0);
}

async function refresh() {
  let status;
  try {
    status = (await api("/api/status")).body;
  } catch {
    status = null;
  }
  if (!status) {
    show("locked");
    $("login-error").textContent = "Postbox can't reach its server right now.";
    return;
  }
  state.maxChars = status.maxChars || 280;
  state.handle = status.handle;
  $("handle").textContent = status.handle ? `@${status.handle}` : "your X account";
  if (!status.authenticated) show("locked");
  else if (!status.xConnected) show("connect");
  else {
    renderBlocks();
    show("compose");
  }
}

// ---------- login / logout ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($("password"));
  const note = $("login-error");
  note.textContent = "";
  const { status, body } = await api("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: input.value }),
  }).catch(() => ({ status: 0, body: null }));
  if (status === 204) {
    input.value = "";
    await refresh();
  } else {
    note.textContent = body?.error || "That didn't work. Try again.";
    input.select();
  }
});

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  await refresh();
}
for (const el of document.querySelectorAll('[data-action="logout"]')) el.addEventListener("click", logout);

// ---------- composer rendering ----------

const blocksEl = $("blocks");
const template = /** @type {HTMLTemplateElement} */ ($("block-template"));

function renderBlocks() {
  // Revoke thumbnails we no longer show is handled at removal time.
  blocksEl.replaceChildren(...state.posts.map((_, i) => buildBlock(i)));
  updateValidity();
}

function buildBlock(index) {
  const post = state.posts[index];
  const frag = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
  const block = /** @type {HTMLElement} */ (frag.querySelector(".block"));
  const textarea = /** @type {HTMLTextAreaElement} */ (block.querySelector(".post-text"));
  const fileInput = /** @type {HTMLInputElement} */ (block.querySelector('input[type="file"]'));
  const textId = `post-${index}`;
  textarea.id = textId;
  block.querySelector("label.visually-hidden")?.setAttribute("for", textId);

  textarea.value = post.text;
  if (index > 0) textarea.placeholder = "Add another post";
  textarea.addEventListener("input", () => {
    post.text = textarea.value;
    autoGrow(textarea);
    updateCounter(block, post);
    updateValidity();
    saveDraft();
  });

  block.querySelector(".remove-block")?.addEventListener("click", () => {
    for (const img of post.images) URL.revokeObjectURL(img.url);
    state.posts.splice(index, 1);
    renderBlocks();
    saveDraft();
    focusBlock(Math.max(0, index - 1));
  });

  fileInput.addEventListener("change", () => {
    addImages(post, Array.from(fileInput.files || []));
    fileInput.value = "";
    renderBlocks();
  });

  renderThumbs(block, post);
  updateCounter(block, post);
  requestAnimationFrame(() => autoGrow(textarea));
  return block;
}

function renderThumbs(block, post) {
  const thumbs = /** @type {HTMLElement} */ (block.querySelector(".thumbs"));
  thumbs.replaceChildren(
    ...post.images.map((img, j) => {
      const wrap = document.createElement("div");
      wrap.className = "thumb";
      const el = document.createElement("img");
      el.src = img.url;
      el.alt = "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove image");
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(img.url);
        post.images.splice(j, 1);
        renderBlocks();
      });
      wrap.append(el, remove);
      return wrap;
    }),
  );
  const button = /** @type {HTMLElement} */ (block.querySelector(".image-button"));
  button.hidden = post.images.length >= MAX_IMAGES;
}

function addImages(post, files) {
  let rejected = false;
  for (const file of files) {
    if (post.images.length >= MAX_IMAGES) break;
    if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      rejected = true;
      continue;
    }
    post.images.push({ file, url: URL.createObjectURL(file) });
  }
  if (rejected) showError("Images need to be JPEG, PNG or WebP, 5 MB or smaller.");
}

function autoGrow(textarea) {
  if (CSS.supports("field-sizing", "content")) return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function remaining(post) {
  return state.maxChars - weightedLength(post.text);
}

function updateCounter(block, post) {
  const counter = /** @type {HTMLElement} */ (block.querySelector(".counter"));
  const left = remaining(post);
  counter.textContent = left <= COUNTER_THRESHOLD ? String(left) : "";
  counter.classList.toggle("is-over", left <= 0);
}

function postIsValid(post) {
  return (post.text.trim().length > 0 || post.images.length > 0) && remaining(post) >= 0;
}

function updateValidity() {
  const send = /** @type {HTMLButtonElement} */ ($("send"));
  send.disabled = state.sending || !state.posts.every(postIsValid);
  send.textContent = state.sending ? "Sending…" : state.posts.length > 1 ? "Send thread" : "Send";
}

function focusBlock(i) {
  const areas = blocksEl.querySelectorAll("textarea");
  const el = /** @type {HTMLTextAreaElement | undefined} */ (areas[i]);
  if (el && !matchMedia("(hover: none)").matches) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
}

$("add-post").addEventListener("click", () => {
  state.posts.push({ text: "", images: [] });
  renderBlocks();
  saveDraft();
  const areas = blocksEl.querySelectorAll("textarea");
  /** @type {HTMLTextAreaElement} */ (areas[areas.length - 1]).focus();
});

// ---------- draft persistence (text only) ----------

const saveDraft = debounce(() => {
  try {
    const texts = state.posts.map((p) => p.text);
    if (texts.every((t) => !t)) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(texts));
  } catch {}
}, 500);

// Don't lose the last half-second of typing on refresh or when the app is backgrounded.
window.addEventListener("pagehide", () => saveDraft.flush());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveDraft.flush();
});

function restoreDraft() {
  try {
    const texts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (Array.isArray(texts) && texts.length) {
      state.posts = texts.slice(0, 25).map((t) => ({ text: String(t ?? ""), images: [] }));
    }
  } catch {}
}

function clearDraft() {
  saveDraft.cancel(); // a pending save must not resurrect the sent text
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {}
}

// ---------- errors ----------

function showError(message) {
  $("send-error-text").textContent = message;
  $("send-error").hidden = false;
}
function hideError() {
  $("send-error").hidden = true;
  $("send-error-text").textContent = "";
}
$("dismiss-error").addEventListener("click", hideError);

// ---------- sending ----------

function setSending(on) {
  state.sending = on;
  $("composer").classList.toggle("is-sending", on);
  for (const el of $("composer").querySelectorAll("textarea, input, button")) {
    if (el.id !== "send") /** @type {HTMLInputElement} */ (el).disabled = on;
  }
  updateValidity();
}

async function send() {
  if (state.sending || !state.posts.every(postIsValid)) return;
  hideError();
  setSending(true);

  const form = new FormData();
  form.append("posts", JSON.stringify(state.posts.map((p) => ({ text: p.text, images: p.images.length }))));
  state.posts.forEach((p, i) => p.images.forEach((img, j) => form.append(`image_${i}_${j}`, img.file, img.file.name)));

  let status = 0;
  let body = null;
  try {
    ({ status, body } = await api("/api/post", { method: "POST", body: form }));
  } catch {
    body = null;
  }

  if (body?.ok) {
    await celebrate();
    return;
  }

  setSending(false);
  if (status === 401) return refresh();

  const sent = Number(body?.sent) || 0;
  if (sent > 0) {
    for (const p of state.posts.slice(0, sent)) for (const img of p.images) URL.revokeObjectURL(img.url);
    state.posts = state.posts.slice(sent);
    saveDraft();
  }
  renderBlocks();

  if (body?.reconnect) {
    await refresh();
    $("connect-note").textContent = body.error;
    return;
  }
  showError(body?.error || "Postbox couldn't reach its server. Nothing was sent.");
}

async function celebrate() {
  const composer = $("composer");
  const sentEl = $("sent");
  clearDraft();
  composer.classList.add("is-lifting");
  await wait(400);
  composer.hidden = true;
  composer.classList.remove("is-lifting", "is-sending");

  for (const p of state.posts) for (const img of p.images) URL.revokeObjectURL(img.url);
  state.posts = [{ text: "", images: [] }];
  state.sending = false;

  sentEl.hidden = false;
  requestAnimationFrame(() => sentEl.classList.add("is-visible"));
  await wait(2000);
  sentEl.classList.remove("is-visible");
  await wait(400);
  sentEl.hidden = true;

  renderBlocks();
  for (const el of composer.querySelectorAll("textarea, input, button")) /** @type {HTMLInputElement} */ (el).disabled = false;
  updateValidity();
  composer.hidden = false;
  composer.classList.add("is-fading-in");
  setTimeout(() => composer.classList.remove("is-fading-in"), 450);
  focusBlock(0);
}

$("send").addEventListener("click", send);

// ---------- settings sheet ----------

const sheet = $("sheet");
const backdrop = $("sheet-backdrop");
let lastFocus = null;

function openSheet() {
  lastFocus = document.activeElement;
  sheet.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    sheet.classList.add("is-open");
    backdrop.classList.add("is-open");
    $("close-settings").focus();
  });
}

function closeSheet(immediate = false) {
  if (sheet.hidden) return;
  sheet.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  const done = () => {
    sheet.hidden = true;
    backdrop.hidden = true;
  };
  if (immediate) done();
  else setTimeout(done, 300);
  if (lastFocus instanceof HTMLElement) lastFocus.focus();
}

$("open-settings").addEventListener("click", openSheet);
$("close-settings").addEventListener("click", () => closeSheet());
backdrop.addEventListener("click", () => closeSheet());

$("disconnect").addEventListener("click", async () => {
  await api("/api/disconnect", { method: "POST" }).catch(() => {});
  closeSheet(true);
  await refresh();
});

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sheet.hidden) {
    e.preventDefault();
    closeSheet();
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !screens.compose.hidden && sheet.hidden) {
    e.preventDefault();
    send();
  }
});

// ---------- start ----------

restoreDraft();
refresh();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
