import { defineConfig } from "cloudflare/config";

export default defineConfig({
  name: "bidguard-pro-api",
  main: "./index.mjs",
  compatibilityDate: "2026-10-01",
});
