import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tauriConfig = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
  version?: string;
};

export default defineConfig({
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(tauriConfig.version ?? "0.0.0")
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/.git/**",
        "**/.agents/**",
        "**/.codex/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/src-tauri/**",
        "**/*.log"
      ]
    }
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        updater: fileURLToPath(new URL("./updater.html", import.meta.url))
      }
    }
  },
  envPrefix: ["VITE_", "TAURI_"]
});
