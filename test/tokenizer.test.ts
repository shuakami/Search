import { describe, expect, it } from "vitest";
import {
  asciiJoin,
  bigramOverlap,
  compactJoin,
  damerauLevenshtein,
  generateDeletes,
  grams,
  isAsciiToken,
  normalizeText,
  tokenize,
} from "../src/tokenizer";

describe("normalizeText", () => {
  it("lowercases and strips combining marks", () => {
    expect(normalizeText("Café Naïve")).toBe("cafe naive");
  });
  it("collapses dash and underscore runs to a single space", () => {
    expect(normalizeText("hello___world--foo")).toBe("hello world foo");
  });
  it("keeps CJK characters", () => {
    expect(normalizeText("Hello 世界")).toBe("hello 世界");
  });
  it("returns empty string for null / undefined", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });
});

describe("tokenize", () => {
  it("splits ASCII runs and CJK characters", () => {
    expect(tokenize("hello 世界 foo123")).toEqual(["hello", "世", "界", "foo123"]);
  });
  it("collapses punctuation as separators", () => {
    expect(tokenize("path/to/file.txt")).toEqual(["path", "to", "file", "txt"]);
  });
  it("treats non-CJK / non-ASCII letters as separate tokens", () => {
    expect(tokenize("naïve résumé")).toEqual(["naive", "resume"]);
  });
});

describe("asciiJoin / compactJoin", () => {
  it("asciiJoin concatenates ASCII runs only", () => {
    expect(asciiJoin("ssl check 微博")).toBe("sslcheck");
  });
  it("compactJoin concatenates everything", () => {
    expect(compactJoin("ssl check 微博")).toBe("sslcheck微博");
  });
});

describe("isAsciiToken", () => {
  it("returns true only for [a-z0-9]+", () => {
    expect(isAsciiToken("hello")).toBe(true);
    expect(isAsciiToken("foo123")).toBe(true);
    expect(isAsciiToken("世界")).toBe(false);
    expect(isAsciiToken("")).toBe(false);
  });
});

describe("grams", () => {
  it("emits inclusive bigrams and trigrams", () => {
    expect(grams("abcd", 2, 2)).toEqual(["ab", "bc", "cd"]);
    expect(grams("abcd", 2, 3)).toEqual([
      "ab",
      "bc",
      "cd",
      "abc",
      "bcd",
    ]);
  });
});

describe("damerauLevenshtein", () => {
  it("counts substitutions", () => {
    expect(damerauLevenshtein("kitten", "sitten", 5)).toBe(1);
  });
  it("counts adjacent transpositions as 1 edit", () => {
    expect(damerauLevenshtein("ab", "ba", 5)).toBe(1);
    expect(damerauLevenshtein("hello", "hlelo", 5)).toBe(1);
  });
  it("returns maxDistance + 1 when over budget", () => {
    expect(damerauLevenshtein("abc", "xyz", 1)).toBe(2);
  });
  it("equal strings → 0", () => {
    expect(damerauLevenshtein("same", "same", 5)).toBe(0);
  });
});

describe("generateDeletes", () => {
  it("generates 1-edit deletes by default", () => {
    expect(new Set(generateDeletes("cat", 1))).toEqual(
      new Set(["at", "ct", "ca"]),
    );
  });
  it("generates up to 2-edit deletes when asked", () => {
    const result = new Set(generateDeletes("dog", 2));
    expect(result.has("og")).toBe(true);
    expect(result.has("g")).toBe(true);
    expect(result.has("o")).toBe(true);
  });
  it("never returns the original term", () => {
    expect(generateDeletes("foo", 1).includes("foo")).toBe(false);
  });
});

describe("bigramOverlap", () => {
  it("returns 1 for identical strings", () => {
    expect(bigramOverlap("hello", "hello")).toBe(1);
  });
  it("returns 0 for disjoint short strings", () => {
    expect(bigramOverlap("ab", "cd")).toBe(0);
  });
  it("falls between 0 and 1 for partial overlap", () => {
    const overlap = bigramOverlap("hello", "yellow");
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });
});
