import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    cloudflare({
      config: {
        name: "bidguard-pro-api",
        main: "./index.mjs",
        compatibility_date: "2026-10-01",
        workers_dev: true,
      },
    }),
  ],
});
