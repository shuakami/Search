/**
 * Cloudflare Workers integration template for `@shuakami/search`.
 *
 * Deploys a binary search pack at the edge: the pack is read from KV (or
 * baked-in static asset) on cold start, loaded into a `SearchEngine` once,
 * and reused across requests inside the isolate.
 *
 * Why it's fast on Workers:
 *   - The runtime has zero dependencies, no DOM, no Node built-ins, so it
 *     ships into the V8 isolate without polyfills.
 *   - `loadIndex()` is synchronous and zero-copy. After the first cold
 *     request the engine sits warm in module scope until eviction.
 *   - All serving paths (search, suggest, did-you-mean) execute in
 *     microseconds — no fetches, no I/O, no async overhead.
 *
 * Deploy steps:
 *   1. Build a pack: `npx shuakami-search build docs.json -o docs.pack`
 *   2. Upload the pack:
 *        - KV:  `wrangler kv:key put --binding=PACK_KV docs ./docs.pack`
 *        - asset: place under your `assets` dir if your project uses
 *          Workers Sites / `assets` binding.
 *   3. Bind it in `wrangler.toml`:
 *        kv_namespaces = [{ binding = "PACK_KV", id = "..." }]
 *   4. Deploy: `wrangler deploy`.
 */

import { loadIndex, type SearchEngine } from "@shuakami/search";

interface Env {
  PACK_KV?: KVNamespace;
  /**
   * If you bundle the pack as a static asset instead of KV, expose its raw
   * bytes through `ASSETS` and have the worker fetch from `ASSETS.get`.
   */
  ASSETS?: Fetcher;
}

let engine: SearchEngine | null = null;
let loadedAt = 0;

async function getEngine(env: Env): Promise<SearchEngine> {
  if (engine) return engine;

  let pack: Uint8Array;
  if (env.PACK_KV) {
    const buffer = await env.PACK_KV.get("docs", { type: "arrayBuffer" });
    if (!buffer) throw new Error("pack 'docs' missing in PACK_KV");
    pack = new Uint8Array(buffer);
  } else if (env.ASSETS) {
    const res = await env.ASSETS.fetch("https://assets.local/docs.pack");
    if (!res.ok) throw new Error(`assets fetch ${res.status}`);
    pack = new Uint8Array(await res.arrayBuffer());
  } else {
    throw new Error("no PACK_KV or ASSETS binding configured");
  }

  engine = loadIndex(pack);
  loadedAt = Date.now();
  return engine;
}

interface JsonResponseBody {
  hits?: ReturnType<SearchEngine["search"]>;
  suggestions?: ReturnType<SearchEngine["suggest"]>;
  correctedQuery?: string | null;
  cacheStatus?: "hit" | "miss";
  loadedAt?: number;
}

function json(body: JsonResponseBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=10",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cacheStatus: "hit" | "miss" = engine ? "hit" : "miss";
    const eng = await getEngine(env);

    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const detail = eng.searchDetailed(q, { limit });
      return json({
        hits: detail.hits,
        correctedQuery: detail.correctedQuery,
        cacheStatus,
        loadedAt,
      });
    }

    if (url.pathname === "/suggest") {
      const prefix = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 8);
      const suggestions = eng.suggest(prefix, { limit });
      return json({ suggestions, cacheStatus, loadedAt });
    }

    return new Response(
      "shuakami/search worker — try /search?q=… or /suggest?q=…",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};

/**
 * Minimal `wrangler.toml` for this worker:
 *
 * name = "search-edge"
 * main = "examples/cloudflare-workers.ts"
 * compatibility_date = "2025-01-01"
 *
 * [[kv_namespaces]]
 * binding = "PACK_KV"
 * id = "your-kv-namespace-id"
 */
