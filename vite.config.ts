import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

// Standalone web chat client. Served separately from the OpenClaw gateway;
// the app connects to the gateway over WebSocket (ws:// or wss://).
export default defineConfig({
  base: "./",
  plugins: [vue()],
  server: {
    port: 5174,
    // The browser cannot sign the device challenge unless crypto.subtle is
    // available (secure context). For local dev over http://localhost the
    // context is still secure, so a plain `vite` dev server is fine. If you
    // serve from a non-localhost origin, serve over https.
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        // Offline canvas harness used to capture Prose layout screenshots
        // without a real gateway connection. Not shipped to users.
        demo: resolve(__dirname, "index-demo.html"),
      },
    },
  },
});
