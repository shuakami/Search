<!-- prettier-ignore-start -->
<p align="center">
  <a href="https://shuakami.github.io/Search/">
    <img src="docs/figures/hero.png" alt="@shuakami/search — 一个能装进 Uint8Array 的搜索引擎" width="100%" />
  </a>
</p>

<h1 align="center">@shuakami/search</h1>

<p align="center">
  零依赖、单文件的 JavaScript 全文搜索引擎。<br/>
  构建一次，得到一个二进制 pack，加载即查询。<br/>
  浏览器、Node、Worker、Edge Function、Bun、Deno 都能跑。
</p>

<p align="center">
  <a href="https://shuakami.github.io/Search/"><strong>在线 demo →</strong></a>
  &nbsp;&nbsp;&nbsp;
  <a href="README.md">English</a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://www.npmjs.com/package/@shuakami/search">npm</a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://github.com/shuakami/Search/blob/main/LICENSE">MIT</a>
</p>

<p align="center">
  <a href="https://github.com/shuakami/Search/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/shuakami/Search/ci.yml?branch=main&label=CI&style=flat-square"></a>
  <img alt="bundle" src="https://img.shields.io/badge/runtime-14_KB-1f1f22?style=flat-square">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-1f1f22?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5_18-1f1f22?style=flat-square">
</p>

<!-- prettier-ignore-end -->

---

## 为什么再写一个搜索库

现有的 JS 搜索库基本卡在两种取舍上，二选一：

1. **包小，但查询慢。** `fuse.js` 只有几 KB，但每次按键都要扫一遍所有文档。文档多一点、字段长一点，输入框就卡得能感觉到。
2. **查询快，但索引不能离线带走。** `flexsearch`、`lunr` 跑起来很快，但它们的"索引"实质上还是 JSON（甚至要异步分块写入），每次刷新页面都得重新解析、重新建对象。

`@shuakami/search` 走第三条路：

- 构建产物是一个 `Uint8Array`，写成静态文件、塞进 base64、传给 Web Worker、存进 IndexedDB 都行。没有 JSON，没有异步水合，没有按文档逐个再加工的逻辑。
- `loadIndex(pack)` 是同步的、零拷贝的：直接拿 typed-array view 读，进程里不会预先实例化任何对象。
- 一个分词器同时处理 ASCII、汉字、代码标识符；变音符、全角标点、大小写都在同一遍 NFKD 里折叠。构建和查询用的是同一套规则——索引里有什么，搜起来就能搜到什么。
- 拼写容错走 SymSpell delete 表，再加 Damerau–Levenshtein 校验。1–2 个编辑距离都能救回来，但工作量有上限，不会指数爆炸，p99 不会突然飙起来。

运行时 14 KB（gzip ≈ 6 KB），不依赖 `Buffer`、不依赖 DOM、不用 `eval`，没有任何异步初始化。

## 安装

```bash
npm install @shuakami/search
# 或者 pnpm / yarn / bun
```

如果不想接入打包工具，直接 `<script>` 一行：

```html
<script src="https://unpkg.com/@shuakami/search/dist/standalone/shuakami-search.global.js"></script>
<script>
  const { buildIndex, loadIndex } = window.ShuakamiSearch;
</script>
```

## 上手

### 一次性建好索引（跑在 Node、构建脚本或 CI 里）

```ts
import { buildIndex } from "@shuakami/search";

const docs = [
  { id: "1", title: "Hello world",   body: "First post." },
  { id: "2", title: "Search basics", body: "How tokenizers work." },
  { id: "3", title: "搜索入门",       body: "中文示例文档。" },
];

const { pack } = buildIndex(docs, {
  fields: {
    title: { weight: 5, kind: "text" },
    body:  { weight: 1, kind: "text" },
  },
  // 命中结果里要保留哪些原始字段。体量大的 body 字段建议不保留，
  // 渲染时再去你自己的文档存储里取，pack 能小很多。
  storeFields: ["title"],
});

// pack 就是 Uint8Array：写文件、当静态资源、跨 Worker 传、存 IndexedDB——随便用。
await fs.writeFile("site.pack", pack);
```

