import { defineConfig } from "tsup";

/**
 * Standalone IIFE / minified ESM bundles for direct use via a `<script>` tag
 * or `<script type="module">`. Output lands in `dist/standalone/`.
 */
export default defineConfig([
  {
    entry: { "shuakami-search": "src/index.ts" },
    outDir: "dist/standalone",
    format: ["iife"],
    globalName: "ShuakamiSearch",
    target: "es2020",
    minify: true,
    sourcemap: false,
    splitting: false,
    treeshake: true,
    dts: false,
    clean: false,
  },
  {
    entry: { "shuakami-search": "src/index.ts" },
    outDir: "dist/standalone",
    format: ["esm"],
    target: "es2020",
    minify: true,
    sourcemap: false,
    splitting: false,
    treeshake: true,
    dts: false,
    clean: false,
    outExtension() {
      return { js: ".min.js" };
    },
  },
]);
