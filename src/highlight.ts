/**
 * Render a stored field with `<mark>...</mark>` (or any tag) wrapped around
 * the highlight ranges produced by `engine.search()`.
 *
 * Works on every JS runtime — no DOM dependency, no React, just strings.
 */

import type { FieldMatches, MatchRange } from "./runtime";

export interface RenderHighlightOptions {
  /** Tag name. Default: `mark`. */
  tag?: string;
  /** Optional className to put on the tag. */
  className?: string;
  /** Override the open/close strings entirely (className/tag are ignored). */
  open?: string;
  close?: string;
}

/**
 * Wrap each match range in `text` with the configured tag. Ranges are
 * `[start, end]` inclusive on both ends, matching what the engine returns.
 *
 * The result is a simple HTML string. The function escapes `< > & " '` in the
 * source text so it is safe to embed without further sanitization.
 */
export function renderHighlights(
  text: string,
  ranges: readonly MatchRange[],
  options: RenderHighlightOptions = {},
): string {
  if (!text) return "";
  const open =
    options.open ??
    `<${options.tag ?? "mark"}${options.className ? ` class="${options.className}"` : ""}>`;
  const close = options.close ?? `</${options.tag ?? "mark"}>`;

  if (ranges.length === 0) return escape(text);

  // Merge overlapping or adjacent ranges so we don't emit two adjacent
  // <mark>...</mark>...<mark>...</mark> spans for the same matched substring.
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let index = 1; index < sorted.length; index += 1) {
    const [start, end] = sorted[index];
    const last = merged[merged.length - 1];
    if (start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  let cursor = 0;
  let out = "";
  for (const [start, end] of merged) {
    if (end < cursor) continue;
    const safeStart = Math.max(start, cursor);
    if (safeStart > cursor) {
      out += escape(text.slice(cursor, safeStart));
    }
    out += open + escape(text.slice(safeStart, end + 1)) + close;
    cursor = end + 1;
  }
  if (cursor < text.length) {
    out += escape(text.slice(cursor));
  }
  return out;
}

/** Convenience: render the first matched field, or fall back to a slice. */
export function renderHit(
  fields: Readonly<Record<string, string>>,
  matches: readonly FieldMatches[],
  fallbackField: string,
  options: RenderHighlightOptions = {},
): string {
  const match = matches[0];
  if (match) {
    return renderHighlights(
      fields[match.field] ?? "",
      match.ranges,
      options,
    );
  }
  return escape(fields[fallbackField] ?? "");
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
