import { describe, expect, it } from "vitest";
import { renderHighlights } from "../src/highlight";

describe("renderHighlights", () => {
  it("wraps a single range", () => {
    expect(renderHighlights("hello world", [[0, 4]])).toBe(
      "<mark>hello</mark> world",
    );
  });
  it("wraps multiple non-overlapping ranges", () => {
    expect(renderHighlights("the quick brown fox", [[4, 8], [16, 18]])).toBe(
      "the <mark>quick</mark> brown <mark>fox</mark>",
    );
  });
  it("merges overlapping ranges", () => {
    expect(renderHighlights("abcdef", [[0, 2], [1, 4]])).toBe(
      "<mark>abcde</mark>f",
    );
  });
  it("escapes HTML in source text", () => {
    expect(renderHighlights("<script>", [[1, 6]])).toBe(
      "&lt;<mark>script</mark>&gt;",
    );
  });
  it("respects custom tag and className", () => {
    expect(
      renderHighlights("hello", [[0, 4]], { tag: "em", className: "hl" }),
    ).toBe(`<em class="hl">hello</em>`);
  });
});
