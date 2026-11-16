import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Tauri sets TAURI_ENV_PLATFORM while running `tauri dev` / `tauri build`.
// The service worker is pointless (and gets in the way) inside the desktop shell,
// so the PWA layer only ships in the plain web build.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      disable: isTauri,
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "wallpapers/*.jpg"],
      manifest: {
        name: "Agentic OS Command Center",
        short_name: "Jarvis",
        description: "Agentic OS command center: agents, voice, telemetry.",
        theme_color: "#0b0d11",
        background_color: "#0b0d11",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
        // Long-press the home-screen icon → "Talk". Also the target for a
        // hardware-button launch (Samsung side key / Android Routines / Shortcuts app).
        shortcuts: [
          {
            name: "Talk to Jarvis",
            short_name: "Talk",
            description: "Open straight into listening",
            url: "/?voice=1",
            icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }],
          },
        ],
        launch_handler: { client_mode: "navigate-existing" },
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,jpg,webp}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Never cache API / gateway traffic.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: isTauri ? (process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15") : "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
