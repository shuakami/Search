/**
 * Demo entry point — drives the live search UI on the Pages site.
 *
 * The page ships with a manifest of pre-built packs (one per corpus). When the
 * user picks a corpus we fetch the .pack file once, hand it to the runtime,
 * and wire input → engine.search() → result list. Latency stats are tracked
 * in a small ring buffer so we can show p50/p99 over the last N queries.
 */

import { loadIndex, renderHighlights, type SearchEngine } from "shuakami-search";

interface PackEntry {
  slug: string;
  label: string;
  caption: string;
  language: string;
  pack: string;
  docs: number;
  bytes: number;
  display: { title: string; subtitle?: string; meta?: string };
}

const tabsEl = document.getElementById("corpus-tabs") as HTMLElement;
const inputEl = document.getElementById("q") as HTMLInputElement;
const resultsEl = document.getElementById("results") as HTMLUListElement;
const emptyEl = document.getElementById("empty") as HTMLElement;
const corpusMetaEl = document.getElementById("corpus-meta") as HTMLElement;
const statResultsEl = document.getElementById("stat-results") as HTMLElement;
const statLatencyEl = document.getElementById("stat-latency") as HTMLElement;
const statP50El = document.getElementById("stat-p50") as HTMLElement;
const statP99El = document.getElementById("stat-p99") as HTMLElement;

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

class LatencyRing {
  private samples: number[] = [];
  push(value: number) {
    this.samples.push(value);
    if (this.samples.length > 32) this.samples.shift();
  }
  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.floor((p / 100) * (sorted.length - 1)),
    );
    return sorted[index];
  }
}

const ring = new LatencyRing();

let engine: SearchEngine | null = null;
let active: PackEntry | null = null;
const cache = new Map<string, SearchEngine>();
const placeholders: Record<string, string> = {
  ascii: "search…",
  cjk: "搜索…",
  code: "search…",
};

async function loadManifest(): Promise<PackEntry[]> {
  const response = await fetch(`${BASE}/packs/manifest.json`);
  if (!response.ok) throw new Error(`manifest: ${response.status}`);
  return (await response.json()) as PackEntry[];
}

async function loadCorpus(entry: PackEntry): Promise<SearchEngine> {
  if (cache.has(entry.slug)) return cache.get(entry.slug)!;
  const response = await fetch(`${BASE}/packs/${entry.pack}`);
  if (!response.ok) throw new Error(`pack ${entry.slug}: ${response.status}`);
  const buf = new Uint8Array(await response.arrayBuffer());
  const engine = loadIndex(buf);
  cache.set(entry.slug, engine);
  return engine;
}

function fmtMs(value: number): string {
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function renderCorpusMeta(entry: PackEntry) {
  corpusMetaEl.textContent = `${entry.label} · ${entry.docs.toLocaleString()} docs · ${fmtBytes(entry.bytes)}`;
}

function renderTabs(entries: PackEntry[]) {
  tabsEl.innerHTML = "";
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.slug = entry.slug;
    button.textContent = entry.label;
    button.title = entry.caption;
    button.addEventListener("click", () => activate(entry));
    tabsEl.appendChild(button);
  }
}

function activateTabUI(slug: string) {
  for (const button of Array.from(tabsEl.children) as HTMLButtonElement[]) {
    button.setAttribute(
      "aria-selected",
      button.dataset.slug === slug ? "true" : "false",
    );
  }
}

async function activate(entry: PackEntry) {
  active = entry;
  activateTabUI(entry.slug);
  renderCorpusMeta(entry);
  inputEl.placeholder =
    placeholders[entry.language] ?? `search ${entry.label.toLowerCase()}…`;
  resultsEl.innerHTML = "";
  emptyEl.style.display = "block";
  emptyEl.textContent = "loading pack…";
  try {
    engine = await loadCorpus(entry);
    emptyEl.textContent = `${entry.docs.toLocaleString()} docs ready — start typing.`;
    if (inputEl.value.trim()) runSearch(inputEl.value);
  } catch (error) {
    emptyEl.textContent = `failed to load pack: ${(error as Error).message}`;
  }
}

function runSearch(rawQuery: string) {
  if (!engine || !active) return;
  const query = rawQuery.trim();
  if (!query) {
    resultsEl.innerHTML = "";
    emptyEl.style.display = "block";
    emptyEl.textContent = "type to search.";
    statResultsEl.textContent = "0";
    statLatencyEl.textContent = "—";
    return;
  }

  // Take the median of three runs to dampen single-call jitter on the UI.
  let lastHits: ReturnType<SearchEngine["search"]> = [];
  const samples: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    lastHits = engine.search(query, { limit: 25 });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[1];
  ring.push(median);

  statResultsEl.textContent = String(lastHits.length);
  statLatencyEl.textContent = fmtMs(median);
  const p50 = ring.percentile(50);
  const p99 = ring.percentile(99);
  if (p50 !== null) statP50El.textContent = fmtMs(p50);
  if (p99 !== null) statP99El.textContent = fmtMs(p99);

  if (lastHits.length === 0) {
    resultsEl.innerHTML = "";
    emptyEl.style.display = "block";
    emptyEl.textContent = `no matches for "${query}".`;
    return;
  }
  emptyEl.style.display = "none";

  const display = active.display;
  const fragments = lastHits.map((hit) => {
    const titleField = display.title;
    const title = hit.doc.fields[titleField] ?? hit.doc.id;
    const titleMatches = hit.matches.find((match) => match.field === titleField);
    const titleHtml = renderHighlights(title, titleMatches?.ranges ?? []);

    const subtitle =
      display.subtitle && hit.doc.fields[display.subtitle]
        ? hit.doc.fields[display.subtitle]
        : "";
    const meta =
      display.meta && hit.doc.fields[display.meta]
        ? hit.doc.fields[display.meta]
        : "";

    return `<li>
      <div>
        <span class="results__title">${titleHtml}</span>
        ${subtitle ? `<span class="results__sub">${escape(subtitle)}</span>` : ""}
      </div>
      <span class="results__meta">${meta ? `${escape(meta)}  ` : ""}${hit.score.toFixed(0)}</span>
    </li>`;
  });
  resultsEl.innerHTML = fragments.join("");
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function debounce<F extends (value: string) => void>(fn: F, ms: number) {
  let timer: number | undefined;
  return (value: string) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(value), ms);
  };
}

const debouncedSearch = debounce((value: string) => runSearch(value), 80);
inputEl.addEventListener("input", () => debouncedSearch(inputEl.value));
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runSearch(inputEl.value);
});

(async () => {
  try {
    const manifest = await loadManifest();
    if (manifest.length === 0) {
      emptyEl.textContent = "no packs available — run `pnpm prepare:packs` locally.";
      return;
    }
    renderTabs(manifest);
    await activate(manifest[0]);
  } catch (error) {
    emptyEl.textContent = `failed to start: ${(error as Error).message}`;
  }
})();
