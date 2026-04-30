/**
 * shuakami/Search — public entry.
 *
 * The library is split into three small surfaces:
 *
 *   buildIndex(docs, options)        — produce a binary pack
 *   loadIndex(packBytes)             — open a pack, run queries
 *   createSearch(url)                — browser/Node bootstrap, fetch + load
 *
 * Everything else (tokenizer, varint, format constants, highlight helpers)
 * is exported under `@shuakami/search/internals` for advanced use.
 */

export { buildIndex } from "./builder";
export type {
  BuildOptions,
  BuildResult,
  BuildManifest,
  FieldConfig,
  FieldKind,
  SearchDocument,
} from "./builder";

export { loadIndex } from "./runtime";
export type {
  SearchEngine,
  SearchHit,
  SearchOptions,
  StoredDocument,
  FieldMatches,
  MatchRange,
} from "./runtime";

export { createSearch } from "./browser";
export type { CreateSearchOptions } from "./browser";

export { renderHighlights, renderHit } from "./highlight";
export type { RenderHighlightOptions } from "./highlight";

export {
  PACK_MAGIC,
  PACK_VERSION,
} from "./format";
