/**
 * Download representative real-world corpora for benchmarking.
 *
 * Outputs JSON files under bench/datasets/cache/. Re-running is idempotent:
 * the script skips a dataset if its cache file already exists. Pass --force
 * to refetch.
 *
 *   pnpm bench:datasets [--force] [--limit=N]
 */

import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "datasets/cache");
const FORCE = process.argv.includes("--force");
const LIMIT = (() => {
  const flag = process.argv.find((arg) => arg.startsWith("--limit="));
  return flag ? Number(flag.slice("--limit=".length)) : undefined;
})();

async function ensureDir(path: string) {
  await mkdir(dirname(path), { recursive: true });
}

async function exists(path: string) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeDataset(name: string, docs: unknown[]) {
  const path = resolve(ROOT, name);
  await ensureDir(path);
  await fs.writeFile(path, JSON.stringify(docs));
  process.stdout.write(`  wrote ${name} (${docs.length} docs)\n`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "shuakami-search-benchmark/0.1 (https://github.com/shuakami/Search)",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

interface AlgoliaHit {
  objectID: string;
  title?: string;
  story_text?: string;
  url?: string;
  author?: string;
  num_comments?: number;
  points?: number;
  created_at?: string;
}

async function fetchHN(targetCount: number) {
  const out: {
    id: string;
    title: string;
    body: string;
    url: string;
    author: string;
  }[] = [];
  const seen = new Set<string>();
  // Algolia caps a single search at ~50 pages × 100 hits. Vary the query
  // and the date window to actually fan out across the corpus.
  const seeds: Array<{ q: string; tags: string }> = [
    { q: "", tags: "story" },
    { q: "javascript", tags: "story" },
    { q: "python", tags: "story" },
    { q: "rust", tags: "story" },
    { q: "react", tags: "story" },
    { q: "ai", tags: "story" },
    { q: "startup", tags: "story" },
    { q: "design", tags: "story" },
    { q: "database", tags: "story" },
    { q: "linux", tags: "story" },
    { q: "web", tags: "story" },
    { q: "open source", tags: "story" },
    { q: "machine learning", tags: "story" },
    { q: "performance", tags: "story" },
    { q: "cryptography", tags: "story" },
  ];
  for (const seed of seeds) {
    if (out.length >= targetCount) break;
    let page = 0;
    while (out.length < targetCount && page < 50) {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(seed.q)}&tags=${seed.tags}&hitsPerPage=100&page=${page}`;
      const json = await fetchJson<{ hits: AlgoliaHit[]; nbPages: number }>(url);
      if (json.hits.length === 0) break;
      for (const hit of json.hits) {
        if (!hit.title || seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);
        out.push({
          id: hit.objectID,
          title: hit.title,
          body: hit.story_text ?? "",
          url: hit.url ?? "",
          author: hit.author ?? "",
        });
        if (out.length >= targetCount) break;
      }
      if (page >= (json.nbPages ?? 0) - 1) break;
      page += 1;
    }
  }
  return out;
}

interface WikiSearchResult {
  query: { search: { title: string; pageid: number; snippet: string }[] };
  continue?: { sroffset: number };
}

interface WikiExtractResult {
  query: {
    pages: Record<
      string,
      {
        pageid: number;
        title: string;
        extract: string;
        canonicalurl?: string;
      }
    >;
  };
}

async function fetchWikipedia(
  domain: "en.wikipedia.org" | "zh.wikipedia.org",
  seedQueries: string[],
  targetCount: number,
) {
  const out: {
    id: string;
    title: string;
    body: string;
    url: string;
  }[] = [];
  const seenIds = new Set<number>();

  for (const seed of seedQueries) {
    if (out.length >= targetCount) break;
    let offset = 0;
    while (out.length < targetCount) {
      const searchUrl = `https://${domain}/w/api.php?action=query&list=search&srlimit=50&format=json&srsearch=${encodeURIComponent(seed)}&sroffset=${offset}`;
      const search = await fetchJson<WikiSearchResult>(searchUrl);
      const hits = search.query.search.filter(
        (hit) => !seenIds.has(hit.pageid),
      );
      if (hits.length === 0) break;

      const ids = hits.map((hit) => hit.pageid).join("|");
      const extractUrl = `https://${domain}/w/api.php?action=query&prop=extracts|info&exintro=1&explaintext=1&inprop=url&format=json&pageids=${ids}`;
      const extracts = await fetchJson<WikiExtractResult>(extractUrl);
      for (const page of Object.values(extracts.query.pages)) {
        if (!page.extract || page.extract.length < 80) continue;
        if (seenIds.has(page.pageid)) continue;
        seenIds.add(page.pageid);
        out.push({
          id: String(page.pageid),
          title: page.title,
          body: page.extract.slice(0, 1200),
          url: page.canonicalurl ?? `https://${domain}/wiki/${encodeURIComponent(page.title)}`,
        });
        if (out.length >= targetCount) break;
      }

      if (!search.continue) break;
      offset = search.continue.sroffset;
    }
  }
  return out;
}

interface NpmSearchResponse {
  objects: Array<{
    package: {
      name: string;
      description?: string;
      keywords?: string[];
      links?: { homepage?: string; repository?: string };
      author?: { name?: string } | string;
    };
  }>;
  total: number;
}

async function fetchNpm(seeds: string[], targetCount: number) {
  const out: {
    id: string;
    title: string;
    body: string;
    url: string;
    keywords: string[];
  }[] = [];
  const seenIds = new Set<string>();

  for (const seed of seeds) {
    if (out.length >= targetCount) break;
    for (let from = 0; from < 250 && out.length < targetCount; from += 250) {
      const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(seed)}&size=250&from=${from}`;
      const json = await fetchJson<NpmSearchResponse>(url);
      if (json.objects.length === 0) break;
      for (const item of json.objects) {
        const id = item.package.name;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        out.push({
          id,
          title: item.package.name,
          body: item.package.description ?? "",
          url:
            item.package.links?.homepage ??
            item.package.links?.repository ??
            `https://www.npmjs.com/package/${item.package.name}`,
          keywords: item.package.keywords ?? [],
        });
        if (out.length >= targetCount) break;
      }
    }
  }
  return out;
}

