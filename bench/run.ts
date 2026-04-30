/**
 * Benchmark runner. Compares shuakami/Search against fuse.js, minisearch,
 * lunr, and flexsearch on every dataset under bench/datasets/cache/.
 *
 *   pnpm bench
 *   pnpm bench -- --dataset=wiki-zh.json --queries=200
 *
 * Outputs a Markdown table to stdout and a JSON snapshot to bench/results/.
 */

import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFlexSearch,
  createFuse,
  createLunr,
  createMiniSearch,
  createShuakami,
  type BenchmarkDoc,
  type EngineAdapter,
} from "./lib/adapters";
import { generateQueries } from "./lib/queries";
import {
  formatBytes,
  formatMs,
  mean,
  nowMs,
  percentile,
} from "./lib/stats";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, "datasets/cache");
const RESULTS = resolve(HERE, "results");

const args = process.argv.slice(2);
const datasetFilter = readFlag(args, "--dataset");
const queryCount = Number(readFlag(args, "--queries") ?? 200);
const limit = Number(readFlag(args, "--limit") ?? 10);
const warmup = Number(readFlag(args, "--warmup") ?? 1);

function readFlag(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("-")) {
    return args[idx + 1];
  }
  return undefined;
}

async function listDatasets(): Promise<string[]> {
  const all = await fs.readdir(CACHE).catch(() => []);
  const json = all.filter((name) => name.endsWith(".json"));
  return datasetFilter
    ? json.filter((name) => name.includes(datasetFilter))
    : json;
}

interface Row {
  engine: string;
  buildMs: number;
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  recall: number;
}

