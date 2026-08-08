# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**Lynage 是 AI Agent 的长期记忆库：对话原文存 SQLite，自动建摘要索引，搜索时打开原文验证。不压缩，不丢弃。**

**对话越长，传统方案只有两条路：要么全塞进上下文（token 越来越贵），要么压缩成摘要（信息永远丢失）。Lynage 给了第三条路。**

[English](README.md) · [快速开始](#-快速开始) · [为什么选 Lynage](#-为什么选-lynage) · [搜索架构](#-搜索架构) · [API](#-api-参考)

---

## 🚀 快速开始

```bash
pnpm add lynage-memory
```

```ts
import { createLynageMemory } from "lynage-memory";

const memory = createLynageMemory();

// Agent 循环
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });

// 搜索历史
const result = await memory.search({ query: "数据库方案", sessionId: threadId });
const messages = await memory.openSource(result.candidates[0].contextId);
```

**开启 AI 归档（500 轮以上推荐）：**

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
  embedder: new TransformersEmbedder(),  // bge-small-en，本地免费
});
```

---

## 💡 为什么选 Lynage

| | 向量记忆（Mem0 / Zep） | Lynage |
|---|---|---|
| 10,000 轮后 | 上下文膨胀或截断 → 丢失早期信息 | 树压缩到 ~3 层，上下文恒定 ~800 tokens |
| 信息保留 | 截断 = 永久丢失 | 消息不可变，永不丢失 |
| 搜索 | 线性扫描 | 对数深度树导航（log₂₀ N） |
| 上下文成本 | 每轮都在涨 | 固定，无论对话多长 |

### 2000 轮失忆式提问（DeepSeek V4 Flash，本仓可复现）

50 个事实嵌入 2000 轮对话，用含糊问题测试（"一开始用的什么？中间换了什么？最后定的哪个？"）：

| 指标 | Lynage | Flat FTS |
|---|---|---|
| 准确率 | **90%** (9/10) | 0% (0/10) |
| 幻觉 | 0 | 0 |
| 回答 | 完整叙述决策过程 | "历史中完全没有提到" |

Flat FTS 得 0% 因为 trigram 匹配不了自然语言填充词。Lynage 的 `extractKeywords` 剥离填充词保留主题词，找到对应 chunk，完整叙述"试 A → 弃 → 选 C"。

### Galgame 剧情保真率

205 轮中文 Galgame，12 个细节埋在前 4 章：

| 上下文 | recall@prompt |
|---|---|
| 仅摘要 | 83% |
| 摘要 + 原文 | **92%** |

摘要 + 原文 > 仅摘要，证明细节活在原始对白里。`openSource` 打开原文是保真关键。

---

## 🔍 搜索架构

分层检索 — 每层零 LLM 成本，逐层回退：

```
用户查询
  │
  ├─ L0: 目录 FTS (~1ms, 零 LLM)
  │   命中率 ~30%
  │
  ├─ L1: 分块 FTS + 消息 FTS (~6ms, 零 LLM)
  │   命中率 ~50%
  │
  ├─ L2: 语义嵌入 (~0.5ms trigram / ~30ms bge, 零 LLM)
  │   命中率 ~85%
  │
  └─ L3: LLM 重排 (~1-5s)
      命中率 ~95%
```

大部分查询在 L1-L2 解决。L3 仅用于真正模糊的查询。

---

## 📜 API 参考

| 方法 | 说明 |
|---|---|
| `memory.startTurn(sessionId, userId, input)` | 保存用户消息，返回编译上下文 |
| `turn.finish({ response })` | 保存助手回复，自动触发归档 |
| `memory.search({ query, sessionId })` | 分层搜索，返回排序候选 |
| `memory.openSource(contextId)` | 打开分块，读取原始消息 |
| `memory.commit(actions, sessionId, userId?)` | 写回工作记忆 |
| `memory.getWorkingMemory(sessionId)` | 读取当前任务状态 |
| `memory.getUserMemory(userId)` | 读取跨会话用户偏好 |
| `memory.getDirectoryTree(sessionId)` | 查看生成树结构 |

### MCP Server / Claude Code 集成

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

配置后获得 6 个工具：`lynage_memory_read` / `search` / `open_source` / `commit` / `read_user` / `stats`。

---

## 📁 仓库结构

| 目录 | 内容 |
|---|---|
| `packages/core/` | 核心：记忆、搜索、归档、压缩、验证 |
| `packages/storage-sqlite/` | SQLite + FTS5 存储 |
| `packages/adapter-ai-sdk/` | Vercel AI SDK 适配器 |
| `packages/mcp-server/` | MCP Server，跨框架 |
| `benchmarks/` | 基准测试（forget、10k、Galgame） |
| `docs/` | 架构详解、集成指南 |

### 跑基准测试

```bash
cd benchmarks/baseline
TURNS=2000 pnpm tsx bench-10k.ts    # Lynage
TURNS=2000 pnpm tsx bench-forget.ts # 失忆式提问
```

### 开发

```bash
pnpm test       # 56 项测试
pnpm typecheck  # 6 个包类型检查
```

---

## 🔬 局限性

- **AI 摘要语言漂移**：中文对话可能产英文摘要，降低中文 FTS 召回。消息级 FTS 兜底。
- **无时间推理**：跨主题对比"哪个先决定"不支持。
- **嵌入窗口 512 token**：多主题窗口中部内容排名偏低。减小 `retainTokens` 可缓解。

---

## 许可证

MIT
