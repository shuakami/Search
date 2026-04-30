/**
 * Build an index in memory and query it. Run with `pnpm tsx examples/node-cli.ts`.
 */

import { buildIndex, loadIndex, renderHighlights } from "../src/index";

const docs = [
  {
    id: "1",
    title: "Hello world",
    body: "First post on the new blog.",
    tags: ["blog", "intro"],
  },
  {
    id: "2",
    title: "Search basics",
    body: "Tokenizers, postings, and how scoring works.",
    tags: ["theory"],
  },
  {
    id: "3",
    title: "搜索入门",
    body: "中文示例文档，演示混合脚本分词。",
    tags: ["theory", "i18n"],
  },
  {
    id: "4",
    title: "Adventures with WebAssembly",
    body: "Compiling a search runtime to WASM and back.",
    tags: ["wasm", "perf"],
  },
];

const { pack, manifest } = buildIndex(docs, {
  fields: {
    title: { weight: 5, kind: "text" },
    body: { weight: 1, kind: "text" },
  },
  storeFields: ["title", "body"],
  tagsField: "tags",
});

console.log(`built pack: ${pack.length} bytes`);
console.log(`manifest:`, manifest);

const engine = loadIndex(pack);

for (const query of ["search", "中文", "wasm", "tokenisr"]) {
  console.log("\n→", JSON.stringify(query));
  const hits = engine.search(query, { limit: 3 });
  for (const hit of hits) {
    const titleMatches = hit.matches.find((field) => field.field === "title");
    const titleHtml = renderHighlights(
      hit.doc.fields.title,
      titleMatches?.ranges ?? [],
    );
    console.log(
      `  [${hit.doc.id}] score=${hit.score.toFixed(3)} ${titleHtml}`,
    );
  }
}
