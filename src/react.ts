/**
 * React bindings for `shuakami-search`.
 *
 * These hooks are intentionally minimal: they own no global state, do no
 * fetching themselves, and never throw on the render path. You build (or
 * fetch) a `pack: Uint8Array` once, hand it to `useSearch`, and the hook
 * memoises the engine + keeps a stable reference between renders.
 *
 * The bindings are tree-shakeable — apps that import `shuakami-search`
 * without touching `/react` never pull React in.
 *
 * NOTE: `react` is declared as a peer dependency. If you use these helpers,
 * make sure your project has React 17+ installed.
 */

import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  loadIndex,
  type DetailedSearchResult,
  type FieldMatches,
  type MatchRange,
  type SearchEngine,
  type SearchHit,
  type SearchOptions,
  type SuggestHit,
  type SuggestOptions,
} from "./runtime";

/* -------------------------------------------------------------------------- */
/*  useSearchEngine — load a pack into a memoised SearchEngine                */
/* -------------------------------------------------------------------------- */

/**
 * Loads a `Uint8Array | ArrayBuffer` pack into a `SearchEngine` and memoises
 * it. The engine is rebuilt only when `pack` changes by reference.
 *
 * Returns `null` until the pack is non-null, so consumers can always treat
 * the return value as the source of truth.
 */
export function useSearchEngine(
  pack: Uint8Array | ArrayBuffer | null | undefined,
): SearchEngine | null {
  return useMemo(() => {
    if (!pack) return null;
    return loadIndex(pack);
  }, [pack]);
}

/* -------------------------------------------------------------------------- */
/*  useSearch — debounced query against a pack                                */
/* -------------------------------------------------------------------------- */

export interface UseSearchOptions extends SearchOptions {
  /**
   * Debounce window in milliseconds. Default: 80 (matches the demo's UX).
   * Set to 0 to run on every keystroke synchronously.
   */
  debounceMs?: number;
}

export interface UseSearchResult {
  /** Top-K hits for the most-recently-applied query. */
  hits: SearchHit[];
  /** "did you mean" rewrite, or `null` when no fuzzy correction was used. */
  correctedQuery: string | null;
  /** True while a debounced query is pending. */
  pending: boolean;
  /** The trimmed query that produced `hits` (may differ from the live input). */
  appliedQuery: string;
}

/**
 * Run a query against a `pack`. The hook owns:
 *   - lazy `loadIndex(pack)` (memoised)
 *   - debounce timer (cleared on unmount + on rapid input)
 *   - "applied query" so consumers can render against the latest *settled*
 *     state without flickering during typing.
 *
 * Errors during `loadIndex()` propagate synchronously — that's a bad pack and
 * should fail loudly, not silently return zero hits.
 */
export function useSearch(
  pack: Uint8Array | ArrayBuffer | null | undefined,
  query: string,
  options: UseSearchOptions = {},
): UseSearchResult {
  const engine = useSearchEngine(pack);
  const { debounceMs = 80, ...searchOptions } = options;

  // Stash the latest options inside a ref so the effect can read them without
  // re-firing every time the consumer re-creates an inline object literal.
  const optionsRef = useRef(searchOptions);
  optionsRef.current = searchOptions;

  const [state, setState] = useState<{
    hits: SearchHit[];
    correctedQuery: string | null;
    appliedQuery: string;
  }>({ hits: [], correctedQuery: null, appliedQuery: "" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!engine) {
      setState({ hits: [], correctedQuery: null, appliedQuery: "" });
      setPending(false);
      return;
    }

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setState({ hits: [], correctedQuery: null, appliedQuery: trimmed });
      setPending(false);
      return;
    }

    setPending(true);

    function run() {
      // engine cannot be null here — we returned above when it was — but the
      // closure captures it as `SearchEngine | null` because of the outer
      // narrowing scope, so re-narrow inside the timer.
      if (!engine) return;
      const result: DetailedSearchResult = engine.searchDetailed(
        trimmed,
        optionsRef.current,
      );
      setState({
        hits: result.hits,
        correctedQuery: result.correctedQuery,
        appliedQuery: trimmed,
      });
      setPending(false);
    }

    if (debounceMs <= 0) {
      run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
    return () => clearTimeout(timer);
  }, [engine, query, debounceMs]);

  return {
    hits: state.hits,
    correctedQuery: state.correctedQuery,
    pending,
    appliedQuery: state.appliedQuery,
  };
}

/* -------------------------------------------------------------------------- */
/*  useSuggest — autocomplete                                                 */
/* -------------------------------------------------------------------------- */

