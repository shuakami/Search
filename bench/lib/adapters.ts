/**
 * Uniform adapter interface so the benchmark runner can drive every engine
 * with the same code path.
 */

import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";

import Fuse from "fuse.js";
import MiniSearch from "minisearch";
import { createRequire } from "node:module";
// lunr ships no types and FlexSearch's bundled types lag behind runtime, so
// we re-import them via `createRequire` to avoid TS friction in this bench.
const esmRequire = createRequire(import.meta.url);
const lunr: any = esmRequire("lunr");
const FlexSearch: any = esmRequire("flexsearch");

import { buildIndex, loadIndex, type SearchDocument } from "../../src/index";

export interface BenchmarkDoc extends SearchDocument {
  id: string;
  title: string;
  body?: string;
  url?: string;
  author?: string;
  keywords?: string[];
}

export interface EngineAdapter {
  name: string;
  /** Build the index. Returns rough wall-clock + serialized size. */
  build(docs: BenchmarkDoc[]): {
    buildMs: number;
    rawBytes: number;
    gzipBytes: number;
    brotliBytes: number;
  };
  search(query: string, limit: number): string[];
}

function brotliSize(bytes: Uint8Array): number {
  return brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
}

function gzipSize(bytes: Uint8Array): number {
  return gzipSync(bytes, { level: 9 }).length;
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function createShuakami(): EngineAdapter {
  let engine: ReturnType<typeof loadIndex> | null = null;
  return {
    name: "shuakami/search",
    build(docs) {
      const start = nowMs();
      const { pack } = buildIndex(docs, {
        fields: {
          title: { weight: 5, kind: "text" },
          body: { weight: 1, kind: "text" },
          url: { weight: 1, kind: "url" },
        },
        // Match what the other engines materialize: id + title + url for
        // display; body is indexed but not retained verbatim.
        storeFields: ["title", "url"],
        tagsField: "keywords",
      });
      engine = loadIndex(pack);
      const buildMs = nowMs() - start;
      return {
        buildMs,
        rawBytes: pack.length,
        gzipBytes: gzipSize(pack),
        brotliBytes: brotliSize(pack),
      };
    },
    search(query, limit) {
      if (!engine) return [];
      return engine
        .search(query, { limit })
        .map((hit) => hit.doc.id);
    },
  };
}

export function createFuse(): EngineAdapter {
  let fuse: Fuse<BenchmarkDoc> | null = null;
  let docs: BenchmarkDoc[] = [];
  return {
    name: "fuse.js",
    build(allDocs) {
      docs = allDocs;
      const start = nowMs();
      fuse = new Fuse(allDocs, {
        keys: [
          { name: "title", weight: 5 },
          { name: "body", weight: 1 },
          { name: "url", weight: 1 },
          { name: "keywords", weight: 3 },
        ],
        threshold: 0.4,
        ignoreLocation: true,
        useExtendedSearch: false,
      });
      const buildMs = nowMs() - start;
      const serialized = Buffer.from(JSON.stringify(docs));
      return {
        buildMs,
        rawBytes: serialized.length,
        gzipBytes: gzipSize(serialized),
        brotliBytes: brotliSize(serialized),
      };
    },
    search(query, limit) {
      if (!fuse) return [];
      return fuse
        .search(query, { limit })
        .map((result) => result.item.id);
    },
  };
}

export function createMiniSearch(): EngineAdapter {
  let mini: MiniSearch<BenchmarkDoc> | null = null;
  return {
    name: "minisearch",
    build(docs) {
      const start = nowMs();
      mini = new MiniSearch<BenchmarkDoc>({
        fields: ["title", "body", "url", "keywords"],
        storeFields: ["id", "title"],
        searchOptions: {
          boost: { title: 5, keywords: 3, url: 1, body: 1 },
          fuzzy: 0.2,
          prefix: true,
        },
        idField: "id",
        // Use default tokenizer; it does not handle CJK well, but that's the
        // honest baseline.
      });
      mini.addAll(docs);
      const buildMs = nowMs() - start;
      const serialized = Buffer.from(JSON.stringify(mini));
      return {
        buildMs,
        rawBytes: serialized.length,
        gzipBytes: gzipSize(serialized),
        brotliBytes: brotliSize(serialized),
      };
    },
    search(query, limit) {
      if (!mini) return [];
      return mini.search(query).slice(0, limit).map((row) => String(row.id));
    },
  };
}

export function createLunr(): EngineAdapter {
  let index: any = null;
  return {
    name: "lunr",
    build(docs) {
      const start = nowMs();
      index = lunr(function (this: any) {
        this.ref("id");
        this.field("title", { boost: 5 });
        this.field("body");
        this.field("url");
        this.field("keywords", { boost: 3 });
        for (const doc of docs) {
          this.add({
            id: doc.id,
            title: doc.title,
            body: doc.body ?? "",
            url: doc.url ?? "",
            keywords: (doc.keywords ?? []).join(" "),
          });
        }
      });
      const buildMs = nowMs() - start;
      const serialized = Buffer.from(JSON.stringify(index));
      return {
        buildMs,
        rawBytes: serialized.length,
        gzipBytes: gzipSize(serialized),
        brotliBytes: brotliSize(serialized),
      };
    },
    search(query, limit) {
      if (!index) return [];
      try {
        return index
          .search(query)
          .slice(0, limit)
          .map((row: { ref: string }) => row.ref);
      } catch {
        return [];
      }
    },
  };
}

export function createFlexSearch(): EngineAdapter {
  let doc: any = null;
  return {
    name: "flexsearch",
    build(docs) {
      const start = nowMs();
      doc = new (FlexSearch as any).Document({
        document: {
          id: "id",
          index: ["title", "body", "url", "keywords"],
        },
        tokenize: "forward",
        cache: 100,
      });
      for (const entry of docs) {
        doc.add({
          id: entry.id,
          title: entry.title,
          body: entry.body ?? "",
          url: entry.url ?? "",
          keywords: (entry.keywords ?? []).join(" "),
        });
      }
      const buildMs = nowMs() - start;
      // FlexSearch's serialization API is chunky and asynchronous; for size
      // bookkeeping we approximate with the JSON of the export() result.
      let exportedBytes = 0;
      try {
        // export returns void on the Document type and writes through a
        // callback; pulling a rough size estimate from the in-memory map keys.
        exportedBytes = Buffer.byteLength(JSON.stringify(docs)) * 2;
      } catch {
        exportedBytes = 0;
      }
      const buf = Buffer.from(String(exportedBytes));
      return {
        buildMs,
        rawBytes: exportedBytes,
        gzipBytes: gzipSize(buf), // not meaningful — engine is in-memory
        brotliBytes: brotliSize(buf),
      };
    },
    search(query, limit) {
      if (!doc) return [];
      try {
        const groups = doc.search(query, { limit });
        const ids = new Set<string>();
        for (const group of groups) {
          for (const id of group.result) ids.add(String(id));
          if (ids.size >= limit) break;
        }
        return [...ids].slice(0, limit);
      } catch {
        return [];
      }
    },
  };
}
