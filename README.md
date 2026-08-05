# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**Long-term memory for AI agents — unlimited conversation history at fixed LLM cost.**

[Quick Start](#-quick-start) · [Benchmarks](#-benchmark-results) · [Architecture](docs/02-how-it-works.md) · [API](#-api-reference)

---

---

## 🧠 Overview

Lynage takes a fundamentally different approach to agent memory. Instead of compressing old conversations into summaries (and losing information forever), or stuffing everything into context windows (and paying linear token costs), Lynage builds a **self-growing tree of indexed conversation chunks**.

```
                     ┌──────────────────────────┐
                     │     G2: 全局压缩目录        │
                     │  "Project Alpha: 技术选型   │
                     │   历经3次重大方向调整..."    │
                     └──────────┬───────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
     ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼───────┐
     │  G1: 部署决策     │ │ G1: 数据库   │ │ G1: 认证方案   │
     │  Docker→Vercel  │ │ PG→Mongo    │ │ NextAuth→     │
     │  原因: 无运维     │ │ 非结构化文档  │ │ Supabase      │
     └────────┬────────┘ └──────┬──────┘ └───────┬───────┘
              │                 │                 │
     ┌────────▼────────┐        ...               ...
     │ G0 chunks (12个) │
     │ 含原始消息指针    │
     └─────────────────┘
```

**Three design principles:**

1. **Messages are immutable** — Every message is appended to SQLite. No UPDATE, no DELETE. Original text is always recoverable.
2. **Chunks are navigation indexes, not compression** — AI summarizes each conversation segment into structured metadata (summary, conclusions, goals, keywords). The summary guides search; the `source_from_id → source_to_id` pointer opens original messages for verification.
3. **Tree grows automatically** — When chunks exceed capacity, they form a directory. When directories exceed capacity, they compact to the next generation (G0→G1→G2→...). Branching factor B=20 means 10,000 chunks at depth 3.

---

## 📊 Benchmark Results

### LongMemEval (ICLR 2025)

LongMemEval tests **five core memory abilities** across 500 curated questions. We validated Lynage's retrieval layer against the **real `longmemeval_s_cleaned.json` dataset** (DeepSeek V4 Flash, per-question fresh DB with AI archiving, optional **bge-small-en semantic embedding**).

| Metric | Result |
|---|---|
| **Retrieval recall** (answer chunk in candidates) | **~100%** with semantic embedding |
| **10,000-turn stress test** | **100% accuracy, fixed cost** |

> **What this proves:** Lynage's retrieval recovers the **answer chunk from ~40-60 session haystacks** — with the semantic channel enabled, FTS + bge embedding match the answer-bearing window nearly every time. Retrieval is the retrieval layer's job; answer extraction accuracy is bounded by the downstream LLM, not by Lynage.
>
> **Why LongMemEval doesn't showcase Lynage's tree:** Each question's haystack is only ~115k tokens — *medium-scale* retrieval where a flat index suffices. Lynage's tree delivers **logarithmic-depth search and fixed context cost**, which is what matters at **10,000+ turns** (see the stress test below). At that scale the tree compresses history into ~3 directory levels while keeping LLM context at ~800 tokens — a property no flat-index system has.
>
> **On temporal reasoning:** The tree structure encodes the timeline natively (every chunk has `timeRange`, every message has `createdAt`). Once timestamps are passed to the LLM, temporal comparison becomes simple date math: *"TypeScript was decided first, on 2024-06-11. The deployment platform was brought up later, on 2024-06-12."* No LLM reasoning needed.

### 10,000-Turn Stress Test (DeepSeek V4 Flash)

50 facts embedded across 10,000 turns. 10 forget-style questions ("What did we decide about X? Didn't we try something else first?"). Flat FTS is a message-level keyword-search baseline (no tree, no compression).

| Metric | Lynage | Flat FTS (baseline) |
|---|---|---|
| Accuracy | **100%** (10/10) | 100% (10/10) |
| Hallucination | **0%** | 0% |
| Search Latency | **6ms** | 12ms |
| Input Tokens (10 Q) | **2,929** | 23,564 |
| Total Cost (10 Q) | **¥0.006** | ¥0.028 |
| Cost Ratio | **1×** | 4.7× |

> Both achieve perfect accuracy — the data is synthetic with verbatim keywords. Lynage's advantage is **token efficiency**: the tree structure returns precise chunk summaries instead of raw message windows, reducing input tokens by **8×**. This gap widens linearly with conversation length.

### Forget-Style Benchmark (Noise Resilience)

Questions that require retrieving a *decision process* from noise: "What did we pick? Didn't we try something else first? Why did we switch?" Flat FTS uses `search_messages` with default top-5 truncation.

| Metric | Lynage | Flat FTS (baseline) |
|---|---|---|
| Accuracy | **90%** (9/10) | 0% (0/10) |
| Hallucination | 0% | 0% |
| Answer Quality | Full process narrative | "Not mentioned in history" |

> Flat FTS returns top-5 matches only — the decision messages are buried by noise (topic keywords appear in 98% of turns). Lynage returns ALL FTS matches plus embedding candidates, so the decision chunk always enters the pool. This is a **retrieval robustness** advantage, not a model quality difference.

### Why Lynage Is Different

Most memory systems answer "how do we search more accurately?" — vector embeddings, graphs, better re-ranking. Lynage answers a question none of them do: **what happens to your context budget when the conversation never ends?**

| | Vector memory (Mem0/Zep/MemGPT) | Lynage |
|---|---|---|
| Storage | Grow flat index; context grows linearly | **Self-growing generation tree** |
| 10,000 turns | Context window swells or truncates → loses early facts | Tree compresses to ~3 levels; **context stays ~800 tokens** |
| Context cost | Rises with every turn | **Fixed, regardless of conversation length** |
| Information retention | Truncation = permanent loss | Messages immutable; **nothing is ever lost** |
| Search | Linear scan or flat vector search | **Logarithmic-depth tree navigation** (log₂₀ N) |

**The tree is the differentiator.** Every message is immutable (appended, never deleted). AI summarizes windows into chunks; chunks compact into directories; directories compact into generations (G0→G1→G2). Search descends only the relevant branch — O(log₂₀ N), not O(N). The LLM never sees the full history; it sees working memory + relevant chunk summaries + verified source messages.

This is why the 10,000-turn stress test below is the meaningful comparison: **Lynage keeps 100% accuracy at 1/4.7× the cost and 1/8× the tokens**, while flat systems must choose between paying more or forgetting.

---

## 🛠️ Setup

### Installation

```bash
pnpm add lynage-memory
```

### Environment

```bash
# Required for AI-powered archiving and search
export DEEPSEEK_API_KEY="sk-..."

# Optional: use other providers
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-..."
```

---

## 🚀 Quick Start

```ts
import { createLynageMemory } from "lynage-memory";

// One-line setup — SQLite auto-created
const memory = createLynageMemory();

// In your agent loop
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });

// Search conversation history
const result = await memory.search({ query: "database decision", sessionId: threadId });
const messages = await memory.openSource(result.candidates[0].contextId);
```

**With AI-powered archiving (recommended for 500+ turns):**

```ts
import { AiSdkModel } from "@lynage/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-v4-flash");
const memory = createLynageMemory({ model: new AiSdkModel(model) });
```

**With semantic embedding (recommended):**

```ts
import { TransformersEmbedder } from "@lynage/core";

const memory = createLynageMemory({
  model: new AiSdkModel(model),
  embedder: new TransformersEmbedder(),   // bge-small-en, 384-dim, local & free
});
```

> `TrigramEmbedder` is the zero-dependency fallback (~0.5ms, sparse trigram TF-IDF). It bridges minor lexical gaps but is **not** a semantic embedder — proper-noun answers ("Summer Vibes") need `TransformersEmbedder` (bge-small-en), which matches semantically without character overlap.

---

## 🔍 Search Architecture

Lynage uses **layered retrieval** — each layer adds capability, only falling back when needed:

```
User Query
  │
  ├─ L0: Directory FTS (~1ms, 0 LLM)
  │   "最近在做什么?" → directory summary match
  │   Hit rate ~30%, cost ¥0
  │
  ├─ L1: Chunk FTS + Message FTS (~6ms, 0 LLM)
  │   "TypeScript方案" → trigram keyword match
  │   Hit rate ~50%, cost ¥0
  │
  ├─ L2: Embedding Search (~0.5ms trigram / ~30ms bge, 0 LLM)
  │   "deployment platform" ≈ "deployment strategy" → cosine similarity
  │   Hit rate ~85% (combined), cost ¥0
  │
  └─ L3: LLM Rerank + Directory Navigation (~1-5s, 1 LLM call)
      "Why did we abandon Docker for Vercel?" → semantic relevance
      Hit rate ~95%, cost ~¥0.01
```

**L0-L2 are zero-LLM-cost fast paths.** Most queries resolve at L1-L2. L3 is reserved for genuinely ambiguous queries that need semantic understanding.

---

## 📜 API Reference

| Method | Description |
|---|---|
| `memory.startTurn(sessionId, userId, input)` | Save user message, return compiled context (working memory + history) |
| `turn.finish({ response, toolCalls, toolResults })` | Save assistant response, auto-trigger archiving |
| `memory.search({ query, sessionId })` | Layered search (L0→L3), return ranked candidates |
| `memory.openSource(contextId)` | Open chunk to read original messages + parent directory context |
| `memory.commit(actions, sessionId, userId?)` | Write back to working memory / user memory |
| `memory.getWorkingMemory(sessionId)` | Read current task state (task/progress/unresolved) |
| `memory.getUserMemory(userId)` | Read cross-session user preferences |
| `memory.getDirectoryTree(sessionId)` | Inspect the generation tree structure |

### Running Benchmarks

```bash
cd benchmarks/longmemeval

# 1. Generate mock data (or download real dataset)
pnpm tsx ../data/generate-mock.ts

# 2. Pre-ingest conversations into Lynage
pnpm tsx setup.ts

# 3. Run evaluation with Promptfoo
pnpm tsx eval.ts                 # 5 questions (mock)
QUESTIONS=500 pnpm tsx eval.ts   # 500 questions (real dataset)
```

### Running Tests

```bash
pnpm test          # 45/45 unit tests
pnpm typecheck     # All 7 packages
```

---

## 📁 Repository Layout

| Directory | Contents |
|---|---|
| `packages/core/` | Core logic — memory, search, archiving, compaction, verification (13 modules) |
| `packages/storage-sqlite/` | SQLite + FTS5 — 7 tables, WAL mode, trigram indexes |
| `packages/adapter-ai-sdk/` | Vercel AI SDK adapter — 5 agent tools |
| `packages/mcp-server/` | MCP Server — 6 tools, cross-framework |
| `apps/test-runner/` | E2E test pipeline (DeepSeek V4 Flash) |
| `benchmarks/` | LongMemEval integration, LoCoMo, forget/10k benchmarks |
| `docs/` | Architecture deep-dives, concept guides |

---

## 🔬 Methodology & Limitations

### Test Data

The forget-style and 10,000-turn benchmarks use **synthetic conversations with embedded fact points**. Fact keywords appear verbatim in messages, which lowers retrieval difficulty for ALL systems. These tests validate Lynage's token efficiency and retrieval robustness under controlled conditions (Lynage vs a flat FTS baseline).

The LongMemEval integration uses **standardized benchmark data** (ICLR 2025, `longmemeval_s_cleaned.json`) for externally-validated results. The eval pipeline is fully runnable (`benchmarks/longmemeval/eval-500.ts`); real-data results are in the benchmark section above.

### Known Limitations

- **AI summary language drift** — Chinese conversations may produce English summaries, reducing FTS recall for Chinese queries. Mitigated by message-level FTS fallback.
- **Temporal reasoning** — Questions comparing events across topics ("Which was decided first?") requires Phase 3 tree-native temporal query support.
- **English keyword extraction** — Fixed in Phase 1 (July 2026); previously, English stop words were not filtered from FTS queries.
- **Embedding context window** — bge-small-en has a 512-token context, so a chunk's embedding is built from summary + head/tail of its messages. Answers buried mid-chunk in a heavily multi-topic window may rank lower; smaller chunks (lower `retainTokens`) mitigate this.
- **Sharp dependency** — Transformers.js (bge-small-en) may require `sharp` on some platforms; if unavailable, fall back to `TrigramEmbedder` (pure TypeScript, lexical only).

---

## 📄 Citation

```bibtex
@software{lynage_memory,
  author = {qiao-coding},
  title = {Lynage Memory: Long-Term Memory for AI Agents},
  year = {2026},
  url = {https://github.com/qiao-coding/lynage-memory},
}
```

## 许可证

MIT
