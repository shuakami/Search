# Integration templates

Drop-in starting points for the most common deployment surfaces. Each file is
a single TypeScript module with the bindings, message protocol, and inline
deploy notes you need.

| File | What it does |
| --- | --- |
| `react-app.tsx` | React hooks (`useSearch`, `useSuggest`, `<Highlight />`) wiring search + autocomplete + did-you-mean into a small component. |
| `cloudflare-workers.ts` | Edge-deployed worker that loads a pack from KV (or a static asset) and serves `/search?q=…` and `/suggest?q=…`. Cold start ~1 ms, warm requests run inside the V8 isolate. |
| `service-worker.ts` | Offline-capable in-page search. Caches the pack on `install`, loads it once on first message, replies to any tab on the origin via `postMessage`. |

Each template is plain TypeScript — no framework-specific bundler, no `vite`
plugin, no extra runtime. They're designed to copy-paste into existing
projects rather than to be cloned wholesale.

## Common pieces

All templates share the same input: a `Uint8Array` produced by
`buildIndex()` (or the `shuakami-search build` CLI). You can ship that pack
through:

- Static asset CDN (recommended for ≤1 MB packs).
- KV / Object storage (Cloudflare Workers, R2, S3).
- Service-worker-managed `Cache` (offline-first PWAs).
- Inlined as base64 (no infra; only sane for tiny corpora).

The runtime itself is dependency-free and synchronous, so any of the above
loads at memory speed once the bytes have arrived.
