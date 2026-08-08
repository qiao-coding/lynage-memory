# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**Lynage is a long-term memory store for AI agents: original messages in SQLite, auto-indexed summaries for search, open-source verification on recall. No compression, no data loss.**

**The longer the conversation, the harder the trade-off: stuff everything into context (tokens grow linearly), or compress into summaries (information is lost forever). Lynage is the third option.**

[中文](README_zh.md) · [Quick Start](#-quick-start) · [Why Lynage](#-why-lynage) · [Search](#-search-architecture) · [API](#-api-reference)

---

## 🚀 Quick Start

```bash
pnpm add lynage-memory
```

```ts
import { createLynageMemory } from "lynage-memory";

const memory = createLynageMemory();

// Agent loop
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });

// Search history
const result = await memory.search({ query: "database decision", sessionId: threadId });
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
  embedder: new TransformersEmbedder(),  // bge-small-en, local & free
});
```

---

## 💡 Why Lynage

| | Vector memory (Mem0 / Zep) | Lynage |
|---|---|---|
| 10,000 turns later | Context swells or truncates → loses early facts | Tree compresses to ~3 levels, context stays ~800 tokens |
| Information retention | Truncation = permanent loss | Messages immutable, nothing lost |
| Search | Linear scan | Logarithmic-depth tree navigation (log₂₀ N) |
| Context cost | Grows every turn | Fixed, regardless of conversation length |

### 2,000-turn Forget Benchmark (DeepSeek V4 Flash, reproducible)

50 facts embedded across 2,000 turns, queried with vague recall questions ("what did we pick? didn't we try something else first?"):

| Metric | Lynage | Flat FTS |
|---|---|---|
| Accuracy | **90%** (9/10) | 0% (0/10) |
| Hallucination | 0 | 0 |
| Answer | Full decision narrative | "Not mentioned in history" |

Flat FTS fails because trigram matching chokes on natural-language filler words. Lynage's `extractKeywords` strips fillers, keeps topic terms, finds the decision chunk, and narrates the full process (tried A → abandoned → chose C).

### Galgame Recall@Prompt

205-turn Chinese Galgame, 12 details planted in chapters 1-4:

| Context | Recall@prompt |
|---|---|
| Summaries only | 83% |
| Summaries + source | **92%** |

Source beats summaries alone — narrative detail lives in the original dialogue. `openSource` restoring raw messages is what makes fidelity work.

---

## 🔍 Search Architecture

Layered retrieval — each layer zero LLM cost, fall through only when needed:

```
User Query
  │
  ├─ L0: Directory FTS (~1ms, 0 LLM)
  │   Hit rate ~30%
  │
  ├─ L1: Chunk FTS + Message FTS (~6ms, 0 LLM)
  │   Hit rate ~50%
  │
  ├─ L2: Semantic Embedding (~0.5ms trigram / ~30ms bge, 0 LLM)
  │   Hit rate ~85%
  │
  └─ L3: LLM Rerank (~1-5s)
      Hit rate ~95%
```

Most queries resolve at L1-L2. L3 is reserved for genuinely ambiguous queries.

---

## 📜 API Reference

| Method | Description |
|---|---|
| `memory.startTurn(sessionId, userId, input)` | Save user message, return compiled context |
| `turn.finish({ response })` | Save assistant reply, auto-trigger archiving |
| `memory.search({ query, sessionId })` | Layered search, return ranked candidates |
| `memory.openSource(contextId)` | Open chunk, read original messages |
| `memory.commit(actions, sessionId, userId?)` | Write back to working memory |
| `memory.getWorkingMemory(sessionId)` | Read current task state |
| `memory.getUserMemory(userId)` | Read cross-session user preferences |
| `memory.getDirectoryTree(sessionId)` | Inspect the generation tree |

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

---

## 📁 Repository Layout

| Directory | Contents |
|---|---|
| `packages/core/` | Core: memory, search, archiving, compaction, verification |
| `packages/storage-sqlite/` | SQLite + FTS5 storage |
| `packages/adapter-ai-sdk/` | Vercel AI SDK adapter |
| `packages/mcp-server/` | MCP Server, cross-framework |
| `benchmarks/` | Forget, 10k, Galgame recall benchmarks |
| `docs/` | Architecture deep-dives, integration guides |

### Running Benchmarks

```bash
cd benchmarks/baseline
TURNS=2000 pnpm tsx bench-10k.ts    # Lynage
TURNS=2000 pnpm tsx bench-forget.ts # Forget-style
```

### Development

```bash
pnpm test       # 56 tests
pnpm typecheck  # 6 packages
```

---

## 🔬 Limitations

- **Summary language drift**: Chinese conversations may produce English summaries, reducing FTS recall. Mitigated by message-level FTS fallback.
- **No temporal reasoning**: "Which was decided first?" across topics not yet supported.
- **Embedding window 512 tokens**: Mid-window content in multi-topic chunks may rank lower. Mitigated by smaller `retainTokens`.

---

## License

MIT
