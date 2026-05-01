/**
 * React integration example for `@shuakami/search`.
 *
 * Demonstrates the three hooks shipped under `@shuakami/search/react`:
 *   - `useSearch(pack, query)` — debounced search with `correctedQuery`
 *   - `useSuggest(pack, prefix)` — autocomplete
 *   - `<Highlight />` — render highlighted spans without
 *     `dangerouslySetInnerHTML`
 *
 * The pack is fetched once on mount and stays in component state for the
 * lifetime of the page. No global store, no provider, no context — the
 * hooks own their memoisation internally.
 */

import { useEffect, useState } from "react";
import {
  Highlight,
  useSearch,
  useSuggest,
} from "@shuakami/search/react";

function usePack(url: string): Uint8Array | null {
  const [pack, setPack] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        if (!cancelled) setPack(new Uint8Array(buf));
      })
      .catch((err) => console.error("[search] failed to load pack:", err));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return pack;
}

export function SearchBox(): JSX.Element {
  const pack = usePack("/docs.pack");
  const [query, setQuery] = useState("");

  // The whole search runs synchronously inside a debounced effect — typing
  // stays smooth even on slow devices because we never block on layout.
  const { hits, correctedQuery, pending } = useSearch(pack, query, {
    limit: 12,
    debounceMs: 80,
  });

  // Live autocomplete: independent of `useSearch`, runs at every keystroke
  // (30 ms debounce). Uses the same pack — no extra memory.
  const { suggestions } = useSuggest(pack, query, { limit: 6 });

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search…"
        autoFocus
        style={{
          width: "100%",
          padding: 12,
          fontSize: 16,
          border: "1px solid #ddd",
          borderRadius: 8,
        }}
      />

      {suggestions.length > 0 && query && (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
          {suggestions.map((suggestion) => (
            <li key={suggestion.term}>
              <button
                type="button"
                onClick={() => setQuery(suggestion.term)}
                style={{
                  background: "none",
                  border: 0,
                  padding: "4px 0",
                  cursor: "pointer",
                  color: "#444",
                }}
              >
                {suggestion.term}
                <span style={{ opacity: 0.5, marginLeft: 6 }}>
                  · {suggestion.docFrequency}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {correctedQuery && correctedQuery !== query && (
        <p style={{ color: "#555" }}>
          did you mean{" "}
          <button
            type="button"
            onClick={() => setQuery(correctedQuery)}
            style={{
              background: "none",
              border: 0,
              fontStyle: "italic",
              borderBottom: "1px solid #ccc",
              cursor: "pointer",
            }}
          >
            {correctedQuery}
          </button>
          ?
        </p>
      )}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {hits.map((hit) => {
          const titleMatches = hit.matches.find((m) => m.field === "title");
          return (
            <li key={hit.doc.id} style={{ padding: "12px 0" }}>
              <Highlight
                text={hit.doc.fields.title ?? hit.doc.id}
                ranges={titleMatches?.ranges ?? []}
                highlightClassName="hit"
              />
            </li>
          );
        })}
      </ul>

      {pending && <p style={{ opacity: 0.5 }}>searching…</p>}
    </div>
  );
}

/**
 * styles.css companion:
 *
 *   .hit {
 *     background: rgba(255, 230, 0, 0.45);
 *     padding: 0 1px;
 *   }
 */
