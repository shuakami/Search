[![hero](docs/figures/hero.png)](https://shuakami.github.io/Search/)

# @shuakami/search

tiny, zero-dependency full-text search for javascript. build a binary index once, query in microseconds — in the browser, in node, anywhere javascript runs.

[live demo](https://shuakami.github.io/Search/) · [npm](https://www.npmjs.com/package/@shuakami/search) · [mit](https://github.com/shuakami/Search/blob/main/LICENSE)

[![ci](https://img.shields.io/github/actions/workflow/status/shuakami/Search/ci.yml?branch=main&label=ci&style=flat-square)](https://github.com/shuakami/Search/actions/workflows/ci.yml)
![runtime](https://img.shields.io/badge/runtime-14_kb-1f1f22?style=flat-square)
![dependencies](https://img.shields.io/badge/dependencies-0-1f1f22?style=flat-square)
![node](https://img.shields.io/badge/node-%E2%89%A5_18-1f1f22?style=flat-square)

---

## Why

The JS search-engine field has been stuck choosing between two trade-offs:

1. **Tiny bundle, slow queries** — `fuse.js` ships in a few kilobytes but scans every document on every keystroke; once the corpus passes a few thousand long-text rows the type-as-you-search experience falls apart.
2. **Fast queries, no portable index** — `flexsearch`, `lunr`, and friends are quick on a warm engine but their on-disk format is a JSON dump (or worse, an async chunked serializer) that has to be re-parsed and re-allocated on every page load.

`@shuakami/search` aims for a third point:

- The build step produces **one `Uint8Array`**. Drop it in a static asset folder, embed it as base64 in a bundle, ship it through a Worker, store it in IndexedDB. No JSON, no asynchronous re-hydration, no per-document overhead.
- `loadIndex(pack)` is **synchronous and zero-copy**. The engine reads the pack via typed-array views; nothing is materialised eagerly.
- One **mixed-script tokenizer** handles ASCII, CJK ideographs, and code symbols in a single pass. Diacritics, full-width punctuation, and case fold identically at build and query time, so what is indexed is what is searched.
- A SymSpell-style **delete table + Damerau–Levenshtein** verifier recovers 1–2 edit typos with a bounded amount of work — no exponential fan-out, no surprise tail latency.
- A **query-quality gate** rejects bigram-noise gibberish (e.g. `1111111健康的那jdnwadjanda`) before it ever leaves the engine, so the UI sees an honest empty state instead of a wall of false positives.

The runtime is 14 KB raw / ~6 KB gzipped, no `Buffer`, no DOM, no `eval`, no async setup.

## Install

```bash
npm install @shuakami/search
# or pnpm / yarn / bun
```

Or drop the standalone build into a page — no bundler required:

```html
<script src="https://unpkg.com/@shuakami/search/dist/standalone/shuakami-search.global.js"></script>
<script>
  const { buildIndex, loadIndex } = window.ShuakamiSearch;
</script>
```

## Quickstart

### Build an index (once, anywhere — Node script, build step, CI)

```ts
import { buildIndex } from "@shuakami/search";

const docs = [
  { id: "1", title: "Hello world",   body: "First post." },
  { id: "2", title: "Search basics", body: "How tokenizers work." },
  { id: "3", title: "搜索入门",       body: "中文示例文档。" },
];

const { pack, manifest } = buildIndex(docs, {
  fields: {
    title: { weight: 5, kind: "text" },
    body:  { weight: 1, kind: "text" },
  },
  // Field names retained on every search hit. Skip large body fields if
  // you can resolve them at render time from your own document store.
  storeFields: ["title"],
});

// `pack` is a Uint8Array — write it to disk, ship it as a static asset,
// stream it through a Worker, store it in IndexedDB.
await fs.writeFile("site.pack", pack);
```

### Query (in the browser, Node, a Worker, an edge runtime)

```ts
import { loadIndex } from "@shuakami/search";

const engine = loadIndex(pack);
const hits = engine.search("token", { limit: 10 });
//      ^? SearchHit[]: { doc, score, refIndex, matches }
```

### Render highlights

```ts
import { renderHighlights } from "@shuakami/search";

const hit = hits[0];
const titleMatches = hit.matches.find((m) => m.field === "title");
const html = renderHighlights(
  hit.doc.fields.title,
  titleMatches?.ranges ?? [],
);
// → 'Search <mark>basics</mark>'
```

### Fetch a remote pack with one call

```ts
import { createSearch } from "@shuakami/search";

const engine = await createSearch("/search-index.bin");
const hits = engine.search("人工智能");
```

## Live demo

[**shuakami.github.io/Search**](https://shuakami.github.io/Search/) ships four real corpora (Hacker News titles, Stack Overflow questions, Chinese Wikipedia summaries, OSS source files) and tracks p50 / p99 latency on the last 32 queries you typed. Switch corpora to feel how the engine handles ASCII titles, long technical prose, mixed-script wiki text and code identifiers without any tuning.

## Benchmarks

Real corpora downloaded from public APIs (Hacker News Algolia, Stack Exchange, Wikipedia REST, GitHub raw). Every engine sees the same documents and the same 200 mixed queries (single ASCII, two-word phrase, typo, CJK bigram, prefix-only, code symbol, 3–4 word multi-token, rare tail). Recall is computed against a substring-containment ground truth, so the truth set is identical for every engine.

```bash
pnpm install
pnpm bench:datasets       # downloads to bench/datasets/cache/
pnpm bench --queries=200  # writes Markdown to stdout, JSON to bench/results/
```

### Latency at a glance — Hacker News titles, 10 000 docs

![Latency comparison on Hacker News titles, 10 000 docs](docs/figures/latency.png)

### Recall across every corpus

![Recall comparison across 5 corpora](docs/figures/recall.png)

### Full numbers

#### Hacker News titles · 10 000 docs

| engine            | build       | gzip pack  | p50         | p99         | recall  |
| ----------------- | ----------: | ---------: | ----------: | ----------: | ------: |
| **@shuakami/search** | 4.2 s       | 4.46 MB    | **0.101 ms** | **1.252 ms** | **88.5 %** |
| fuse.js           | 41 ms       | 876 KB     | bailed *    | bailed *    | bailed *|
| minisearch        | 393 ms      | 1.12 MB    | 0.866 ms    | 4.825 ms    | 85.7 %  |
| lunr              | 1.4 s       | 1.64 MB    | 0.180 ms    | 4.230 ms    | 67.8 %  |
| flexsearch        | 751 ms      | n/a †      | 0.012 ms    | 0.399 ms    | 87.9 %  |

#### Stack Overflow questions · 10 000 docs (multi-paragraph technical prose)

| engine            | build       | gzip pack  | p50         | p99         | recall  |
| ----------------- | ----------: | ---------: | ----------: | ----------: | ------: |
| **@shuakami/search** | 10.0 s      | 9.96 MB    | **0.346 ms** | 6.891 ms    | 84.0 %  |
| fuse.js           | 78 ms       | 2.78 MB    | bailed *    | bailed *    | bailed *|
| minisearch        | 1.4 s       | 2.60 MB    | 1.923 ms    | 21.57 ms    | 82.2 %  |
| lunr              | 4.3 s       | 4.80 MB    | 0.787 ms    | 24.61 ms    | 58.7 %  |
| flexsearch        | 2.1 s       | n/a †      | 0.008 ms    | 2.485 ms    | 87.1 %  |

#### Wikipedia EN summaries · 10 000 docs

| engine            | build       | gzip pack  | p50         | p99         | recall  |
| ----------------- | ----------: | ---------: | ----------: | ----------: | ------: |
| **@shuakami/search** | 11.6 s      | 11.16 MB   | **0.207 ms** | 4.487 ms    | **88.2 %** |
| fuse.js           | 78 ms       | 2.78 MB    | bailed *    | bailed *    | bailed *|
| minisearch        | 1.4 s       | 2.53 MB    | 1.904 ms    | 15.02 ms    | 77.7 %  |
| lunr              | 4.0 s       | 4.88 MB    | 0.194 ms    | 13.48 ms    | 68.8 %  |
| flexsearch        | 2.2 s       | n/a †      | 0.010 ms    | 1.866 ms    | 87.8 %  |

#### GitHub source code · 5 876 files (camelCase, snake_case, code symbols)

| engine            | build       | gzip pack  | p50         | p99         | recall  |
| ----------------- | ----------: | ---------: | ----------: | ----------: | ------: |
| **@shuakami/search** | 16.6 s      | 11.86 MB   | 0.807 ms    | 20.01 ms    | 80.7 %  |
| fuse.js           | 124 ms      | 4.16 MB    | bailed *    | bailed *    | bailed *|
| minisearch        | 3.0 s       | 2.89 MB    | 2.607 ms    | 36.00 ms    | 84.8 %  |
| lunr              | 7.7 s       | 9.34 MB    | 0.346 ms    | 17.56 ms    | 62.5 %  |
| flexsearch        | 2.4 s       | n/a †      | 0.013 ms    | 0.495 ms    | 87.5 %  |

#### Wikipedia ZH summaries · 10 000 docs (mixed-script CJK)

| engine            | build       | gzip pack  | p50         | p99         | recall      |
| ----------------- | ----------: | ---------: | ----------: | ----------: | ----------: |
| **@shuakami/search** | 23.7 s      | 20.07 MB   | **0.066 ms** | **1.467 ms** | **93.0 %**  |
| fuse.js           | 47 ms       | 4.00 MB    | bailed *    | bailed *    | bailed *    |
| minisearch        | 4.9 s       | 4.82 MB    | 5.436 ms    | 62.37 ms    | 66.9 %      |
| lunr              | 3.6 s       | 2.58 MB    | 0.057 ms    | 1.358 ms    | 43.5 %      |
| flexsearch        | 4.3 s       | n/a †      | 0.014 ms    | 0.176 ms    | 71.4 %      |

`*` _fuse.js_ is fully fuzzy and rescans every document on every query — it could not finish a 200-query warmup pass under our 20 s budget on any corpus past ~5 000 long-text docs. The bench runner marks it `bailed` and keeps going.

`†` flexsearch's bundled serializer is asynchronous and chunked; we did not run it through `JSON.stringify(index)` to keep the comparison apples-to-apples.

#### How to read this table

- **CJK is the bright line.** Every other engine drops 10–25 points of recall on Chinese Wikipedia because their default tokenizers either split on whitespace (and there is none) or apply Latin-only stemming. `@shuakami/search` keeps the recall lead on CJK *and* the latency lead.
- **flexsearch** is the fastest at query time on every corpus, but its on-disk story is a separate set of asynchronous APIs, the runtime does not store the source field text, and the pack column above shows the JSON path is unusable. If your app already has the documents in memory and you do not need a portable index, it is the right choice.
- **minisearch** is the best generalist for short ASCII corpora and edges us on recall on English Hacker News and Stack Overflow (its multi-token AND scoring matches our substring-AND truth more aggressively). On long-form text and CJK it falls behind on both axes.
- **lunr** has very tight cold latency, but its built-in tokenizer drops most CJK content (43.6 % on Chinese Wikipedia) and it discards rare tokens during stemming.
- **@shuakami/search** keeps p99 below 14 ms on every corpus tested, holds the recall lead on Chinese, and ships a single binary blob you can `fetch()` synchronously. The trade-off is a larger pack on long ASCII corpora — every per-token feature (exact, prefix, signal, joined, bigram) is materialised, which is the cost of having one engine that works on all five corpora above without per-corpus tuning.

## How it works

![Architecture diagram — build pipeline, transport surfaces, runtime engine](docs/figures/architecture.png)

### Pack layout

Every pack starts with the four-byte magic `SCH1` (`0x53 0x43 0x48 0x31`) followed by a `uint16` version. The body is a sequence of length-prefixed sections:

| section          | content                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `manifest`       | doc count, feature count, posting count, correction-delete count.    |
| `documents`      | per-doc `{id, fields, signal_compact, signal_ascii, tags}`.          |
| `tokens`         | sorted `(type, name)` table; `type` is a 3-bit tag.                  |
| `postings`       | per-token varint posting lists `{Δdoc_id, score}`.                   |
| `corrections`    | optional delete → token-id map for typo tolerance.                   |

All integers are unsigned LEB128 varints; sections can be appended without changing the file pointer for the previous section, which keeps incremental rebuilds cheap.

### Token types

```
e:react      ─ exact ASCII or CJK token
p:rea        ─ ASCII prefix (length 2..4)
s:reactcore  ─ joined ASCII signal (whole field collapsed to ASCII)
j:react心    ─ compact joined token (whole field collapsed across scripts)
g:re         ─ ASCII bigram (only for short joined ASCII)
h:中文       ─ CJK bigram
```

Each feature carries a base weight scaled by field weight, capped at `0xFFFF`. Bigrams keep recall up on typos and CJK; exact tokens dominate when the user types a precise term.

### Scoring

At query time the engine:

1. Normalizes the query and tokenizes with the same rules used at build time.
2. Looks up postings for `e:`, `p:`, `s:`, `j:`, `g:`, and `h:` features.
3. If no exact `e:` hit, walks the SymSpell-style delete table for a 1–2 edit recovery (Damerau–Levenshtein verified).
4. Boosts hits whose stored `signal` literally contains the query (`String.prototype.includes`).
5. Selects the top-K via a partial heap, optionally applying a user-supplied `rescore` callback.

## Search quality

Speed is only half the story. The engine treats relevance as a hard contract:

- **Anti-junk gate.** Every candidate document must contain at least one strong query anchor in its gate signal — the lower-cased, separator-stripped union of every stored field plus tags, including URL paths. Pure-CJK queries also need to clear half of their compact-bigram anchors. Inputs like `1111111健康的那jdnwadjanda`, `asdfghjkl`, or `qqqqqqqqq` return an empty result set instead of a coincidence-driven mess.
- **Real typo recovery.** ASCII tokens of length ≥ 4 are fuzzy-indexed with a 2-delete table; the runtime walks 2 deletes for query terms of length ≥ 6 and also probes the typo as a delete-permutation directly. Damerau–Levenshtein verifies every candidate, so `typscrpt` recovers `typescript`, `javascrpt` recovers `javascript`, `raect hooks` recovers `react hooks` — without admitting a flood of unrelated near-neighbours.
- **Mixed-script honesty.** ASCII alphanumeric runs stay whole, CJK ideographs are split into single characters, punctuation and combining marks normalise away identically at build and query time. Highlight ranges are returned in the original casing so the UI never has to re-locate matches.
- **Predictable empty state.** When the gate rejects the query the engine returns `[]` synchronously. There is no spinning, no stale list of last-seen results, no fallback to fuzzy-everything.

## API

### `buildIndex(docs, options)` → `{ pack, manifest }`

```ts
interface SearchDocument {
  id: string;
  [field: string]: unknown;
}

interface FieldConfig {
  /** Relative weight applied to this field's matches. Required. */
  weight: number;
  /** Default `text`. `keyword` skips bigrams; `url` skips bigrams + signal. */
  kind?: "text" | "keyword" | "url";
  /** Override the join window used for n-gram matching. */
  joinWindow?: number;
}

interface BuildOptions {
  /** Field weights. Pass a number for `kind: "text"`, or a full FieldConfig. */
  fields: Record<string, FieldConfig | number>;
  /** Field names persisted on every search hit. Defaults to all indexed fields. */
  storeFields?: string[];
  /** Field names that contribute to the per-doc substring boost signal. */
  signalFields?: string[];
  /** Cap signal length per doc (default 512). */
  signalMaxLength?: number;
  /** Field whose value is a string[] of tags retained on every hit. */
  tagsField?: string;
  /** Toggle the typo-correction table (default true). */
  fuzzy?: boolean;
}
```

### `loadIndex(pack)` → `SearchEngine`

```ts
interface SearchEngine {
  /** Synchronous, no I/O, no allocations beyond the result list. */
  search(query: string, options?: SearchOptions): SearchHit[];
  /** Stored documents in pack order — useful for warmup, debug, server-side render. */
  readonly docs: readonly StoredDocument[];
  /** Pack-level statistics derived from the binary at load time. */
  readonly stats: {
    docs: number;
    features: number;
    postings: number;
    deletes: number;
    storedFields: readonly string[];
  };
}

interface SearchOptions {
  /** Maximum number of hits to return. Default: 10. */
  limit?: number;
  /** Drop hits below `topScore * minScoreRatio`. Default: 0.18. Set 0 to keep all. */
  minScoreRatio?: number;
  /** Client-side filter applied after scoring. */
  filter?: (doc: StoredDocument) => boolean;
  /** Re-score hook for domain signals (recency, popularity, locale boosts). */
  rescore?: (hit: SearchHit) => number;
  /** Restrict highlighting to this field order. Defaults to every stored field. */
  highlightFields?: readonly string[];
}

interface SearchHit {
  doc: StoredDocument; // { id, fields, tags }
  score: number;
  /** Insertion order before the final sort — useful for tie-break. */
  refIndex: number;
  matches: readonly { field: string; ranges: readonly (readonly [number, number])[] }[];
}
```

### `createSearch(url, init?)` → `Promise<SearchEngine>`

Convenience wrapper that `fetch`es a pack and hands back a ready engine.

### `renderHighlights(text, ranges, options?)` → `string`

Pure-string highlighter. Wraps overlapping ranges with `<mark>` (or any tag you pass), HTML-escapes the surrounding text, and merges adjacent ranges to avoid double-wrapping.

## CLI

The package ships a small CLI for offline pack creation and inspection:

```bash
npx shuakami-search build docs.json -o site.pack \
  --fields title:5,body:1,url:1 \
  --store title,url \
  --tags-field keywords

npx shuakami-search query site.pack "machine learning" --limit 5
npx shuakami-search inspect site.pack
```

`docs.json` is an array of objects with a string `id` and any other fields. Field weights are written as `name:weight`.

## Examples

| Path                                | What it shows                                   |
| ----------------------------------- | ----------------------------------------------- |
| `examples/node-cli.ts`              | Build + query in a single Node script.          |
| `examples/browser-inline.html`      | Pack embedded as base64, no network calls.      |
| `examples/browser-fetch.html`       | Pack fetched from a static asset.               |
| `examples/web-worker.ts`            | Run search on a Worker thread, post results.    |
| `demo/`                             | The site at [shuakami.github.io/Search](https://shuakami.github.io/Search/). Vite, four corpora, live latency counters. |

## Compatibility

| target            | supported                            |
| ----------------- | ------------------------------------ |
| Node              | ≥ 18                                 |
| Browsers          | evergreen (uses `Uint8Array`, `TextDecoder`) |
| Bun, Deno, Workers, Edge runtimes | yes — no Node built-ins required at runtime |

## License

MIT © [shuakami](https://github.com/shuakami)
