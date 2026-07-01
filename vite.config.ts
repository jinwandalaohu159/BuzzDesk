import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

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
    minify: "esbuild"
  },
  envPrefix: ["VITE_", "TAURI_"]
});
