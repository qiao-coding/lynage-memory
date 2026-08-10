# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**Lynage 是给会讲故事的 AI Agent 用的剧情记忆工具。写小说、做 Galgame、跑长线互动剧情时，它让 Agent 记得住每一处剧情细节——谁说过什么、埋了什么伏笔、时间线走到哪了。剧情再长，细节不丢，上下文成本不涨。**

[English](README.md) · [快速开始](#-快速开始) · [剧情保真率](#-剧情保真率) · [怎么做到的](#-怎么做到的) · [API](#-api-参考)

---

## 🎭 为什么剧情 Agent 需要 Lynage

写长故事的 Agent 有一个绕不开的难题：**剧情需要前后一致，但记忆会断层。**

写第 5 章时，要记得第 1 章的台词、第 2 章埋的伏笔、第 3 章定下的时间线。一旦记错，就是——角色名前后不一致、伏笔收不回来、时间线对不上。读者立刻出戏。

传统记忆方案在这里都会失败：

| 方案 | 剧情场景下的问题 |
|---|---|
| **全塞进上下文** | 剧情越长，token 越贵；总有一天塞不下，只能截断，早期剧情被扔 |
| **压缩成摘要** | 细节活在原文对白里，摘要把"那晚的月亮"压成"场景描写"，伏笔和细节永久丢失 |
| **向量记忆** | 存得下，但检索是"找相似"——剧情细节是精确的事实，不是相似语义 |

**Lynage 给的第三条路：原文一字不差地存，按剧情片段建索引，写新章节时把相关原文捞回来。** 细节永远在，成本不随剧情长度增长。

---

## 📖 剧情保真率（核心指标）

衡量一个剧情记忆工具是否合格，只有一个标准：**写新章节时，过去埋下的剧情细节有多少能进到生成器的上下文里。**

合成 5 章中文 Galgame（205 轮），12 个剧情细节埋在前 4 章（第 5 章必须回忆前文才能写），用 `bge-small-zh` 嵌入（`benchmarks/galgame/recall-bench.ts`）：

| 上下文 | 剧情保真率 |
|---|---|
| **仅摘要** | 83%（10/12） |
| **摘要 + 原始消息** | **92%（11/12）** |

按细节类型（摘要 + 原文）：**台词 100% · 时间线 100% · 伏笔 100%**。

> **摘要 + 原文 > 仅摘要，证明剧情细节活在原始对白里，摘要只是导航不是存储。** Lynage 的 `openSource` 把原文捞回来，是保真的关键。把剧情细节提炼成角色画像属于 Agent 层职责，Lynage 只负责把原文完整交出去。

---

## 🧠 怎么做到的

Lynage 不压缩、不截断，而是构建一棵**自生长的剧情分块索引树**：

```
                     ┌──────────────────────────┐
                     │     G2: 全局概览          │
                     │  "Project Alpha: 技术选型  │
                     │   历经3次重大方向调整..."   │
                     └──────────┬───────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
     ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼───────┐
     │  G1: 章节A       │ │ G1: 章节B   │ │ G1: 角色线C   │
     │  开场·伏笔1      │ │ 冲突·伏笔2  │ │ 关系变化       │
     └────────┬────────┘ └──────┬──────┘ └───────┬───────┘
              │                 │                 │
     ┌────────▼────────┐        ...               ...
     │ G0 剧情片段 (12)  │
     │ 含原文消息指针    │
     └─────────────────┘
```

**三个设计原则：**

1. **剧情原文不可变** — 每一句对白追加写入 SQLite，永不修改、永不删除。原文永远可恢复。
2. **分块是导航索引，不是压缩** — AI 为每个剧情片段生成结构化元数据（摘要、结论、目标、关键词），比如"伏笔：窗外那棵树"。摘要引导搜索；指针打开原文验证。
3. **树自动生长** — 片段超容量自动建目录，目录超容量自动升代（G0→G1→G2→...）。剧情多长都不会失控。

---

## 🚀 快速开始

```bash
pnpm add lynage-memory
```

```ts
import { createLynageMemory } from "lynage-memory";

// 一行初始化 — SQLite 自动创建
const memory = createLynageMemory();

// 剧情生成 Agent 的每一轮
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });

// 写新章节前，捞回相关剧情
const result = await memory.search({ query: "伏笔 窗外那棵树", sessionId: threadId });
const messages = await memory.openSource(result.candidates[0].contextId);
```

**开启 AI 归档（推荐 500 轮以上）：**

```ts
import { LynageSdkModel } from "@lynage/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-v4-flash");
const memory = createLynageMemory({ model: new LynageSdkModel(model) });
```

**开启语义嵌入：**

```ts
import { TransformersEmbedder } from "@lynage/core";

const memory = createLynageMemory({
  model: new LynageSdkModel(model),
  embedder: new TransformersEmbedder(),   // bge-small-en/zh，本地免费
});
```

---

## 🔍 搜索架构

分层检索 — 大部分查询零 LLM 成本，逐层回退：

```
用户查询
  │
  ├─ L0: 目录 FTS (~1ms, 零 LLM)   "当前主线到哪了?" → 命中 ~30%
  ├─ L1: 分块 FTS + 消息 FTS (~6ms, 零 LLM)   "窗外那棵树" → 命中 ~50%
  ├─ L2: 语义嵌入 (~30ms, 零 LLM)  "那段夜谈" ≈ "雨夜对话" → 命中 ~85%
  └─ L3: LLM 重排 (~1-5s)         "谁在开头立下了那个约定?" → 命中 ~95%
```

大部分查询在 L1-L2 解决。L3 仅用于真正模糊的查询。

---

## 📜 API 参考

| 方法 | 说明 |
|---|---|
| `memory.startTurn(sessionId, userId, input)` | 保存用户消息，返回编译上下文 |
| `turn.finish({ response })` | 保存助手回复，自动触发归档 |
| `memory.search({ query, sessionId })` | 分层搜索，返回排序候选 |
| `memory.openSource(contextId)` | 打开剧情片段，读取原始消息 |
| `memory.commit(actions, sessionId, userId?)` | 写回工作记忆 |
| `memory.getDirectoryTree(sessionId)` | 查看剧情索引树结构 |

### MCP Server / Claude Code

```bash
npx lynage-memory mcp --db ./lynage.db --provider deepseek --model deepseek-v4-flash
```

Claude Code 配置（`.claude/settings.json`）：

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

配置后获得 6 个记忆工具：`lynage_memory_read` / `search` / `open_source` / `commit` / `read_user` / `stats`。

### 跑剧情保真率基准

```bash
cd benchmarks/galgame && pnpm tsx recall-bench.ts
```

### 跑测试

```bash
pnpm test       # 56 单元测试
pnpm typecheck  # 6 包全部通过
```

---

## 📁 仓库结构

| 目录 | 内容 |
|---|---|
| `packages/core/` | 核心逻辑 — 记忆、搜索、归档、升代、验证 |
| `packages/storage-sqlite/` | SQLite + FTS5 — 7 张表、WAL 模式、trigram 索引 |
| `packages/adapter-ai-sdk/` | Vercel AI SDK 适配 |
| `packages/mcp-server/` | MCP Server，跨框架 |
| `benchmarks/` | Galgame 剧情保真率、LoCoMo、失忆/10k 基准 |
| `docs/` | 架构深入、概念指南 |

---

## 🔬 已知局限

- **AI 摘要语言漂移** — 中文对话可能生成英文摘要，降低中文查询召回。消息级 FTS 兜底。
- **嵌入窗口 512 token** — 重度多主题片段中部细节排名可能偏低。
- **时序推理** — "哪个伏笔先埋的？"这类跨主题时间比较尚不支持。

---

## 许可证

MIT
