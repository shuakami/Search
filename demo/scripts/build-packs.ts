/**
 * Build search packs for the demo from the same datasets we benchmark on.
 * Runs locally before the Vite build; outputs land in `public/packs/`.
 *
 *   pnpm prepare:packs
 */

import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { buildIndex, type BuildOptions } from "../../src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(ROOT, "..");
const CACHE = resolve(REPO_ROOT, "bench/datasets/cache");
const OUT = resolve(ROOT, "public/packs");

type RawDoc = Record<string, unknown> & { id: string };

interface DemoSet {
  slug: string;
  source: string;
  label: string;
  caption: string;
  language: "ascii" | "cjk" | "code";
  build: BuildOptions;
  /** Optional cap so the demo pack stays light — Pages serves it eagerly. */
  limit?: number;
  /** Per-field char cap applied before indexing (keeps the pack light). */
  trim?: Record<string, number>;
  /** Pick which fields to show in the result list. */
  display: { title: string; subtitle?: string; meta?: string };
}

const sets: DemoSet[] = [
  {
    slug: "hn",
    source: "hn-stories.json",
    label: "hacker news",
    caption: "story titles, mostly English",
    language: "ascii",
    limit: 3000,
    trim: { body: 120 },
    build: {
      fields: {
        title: { weight: 5, kind: "text" },
        body: { weight: 1, kind: "text" },
        author: { weight: 1, kind: "keyword" },
      },
      storeFields: ["title", "url", "author"],
      signalFields: ["title", "author"],
    },
    display: { title: "title", subtitle: "url", meta: "author" },
  },
  {
    slug: "stackoverflow",
    source: "stackoverflow.json",
    label: "stack overflow",
    caption: "high-vote technical questions",
    language: "ascii",
    limit: 2500,
    trim: { body: 200 },
    build: {
      fields: {
        title: { weight: 5, kind: "text" },
        body: { weight: 1, kind: "text" },
        tags: { weight: 3, kind: "keyword" },
      },
      storeFields: ["title", "url"],
      signalFields: ["title"],
      tagsField: "tags",
    },
    display: { title: "title", subtitle: "url" },
  },
  {
    slug: "wiki-zh",
    source: "wiki-zh.json",
    label: "中文 wikipedia",
    caption: "intro paragraphs, mixed-script",
    language: "cjk",
    limit: 2500,
    trim: { body: 220 },
    build: {
      fields: {
        title: { weight: 6, kind: "text" },
        body: { weight: 1, kind: "text" },
      },
      storeFields: ["title", "url"],
      signalFields: ["title"],
    },
    display: { title: "title", subtitle: "url" },
  },
  {
    slug: "code",
    source: "github-code.json",
    label: "source code",
    caption: "OSS files: react, vue, rust, go, python",
    language: "code",
    limit: 1500,
    trim: { body: 360 },
    build: {
      fields: {
        title: { weight: 4, kind: "text" },
        body: { weight: 1, kind: "text" },
        repo: { weight: 1, kind: "keyword" },
        language: { weight: 1, kind: "keyword" },
      },
      storeFields: ["title", "repo", "language", "url"],
      signalFields: ["title", "repo"],
    },
    display: { title: "title", subtitle: "repo", meta: "language" },
  },
];

async function loadJson<T>(file: string): Promise<T> {
  const buf = await fs.readFile(file, "utf-8");
  return JSON.parse(buf) as T;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const manifest: Array<{
    slug: string;
    label: string;
    caption: string;
    language: string;
    pack: string;
    docs: number;
    bytes: number;
    display: DemoSet["display"];
  }> = [];

  for (const set of sets) {
    const path = resolve(CACHE, set.source);
    try {
      await fs.access(path);
    } catch {
      process.stdout.write(`  skip ${set.slug} (no ${set.source})\n`);
      continue;
    }
    let docs = await loadJson<RawDoc[]>(path);
    if (set.limit) docs = docs.slice(0, set.limit);
    if (set.trim) {
      docs = docs.map((doc) => {
        const out = { ...doc };
        for (const [field, max] of Object.entries(set.trim!)) {
          const value = out[field];
          if (typeof value === "string" && value.length > max) {
            out[field] = value.slice(0, max);
          }
        }
        return out;
      });
    }
    process.stdout.write(`  building ${set.slug} (${docs.length} docs)... `);
    const { pack, manifest: m } = buildIndex(docs, set.build);
    const outPath = resolve(OUT, `${set.slug}.pack`);
    await fs.writeFile(outPath, pack);
    process.stdout.write(`${(pack.byteLength / 1024).toFixed(0)} KB, ${m.features} features\n`);
    manifest.push({
      slug: set.slug,
      label: set.label,
      caption: set.caption,
      language: set.language,
      pack: `${set.slug}.pack`,
      docs: docs.length,
      bytes: pack.byteLength,
      display: set.display,
    });
  }

  await fs.writeFile(
    resolve(OUT, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  process.stdout.write(`  wrote ${manifest.length} pack(s) + manifest.json\n`);
}

main().catch((error) => {
  process.stderr.write(`build-packs: ${error?.message ?? error}\n`);
  process.exit(1);
});
