# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**让 AI 不会忘记你们聊过什么。对话再长，始终能找到当时的原文 — 不丢信息、不靠摘要瞎猜、上下文大小始终保持固定。**

[English](README.md) · [快速开始](#-quick-start) · [基准测试](#-benchmark-results) · [架构](docs/02-how-it-works.md) · [API](#-api-reference)

***

## 🧠 概述

Lynage 是**记忆基础设施层，不是推理层**。它保证 Agent 从记忆里需要的东西：原文永不丢失、可被自生长的树导航、按需高保真召回。

Lynage 对 Agent 记忆采取了根本不同的思路。不把旧对话压缩成摘要（信息永久丢失），也不把所有内容塞进上下文窗口（Token 成本线性增长），而是构建一棵**自生长的对话分块索引树**。

```
                     ┌──────────────────────────┐
                     │     G2: 全局压缩目录       │
                     │  "Project Alpha: 技术选型  │
                     │   历经3次重大方向调整..."   │
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

**三个设计原则：**

1. **消息不可变** — 每条消息追加写入 SQLite，无 UPDATE、无 DELETE。原文永远可恢复。
2. **分块是导航索引，不是压缩** — AI 为每个对话片段生成结构化元数据（摘要、结论、目标、关键词）。摘要引导搜索；`source_from_id → source_to_id` 指针打开原文验证。
3. **树自动生长** — 分块超容量自动建目录，目录超容量自动升代（G0→G1→G2→...）。分支因子 B=20，10,000 个分块仅 3 层深度。

***

## 📊 基准测试结果

### 10,000 轮压力测试（DeepSeek V4 Flash，2,000 轮验证）

50 个事实点嵌入 2,000 轮对话，抽样 10 道失忆式提问。**本仓可复现**：Lynage 用树摘要作答（`benchmarks/baseline/bench-10k.ts`）；Flat FTS 基线用 `search_messages` top-5（`bench-flat.ts`）。

**失忆式提问基准**（决策过程埋在噪声里："怎么定的？是不是先试了别的？最后选哪个？"）：

| 指标   | Lynage         | Flat FTS（基线） |
| ---- | -------------- | ------------ |
| 准确率  | **90%** (9/10) | 0% (0/10)    |
| 幻觉率  | 0              | 0            |
| 回答质量 | 完整叙述决策过程       | "历史中完全没有提到"  |

> Flat FTS 得 **0%**，因为 `search_messages` 的 trigram FTS 解析不了含糊自然语言问句（"记不太清了…是不是…怎么定的"）—— 填充词破坏了匹配，返回 0 条。Lynage 的 `extractKeywords` 剥离填充词保留主题词，找到决策 chunk，完整叙述"试 A → 弃 → 选 C"过程。在 2,000 轮 / 4,000 消息的会话里，Lynage 9/10 找回决策，Flat 一无所获。这是**检索鲁棒性**优势，不是模型质量差异。

### Galgame 剧情保真率（recall\@prompt）

为叙事记忆设计：具体剧情细节有多少能进入给生成器的上下文。合成 5 章中文 Galgame（205 轮），12 个细节埋在前 4 章（写第 5 章需回忆过去），`bge-small-zh` 嵌入（`benchmarks/galgame/recall-bench.ts`）。

| 上下文           | recall\@prompt |
| ------------- | -------------- |
| **仅摘要**       | 83%（10/12）     |
| **摘要 + 原始消息** | **92%**（11/12） |

> **摘要 + 原文高于仅摘要，说明剧情细节活在原始对白里，摘要是导航不是存储** —— Lynage 的 `openSource` 恢复原文是保真的关键。

### Lynage 的差异化

大多数记忆系统回答的问题是"怎么检索更准？" — 向量嵌入、图谱、更好的重排。Lynage 回答了一个它们都不回答的问题：**对话永不结束时，上下文预算怎么办？**

| <br />    | 向量记忆（Mem0/Zep/MemGPT） | Lynage                            |
| --------- | --------------------- | --------------------------------- |
| 存储        | 平面索引增长；上下文线性膨胀        | **自生长分块索引树**                      |
| 10,000 轮后 | 上下文窗口膨胀或截断 → 丢早期事实    | 树压缩到 \~3 层；**上下文恒定 \~800 tokens** |
| 上下文成本     | 每轮都在涨                 | **固定，无论对话多长**                     |
| 信息保留      | 截断 = 永久丢失             | 消息不可变；**永不丢失**                    |
| 搜索        | 线性扫描或平面向量搜索           | **对数深度树导航**（log₂₀ N）              |

**树就是差异化。** 每条消息不可变（追加写、永不删除）。AI 把窗口摘要成 chunk，chunk 压缩成目录，目录压缩成世代（G0→G1→G2）。搜索只下钻相关分支 — O(log₂₀ N)，不是 O(N)。LLM 永远不看到全部历史，只看到工作记忆 + 相关 chunk 摘要 + 验证后的原文片段。

这就是为什么下面的 10,000 轮压力测试才是真正的对比：**Lynage 保持 100% 准确率，成本是平面的 1/4.7，Token 是 1/8** — 而平面系统必须在"花更多钱"和"遗忘"之间二选一。

***

## 🛠️ 环境配置

### 安装

```bash
pnpm add lynage-memory
```

### 环境变量

```bash
# AI 归档和搜索必需
export DEEPSEEK_API_KEY="sk-..."

# 可选：其他模型厂商
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-..."
```

***

## 🚀 快速开始

```ts
import { createLynageMemory } from "lynage-memory";

// 一行初始化 — SQLite 自动创建
const memory = createLynageMemory();

// Agent 循环中使用
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });

