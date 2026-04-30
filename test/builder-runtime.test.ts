import { describe, expect, it } from "vitest";
import { buildIndex, loadIndex, type SearchDocument } from "../src/index";

const DOCS: SearchDocument[] = [
  {
    id: "1",
    title: "Get current weather",
    body: "Returns temperature, humidity, wind speed for a given location.",
    url: "/api/weather",
    tags: ["weather", "misc"],
  },
  {
    id: "2",
    title: "Translate text",
    body: "Translate text between supported languages, supports Chinese-English.",
    url: "/api/translate",
    tags: ["nlp", "translation", "翻译"],
  },
  {
    id: "3",
    title: "Generate QR code",
    body: "Generate a 二维码 PNG for any URL or text payload.",
    url: "/api/qrcode",
    tags: ["qrcode", "二维码", "image"],
  },
  {
    id: "4",
    title: "SSL certificate check",
    body: "Inspect the SSL/TLS certificate chain for a host.",
    url: "/api/ssl-check",
    tags: ["ssl", "security"],
  },
  {
    id: "5",
    title: "微博 hot list",
    body: "Hourly snapshot of trending topics on weibo.",
    url: "/api/hotboard/weibo",
    tags: ["hotboard", "weibo", "微博"],
  },
];

describe("buildIndex / loadIndex", () => {
  it("round-trips stored fields and tags", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1, url: { weight: 1, kind: "url" } },
      tagsField: "tags",
    });
    const engine = loadIndex(pack);
    expect(engine.stats.docs).toBe(DOCS.length);
    expect(engine.stats.storedFields).toEqual(["title", "body", "url"]);

    const doc = engine.docs[0];
    expect(doc.id).toBe("1");
    expect(doc.fields.title).toBe("Get current weather");
    expect(doc.tags).toEqual(["weather", "misc"]);
  });

  it("matches single ASCII tokens", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1, url: { weight: 1, kind: "url" } },
    });
    const engine = loadIndex(pack);
    const hits = engine.search("weather");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.id).toBe("1");
  });

  it("matches CJK queries", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
      tagsField: "tags",
    });
    const engine = loadIndex(pack);
    expect(engine.search("翻译")[0]?.doc.id).toBe("2");
    expect(engine.search("二维码")[0]?.doc.id).toBe("3");
    expect(engine.search("微博")[0]?.doc.id).toBe("5");
  });

  it("matches multi-token ASCII signal queries (e.g. 'ssl check')", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1, url: { weight: 1, kind: "url" } },
    });
    const engine = loadIndex(pack);
    expect(engine.search("ssl check")[0]?.doc.id).toBe("4");
    expect(engine.search("sslcheck")[0]?.doc.id).toBe("4");
  });

  it("tolerates one-character typos via the fuzzy correction tables", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
    });
    const engine = loadIndex(pack);
    const hits = engine.search("waether"); // weather missing one letter
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.id).toBe("1");
  });

  it("respects --no-fuzzy by skipping the correction tables entirely", () => {
    const { manifest } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
      fuzzy: false,
    });
    expect(manifest.correctionDeletes).toBe(0);
  });

  it("with fuzzy enabled, a tag-driven typo recovers a strong score", () => {
    // tagsField produces single-token `s:` features that are exactly the
    // shape the fuzzy delete table is designed for.
    const { pack: packA } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
      tagsField: "tags",
      fuzzy: true,
    });
    const { pack: packB } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
      tagsField: "tags",
      fuzzy: false,
    });
    const fuzzyHits = loadIndex(packA).search("waether");
    const exactHits = loadIndex(packB).search("waether");
    expect(fuzzyHits[0]?.doc.id).toBe("1");
    const fuzzyTop = fuzzyHits[0]?.score ?? 0;
    const exactTop = exactHits[0]?.score ?? 0;
    expect(fuzzyTop).toBeGreaterThan(exactTop);
  });

  it("filter callback prunes results client-side", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
      tagsField: "tags",
    });
    const engine = loadIndex(pack);
    const hits = engine.search("weather", {
      filter: (doc) => doc.tags.includes("misc"),
    });
    expect(hits.every((hit) => hit.doc.tags.includes("misc"))).toBe(true);
  });

  it("rescore callback re-ranks by custom signal", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1, url: { weight: 1, kind: "url" } },
    });
    const engine = loadIndex(pack);
    const baseline = engine.search("api", { limit: 5 });
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline[0]?.doc.id).not.toBe("5");

    const rescored = engine.search("api", {
      limit: 5,
      // Force doc 5 to the top regardless of base score.
      rescore: (hit) => (hit.doc.id === "5" ? 1e6 : hit.score),
    });
    expect(rescored[0]?.doc.id).toBe("5");
  });

  it("rejects pure-gibberish queries instead of returning bigram noise", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
      tagsField: "tags",
    });
    const engine = loadIndex(pack);
    // Mixed gibberish that contains accidental CJK + ASCII bigrams. Without
    // the query-quality gate the engine returns documents purely because
    // their bigrams overlap with the noise.
    expect(engine.search("1111111健康的那jdnwadjanda")).toEqual([]);
    expect(engine.search("asdfghjkl")).toEqual([]);
    expect(engine.search("qqqqqqqqqq")).toEqual([]);
    expect(engine.search("xxxxxxxx健")).toEqual([]);
  });

  it("recovers from 1- and 2-edit ASCII typos via the fuzzy table", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1, url: { weight: 1, kind: "url" } },
      tagsField: "tags",
    });
    const engine = loadIndex(pack);
    // 1-edit deletion: "translate" → "translte"
    expect(engine.search("translte")[0]?.doc.id).toBe("2");
    // 1-edit substitution: "translate" → "trabslate"
    expect(engine.search("trabslate")[0]?.doc.id).toBe("2");
    // 2-edit deletion: "weather" → "wether"
    expect(engine.search("wether")[0]?.doc.id).toBe("1");
  });

  it("returns highlight ranges that match the original casing", () => {
    const { pack } = buildIndex(DOCS, {
      fields: { title: 5, body: 1 },
    });
    const engine = loadIndex(pack);
    const hit = engine.search("weather")[0];
    const titleMatch = hit.matches.find((match) => match.field === "title");
    expect(titleMatch).toBeDefined();
    const range = titleMatch?.ranges[0];
    expect(range).toBeDefined();
    if (!range) return;
    expect(
      hit.doc.fields.title.slice(range[0], range[1] + 1).toLowerCase(),
    ).toBe("weather");
  });
});
