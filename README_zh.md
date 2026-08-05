# Lynage Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-blue)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

**AI Agent 长对话记忆系统 — 无限对话历史，固定 LLM 成本。**

[English](README.md) · [快速开始](#-快速开始) · [基准测试](#-基准测试结果) · [架构](docs/02-how-it-works.md) · [API](#-api-参考)


---

## 🧠 概述

Lynage 对 Agent 记忆采取了根本不同的思路。不把旧对话压缩成摘要（信息永久丢失），也不把所有内容塞进上下文窗口（Token 成本线性增长），而是构建一棵**自生长的对话分块索引树**。

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

**三个设计原则：**

1. **消息不可变** — 每条消息追加写入 SQLite，无 UPDATE、无 DELETE。原文永远可恢复。
2. **分块是导航索引，不是压缩** — AI 为每个对话片段生成结构化元数据（摘要、结论、目标、关键词）。摘要引导搜索；`source_from_id → source_to_id` 指针打开原文验证。
3. **树自动生长** — 分块超容量自动建目录，目录超容量自动升代（G0→G1→G2→...）。分支因子 B=20，10,000 个分块仅 3 层深度。

---

## 📊 基准测试结果

### LongMemEval（ICLR 2025）

LongMemEval 用 500 道精选题测试**五项核心记忆能力**。我们用**真实 `longmemeval_s_cleaned.json` 数据集**验证了 Lynage 的检索层（DeepSeek V4 Flash，每题独立 DB + AI 归档，可选 **bge-small-en 语义嵌入**）。

| 指标 | 结果 |
|---|---|
| **检索召回**（答案 chunk 进候选池） | **~100%**（带语义嵌入） |
| **10,000 轮压力测试** | **100% 准确率 + 固定成本** |

> **这证明了什么：** Lynage 的检索能从 ~40-60 个 session 的历史中找回答案 chunk —— 开启语义通道后，FTS + bge 嵌入几乎每次都能匹配到答案所在窗口。检索是检索层的职责；答案提取准确率由下游 LLM 决定，不是 Lynage 的职责。
>
> **为什么 LongMemEval 展示不了 Lynage 的树：** 每题 haystack 仅 ~115k tokens — **中等规模**检索，平面索引就够。Lynage 的树提供**对数深度搜索 + 固定上下文成本**，这在 **10,000+ 轮**才显威力（见下方压力测试）— 树把历史压缩到 ~3 层目录，LLM 上下文恒定 ~800 tokens，平面索引系统做不到。
>
> **关于时序推理：** 树结构天然编码时间线（chunk 有 `timeRange`，消息有 `createdAt`）。时间戳传给 LLM 后，时序比较变成简单日期运算：*"TypeScript 先决定，在 2024-06-11。部署平台后来在 2024-06-12。"* 无需 LLM 推理。

### 10,000 轮压力测试（DeepSeek V4 Flash）

10,000 轮对话中嵌入 50 个事实点，抽样 10 道失忆式提问。Flat FTS 是消息级关键词搜索基线（无树、无压缩）。

| 指标 | Lynage | Flat FTS（基线） |
|---|---|---|
| 准确率 | **100%** (10/10) | 100% (10/10) |
| 幻觉率 | **0%** | 0% |
| 搜索延迟 | **6ms** | 12ms |
| 输入 Token（10 题） | **2,929** | 23,564 |
| 总成本（10 题） | **¥0.006** | ¥0.028 |
| 成本比 | **1×** | 4.7× |

> 两者准确率打平 — 合成数据关键词原样出现，检索难度低。Lynage 的优势在 **Token 效率**：树结构返回精准的分块摘要而非原始消息窗口，输入 Token 减少 **8 倍**。对话越长，差距越大。

### 失忆式提问基准（噪声鲁棒性）

测试「记不清细节」的提问方式。Flat FTS 使用 `search_messages` 默认 top-5 截断。

| 指标 | Lynage | Flat FTS（基线） |
|---|---|---|
| 准确率 | **90%** (9/10) | 0% (0/10) |
| 幻觉率 | 0% | 0% |
| 回答质量 | 完整叙述决策过程 | "历史中完全没有提到" |

> Flat FTS 只返回 top-5 匹配 — 决策消息被噪声淹没（主题词出现在 98% 的对话中）。Lynage 返回所有 FTS 匹配加嵌入候选，决策分块始终在候选池中。这是**检索鲁棒性**优势，不是模型质量差异。

### Lynage 的差异化

大多数记忆系统回答的问题是"怎么检索更准？" — 向量嵌入、图谱、更好的重排。Lynage 回答了一个它们都不回答的问题：**对话永不结束时，上下文预算怎么办？**

| | 向量记忆（Mem0/Zep/MemGPT） | Lynage |
|---|---|---|
| 存储 | 平面索引增长；上下文线性膨胀 | **自生长世代树** |
| 10,000 轮后 | 上下文窗口膨胀或截断 → 丢早期事实 | 树压缩到 ~3 层；**上下文恒定 ~800 tokens** |
| 上下文成本 | 每轮都在涨 | **固定，无论对话多长** |
| 信息保留 | 截断 = 永久丢失 | 消息不可变；**永不丢失** |
| 搜索 | 线性扫描或平面向量搜索 | **对数深度树导航**（log₂₀ N） |

**树就是差异化。** 每条消息不可变（追加写、永不删除）。AI 把窗口摘要成 chunk，chunk 压缩成目录，目录压缩成世代（G0→G1→G2）。搜索只下钻相关分支 — O(log₂₀ N)，不是 O(N)。LLM 永远不看到全部历史，只看到工作记忆 + 相关 chunk 摘要 + 验证后的原文片段。

这就是为什么下面的 10,000 轮压力测试才是真正的对比：**Lynage 保持 100% 准确率，成本是平面的 1/4.7，Token 是 1/8** — 而平面系统必须在"花更多钱"和"遗忘"之间二选一。

---

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

---

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
import { AiSdkModel } from "@lynage/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const model = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-v4-flash");
const memory = createLynageMemory({ model: new AiSdkModel(model) });
```

**接入语义嵌入（推荐）：**

```ts
import { TransformersEmbedder } from "@lynage/core";

