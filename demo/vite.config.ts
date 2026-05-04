import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// Repository GitHub Pages will serve under https://shuakami.github.io/Search/
// so the bundle must use that base path.
export default defineConfig({
  base: "/Search/",
  resolve: {
    alias: {
      "shuakami-search": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  build: {
    target: "es2020",
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
  },
});
