import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
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