async function runDataset(filename: string) {
  const path = resolve(CACHE, filename);
  const docs = JSON.parse(await fs.readFile(path, "utf8")) as BenchmarkDoc[];
  process.stdout.write(`\n## ${filename}  (${docs.length} docs)\n\n`);

  const queries = generateQueries(docs, queryCount, hashString(filename));
  if (queries.length < queryCount * 0.5) {
    process.stdout.write(
      `  warn: only ${queries.length} usable queries generated\n`,
    );
  }

  const builders: Array<() => EngineAdapter> = [
    createShuakami,
    createFuse,
    createMiniSearch,
    createLunr,
    createFlexSearch,
  ];

  const rows: Row[] = [];
  const truthByQuery = new Map<string, ReadonlySet<string>>();
  for (const query of queries) {
    truthByQuery.set(query.query, new Set(query.truth));
  }

  // Budgets: any single query > QUERY_BUDGET_MS or aggregate warmup time >
  // WARMUP_BUDGET_MS marks the engine as N/A on this corpus. This is what
  // lets fuse.js stay in the table on small corpora but drop out gracefully
  // on huge ones instead of running for hours.
  const QUERY_BUDGET_MS = 2000;
  const WARMUP_BUDGET_MS = 20_000;
  const BUILD_BUDGET_MS = 120_000;

  for (const builder of builders) {
    const engine = builder();
    let stats;
    const buildStart = nowMs();
    try {
      stats = engine.build(docs);
    } catch (error) {
      process.stdout.write(
        `  ${engine.name}: build failed — ${(error as Error).message}\n`,
      );
      continue;
    }
    if (stats.buildMs > BUILD_BUDGET_MS) {
      process.stdout.write(
        `  ${engine.name}: build exceeded budget (${stats.buildMs.toFixed(0)} ms > ${BUILD_BUDGET_MS} ms)\n`,
      );
      continue;
    }
    void buildStart;

    // Warmup. Bail out completely if the cumulative warmup time exceeds
    // WARMUP_BUDGET_MS — this engine is too slow for this corpus.
    let warmupBailed = false;
    const warmupStart = nowMs();
    outer: for (let pass = 0; pass < warmup; pass += 1) {
      for (const query of queries) {
        engine.search(query.query, limit);
        if (nowMs() - warmupStart > WARMUP_BUDGET_MS) {
          process.stdout.write(
            `  ${engine.name}: warmup budget exceeded (${(nowMs() - warmupStart).toFixed(0)} ms), marking N/A\n`,
          );
          warmupBailed = true;
          break outer;
        }
      }
    }
    if (warmupBailed) {
      rows.push({
        engine: engine.name,
        buildMs: stats.buildMs,
        rawBytes: stats.rawBytes,
        gzipBytes: stats.gzipBytes,
        brotliBytes: stats.brotliBytes,
        meanMs: NaN,
        p50Ms: NaN,
        p95Ms: NaN,
        p99Ms: NaN,
        recall: NaN,
      });
      continue;
    }

    const samples: number[] = [];
    let recallSum = 0;
    let recallCount = 0;
    let bailed = false;

    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index];
      const start = nowMs();
      const results = engine.search(query.query, limit);
      const elapsed = nowMs() - start;
      samples.push(elapsed);
      if (elapsed > QUERY_BUDGET_MS) {
        process.stdout.write(
          `  ${engine.name}: query budget exceeded (${elapsed.toFixed(0)} ms on "${query.query}"), bailing\n`,
        );
        bailed = true;
        break;
      }
      const truth = truthByQuery.get(query.query);
      if (truth && truth.size > 0) {
        const got = results.slice(0, Math.min(limit, truth.size));
        const matched = got.filter((id) => truth.has(id)).length;
        recallSum += matched / Math.min(limit, truth.size);
        recallCount += 1;
      }
    }

    if (bailed && samples.length < queries.length / 2) {
      // Not enough samples for a meaningful number; mark as N/A.
      rows.push({
        engine: engine.name,
        buildMs: stats.buildMs,
        rawBytes: stats.rawBytes,
        gzipBytes: stats.gzipBytes,
        brotliBytes: stats.brotliBytes,
        meanMs: NaN,
        p50Ms: NaN,
        p95Ms: NaN,
        p99Ms: NaN,
        recall: NaN,
      });
      continue;
    }

    rows.push({
      engine: engine.name,
      buildMs: stats.buildMs,
      rawBytes: stats.rawBytes,
      gzipBytes: stats.gzipBytes,
      brotliBytes: stats.brotliBytes,
      meanMs: mean(samples),
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      p99Ms: percentile(samples, 99),
      recall: recallCount === 0 ? 0 : recallSum / recallCount,
    });
  }

  const table = renderTable(filename, rows);
  process.stdout.write(table + "\n");
  await mkdir(RESULTS, { recursive: true });
  await fs.writeFile(
    resolve(RESULTS, `${filename.replace(/\.json$/, "")}.json`),
    JSON.stringify({ filename, docs: docs.length, queryCount: queries.length, rows }, null, 2),
  );
  return { filename, rows };
}

function renderTable(filename: string, rows: Row[]): string {
  const header = [
    "| engine | build | raw size | gzip | brotli | mean | p50 | p95 | p99 | recall |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  const fmt = (value: number, formatter: (n: number) => string) =>
    Number.isFinite(value) ? formatter(value) : "N/A";
  const body = rows.map((row) =>
    [
      `| ${row.engine}`,
      fmt(row.buildMs, formatMs),
      fmt(row.rawBytes, formatBytes),
      fmt(row.gzipBytes, formatBytes),
      fmt(row.brotliBytes, formatBytes),
      fmt(row.meanMs, formatMs),
      fmt(row.p50Ms, formatMs),
      fmt(row.p95Ms, formatMs),
      fmt(row.p99Ms, formatMs),
      Number.isFinite(row.recall) ? `${(row.recall * 100).toFixed(1)}%` : "N/A",
    ].join(" | ") + " |",
  );
  void filename;
  return [...header, ...body].join("\n");
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function main() {
  const datasets = await listDatasets();
  if (datasets.length === 0) {
    process.stderr.write(
      "no datasets cached. Run `pnpm bench:datasets` first.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`# benchmark — ${datasets.length} datasets\n`);
  for (const dataset of datasets) {
    await runDataset(dataset);
  }
}

main().catch((error) => {
  process.stderr.write(`bench: ${error?.message ?? error}\n`);
  process.exit(1);
});
