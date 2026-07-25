# Lynage Memory

> 面向长期运行 Agent 的上下文谱系记忆模块 (Context Lineage Memory)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-orange)](https://pnpm.io/)
[![Vitest](https://img.shields.io/badge/test-vitest-22/22-green)](https://vitest.dev/)
[![Arch Coverage](https://img.shields.io/badge/arch-100%25-brightgreen)]()

---

## 1. 定位

**Lynage Memory 是基于 Context Lineage 的 Agent 记忆与上下文管理模块。**

- **负责**: 消息保存、上下文维护、历史归档、目录索引、历史检索、原文恢复、Prompt 编译、并行搜索、原文验证
- **不负责**: 模型调用、Agent 调度、Workflow 编排、Tool 执行、Skill 系统、多 Agent 协作

> Lynage Memory 是让 Agent 记忆始终保留原始上下文、时间位置和任务进度的长期记忆模块。

---

## 2. 核心问题

```
传统 Agent: 完整对话 → 上下文上限 → 压缩摘要 → 原文丢失 → 语义漂移 → 孤立事实
Lynage:     完整对话 → 原文归档 → 导航摘要 → 目录压缩 → 需要时逐层下钻读取原文
```

**压缩的是目录和索引视图，不是原始信息。**

---

## 3. 核心原则

- **原文是事实来源** — 摘要仅用于导航，不能替代原文承担最终事实判断
- **记忆保留谱系** — 恢复: 从哪里产生、为什么、哪个阶段、改了什么、去哪读原文
- **按时间与容量组织** — 不依赖语义分类，目录按时间顺序 + 节点容量 + 归档代数自动生长
- **搜索可验证可继续** — 结果必须回原文验证，模糊查询分批搜索并保存进度

---

## 4. 整体架构

```
Agent Framework
├── Model
├── Tools
├── Workflow
└── Lynage Adapter
        │
        ▼
Lynage Memory Core
├── Source Store              (SQLite + WAL + FTS5)
├── Recent Context Manager    (TurnManager)
├── Working Memory            (session-scoped task state)
├── User Memory               (cross-task stable preferences)
├── Archive Manager           (threshold → boundary → Chunk)
├── Directory Indexer         (generation tree + drill-down)
├── Generation Compactor      (G0→G1→G2)
├── History Retriever         (FTS + directory drill-down)
├── Parallel Search Coordinator (shared-context concurrent workers)
├── Source Verifier           (candidate → original text verification)
├── Context Compiler          (6 views: normal-chat/project-work/history-search/...)
├── Search Task Manager       (persistent fuzzy search + cursor)
└── Memory Action Validator   (Zod schema + incremental write-back)
```

### 数据流：一轮对话

```
用户输入 → lynageStreamText()
  ├── memory.startTurn()         保存 user message + 编译上下文
  ├── streamText()               调用模型 + 5 个 Agent 工具可用
  └── turn.finish()              保存 assistant + tool messages
        └── ArchiveManager.checkAndArchive()
              ├── 检查 Token 阈值
              ├── findNaturalBoundary()    Q&A 对 / Tool 调用边界
              ├── model.summarizeChunk()   AI 导航摘要
              ├── 创建 ContextChunk (sourceFrom → sourceTo)
              ├── 加入 G0 Directory
              └── GenerationCompactor     G0 满 → G1 → G2
```

### 数据流：历史检索

```
lynageSearch("之前为什么放弃语义分类？")
  ├── FTS5 搜索 messages.content
  ├── Directory drill-down (Root → Dir → Chunk)
  ├── SourceVerifier.verifyBatch()     原文验证 + 置信度评分
  └── compileContext(view: "history-search")  → 模型可读格式
```

### 数据流：并行搜索 (M8)

```
lynageParallelSearch(question, projectGoal, knownDecisions)
  ├── 创建 ProjectSnapshot (共享目标/进度/决策/问题)
  ├── 收集所有目录 → 分配给 N 个 Worker
  ├── Worker 1..N: 并发读取不同子目录 → 返回证据位置
  ├── 合并去重 → SourceVerifier 批量验证
  └── 重建信息演变链 → 输出最终结论
```

---

## 5. 架构映射

| 架构文档 (§) | 概念 | 代码实现 |
|---|---|---|
| §5 | User Memory (跨任务稳定偏好) | `user_memory` 表 + `getUserMemory()` |
| §5 | Working Memory (当前任务状态) | `working_memory` 表 + `commit()` |
| §5 | Source Store (不可变消息) | `messages` 表 (WAL + FTS5) |
| §6 | Context Chunk | `context_chunks` 表 |
| §7 | 代际目录 (G0→G1→G2) | `directories` 表 + `GenerationCompactor` |
| §8 | 普通检索 (Root→Dir→Chunk→Source) | `HistoryRetriever` |
| §9 | 模糊搜索 (持久化任务+游标) | `SearchTaskManager` |
| §10 | Shared-Context Parallel Memory | `ParallelSearchCoordinator` |
| §11 | 主进程验证+演变链重建 | `SourceVerifier` + `deepVerify()` |
| §13 | Context Compiler (6 视图) | `compileContext(view: ...)` |
| §14 | 模型写回 (增量+Schema) | `MemoryActionSchema` + `commit()` |
| §15 | SQLite = 唯一事实来源 | Drizzle + WAL + FTS5 |

---

## 6. 核心模块 (13 个)

| 模块 | 文件 | 职责 |
|------|------|------|
| Source Store | `storage-sqlite/src/store.ts` | 7 表, WAL+FTS5, 不可变追加 |
| Recent Context | `core/src/turn.ts` | startTurn/finishTurn 生命周期 |
| Working Memory | `core/src/memory.ts` | commit() / upsertWorkingMemory |
| User Memory | `core/src/memory.ts` | getUserMemory / upsertUserMemory |
| Archive Manager | `core/src/archive-manager.ts` | 阈值→边界→Chunk→目录 |
| Boundary Detector | `core/src/boundary-detector.ts` | Q&A对/Tool调用原子性保护 |
| Generation Compactor | `core/src/generation-compactor.ts` | G0 满→G1→G2 |
| History Retriever | `core/src/history-retriever.ts` | FTS+目录下钻+openSource |
| Parallel Search Coordinator | `core/src/parallel-search-coordinator.ts` | 共享快照+Worker并发+合并 |
| Source Verifier | `core/src/source-verifier.ts` | verify/verifyBatch/deepVerify |
| Context Compiler | `core/src/context-compiler.ts` | 6 视图 Prompt 编译 |
| Search Task Manager | `core/src/search-task-manager.ts` | 持久化模糊搜索+游标 |
| Memory Validator | `core/src/schemas.ts` | Zod 校验 AI 输出 |

---

## 7. 仓库结构

```
lynage-memory/
├── apps/reference-agent/         # AI SDK Agent 测试宿主
├── packages/
│   ├── core/                     # @lynage/core (14 source + 4 test, 22 tests)
│   ├── storage-sqlite/           # @lynage/storage-sqlite (Drizzle 7 tables)
│   ├── adapter-ai-sdk/           # @lynage/ai-sdk (5 Agent tools)
│   └── mcp-server/               # @lynage/mcp (6 MCP tools)
├── benchmarks/baseline/          # Lynage vs Summary vs NoMemory
└── docs/                         # 架构文档
```

### 包依赖

```
            @lynage/core (zod)
           ↗              ↖
@lynage/storage-sqlite    @lynage/ai-sdk
          ↗              ↗
   @lynage/mcp    apps/reference-agent
```

---

## 8. Agent 工具 (5 个)

| 工具 | 功能 |
|------|------|
| `lynageSearch` | 搜索历史 (FTS+下钻+原文验证) |
| `lynageOpenSource` | 读取 Context Chunk 原始消息 |
| `lynageListDirectories` | 列出代际目录树 |
| `lynageContinueSearch` | 继续模糊搜索下一批 |
| `lynageParallelSearch` | 共享上下文并行搜索 (多 Worker) |

## 9. MCP 工具 (6 个)

| 工具 | 功能 |
|------|------|
| `lynage_memory_read` | 读取 Working Memory |
| `lynage_memory_read_user` | 读取 User Memory (长期偏好) |
| `lynage_memory_search` | 搜索历史 |
| `lynage_memory_open_source` | 读取原文 |
| `lynage_memory_commit` | 写回记忆 |
| `lynage_memory_stats` | 归档统计 |

---

## 10. 开发阶段

| 阶段 | 功能 | 状态 |
|------|------|------|
| M0 | 基线 Agent + SQLite 消息记录 | ✅ |
| M1 | Turn 生命周期 | ✅ |
| M2 | 单层归档 (Context Chunk + Directory) | ✅ |
| M3 | 原文恢复 (search/openSource/compile) | ✅ |
| M4 | Benchmark (Lynage 100% vs Summary 80% vs NoMemory 0%) | ✅ |
| M5 | 代际目录树 (G0→G1→G2) | ✅ |
| M6 | 持久化模糊搜索 (游标+分批) | ✅ |
| M7 | MCP Server (6 tools) | ✅ |
| P0 | User Memory 独立表 | ✅ |
| P1a | Source Verifier | ✅ |
| P1b | Context Compiler 6 视图 | ✅ |
| P2/M8 | Shared-Context Parallel Memory | ✅ |

---

## 11. 快速开始

```bash
git clone https://github.com/qiao-coding/lynage-memory.git
cd lynage-memory && pnpm install

cp apps/reference-agent/.env.example apps/reference-agent/.env
# 编辑 .env 填入 OPENAI_API_KEY

cd apps/reference-agent && pnpm dev "你好"
```

```bash
pnpm -r typecheck    # 6/6 包
pnpm test            # 22/22 测试
pnpm bench           # Lynage 100% vs Summary 80% vs NoMemory 0%
```

---

## 12. 技术栈

| 选择 | 原因 |
|------|------|
| SQLite + WAL + FTS5 | 零配置、全文搜索、单文件 |
| Drizzle ORM | TypeScript schema、类型推断、迁移 |
| Zod | AI 输出 Runtime 校验 |
| Vercel AI SDK v4 | generateObject + streamText |
| better-sqlite3 | 同步 API、WAL 友好 |
| tsx / tsdown | 开发运行 / CJS+ESM 构建 |
| Vitest | 单元测试 + MockStore |

## 13. 不做的

- 向量数据库 / Embedding
- 自动项目语义分类
- 多用户云同步
- 分布式存储
- 复杂权限系统
- 完整 Agent Runtime

---

## License

MIT