/**
 * GitHub code search (public). Each "doc" is one file from a popular repo:
 *   id        = "owner/repo:path"
 *   title     = path basename
 *   body      = raw file content (truncated)
 *   url       = blob url
 *   language  = file language
 */
async function fetchGitHubCode(targetCount: number) {
  const out: {
    id: string;
    title: string;
    body: string;
    url: string;
    language: string;
    repo: string;
  }[] = [];
  const seen = new Set<string>();

  // Pull file lists from a curated set of popular OSS repos across languages.
  // We list the default branch's tree (recursive) and sample by extension.
  const repos: Array<{ slug: string; branch: string; exts: string[] }> = [
    { slug: "facebook/react", branch: "main", exts: [".js", ".ts"] },
    { slug: "vuejs/core", branch: "main", exts: [".ts"] },
    { slug: "tailwindlabs/tailwindcss", branch: "main", exts: [".js", ".ts"] },
    { slug: "expressjs/express", branch: "master", exts: [".js"] },
    { slug: "nodejs/node", branch: "main", exts: [".js"] },
    { slug: "django/django", branch: "main", exts: [".py"] },
    { slug: "pallets/flask", branch: "main", exts: [".py"] },
    { slug: "psf/requests", branch: "main", exts: [".py"] },
    { slug: "rust-lang/rust", branch: "master", exts: [".rs"] },
    { slug: "tokio-rs/tokio", branch: "master", exts: [".rs"] },
    { slug: "golang/go", branch: "master", exts: [".go"] },
    { slug: "kubernetes/kubernetes", branch: "master", exts: [".go"] },
    { slug: "spring-projects/spring-framework", branch: "main", exts: [".java"] },
  ];

  const auth: Record<string, string> =
    process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : process.env.SHUAKAMI_GITHUB_PAT
        ? { Authorization: `Bearer ${process.env.SHUAKAMI_GITHUB_PAT}` }
        : {};

  for (const repo of repos) {
    if (out.length >= targetCount) break;
    const treeUrl = `https://api.github.com/repos/${repo.slug}/git/trees/${repo.branch}?recursive=1`;
    let tree: { tree: Array<{ path: string; type: string; sha: string }> };
    try {
      const response = await fetch(treeUrl, {
        headers: {
          "User-Agent": "shuakami-search-benchmark/0.1",
          Accept: "application/vnd.github+json",
          ...auth,
        },
      });
      if (!response.ok) continue;
      tree = (await response.json()) as typeof tree;
    } catch {
      continue;
    }

    const perRepoCap = Math.ceil(targetCount / repos.length);
    const candidates = tree.tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          repo.exts.some((ext) => entry.path.endsWith(ext)) &&
          !entry.path.includes("/test/") &&
          !entry.path.includes("/tests/") &&
          !entry.path.includes("/__tests__/") &&
          !entry.path.endsWith(".min.js"),
      )
      .slice(0, perRepoCap + 40);

    const startCount = out.length;

    // Fan out 8 raw-content fetches at a time per repo; the file count is
    // bounded by `perRepoCap`, so this is a fixed amount of work, not a
    // crawl. Stop early once the per-repo cap is hit.
    const concurrency = 8;
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length && out.length - startCount < perRepoCap) {
        const entry = candidates[cursor++];
        if (out.length >= targetCount) return;
        const id = `${repo.slug}:${entry.path}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const rawUrl = `https://raw.githubusercontent.com/${repo.slug}/${repo.branch}/${entry.path}`;
        let text: string;
        try {
          const resp = await fetch(rawUrl, {
            headers: { "User-Agent": "shuakami-search-benchmark/0.1" },
          });
          if (!resp.ok) continue;
          text = await resp.text();
        } catch {
          continue;
        }
        if (!text || text.length > 200_000) continue;
        out.push({
          id,
          title: entry.path.split("/").pop() ?? entry.path,
          body: text.slice(0, 8000),
          url: `https://github.com/${repo.slug}/blob/${repo.branch}/${entry.path}`,
          language: repo.exts[0]?.replace(".", "") ?? "txt",
          repo: repo.slug,
        });
      }
    };
    await Promise.all(
      Array.from({ length: concurrency }, () => worker()),
    );
  }

  return out;
}

