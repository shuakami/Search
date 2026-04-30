/**
 * Use the search engine on a Web Worker so the UI thread never blocks during
 * long indexing or large queries.
 *
 * The host page can spin this Worker up with:
 *
 *   const worker = new Worker(new URL("./web-worker.ts", import.meta.url), {
 *     type: "module",
 *   });
 *   worker.postMessage({ kind: "build", docs, options });
 *   worker.postMessage({ kind: "search", query: "hello", limit: 10 });
 *   worker.onmessage = (event) => console.log(event.data);
 */

/// <reference lib="webworker" />

import {
  buildIndex,
  loadIndex,
  type BuildOptions,
  type SearchEngine,
  type SearchOptions,
  type SearchDocument,
} from "../src/index";

let engine: SearchEngine | null = null;

type IncomingMessage =
  | { kind: "build"; docs: SearchDocument[]; options: BuildOptions }
  | { kind: "load"; pack: ArrayBuffer }
  | { kind: "search"; query: string; options?: SearchOptions; nonce?: number };

self.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  switch (message.kind) {
    case "build": {
      const { pack } = buildIndex(message.docs, message.options);
      engine = loadIndex(pack);
      // Hand the pack back to the host so it can be cached, persisted, etc.
      const transferable = pack.buffer.slice(
        pack.byteOffset,
        pack.byteOffset + pack.byteLength,
      ) as ArrayBuffer;
      (self as unknown as Worker).postMessage(
        { kind: "ready", pack: transferable },
        [transferable],
      );
      break;
    }
    case "load": {
      engine = loadIndex(new Uint8Array(message.pack));
      (self as unknown as Worker).postMessage({ kind: "ready" });
      break;
    }
    case "search": {
      if (!engine) {
        (self as unknown as Worker).postMessage({
          kind: "error",
          nonce: message.nonce,
          error: "engine not initialised; send {kind:'build'|'load'} first",
        });
        return;
      }
      const hits = engine.search(message.query, message.options);
      (self as unknown as Worker).postMessage({
        kind: "results",
        nonce: message.nonce,
        hits,
      });
      break;
    }
  }
});