// 搜索对话历史
const result = await memory.search({ query: "数据库方案", sessionId: threadId });
const messages = await memory.openSource(result.candidates[0].contextId);
```

**接入 AI 归档（推荐 500 轮以上对话）：**

```ts
import { LynageSdkModel } from "@lynage/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-v4-flash");
const memory = createLynageMemory({ model: new LynageSdkModel(model) });
```

**接入语义嵌入（推荐）：**

```ts
import { TransformersEmbedder } from "@lynage/core";

const memory = createLynageMemory({
  model: new LynageSdkModel(model),
  embedder: new TransformersEmbedder(),   // bge-small-en，384 维，本地免费
});
```

> `TrigramEmbedder` 是零依赖回退方案（\~0.5ms，稀疏 trigram TF-IDF）。它能桥接轻微词汇差距，但**不是语义嵌入** —— 专有名词答案（"Summer Vibes"）需要 `TransformersEmbedder`（bge-small-en），它无需字符重叠即可语义匹配。

***

## 🔍 搜索架构

Lynage 使用**分层检索** — 每层增加能力，逐层回退：

```
用户查询
  │
  ├─ L0: 目录 FTS (~1ms, 零 LLM)
  │   "最近在做什么?" → 目录摘要匹配
  │   命中率 ~30%, 成本 ¥0
  │
  ├─ L1: 分块 FTS + 消息 FTS (~6ms, 零 LLM)
  │   "TypeScript方案" → trigram 关键词匹配
  │   命中率 ~50%, 成本 ¥0
  │
  ├─ L2: 语义嵌入 (~0.5ms trigram / ~30ms bge, 零 LLM)
  │   "部署平台" ≈ "deployment strategy" → 余弦相似度
  │   命中率 ~85%（合并）, 成本 ¥0
  │
  └─ L3: LLM 重排 + 目录导航 (~1-5s, 1 次 LLM 调用)
      "为什么放弃 Docker 选 Vercel？" → 语义相关性
      命中率 ~95%, 成本 ~¥0.01
```

**L0-L2 是零 LLM 成本的快速路径。** 大部分查询在 L1-L2 解决。L3 仅用于真正模糊、需要语义理解的查询。

***

## 📜 API 参考

| 方法                                                  | 说明                        |
| --------------------------------------------------- | ------------------------- |
| `memory.startTurn(sessionId, userId, input)`        | 保存用户消息，返回编译上下文（工作记忆 + 历史） |
| `turn.finish({ response, toolCalls, toolResults })` | 保存助手回复，自动触发归档             |
| `memory.search({ query, sessionId })`               | 分层搜索（L0→L3），返回排序候选        |
| `memory.openSource(contextId)`                      | 打开分块读取原始消息 + 父目录上下文       |
| `memory.commit(actions, sessionId, userId?)`        | 增量写回工作记忆 / 用户记忆           |
| `memory.getWorkingMemory(sessionId)`                | 读取当前任务状态（任务/进度/未解决）       |
| `memory.getUserMemory(userId)`                      | 读取跨会话用户偏好                 |
| `memory.getDirectoryTree(sessionId)`                | 查看生成树结构                   |

### MCP Server / Claude Code 集成

一行命令接入：

```bash
# Stdio 模式（Claude Code 默认）
npx lynage-memory mcp --db ./lynage.db --provider deepseek --model deepseek-v4-flash

