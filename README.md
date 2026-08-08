# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**Break through the context window limit. Your agent's conversations can go on forever — every word is stored, always findable, and context costs never grow with conversation length.**

[中文](README_zh.md) · [Quick Start](#-quick-start) · [Benchmarks](#-benchmark-results) · [Architecture](docs/02-how-it-works.md) · [API](#-api-reference)

---

## 🧠 Overview

Lynage is a **memory infrastructure layer, not a reasoning layer**. It guarantees what an agent needs from memory: original text is never lost, it can be navigated by a self-growing tree, and specific content is recalled on demand.

Lynage takes a fundamentally different approach to agent memory. Instead of compressing old conversations into summaries (and losing information forever), or stuffing everything into context windows (and paying linear token costs), Lynage builds a **self-growing tree of indexed conversation chunks**.

```
                     ┌──────────────────────────┐
                     │     G2: Global Summary     │
                     │  "Project Alpha: tech stack│
                     │   went through 3 pivots..."│
                     └──────────┬───────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
     ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼───────┐
     │ G1: Deploy       │ │ G1: Database │ │ G1: Auth       │
     │  Docker→Vercel   │ │ PG→Mongo     │ │ NextAuth→      │
     │  Reason: no ops   │ │ Unstructured │ │ Supabase       │
     └────────┬────────┘ └──────┬──────┘ └───────┬───────┘
              │                 │                 │
     ┌────────▼────────┐        ...               ...
     │ G0 chunks (12)   │
     │ w/ source ptrs   │
     └─────────────────┘
```

**Three design principles:**

1. **Messages are immutable** — Every message is appended to SQLite. No UPDATE, no DELETE. Original text is always recoverable.
2. **Chunks are navigation indexes, not compression** — AI summarizes each conversation segment into structured metadata (summary, conclusions, goals, keywords). The summary guides search; the `source_from_id → source_to_id` pointer opens original messages for verification.
3. **Tree grows automatically** — When chunks exceed capacity, they form a directory. When directories exceed capacity, they compact to the next generation (G0→G1→G2→...). Branching factor B=20 means 10,000 chunks at depth 3.

---

## 📊 Benchmark Results

### 10,000-Turn Stress Test (DeepSeek V4 Flash, validated at 2,000 turns)

50 facts embedded across 2,000 turns. Reproducible in-repo: Lynage answers from tree summaries (`benchmarks/baseline/bench-10k.ts`); Flat FTS is a message-level keyword baseline via `search_messages` top-5 (`bench-flat.ts`).

**Forget-style benchmark** — decision process buried in noise ("what did we pick? didn't we try something else first?"):

| Metric | Lynage | Flat FTS (baseline) |
|---|---|---|
| Accuracy | **90%** (9/10) | 0% (0/10) |
| Hallucination | 0 | 0 |
| Answer Quality | Full process narrative | "Not mentioned in history" |

> Flat FTS gets **0%** because `search_messages` trigram FTS cannot parse vague natural-language questions — filler words break the match, returning zero results. Lynage's `extractKeywords` strips fillers and keeps the topic term, finds the decision chunk, and narrates the full process (tried A → abandoned → chose C). This is the **retrieval robustness** advantage — on a 2,000-turn session with 4,000 messages, Lynage recovers the decision 9/10 while flat recovers nothing.

### Galgame Recall@Prompt (Narrative Fidelity)

Designed for narrative memory (Protocol Zero): how often specific plot details survive into the context handed to a story generator. Synthetic 5-chapter Chinese Galgame (205 turns), 12 details planted in chapters 1-4 (writing ch.5 requires recalling the past), `bge-small-zh` embedding (`benchmarks/galgame/recall-bench.ts`).

| Context | Recall@prompt |
|---|---|
| **Summaries only** | 83% (10/12) |
| **Summaries + raw messages** | **92%** (11/12) |

> **Summaries + source beats summaries alone because narrative detail lives in the raw dialogue; summaries are navigation, not storage** — `openSource` restoring the original lines is what makes fidelity work.

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

This is why the 10,000-turn stress test is the meaningful comparison: **Lynage keeps 100% accuracy at 1/4.7× the cost and 1/8× the tokens**, while flat systems must choose between paying more or forgetting.

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
import { LynageSdkModel } from "@lynage/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-v4-flash");
const memory = createLynageMemory({ model: new LynageSdkModel(model) });
```

**With semantic embedding (recommended):**

```ts
import { TransformersEmbedder } from "@lynage/core";

const memory = createLynageMemory({
  model: new LynageSdkModel(model),
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
  │   "What are we working on?" → directory summary match
  │   Hit rate ~30%, cost ¥0
  │
  ├─ L1: Chunk FTS + Message FTS (~6ms, 0 LLM)
  │   "TypeScript approach" → trigram keyword match
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

**L0-L2 are zero-LLM-cost fast paths.** Most queries resolve at L1-L2. L3 is reserved for genuinely ambiguous queries.

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

### MCP Server / Claude Code Integration

```bash
# Stdio mode (Claude Code default)
npx lynage-memory mcp --db ./lynage.db --provider deepseek --model deepseek-v4-flash

# HTTP mode (remote clients / browser)
npx lynage-memory serve --db ./lynage.db --port 4318
```

Claude Code config (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "lynage": {
      "command": "npx",
      "args": ["lynage-memory", "mcp", "--db", "./lynage.db", "--provider", "deepseek", "--model", "deepseek-v4-flash"]
    }
  }
}
```

6 tools provided: `lynage_memory_read` / `search` / `open_source` / `commit` / `read_user` / `stats`.

### Running Benchmarks

```bash
# 10k fair + forget stress tests (Lynage vs Flat FTS baseline)
cd benchmarks/baseline
TURNS=2000 pnpm tsx bench-10k.ts          # Lynage fair
TURNS=2000 pnpm tsx bench-flat.ts         # Flat FTS baseline
TURNS=2000 pnpm tsx bench-forget.ts       # Lynage forget (noise resilience)
TURNS=2000 pnpm tsx bench-flat-forget.ts  # Flat FTS forget baseline

# Galgame recall@prompt (plot-detail fidelity)
cd benchmarks/galgame && pnpm tsx recall-bench.ts
```

### Running Tests

```bash
pnpm test          # 56 unit tests
pnpm typecheck     # All 6 packages
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
| `benchmarks/` | Galgame recall@prompt, LoCoMo, forget/10k benchmarks |
| `docs/` | Architecture deep-dives, concept guides |

---

## 🔬 Methodology & Limitations

### Test Data

The forget-style and 10,000-turn benchmarks use **synthetic conversations with embedded fact points**. Fact keywords appear verbatim in messages, which lowers retrieval difficulty for ALL systems. These tests validate Lynage's token efficiency and retrieval robustness under controlled conditions (Lynage vs a flat FTS baseline).

The Galgame recall@prompt benchmark (`benchmarks/galgame/recall-bench.ts`) measures **plot-detail fidelity**: how often specific dialogue lines, timeline events, foreshadows, and character memories survive into the context given to a generator — the metric that matters for narrative memory (see Protocol Zero design).

### Known Limitations

- **AI summary language drift** — Chinese conversations may produce English summaries, reducing FTS recall for Chinese queries. Mitigated by message-level FTS fallback.
- **Temporal reasoning** — Questions comparing events across topics ("Which was decided first?") requires Phase 3 tree-native temporal query support.
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

## License

MIT
