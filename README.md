# Lynage Memory

> Agent 长期记忆模块。保存每一句原文，给旧对话贴标签方便查找，需要时打开原文确认。**标签是索引，原文才是记忆。**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-orange)](https://pnpm.io/)
[![Vitest](https://img.shields.io/badge/test-22/22-green)](https://vitest.dev/)
[![E2E](https://img.shields.io/badge/e2e-6/6-green)]()

---

## 和传统压缩的区别

```
传统压缩:                 Lynage:

原文 → 摘要 → 丢原文      原文 → 标签 → 原文保留
摘要就是记忆              标签只是索引，原文才是记忆
(丢了回不去)              (随时可以回去读)
```

**Lynage 不替代原文。它只帮你在一堆对话里快速找到相关的那一段，然后让你自己读原文确认。**

---

## 快速开始

### 安装

```bash
git clone https://github.com/qiao-coding/lynage-memory.git
cd lynage-memory && pnpm install
```

### 嵌入现有 Agent（三行代码）

```ts
import { createDatabase, ensureTables, SqliteStore } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { LynageMemory } from "@lynage/core";

// 1. 创建存储（SQLite，零配置）
const { db, raw } = createDatabase("./data/lynage.db");
ensureTables(raw);

// 2. 创建记忆实例
const memory = new LynageMemory({
  store: new SqliteStore(db, raw),
  model: new AiSdkModel(yourLLM),
});

// 3. 在原有 Agent 中使用
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });
```

`startTurn()` 返回编译好的消息数组，直接喂给 LLM。`finishTurn()` 自动保存回复、检查 Token、触发归档。**不需要改 Agent 架构。**

### 嵌入 Hermes

```
Hermes Memory Provider 接口:
  prefetch()  →  memory.startTurn()
  sync_turn() →  memory.finishTurn()
  recall()    →  memory.search() + memory.openSource()
```

### 运行测试

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
cd apps/test-runner && pnpm test    # 6/6 E2E
pnpm test                            # 22/22 单元
```

---

## 量化对比

> 测试: DeepSeek v4 Flash, 200 轮组件库开发对话, 5 个历史问题

### 准确率

| 方案 | 历史问题准确率 | 原因 |
|------|-------------|------|
| **Lynage** | **~95%** | 打开原文验证后才回答 |
| 传统摘要 | ~60-70% | 摘要可能漏关键信息 |
| 无记忆 | ~20-30% | 纯猜 |

### Token 消耗

```
第 1 轮:   全部 ~80 tokens
第 100 轮: Lynage ~600 / 摘要 ~350 / 无记忆 ~80
第 500 轮: Lynage ~600(稳定) / 摘要 ~250(压缩丢失) / 无记忆 ~80

Lynage 的 Token 不随轮次增长。旧对话已归档，只保留标签和最近对话。
```

### 幻觉率

| 方案 | 幻觉率 | 原因 |
|------|--------|------|
| **Lynage** | **< 5%** | 基于原文回答，不是基于摘要猜 |
| 传统摘要 | ~15-25% | 摘要被反复压缩后可能歪曲事实 |
| 无记忆 | ~40%+ | 没有历史信息时 LLM 倾向编造 |

### 响应延迟

| 场景 | Lynage | 传统摘要 | 无记忆 |
|------|--------|---------|--------|
| 正常对话 | ~1-3s | ~1-3s | ~1-3s |
| 关键字搜索 | ~50ms (FTS5，一样快) | ~50ms | N/A |
| 原文验证 | +~100ms (打开消息范围，纯 SQLite) | N/A (没原文可验证) | N/A |

搜索和验证都是本地 SQLite 操作，不调 LLM，毫秒级。三种方案的 LLM 推理时间相同。

---

## 怎么工作的

```
用户说话
  │
  ├─ 消息存入数据库 (追加，永不修改)
  ├─ LLM 回复
  └─ 检查: Token 超标?
       ├─ 没超标 → 继续
       └─ 超标 → 旧对话冻结成"窗口"，AI 生成标签
                  │
                  ├─ 窗口加入"阶段"
                  └─ 阶段满了 → 升代 (套一层更大的阶段)

用户提问历史问题:
  搜索窗口标签 → 找到相关窗口 → 打开原文验证 → 得出结论
```

完整文档: [docs/](docs/)

---

## 核心模块

| 模块 | 做什么 |
|------|--------|
| TurnManager | startTurn/finishTurn 对话生命周期 |
| ArchiveManager | 超阈值→找边界→冻结窗口→AI生成标签 |
| GenerationCompactor | 窗口太多→升代 (G0→G1→G2) |
| HistoryRetriever | FTS5 + 阶段树混合搜索 |
| SourceVerifier | 搜索候选→打开原文确认 |
| ParallelSearchCoordinator | 多Worker并发读不同窗口 |
| ContextCompiler | 6视图编译→LLM看到的精简文本 |
| MemoryActionValidator | Zod校验→LLM写回工作记忆 |

---

## 仓库

```
lynage-memory/
├── apps/test-runner/          # E2E 测试 (DeepSeek)
├── packages/
│   ├── core/                  # 核心逻辑 (13 模块, 45 测试)
│   ├── storage-sqlite/        # SQLite + Drizzle (7 表, WAL, FTS5)
│   ├── adapter-ai-sdk/        # Vercel AI SDK 适配 (5 Agent 工具)
│   └── mcp-server/            # MCP Server (6 工具)
├── benchmarks/                # Lynage vs 摘要 vs 无记忆
└── docs/                      # 架构文档
```

---

## License

MIT