interface SOQuestion {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  tags: string[];
  score: number;
}

interface SOResponse {
  items: SOQuestion[];
  has_more: boolean;
  backoff?: number;
}

/**
 * StackOverflow questions via the Stack Exchange API. We pull highly-voted
 * questions by tag — this gives us long, technical, multi-paragraph English
 * docs with code mixed in: a much harder corpus than HN titles or wiki blurbs.
 */
async function fetchStackOverflow(targetCount: number) {
  const out: {
    id: string;
    title: string;
    body: string;
    url: string;
    tags: string[];
  }[] = [];
  const tags = [
    "javascript", "typescript", "python", "java", "c++", "rust", "go",
    "react", "node.js", "css", "html", "linux", "git", "docker", "sql",
    "regex", "algorithm", "performance",
  ];
  for (const tag of tags) {
    if (out.length >= targetCount) break;
    let page = 1;
    while (out.length < targetCount && page <= 25) {
      const url = `https://api.stackexchange.com/2.3/questions?order=desc&sort=votes&tagged=${encodeURIComponent(tag)}&site=stackoverflow&pagesize=100&page=${page}&filter=withbody`;
      let json: SOResponse;
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "shuakami-search-benchmark/0.1",
            Accept: "application/json",
          },
        });
        if (!response.ok) break;
        json = (await response.json()) as SOResponse;
      } catch {
        break;
      }
      for (const q of json.items) {
        if (out.length >= targetCount) break;
        const id = String(q.question_id);
        if (out.find((row) => row.id === id)) continue;
        // Strip HTML tags from body roughly — bench tokenizer just cares about words.
        const plain = (q.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
        out.push({
          id,
          title: q.title,
          body: plain,
          url: q.link,
          tags: q.tags,
        });
      }
      if (!json.has_more) break;
      page += 1;
      if (json.backoff) await new Promise((r) => setTimeout(r, json.backoff! * 1000));
    }
  }
  return out;
}

async function main() {
  await mkdir(ROOT, { recursive: true });

  const tasks: Array<{ name: string; build: () => Promise<unknown[]> }> = [
    {
      name: "hn-stories.json",
      build: () => fetchHN(LIMIT ?? 10000),
    },
    {
      name: "github-code.json",
      build: () => fetchGitHubCode(LIMIT ?? 8000),
    },
    {
      name: "stackoverflow.json",
      build: () => fetchStackOverflow(LIMIT ?? 8000),
    },
    {
      name: "wiki-en.json",
      build: () =>
        fetchWikipedia(
          "en.wikipedia.org",
          [
            "computer science", "algorithm", "music", "history", "geography",
            "physics", "biology", "literature", "philosophy", "machine learning",
            "art", "film", "sport", "medicine", "chemistry", "economics",
            "politics", "engineering", "mathematics", "linguistics", "astronomy",
            "psychology", "war", "religion", "food", "animal", "plant",
            "weather", "transport", "architecture", "technology",
          ],
          LIMIT ?? 10000,
        ),
    },
    {
      name: "wiki-zh.json",
      build: () =>
        fetchWikipedia(
          "zh.wikipedia.org",
          [
            "计算机", "算法", "音乐", "历史", "地理", "物理", "生物",
            "文学", "哲学", "人工智能", "艺术", "电影", "体育", "医学",
            "化学", "经济", "政治", "工程", "数学", "语言学", "天文学",
            "心理学", "战争", "宗教", "食物", "动物", "植物", "天气",
            "交通", "建筑",
          ],
          LIMIT ?? 8000,
        ),
    },
    {
      name: "npm-packages.json",
      build: () =>
        fetchNpm(
          [
            "react", "vue", "test", "build", "lint", "graph", "search",
            "image", "auth", "cli", "server", "http", "parser", "router",
            "plugin", "framework", "validator", "date", "crypto", "stream",
          ],
          LIMIT ?? 10000,
        ),
    },
  ];

  for (const task of tasks) {
    const path = resolve(ROOT, task.name);
    if (!FORCE && (await exists(path))) {
      const stats = await fs.stat(path);
      process.stdout.write(
        `  skip ${task.name} (already cached, ${(stats.size / 1024).toFixed(1)} KB)\n`,
      );
      continue;
    }
    process.stdout.write(`  fetching ${task.name}...\n`);
    try {
      const docs = await task.build();
      await writeDataset(task.name, docs);
    } catch (error) {
      process.stderr.write(
        `  failed ${task.name}: ${(error as Error).message}\n`,
      );
    }
  }
}

main().catch((error) => {
  process.stderr.write(`prepare-datasets: ${error?.message ?? error}\n`);
  process.exit(1);
});