const memory = createLynageMemory({
  model: new AiSdkModel(model),
  embedder: new TransformersEmbedder(),   // bge-small-en，384 维，本地免费
});
```

> `TrigramEmbedder` 是零依赖回退方案（~0.5ms，稀疏 trigram TF-IDF）。它能桥接轻微词汇差距，但**不是语义嵌入** —— 专有名词答案（"Summer Vibes"）需要 `TransformersEmbedder`（bge-small-en），它无需字符重叠即可语义匹配。

---

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

---

## 📜 API 参考

| 方法 | 说明 |
|---|---|
| `memory.startTurn(sessionId, userId, input)` | 保存用户消息，返回编译上下文（工作记忆 + 历史） |
| `turn.finish({ response, toolCalls, toolResults })` | 保存助手回复，自动触发归档 |
| `memory.search({ query, sessionId })` | 分层搜索（L0→L3），返回排序候选 |
| `memory.openSource(contextId)` | 打开分块读取原始消息 + 父目录上下文 |
| `memory.commit(actions, sessionId, userId?)` | 增量写回工作记忆 / 用户记忆 |
| `memory.getWorkingMemory(sessionId)` | 读取当前任务状态（任务/进度/未解决） |
| `memory.getUserMemory(userId)` | 读取跨会话用户偏好 |
| `memory.getDirectoryTree(sessionId)` | 查看生成树结构 |

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
cd benchmarks/longmemeval

# 1. 生成 mock 数据（或下载真实数据集）
pnpm tsx ../data/generate-mock.ts

# 2. 预摄入对话到 Lynage
pnpm tsx setup.ts

# 3. 用 Promptfoo 评测
pnpm tsx eval.ts                 # 5 题 (mock)
QUESTIONS=500 pnpm tsx eval.ts   # 500 题 (真实数据集)
```

### 跑测试

```bash
pnpm test          # 45/45 单元测试
pnpm typecheck     # 7 包全部通过
```

---

## 📁 仓库结构

| 目录 | 内容 |
|---|---|
| `packages/core/` | 核心逻辑 — 记忆、搜索、归档、升代、验证、编译（13 模块） |
| `packages/storage-sqlite/` | SQLite + FTS5 — 7 张表、WAL 模式、trigram 索引 |
| `packages/adapter-ai-sdk/` | Vercel AI SDK 适配 — 5 个 Agent 工具 |
| `packages/mcp-server/` | MCP Server — 6 个工具，跨框架 |
| `apps/test-runner/` | E2E 测试管线（DeepSeek V4 Flash） |
| `benchmarks/` | LongMemEval 集成、LoCoMo、失忆/10k 基准 |
| `docs/` | 架构深入、概念指南 |

---

## 🔬 方法论与局限

### 测试数据

失忆式提问和 10,000 轮基准使用**嵌入事实点的合成对话**。事实关键词直接出现在消息中，降低了所有系统的检索难度。这些测试验证受控条件下 Lynage 的 Token 效率和检索鲁棒性（对比 Flat FTS 基线）。

LongMemEval 集成使用**标准化基准数据**（ICLR 2025，`longmemeval_s_cleaned.json`），提供外部验证的结果。评测 pipeline 完整可用（`benchmarks/longmemeval/eval-500.ts`），真实数据结果见上方基准部分。

### 已知局限

- **AI 摘要语言漂移** — 中文对话可能生成英文摘要，降低中文查询的 FTS 召回率。通过消息级 FTS 回退缓解。
- **时序推理** — 跨主题比较（"先决定哪个？"）需要 Phase 3 树原生时序查询支持。
- **英文关键词提取** — Phase 1 修复（2026-07）；此前英文停用词未被过滤。
- **嵌入上下文窗口** — bge-small-en 上下文 512 token，chunk 的嵌入由摘要 + 消息头尾构成。答案埋在重度多主题窗口中间时排名可能偏低；缩小 chunk（降低 `retainTokens`）可缓解。
- **Sharp 依赖** — Transformers.js（bge-small-en）在某些平台可能需要 `sharp`；不可用时回退 `TrigramEmbedder`（纯 TypeScript，仅词汇匹配）。

---

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
