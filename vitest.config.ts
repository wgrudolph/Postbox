import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Test-only secrets. Real ones are set with `wrangler secret put`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          X_CLIENT_ID: "test-client-id",
          X_CLIENT_SECRET: "test-client-secret",
          APP_PASSWORD: "correct horse battery staple",
          SESSION_SECRET: "c2Vzc2lvbi1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMzJieXRlcyE=",
          TOKEN_ENC_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
          PUBLIC_URL: "https://postbox.test",
        },
      },
    }),
  ],
});
