/**
 * Service Worker integration template for `shuakami-search`.
 *
 * Pattern: install-time pack precache + offline-capable in-page search.
 *
 * The Service Worker:
 *   - Caches `docs.pack` during the `install` phase so first paint is hot.
 *   - Loads the pack into a `SearchEngine` once on `activate` (or first
 *     `message`).
 *   - Listens on `MessageEvent` for `{ type: 'search', q }` /
 *     `{ type: 'suggest', q }` from any page client and replies with hits.
 *
 * The page side then talks to it through `navigator.serviceWorker.controller`
 * — no fetches, no JSON parsing on the hot path; you ship a Uint8Array of
 * hits over `postMessage` (structured-clone friendly).
 *
 * Why this matters:
 *   - Search keeps working offline (the pack is cached).
 *   - The engine is shared across tabs of the same origin, so a 100 KB pack
 *     is only paid for once per origin install.
 *   - Cold start is ~1 ms because `loadIndex` is synchronous and zero-copy.
 */

import {
  loadIndex,
  type DetailedSearchResult,
  type SearchEngine,
} from "shuakami-search";

declare const self: ServiceWorkerGlobalScope;

const PACK_URL = "/docs.pack";
const CACHE_NAME = "shuakami-search-v1";

let enginePromise: Promise<SearchEngine> | null = null;

function getEngine(): Promise<SearchEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const cache = await caches.open(CACHE_NAME);
      let response = await cache.match(PACK_URL);
      if (!response) {
        response = await fetch(PACK_URL);
        cache.put(PACK_URL, response.clone()).catch(() => {
          /* swallow — caching is best-effort */
        });
      }
      const buffer = await response.arrayBuffer();
      return loadIndex(new Uint8Array(buffer));
    })();
  }
  return enginePromise;
}

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Pre-warm: download + persist the pack so the next page load is fast.
      await cache.add(PACK_URL).catch(() => {
        /* swallow — first install may run before the pack is uploaded */
      });
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      // Drop any stale caches from previous releases.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

interface SearchMessage {
  type: "search" | "suggest";
  id: number;
  q: string;
  limit?: number;
}

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as SearchMessage | undefined;
  if (!data || (data.type !== "search" && data.type !== "suggest")) return;

  event.waitUntil(
    (async () => {
      const engine = await getEngine();
      let payload: unknown;
      if (data.type === "search") {
        const detail: DetailedSearchResult = engine.searchDetailed(data.q, {
          limit: data.limit ?? 10,
        });
        payload = {
          type: "search:result",
          id: data.id,
          hits: detail.hits,
          correctedQuery: detail.correctedQuery,
        };
      } else {
        payload = {
          type: "suggest:result",
          id: data.id,
          suggestions: engine.suggest(data.q, { limit: data.limit ?? 8 }),
        };
      }
      // Reply on the same MessageChannel if one was opened, otherwise fall
      // back to broadcasting to the source client.
      if (event.ports[0]) {
        event.ports[0].postMessage(payload);
      } else if (event.source) {
        (event.source as Client).postMessage(payload);
      }
    })(),
  );
});

/**
 * Page-side companion (paste into your app):
 *
 *   navigator.serviceWorker.register('/sw.js');
 *
 *   async function search(q) {
 *     const channel = new MessageChannel();
 *     return new Promise((resolve) => {
 *       channel.port1.onmessage = (e) => resolve(e.data);
 *       navigator.serviceWorker.controller.postMessage(
 *         { type: 'search', id: 1, q },
 *         [channel.port2],
 *       );
 *     });
 *   }
 */
