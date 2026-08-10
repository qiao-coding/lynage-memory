# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**Lynage is a story memory tool for agents that tell stories. Writing a novel, building a Galgame, or running a long interactive narrative — Lynage keeps every plot detail: who said what, what foreshadowing was planted, where the timeline stands. No matter how long the story gets, details survive and context costs stay flat.**

[中文](README_zh.md) · [Quick Start](#-quick-start) · [Narrative Fidelity](#-narrative-fidelity) · [How It Works](#-how-it-works) · [API](#-api-reference)

---

## 🎭 Why Story Agents Need Lynage

Long-form storytelling has one unavoidable problem: **plots must stay consistent, but memory fails.**

Writing chapter 5 means remembering chapter 1's dialogue, the foreshadowing planted in chapter 2, the timeline established in chapter 3. Get it wrong and you get — characters changing names mid-story, foreshadows never paying off, timelines that contradict themselves. The reader breaks immersion instantly.

Traditional memory approaches all fail here:

| Approach | Failure in narrative |
|---|---|
| **Stuff everything into context** | The longer the story, the more it costs; eventually it can't fit and truncates, dropping early chapters |
| **Compress into summaries** | Detail lives in the raw dialogue; summaries flatten "the moon that night" into "scene description" — foreshadows and nuance lost forever |
| **Vector memory** | Stores everything, but retrieval is "find something similar" — plot details are exact facts, not similar semantics |

**Lynage is the third way: store the original text verbatim, index it by story segment, and retrieve the relevant raw passages when writing new chapters.** Detail is never lost, cost never grows with story length.

---

## 📖 Narrative Fidelity (The Core Metric)

There's only one standard that matters: **when writing a new chapter, how much of the previously planted plot survives into the generator's context.**

A synthetic 5-chapter Chinese Galgame (205 turns), 12 plot details planted in chapters 1-4 (chapter 5 requires recalling the past to write), `bge-small-zh` embedding (`benchmarks/galgame/recall-bench.ts`):

| Context | Recall@prompt |
|---|---|
| **Summaries only** | 83% (10/12) |
| **Summaries + raw messages** | **92% (11/12)** |

By detail type (full context): **Dialogue 100% · Timeline 100% · Foreshadowing 100%**.

> **Source beats summaries alone because plot detail lives in the raw dialogue; summaries are navigation, not storage.** `openSource` restoring the original lines is what makes fidelity work. Distilling plot details into character profiles is the agent layer's job — Lynage's job is delivering the original text intact.

---

## 🧠 How It Works

Lynage doesn't compress or truncate. It builds a **self-growing tree of indexed story segments**:

```
                     ┌──────────────────────────┐
                     │     G2: Global Overview   │
                     │  "Project Alpha: tech stack│
                     │   went through 3 pivots..."│
                     └──────────┬───────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
     ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼───────┐
     │ G1: Chapter A    │ │ G1: Chapter B│ │ G1: Character │
     │  Opening·Foreshadow 1 │ │ Conflict·Foreshadow 2 │ │  Relationship shifts │
     └────────┬────────┘ └──────┬──────┘ └───────┬───────┘
              │                 │                 │
     ┌────────▼────────┐        ...               ...
     │ G0 story segments (12) │
     │ w/ source message ptrs │
     └─────────────────┘
```

**Three design principles:**

1. **Story text is immutable** — Every line of dialogue is appended to SQLite. No UPDATE, no DELETE. Original text is always recoverable.
2. **Chunks are navigation indexes, not compression** — AI summarizes each story segment into structured metadata (summary, conclusions, goals, keywords), e.g. "foreshadow: the tree outside the window". Summaries guide search; pointers open original messages for verification.
3. **The tree grows automatically** — When segments exceed capacity, they form a directory. When directories exceed capacity, they compact to the next generation (G0→G1→G2→...). The story can grow forever without losing control.

---

## 🚀 Quick Start

```bash
pnpm add lynage-memory
```

```ts
import { createLynageMemory } from "lynage-memory";

// One-line setup — SQLite auto-created
const memory = createLynageMemory();

// Every turn of your story-generation agent
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });

// Before writing a new chapter, recall related plot
const result = await memory.search({ query: "foreshadowing tree outside window", sessionId: threadId });
const messages = await memory.openSource(result.candidates[0].contextId);
```

**With AI archiving (recommended for 500+ turns):**

```ts
import { LynageSdkModel } from "@lynage/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-v4-flash");
const memory = createLynageMemory({ model: new LynageSdkModel(model) });
```

**With semantic embedding:**

```ts
import { TransformersEmbedder } from "@lynage/core";

const memory = createLynageMemory({
  model: new LynageSdkModel(model),
  embedder: new TransformersEmbedder(),   // bge-small-en/zh, local & free
});
```

---

## 🔍 Search Architecture

Layered retrieval — most queries cost zero LLM, falling through only when needed:

```
User Query
  │
  ├─ L0: Directory FTS (~1ms, 0 LLM)   "where is the main plot now?" → hit ~30%
  ├─ L1: Chunk FTS + Message FTS (~6ms, 0 LLM)   "tree outside window" → hit ~50%
  ├─ L2: Semantic Embedding (~30ms, 0 LLM)   "that night talk" ≈ "rainy dialogue" → hit ~85%
  └─ L3: LLM Rerank (~1-5s)   "who made the promise in the opening?" → hit ~95%
```

Most queries resolve at L1-L2. L3 is reserved for genuinely ambiguous queries.

---

## 📜 API Reference

| Method | Description |
|---|---|
| `memory.startTurn(sessionId, userId, input)` | Save user message, return compiled context |
| `turn.finish({ response })` | Save assistant reply, auto-trigger archiving |
| `memory.search({ query, sessionId })` | Layered search, return ranked candidates |
| `memory.openSource(contextId)` | Open story segment, read original messages |
| `memory.commit(actions, sessionId, userId?)` | Write back to working memory |
| `memory.getDirectoryTree(sessionId)` | Inspect the story index tree |

### MCP Server / Claude Code

```bash
npx lynage-memory mcp --db ./lynage.db --provider deepseek --model deepseek-v4-flash
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

### Running the Narrative Fidelity Benchmark

```bash
cd benchmarks/galgame && pnpm tsx recall-bench.ts
```

### Running Tests

```bash
pnpm test       # 56 unit tests
pnpm typecheck  # 6 packages
```

---

## 📁 Repository Layout

| Directory | Contents |
|---|---|
| `packages/core/` | Core logic — memory, search, archiving, compaction, verification |
| `packages/storage-sqlite/` | SQLite + FTS5 — 7 tables, WAL mode, trigram indexes |
| `packages/adapter-ai-sdk/` | Vercel AI SDK adapter |
| `packages/mcp-server/` | MCP Server, cross-framework |
| `benchmarks/` | Galgame recall@prompt, LoCoMo, forget/10k benchmarks |
| `docs/` | Architecture deep-dives, concept guides |

---

## 🔬 Known Limitations

- **Summary language drift** — Chinese conversations may produce English summaries, reducing recall for Chinese queries. Mitigated by message-level FTS fallback.
- **Embedding window 512 tokens** — Mid-segment details in heavily multi-topic windows may rank lower.
- **No temporal reasoning** — "Which foreshadow came first?" across topics not yet supported.

---

## License

MIT
