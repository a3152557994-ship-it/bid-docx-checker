import { defineConfig } from "@cloudflare/config";

export default defineConfig({
  worker: {
    name: "bidguard-pro-api",
    compatibilityDate: "2026-10-01",
    entrypoint: "./index.mjs",
    workersDev: true,
  },
});