# HTTP 模式（远程客户端 / 浏览器）
npx lynage-memory serve --db ./lynage.db --port 4318
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

配置后自动获得 6 个记忆工具：`lynage_memory_read` / `search` / `open_source` / `commit` / `read_user` / `stats`。

### 跑基准测试

```bash
# 10k 压力测试 + forget 基准（Lynage vs Flat FTS 基线）
cd benchmarks/baseline
TURNS=2000 pnpm tsx bench-10k.ts          # Lynage fair
TURNS=2000 pnpm tsx bench-flat.ts         # Flat FTS 基线
TURNS=2000 pnpm tsx bench-forget.ts       # Lynage forget（噪声鲁棒）
TURNS=2000 pnpm tsx bench-flat-forget.ts  # Flat FTS forget 基线

# Galgame 剧情保真率（recall@prompt）
cd benchmarks/galgame && pnpm tsx recall-bench.ts
```

### 跑测试

```bash
pnpm test          # 45/45 单元测试
pnpm typecheck     # 7 包全部通过
```

***

## 📁 仓库结构

| 目录                         | 内容                                     |
| -------------------------- | -------------------------------------- |
| `packages/core/`           | 核心逻辑 — 记忆、搜索、归档、升代、验证、编译（13 模块）        |
| `packages/storage-sqlite/` | SQLite + FTS5 — 7 张表、WAL 模式、trigram 索引 |
| `packages/adapter-ai-sdk/` | Vercel AI SDK 适配 — 5 个 Agent 工具        |
| `packages/mcp-server/`     | MCP Server — 6 个工具，跨框架                 |
| `apps/test-runner/`        | E2E 测试管线（DeepSeek V4 Flash）            |
| `benchmarks/`              | Galgame 剧情保真率、LoCoMo、失忆/10k 基准         |
| `docs/`                    | 架构深入、概念指南                              |

***

## 🔬 方法论与局限

### 测试数据

失忆式提问和 10,000 轮基准使用**嵌入事实点的合成对话**。事实关键词直接出现在消息中，降低了所有系统的检索难度。这些测试验证受控条件下 Lynage 的 Token 效率和检索鲁棒性（对比 Flat FTS 基线）。

Galgame 剧情保真率评测（`benchmarks/galgame/recall-bench.ts`）测量**剧情细节保真**：具体台词、时间线事件、伏笔、角色记忆有多少比例能进入给生成器的上下文 —— 这是叙事记忆真正该测的指标。

### 已知局限

- **AI 摘要语言漂移** — 中文对话可能生成英文摘要，降低中文查询的 FTS 召回率。通过消息级 FTS 回退缓解。
- **时序推理** — 跨主题比较（"先决定哪个？"）需要 Phase 3 树原生时序查询支持。
- **英文关键词提取** — Phase 1 修复（2026-07）；此前英文停用词未被过滤。
- **嵌入上下文窗口** — bge-small-en 上下文 512 token，chunk 的嵌入由摘要 + 消息头尾构成。答案埋在重度多主题窗口中间时排名可能偏低；缩小 chunk（降低 `retainTokens`）可缓解。
- **Sharp 依赖** — Transformers.js（bge-small-en）在某些平台可能需要 `sharp`；不可用时回退 `TrigramEmbedder`（纯 TypeScript，仅词汇匹配）。

***

## 📄 引用

```bibtex
@software{lynage_memory,
  author = {qiao-coding},
  title = {Lynage Memory: 面向 AI Agent 的长对话记忆系统},
  year = {2026},
  url = {https://github.com/qiao-coding/lynage-memory},
}
```

## 许可证

MIT