export interface UseSuggestOptions extends SuggestOptions {
  /** Debounce window in milliseconds. Default: 30. */
  debounceMs?: number;
}

export interface UseSuggestResult {
  /** Up to `limit` suggestions for the current prefix. */
  suggestions: SuggestHit[];
  /** True while a debounced suggest call is pending. */
  pending: boolean;
}

/**
 * Autocomplete companion to `useSearch`. Returns up to `limit` indexed terms
 * that begin with `prefix`, ranked by document frequency (with optional
 * fuzzy fallback when no prefix matches).
 */
export function useSuggest(
  pack: Uint8Array | ArrayBuffer | null | undefined,
  prefix: string,
  options: UseSuggestOptions = {},
): UseSuggestResult {
  const engine = useSearchEngine(pack);
  const { debounceMs = 30, ...suggestOptions } = options;
  const optionsRef = useRef(suggestOptions);
  optionsRef.current = suggestOptions;

  const [suggestions, setSuggestions] = useState<SuggestHit[]>([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!engine) {
      setSuggestions([]);
      setPending(false);
      return;
    }
    const trimmed = prefix.trim();
    if (trimmed.length < 1) {
      setSuggestions([]);
      setPending(false);
      return;
    }

    setPending(true);
    function run() {
      if (!engine) return;
      const hits = engine.suggest(trimmed, optionsRef.current);
      setSuggestions(hits);
      setPending(false);
    }
    if (debounceMs <= 0) {
      run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
    return () => clearTimeout(timer);
  }, [engine, prefix, debounceMs]);

  return { suggestions, pending };
}

/* -------------------------------------------------------------------------- */
/*  <Highlight /> — render highlighted spans without dangerouslySetInnerHTML  */
/* -------------------------------------------------------------------------- */

export interface HighlightProps {
  /** The full text from the stored field. */
  text: string;
  /**
   * Match ranges to highlight. You can pass either the raw `MatchRange[]`
   * (e.g. `hit.matches[0].ranges`) or the whole `FieldMatches` object — the
   * component accepts both for ergonomic reasons.
   */
  ranges: readonly MatchRange[] | FieldMatches;
  /** Tag for the wrapper. Default: `'span'`. */
  as?: keyof HTMLElementTagNameMap;
  /** Tag used for the highlighted segments. Default: `'mark'`. */
  highlightAs?: keyof HTMLElementTagNameMap;
  className?: string;
  highlightClassName?: string;
}

/**
 * Splits `text` on the engine's match ranges and renders highlighted segments
 * as React elements — no `dangerouslySetInnerHTML`, no parsing, no XSS risk.
 *
 * Overlapping or out-of-order ranges are normalised before rendering, so
 * passing the engine's output directly always produces valid markup.
 */
export function Highlight(props: HighlightProps): ReactElement {
  const {
    text,
    ranges,
    as = "span",
    highlightAs = "mark",
    className,
    highlightClassName,
  } = props;

  const safeRanges: readonly MatchRange[] = Array.isArray(ranges)
    ? (ranges as readonly MatchRange[])
    : (ranges as FieldMatches).ranges ?? [];

  const segments = useMemo(() => {
    if (safeRanges.length === 0) return [{ text, highlighted: false }];
    const sorted = [...safeRanges]
      .map(([start, end]) => [
        Math.max(0, start),
        Math.min(text.length - 1, end),
      ])
      .filter(([start, end]) => end >= start)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    // Merge overlapping / adjacent ranges so we never emit a `<mark>` inside a
    // `<mark>`.
    const merged: [number, number][] = [];
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1] + 1) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }

    const out: { text: string; highlighted: boolean }[] = [];
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) {
        out.push({ text: text.slice(cursor, start), highlighted: false });
      }
      out.push({ text: text.slice(start, end + 1), highlighted: true });
      cursor = end + 1;
    }
    if (cursor < text.length) {
      out.push({ text: text.slice(cursor), highlighted: false });
    }
    return out;
  }, [text, safeRanges]);

  const children = segments.map((segment, index) =>
    segment.highlighted
      ? createElement(
          highlightAs,
          { key: index, className: highlightClassName },
          segment.text,
        )
      : createElement("span", { key: index }, segment.text),
  );

  return createElement(as, { className }, ...children);
}

/* -------------------------------------------------------------------------- */
/*  Re-exports                                                                */
/* -------------------------------------------------------------------------- */

export type {
  SearchEngine,
  SearchHit,
  SearchOptions,
  SuggestHit,
  SuggestOptions,
  DetailedSearchResult,
  FieldMatches,
  MatchRange,
} from "./runtime";