### 查询（浏览器、Node、Worker、Edge 都行）

```ts
import { loadIndex } from "@shuakami/search";

const engine = loadIndex(pack);
const hits = engine.search("token", { limit: 10 });
//      ^? SearchHit[]: { doc, score, refIndex, matches }
```

### 高亮渲染

```ts
import { renderHighlights } from "@shuakami/search";

const hit = hits[0];
const titleMatches = hit.matches.find((m) => m.field === "title");
const html = renderHighlights(
  hit.doc.fields.title,
  titleMatches?.ranges ?? [],
);
// → 'Search <mark>basics</mark>'
```

### 一行加载远程 pack

```ts
import { createSearch } from "@shuakami/search";

const engine = await createSearch("/search-index.bin");
const hits = engine.search("人工智能");
```

## 在线 demo

[**shuakami.github.io/Search**](https://shuakami.github.io/Search/) 上挂了四份真实语料：Hacker News 标题、Stack Overflow 高赞问答、中文维基摘要、开源代码片段。可以随便切换语料试一下，引擎在短英文标题、长技术文本、混合脚本中文、代码标识符这四种场景下手感很不一样。页面右上角实时显示最近 32 次查询的 p50 / p99。

## 性能

数据集全部来自公开 API：Hacker News Algolia、Stack Exchange、Wikipedia REST、GitHub raw。每个引擎跑同一份 200 条混合查询：45% 单词 ASCII、15% 双词短语、10% 拼写错误、10% 中文、5% 长多词、5% 代码标识符、5% 仅前缀、5% 长尾低频。Recall 的 ground truth 用一条统一的判定：原文里是否存在这个 token 的子串。所有引擎用同一份判定。

```bash
pnpm install
pnpm bench:datasets       # 数据集会下载到 bench/datasets/cache/
pnpm bench --queries=200  # 表格写到 stdout，明细 JSON 写到 bench/results/
```

### 一图速览：Hacker News 标题，10 000 条

![HN 标题 10 000 条延迟对比](docs/figures/latency.png)

### 五份语料的 recall

![五份语料的 recall 对比](docs/figures/recall.png)

### 完整数据

#### Hacker News 标题，10 000 条

| 引擎 | build | gzip pack | p50 | p99 | recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@shuakami/search** | 2.5 s | 3.32 MB | **0.224 ms** | **0.845 ms** | 79.5 % |
| fuse.js | 51 ms | 876 KB | 超时 * | 超时 * | 超时 * |
| minisearch | 405 ms | 1.12 MB | 0.731 ms | 5.825 ms | 83.9 % |
| lunr | 1.5 s | 1.64 MB | 0.177 ms | 5.133 ms | 68.1 % |
| flexsearch | 801 ms | n/a † | 0.008 ms | 0.432 ms | 88.8 % |

#### Stack Overflow 高赞问答，8 000 条（多段技术文本）

| 引擎 | build | gzip pack | p50 | p99 | recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@shuakami/search** | 6.5 s | 7.13 MB | **0.350 ms** | 6.433 ms | 74.7 % |
| fuse.js | 59 ms | 2.21 MB | 超时 * | 超时 * | 超时 * |
| minisearch | 1.1 s | 2.05 MB | 1.577 ms | 10.77 ms | 81.8 % |
| lunr | 3.8 s | 3.84 MB | 0.630 ms | 17.06 ms | 59.3 % |
| flexsearch | 1.6 s | n/a † | 0.008 ms | 2.089 ms | 87.1 % |

#### Wikipedia 英文摘要，10 000 条

| 引擎 | build | gzip pack | p50 | p99 | recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@shuakami/search** | 9.9 s | 9.70 MB | 2.385 ms | 13.74 ms | **80.2 %** |
| fuse.js | 71 ms | 2.78 MB | 超时 * | 超时 * | 超时 * |
| minisearch | 1.6 s | 2.53 MB | 1.854 ms | 18.06 ms | 79.2 % |
| lunr | 4.4 s | 4.88 MB | 0.139 ms | 13.65 ms | 66.4 % |
| flexsearch | 2.4 s | n/a † | 0.006 ms | 1.819 ms | 87.6 % |

#### 开源代码，5 000 个文件（camelCase / snake_case / 代码标识符）

| 引擎 | build | gzip pack | p50 | p99 | recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@shuakami/search** | 11.1 s | 7.07 MB | 1.108 ms | 7.056 ms | 76.0 % |
| fuse.js | 98 ms | 3.39 MB | 超时 * | 超时 * | 超时 * |
| minisearch | 2.4 s | 2.36 MB | 2.196 ms | 35.67 ms | 88.4 % |
| lunr | 7.2 s | 7.63 MB | 0.196 ms | 11.42 ms | 64.0 % |
| flexsearch | 2.1 s | n/a † | 0.008 ms | 0.414 ms | 86.8 % |

#### 中文 Wikipedia 摘要，8 000 条（混合脚本 CJK）

| 引擎 | build | gzip pack | p50 | p99 | recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@shuakami/search** | 14.6 s | 12.58 MB | **0.164 ms** | **1.064 ms** | **90.8 %** |
| fuse.js | 76 ms | 3.18 MB | 超时 * | 超时 * | 超时 * |
| minisearch | 3.9 s | 3.82 MB | 4.605 ms | 34.91 ms | 64.9 % |
| lunr | 3.0 s | 2.16 MB | 0.068 ms | 23.82 ms | 43.6 % |
| flexsearch | 3.1 s | n/a † | 0.004 ms | 0.041 ms | 68.0 % |

`*` `fuse.js` 是模糊全文匹配，每次查询都要扫一遍所有文档。在 5 000 条以上的长文本语料上，它在 20 秒暖机预算里跑不完 200 条查询；runner 会把它标成 bailed，然后接着往下跑。

`†` flexsearch 自带的序列化 API 是异步分块写入的；为了对齐口径，没有强行 `JSON.stringify(index)` 来凑一个数。

#### 几点观察

- **CJK 是分水岭。** 其它引擎在中文维基上 recall 比我们低 10–25 个百分点，原因是默认分词器要么按空格拆词（中文里就没有空格），要么只做 Latin 词干化。`@shuakami/search` 在中文场景里同时拿到 recall 第一和延迟第一。
- **flexsearch** 在每份语料上 p50 都最快，但它没有同步、可序列化的索引格式（gzip 这一栏空着），运行时也不存原始字段。如果你的应用文档已经在内存里、又不需要把索引带走，flexsearch 是合适选择。
- **minisearch** 在短英文语料上很稳，HN 和 Stack Overflow 上的 recall 略高于我们（它默认偏向多 token AND 评分，正好契合我们的 substring-AND ground truth）。但在长文本和中文上，延迟和 recall 我们都更好。
- **lunr** 冷启动延迟最低，但内置分词器会丢掉绝大部分中文（中文维基 recall 只有 43.6%），词干化阶段也会顺手把低频词扔掉。
- **@shuakami/search** 在每份语料上 p99 都低于 14 ms，中文双第一。pack 是一个二进制 blob，可以同步 fetch。代价是在长英文语料上 pack 比 minisearch 大——我们把 exact / prefix / signal / joined / bigram 几种 token 特征全都展开预生成进了 pack，这是用一份引擎覆盖五种语料、不需要按场景调参的代价。

## 工作原理

![架构图：构建管线、传输面、运行时](docs/figures/architecture.png)

### Pack 布局

每个 pack 以 4 字节魔数 `SCH1`（`0x53 0x43 0x48 0x31`）开头，紧跟一个 `uint16` 版本号。后面是带长度前缀的 section：

| section          | 内容                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `manifest`       | 文档数、feature 数、posting 数、correction-delete 数              |
| `documents`      | 每个文档 `{ id, fields, signal_compact, signal_ascii, tags }`     |
| `tokens`         | 排序好的 `(type, name)` 表；type 用 3 位 tag 表示                 |
| `postings`       | 每个 token 的 varint posting list `{ Δdoc_id, score }`            |
| `corrections`    | 可选的 delete → token-id 表，用来做拼写容错                       |

整数全部走无符号 LEB128 varint。section 是追加式的，加一段新数据不会动到前面 section 的文件指针，方便增量重建。

### Token 类型

```
e:react      —— ASCII 或 CJK 的精确 token
p:rea        —— ASCII 前缀（长度 2..4）
s:reactcore  —— ASCII signal（整字段折叠成 ASCII）
j:react心    —— 紧凑 joined token（跨脚本整字段折叠）
g:re         —— ASCII 二元组（仅短 joined ASCII）
h:中文       —— 汉字二元组
```

每种 feature 自带一个基准权重，再乘上字段权重，最终封顶在 `0xFFFF`。bigram 在 typo 和中文场景下负责把 recall 拉上来；用户精确输入时由 exact token 主导。

### 评分

查询时引擎按这个顺序走：

1. 把 query 归一化，分词规则和构建期完全一致。
2. 查 `e:` / `p:` / `s:` / `j:` / `g:` / `h:` 的 posting list。
3. 如果 `e:` 没命中，再查 SymSpell 风格的 delete 表恢复 1–2 个编辑距离的拼写错误，最后用 Damerau–Levenshtein 校验。
4. 如果 stored signal 里整条 query 字面命中，加一个 boost（`String.prototype.includes`）。
5. 用部分堆排序选 top-K；可选地通过 `rescore` 回调再微调。

## API

### `buildIndex(docs, options)` → `{ pack, manifest }`

```ts
interface SearchDocument {
  id: string;
  [field: string]: unknown;
}

interface FieldConfig {
  weight: number;
  kind?: "text" | "keyword" | "url";
  joinWindow?: number;
}

interface BuildOptions {
  fields: Record<string, FieldConfig | number>;
  storeFields?: string[];
  signalFields?: string[];
  signalMaxLength?: number;
  tagsField?: string;
  fuzzy?: boolean;
}
```

### `loadIndex(pack)` → `SearchEngine`

```ts
interface SearchEngine {
  search(query: string, options?: SearchOptions): SearchHit[];
  readonly docCount: number;
  readonly featureCount: number;
}

interface SearchOptions {
  limit?: number;            // 默认 10
  minScoreRatio?: number;    // 低于 `top * ratio` 的命中会被裁掉，默认 0.05
  filter?: (doc: StoredDocument) => boolean;
  rescore?: (hit: SearchHit) => number;
}
```

### `createSearch(url, init?)` → `Promise<SearchEngine>`

便捷封装：fetch 一个 pack，返回已经就绪的 SearchEngine。

### `renderHighlights(text, ranges, options?)` → `string`

纯字符串高亮：用 `<mark>`（或自定义标签）包住命中区间，对周围文本做 HTML 转义，相邻区间会合并，避免重复包裹。

## CLI

```bash
npx shuakami-search build docs.json -o site.pack \
  --fields title:5,body:1,url:1 \
  --store title,url \
  --tags-field keywords

npx shuakami-search query site.pack "machine learning" --limit 5
npx shuakami-search inspect site.pack
```

`docs.json` 是一个对象数组。每个对象需要一个 string 类型的 `id`，其它字段任意。字段权重写成 `name:weight`。

## 示例

| 路径                                | 演示什么                                          |
| ----------------------------------- | ------------------------------------------------- |
| `examples/node-cli.ts`              | Node 脚本里的 build + query。                     |
| `examples/browser-inline.html`      | pack 内联成 base64，纯静态、不发网络请求。        |
| `examples/browser-fetch.html`       | pack 当静态资源 fetch 加载。                      |
| `examples/web-worker.ts`            | Worker 线程里跑查询，主线程通过 postMessage 拿结果。 |
| `demo/`                             | [shuakami.github.io/Search](https://shuakami.github.io/Search/) 的源码：Vite + 4 份语料 + 实时延迟计数。 |

## 兼容性

| 目标              | 是否支持                              |
| ----------------- | ------------------------------------ |
| Node              | ≥ 18                                 |
| 浏览器            | 主流现代浏览器（用到 `Uint8Array`、`TextDecoder`） |
| Bun / Deno / Worker / Edge | 是；运行时不依赖任何 Node 内建模块 |

## 协议

MIT © [shuakami](https://github.com/shuakami)
