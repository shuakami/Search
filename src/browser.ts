/**
 * One-line browser bootstrap. Fetches a precompiled pack and returns a ready
 * `SearchEngine`. Designed for static-asset deployments (Netlify, Cloudflare
 * Pages, GitHub Pages, S3, etc.) where the pack is shipped alongside the page.
 */

import { loadIndex, type SearchEngine } from "./runtime";

export interface CreateSearchOptions {
  /**
   * Optional `fetch` override (e.g. for SSR or for tests). Defaults to global
   * `fetch`.
   */
  fetch?: typeof globalThis.fetch;
  /** Standard `RequestInit` forwarded to `fetch`. */
  init?: RequestInit;
}

/**
 * Fetch a binary pack from a URL and load it into a search engine.
 *
 * @example
 *   const engine = await createSearch("/search-pack.bin");
 *   const hits = engine.search("hello world", { limit: 10 });
 */
export async function createSearch(
  url: string,
  options: CreateSearchOptions = {},
): Promise<SearchEngine> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error(
      "createSearch: no fetch implementation available. Pass `options.fetch`.",
    );
  }
  const response = await fetcher(url, options.init);
  if (!response.ok) {
    throw new Error(
      `createSearch: GET ${url} returned ${response.status} ${response.statusText}`,
    );
  }
  const buffer = await response.arrayBuffer();
  return loadIndex(new Uint8Array(buffer));
}
