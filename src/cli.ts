#!/usr/bin/env node
/**
 * shuakami-search — CLI for the search engine.
 *
 *   shuakami-search build <docs.json> -o pack.bin [--fields title:5,body:1] [--store title,url] [--tags tags] [--no-fuzzy]
 *   shuakami-search query <pack.bin> "your query" [--limit 10]
 *   shuakami-search inspect <pack.bin>
 *
 * The CLI is intentionally tiny: no argument parsing library, no shell magic.
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { buildIndex, type BuildOptions, type SearchDocument } from "./builder";
import { loadIndex } from "./runtime";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[index + 1];
        if (next && !next.startsWith("-")) {
          flags[arg.slice(2)] = next;
          index += 1;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        flags[arg.slice(1)] = next;
        index += 1;
      } else {
        flags[arg.slice(1)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function parseFieldSpec(input: string): BuildOptions["fields"] {
  // "title:5,body:1,url:0.8" → { title: 5, body: 1, url: 0.8 }
  // "title:text:5,path:url:1" → { title: { weight: 5, kind: "text" }, ... }
  const fields: BuildOptions["fields"] = {};
  for (const segment of input.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":").map((part) => part.trim());
    if (parts.length === 2) {
      fields[parts[0]] = Number(parts[1]);
    } else if (parts.length === 3) {
      const kind = parts[1] as "text" | "keyword" | "url";
      fields[parts[0]] = { weight: Number(parts[2]), kind };
    } else {
      throw new Error(`Invalid --fields entry: "${trimmed}"`);
    }
  }
  return fields;
}

function printHelp() {
  process.stdout.write(
    [
      "shuakami-search — build and query binary search packs",
      "",
      "Usage:",
      "  shuakami-search build <docs.json> -o <pack.bin> [options]",
      "  shuakami-search query <pack.bin> <query> [--limit 10]",
      "  shuakami-search inspect <pack.bin>",
      "",
      "Build options:",
      "  --fields  field1:weight,field2:weight   Required. Per-field weights.",
      "                                          Optional kind:  field:text:5",
      "                                                          field:url:1",
      "                                                          field:keyword:3",
      "  --store   field1,field2                 Stored fields (default: all in --fields).",
      "  --tags    field                         If a doc has this string[] field,",
      "                                          its values are stored as filterable tags.",
      "  --no-fuzzy                              Disable typo correction tables.",
      "  -o, --out <path>                        Output path for the pack.",
      "",
      "Examples:",
      '  shuakami-search build docs.json --fields "title:text:5,body:text:1,url:url:1" -o pack.bin',
      '  shuakami-search query pack.bin "hello world" --limit 20',
      "",
    ].join("\n"),
  );
}

async function commandBuild(args: ParsedArgs) {
  const inputPath = args.positional[0];
  if (!inputPath) {
    throw new Error("`build` requires a path to a JSON file of documents.");
  }
  const outPath = String(args.flags.out ?? args.flags.o ?? "pack.bin");
  const fieldsSpec = String(args.flags.fields ?? "title:5,body:1");
  const fields = parseFieldSpec(fieldsSpec);
  const storeFields = args.flags.store
    ? String(args.flags.store)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : undefined;
  const tagsField = args.flags.tags ? String(args.flags.tags) : undefined;
  const fuzzy = !args.flags["no-fuzzy"];

  const raw = await fs.readFile(resolve(inputPath), "utf8");
  const documents = JSON.parse(raw) as SearchDocument[];
  if (!Array.isArray(documents)) {
    throw new Error(
      `Expected ${inputPath} to contain a JSON array of documents.`,
    );
  }

  const start = process.hrtime.bigint();
  const { pack, manifest } = buildIndex(documents, {
    fields,
    storeFields,
    tagsField,
    fuzzy,
  });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  await fs.writeFile(resolve(outPath), pack);
  process.stdout.write(
    [
      `wrote ${outPath} (${formatBytes(manifest.packBytes)})`,
      `  docs       = ${manifest.docs}`,
      `  features   = ${manifest.features}`,
      `  postings   = ${manifest.postings}`,
      `  fuzzy      = ${manifest.correctionDeletes}`,
      `  build      = ${elapsedMs.toFixed(2)} ms`,
      "",
    ].join("\n"),
  );
}

async function commandQuery(args: ParsedArgs) {
  const packPath = args.positional[0];
  const query = args.positional.slice(1).join(" ");
  if (!packPath || !query) {
    throw new Error("`query` requires <pack.bin> and a query string.");
  }
  const limit = Number(args.flags.limit ?? 10);

  const bytes = await fs.readFile(resolve(packPath));
  const engine = loadIndex(bytes);
  const start = process.hrtime.bigint();
  const hits = engine.search(query, { limit });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  process.stdout.write(
    `query: ${JSON.stringify(query)}  (${hits.length} hits, ${elapsedMs.toFixed(3)} ms)\n`,
  );
  for (const hit of hits) {
    const headline =
      hit.doc.fields.title ||
      hit.doc.fields.name ||
      Object.values(hit.doc.fields)[0] ||
      hit.doc.id;
    process.stdout.write(
      `  ${hit.score.toFixed(2).padStart(8)}  ${hit.doc.id}  ${headline}\n`,
    );
  }
}

async function commandInspect(args: ParsedArgs) {
  const packPath = args.positional[0];
  if (!packPath) {
    throw new Error("`inspect` requires <pack.bin>.");
  }
  const bytes = await fs.readFile(resolve(packPath));
  const engine = loadIndex(bytes);
  process.stdout.write(
    [
      `pack:        ${packPath} (${formatBytes(bytes.length)})`,
      `docs:        ${engine.stats.docs}`,
      `features:    ${engine.stats.features}`,
      `postings:    ${engine.stats.postings}`,
      `deletes:     ${engine.stats.deletes}`,
      `stored:      ${engine.stats.storedFields.join(", ") || "(none)"}`,
      "",
    ].join("\n"),
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "build":
      await commandBuild(args);
      break;
    case "query":
      await commandQuery(args);
      break;
    case "inspect":
      await commandInspect(args);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`shuakami-search: ${error?.message ?? error}\n`);
  process.exit(1);
});
