// Error types and the mapping from X failures to calm, human-readable messages.
// Nothing from X's response body is ever passed to the browser verbatim.

export class NotConnectedError extends Error {
  constructor() {
    super("not_connected");
    this.name = "NotConnectedError";
  }
}

/** A non-2xx response from X. Only status and a coarse classification are kept. */
export class XApiError extends Error {
  constructor(
    public status: number,
    public kind: "duplicate" | "credits" | "other" = "other",
    public stage: "upload" | "post" | "token" = "post",
  ) {
    super(`x_api_${status}`);
    this.name = "XApiError";
  }
}

/** The network call failed or timed out before X answered. */
export class XNetworkError extends Error {
  constructor() {
    super("x_network");
    this.name = "XNetworkError";
  }
}

export class ValidationError extends Error {
  constructor(public userMessage: string) {
    super(userMessage);
    this.name = "ValidationError";
  }
}

/**
 * Looks at an X error body only to classify it (duplicate / credits).
 * X's v2 errors are problem+json ({ title, detail, type, status }) and sometimes
 * carry an `errors` array; legacy-style bodies may contain a message string.
 * The body is never returned or logged.
 */
export function classifyXError(status: number, body: unknown): "duplicate" | "credits" | "other" {
  const text = safeStringify(body).toLowerCase();
  if (status === 402 || /credit|usage cap|insufficient.*(funds|balance)/.test(text)) return "credits";
  if (status === 403 && /duplicate/.test(text)) return "duplicate";
  return "other";
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v ?? "");
  } catch {
    return "";
  }
}

export const MESSAGES = {
  notConnected: "Your X connection expired. Reconnect to keep posting.",
  credits: "Your X API credits have run out. Top up in the X developer console.",
  duplicate: "X rejected this as a duplicate of a recent post.",
  rateLimited: "X is rate-limiting right now. Try again in a few minutes.",
  image: "One of the images couldn't be uploaded. Try a smaller JPEG or PNG.",
  other: (sent: number) =>
    sent > 0
      ? `Something went wrong sending to X. Nothing after post ${sent} was sent.`
      : "Something went wrong sending to X. Nothing was sent.",
};

/** Friendly message for a failure that happened after `sent` posts went out. */
export function friendlyMessage(err: unknown, sent: number): string {
  let msg: string;
  if (err instanceof NotConnectedError) msg = MESSAGES.notConnected;
  else if (err instanceof XApiError) {
    if (err.kind === "credits") msg = MESSAGES.credits;
    else if (err.kind === "duplicate") msg = MESSAGES.duplicate;
    else if (err.status === 429) msg = MESSAGES.rateLimited;
    else if (err.stage === "upload") msg = MESSAGES.image;
    else msg = MESSAGES.other(sent);
  } else msg = MESSAGES.other(sent);

  // On a partial thread failure, say what retrying will do (the chain is lost).
  if (sent > 0 && !msg.startsWith("Something went wrong")) {
    msg += ` The first ${sent === 1 ? "post was" : `${sent} posts were`} sent. Retrying sends the rest as a new thread.`;
  } else if (sent > 0) {
    msg += " Retrying sends the rest as a new thread.";
  }
  return msg;
}
