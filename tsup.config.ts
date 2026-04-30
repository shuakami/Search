import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    highlight: "src/highlight.ts",
    cli: "src/cli.ts",
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  target: "es2020",
  splitting: false,
  treeshake: true,
  clean: true,
  dts: true,
  minify: false,
  sourcemap: false,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
