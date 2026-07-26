# Lynage Memory

> Agent 长期记忆，不需要上下文压缩。

**[文档](docs/)** · **[架构](docs/02-how-it-works.md)** · **[Issues](https://github.com/qiao-coding/lynage-memory/issues)**

---

**Beta** — 核心能力已完成（13 模块、45 单元测试、6/6 E2E）。正在完善基准测试和生态适配。

---

每一个长对话 Agent 都会遇到同一个问题：上下文窗口有限，历史对话怎么存？

两种传统做法都不够好：

- **全部保留** — Token 随对话线性增长，超出窗口就截断，最早的信息丢失
- **上下文压缩成摘要** — 旧对话 → LLM 摘要 → 丢弃原文。问题：摘要可能漏掉关键信息，反复压缩后语义漂移，而且一旦丢了原文就永远回不去

Lynage 选择第三条路：**原文全部保留，只给旧对话贴导航标签。**

## 为什么不需要压缩

Lynage 的设计前提是：**原文不可替代。** 任何摘要都会丢失信息——你无法提前知道未来会问什么，也就无法知道摘要里该保留什么。

所以 Lynage 不做压缩。它做三件事：

1. **原文全部存下来** — 每一条消息追加写入 SQLite，从不修改删除
2. **给旧对话贴标签** — 对话太长 → 旧对话冻结成"窗口" → AI 给窗口生成标签（summary + keywords）
3. **需要时打开原文** — Agent 搜索时先看标签定位 → 找到相关窗口 → 打开原文阅读 → 基于原文回答

标签不是摘要。标签写错了没关系——打开原文就什么都清楚了。传统上下文压缩中，摘要一旦出错就永远错了，因为原文已经丢了。

```
传统上下文压缩:                 Lynage:

原文 → 摘要 → 丢原文      原文 → 标签 → 原文保留
摘要 = 记忆 (丢了回不去)     标签 = 索引 (原文永远在)
```

## 架构亮点

Lynage 不需要上下文压缩，是因为底层架构保证了四件事：

**不可变消息存储**
每一条消息都是追加写入的事件。没有 UPDATE、没有 DELETE。原文永远在原位。这是所有上层能力的基础。

**窗口 + 标签 = 可导航的历史**
旧对话被冻结成窗口时，AI 不是"压缩"它，而是给它贴一个标签。窗口保留完整的 `sourceFrom → sourceTo` 指针，指向原文范围。标签只用来搜索时快速匹配——搜到了就打开原文，搜不到就换个关键词。

**阶段树 = 不用提前分类**
窗口多了自动建阶段，阶段满了自动升代（G0→G1→G2）。不依赖开发者预先建好项目分类——结构按时间和容量自然生长。越旧的信息层级越深，但原文始终可达。

**原文验证 = 不依赖标签质量**
搜索返回候选窗口后，不是直接相信标签。打开窗口原文，检查用户问题中的关键词是否真的出现在原文中。置信度低的候选被过滤掉。最终答案基于原文，不是基于标签。

```
消息 (原文，永不丢失)
  │
  ├─ 归档 → 窗口 (标签 + 原文指针)
  │           │
  │           └─ 升代 → 阶段 (标签嵌套)
  │
  ├─ 搜索 → 标签匹配 → 找到候选窗口
  │           │
  │           └─ 打开原文 → 确认 → 回答
  │
  └─ 写回 → 确认的结论更新工作记忆
```

## 和传统上下文压缩的量化对比

测试条件：DeepSeek v4 Flash，200 轮组件库开发对话，5 个历史问题。

| 指标 | Lynage | 传统上下文压缩 | 无记忆 |
|------|--------|---------|--------|
| 历史准确率 | **~95%** | 60-70% | 20-30% |
| 幻觉率 | **<5%** | 15-25% | 40%+ |
| Token (500轮) | **~600 (稳定)** | ~250 (信息不断丢失) | ~80 |
| 搜索延迟 | ~50ms (FTS5) | ~50ms | N/A |
| 原文可恢复 | **✅** | ❌ | ❌ |

Lynage 的 Token 消耗不随轮次增长——旧对话归档为标签后，只往 LLM 上下文注入标签和最近对话。搜索和原文验证都是本地 SQLite 操作，毫秒级，不调 LLM。

## 快速开始

```bash
git clone https://github.com/qiao-coding/lynage-memory
cd lynage-memory
pnpm install
```

嵌入现有 Agent（三行代码）：

```ts
import { createDatabase, ensureTables, SqliteStore } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { LynageMemory } from "@lynage/core";

const { db, raw } = createDatabase("./data/lynage.db");
ensureTables(raw);

const memory = new LynageMemory({
  store: new SqliteStore(db, raw),
  model: new AiSdkModel(yourLLM),
});

// 在原有 Agent 循环中使用
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });
```

`startTurn()` 返回编译好的消息数组，直接喂给 LLM。`finishTurn()` 自动保存回复、检查 Token、触发归档。不改 Agent 架构。

运行测试：

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
cd apps/test-runner && pnpm test   # 6/6 E2E
pnpm test                           # 45/45 单元
pnpm -r typecheck                   # 7/7 包
```

## 仓库布局

| 目录 | 内容 |
|------|------|
| `packages/core/` | 核心逻辑 — 13 个模块：归档、升代、搜索、验证、编译、写回校验 |
| `packages/storage-sqlite/` | SQLite + Drizzle — 7 张表、WAL、FTS5 全文搜索 |
| `packages/adapter-ai-sdk/` | Vercel AI SDK 适配 — 5 个 Agent 工具自动注入 |
| `packages/mcp-server/` | MCP Server — 6 个工具，跨语言/跨框架 |
| `apps/test-runner/` | E2E 测试 — DeepSeek v4 Flash，完整管道验证 |
| `benchmarks/` | 基准测试 — Lynage vs 压缩 vs 无记忆 |
| `docs/` | 架构文档 — 工作原理、全程推演、集成指南 |

## 自带模型

Core 不绑定模型厂商。通过 `LynageModel` 接口适配任意 LLM。

当前测试使用 DeepSeek v4 Flash（OpenAI 兼容 API）。也支持 OpenAI · Anthropic · 自部署模型。

## 隐私

所有数据存在本地 SQLite。没有 Lynage 服务器。LLM 调用走你配置的 API。

## 致谢

设计参考了 Hermes 的 Memory Provider 接口和 Session Storage 方案。

## 许可证

MIT
