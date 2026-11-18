import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Only src/**: scripts/ has its own node:test suite (`npm run test:scripts`),
 * not vitest's. Keep this file's patterns in sync if either moves.
 */
export default defineConfig({
  resolve: {
    // `fileURLToPath`, not `.pathname`: on Windows, `.pathname` keeps the leading "/" and
    // percent-encodes spaces (this repo's own path has several), which Node's resolver then
    // can't find on disk. That silently broke every "@/..." runtime import under Vitest here.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "scripts/**"],
    environment: "node",
  },
});
