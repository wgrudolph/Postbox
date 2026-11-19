export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  TOKEN_ENC_KEY: string;
  PUBLIC_URL: string;
  MAX_CHARS?: string;
}

export function maxChars(env: Env): number {
  const n = Number.parseInt(env.MAX_CHARS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 280;
}

/** PUBLIC_URL without a trailing slash. */
export function publicUrl(env: Env): string {
  return env.PUBLIC_URL.replace(/\/+$/, "");
}
