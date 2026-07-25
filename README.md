# Lynage Memory

> 面向长期运行 Agent 的上下文谱系记忆模块 (Context Lineage Memory)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-orange)](https://pnpm.io/)
[![Vitest](https://img.shields.io/badge/test-vitest-22/22-green)](https://vitest.dev/)

---

## 1. 定位

**Lynage Memory 是基于 Context Lineage 的 Agent 记忆与上下文管理模块。**

它负责：

| 负责 | 不负责 |
|------|--------|
| 保存完整原始对话 | 模型调用 |
| 维护最近上下文 | Agent 调度 |
| 记录当前任务与项目进度 | Workflow 编排 |
| 按时间和容量生成代际目录 | Tool 执行 |
| 将记忆与原始上下文保持关联 | Skill 系统 |
| 检索并恢复历史原文 | 多 Agent 协作 |
| 为 Agent 编译当前所需上下文 | |

一句话定位：

> Lynage Memory 是让 Agent 记忆始终保留原始上下文、时间位置和任务进度的长期记忆模块。

---

## 2. 核心问题

传统 Agent 通常采用：

```
完整对话 → 上下文达到上限 → 生成压缩摘要 → 摘要继续进入上下文 → 旧原文依靠关键词重新搜索
```

问题在于：摘要可能遗漏重要关系、多次压缩造成语义漂移、记忆变成孤立事实、Agent 不知道结论为何产生。

Lynage Memory 改为：

```
完整对话 → 旧消息原样归档 → 对归档段生成一次导航摘要
→ 目录达到容量后压缩目录 → 原目录降级为子目录 → 需要时逐层进入并读取原文
```

**压缩的是目录和索引视图，不是原始信息。**

---

## 3. 核心原则

### 3.1 原文是事实来源

```
原文 = Source of Truth
摘要 = Navigation
```

摘要不能替代原文承担最终事实判断。

### 3.2 最近对话保持完整

当前窗口保留最近的完整消息。达到 Token 阈值后，仅将较旧部分归档，最近部分继续原样保留。

### 3.3 目录按时间与容量生成

不要求 AI 提前判断内容属于哪个项目或主题。目录自然按照 **时间顺序 + 节点容量 + 归档代数** 逐步形成树状结构。

### 3.4 记忆必须保留上下文关系

Lynage 保存的不只是"用户选择 SQLite"，还要能恢复：为什么选择、替代了什么方案、当时讨论到哪个阶段、后续如何使用这个决定、原始消息在哪里。

### 3.5 搜索可验证、可继续

搜索结果必须能回到原文验证。极度模糊的查询允许分批搜索并保存进度。

---

## 4. 整体架构

```
Agent Framework
├── Model
├── Tools
├── Skills
├── Workflow
└── Lynage Memory
    ├── Recent Context     (TurnManager)
    ├── Working Memory     (commit / upsertWorkingMemory)
    ├── Context Archive    (ArchiveManager)
    ├── Generational Dir   (GenerationCompactor)
    ├── History Search     (HistoryRetriever)
    ├── Fuzzy Search       (SearchTaskManager)
    └── Context Compiler   (compileContext)
```

### 数据流：一轮对话

```
用户输入
  │
  ▼
lynageStreamText()
  ├── memory.startTurn()          保存 user message
  │     └── 编译: WorkingMemory + Recent Messages
  ├── streamText()                调用模型
  │     └── onFinish: 收集 toolCalls + toolResults
  └── turn.finish()               保存 assistant + tool messages
        └── ArchiveManager.checkAndArchive()
              ├── 检查 Token 阈值
              ├── findNaturalBoundary()    在 Q&A 对 / Tool 调用边界切断
              ├── model.summarizeChunk()    AI 生成导航摘要
              ├── 创建 ContextChunk         (sourceFromId → sourceToId)
              ├── 加入 G0 Directory
              └── GenerationCompactor       G0 满 → G1 → G2 ...
```

### 数据流：历史检索

```
用户询问历史
  │
  ▼
lynageSearch("之前为什么放弃语义分类？")
  ├── FTS5 搜索 messages.content
  ├── Directory drill-down (Root → Dir → Chunk)
  ├── 合并候选，按相关性排序
  └── compileRetrievedContext()    编译为模型可读文本
        │
        ▼
lynageOpenSource("ctx-028")
  └── 从 Chunk 的 sourceFromId → sourceToId 读取原始消息
```

---

## 5. 与原始架构文档的映射

原始文档描述的逻辑结构 | 代码实现
--- | ---
`user.json` (稳定用户信息) | `WorkingMemory` 表 (通过 `upsertWorkingMemory`)
`memory.json` (当前工作记忆) | `WorkingMemory` 表 (currentTask/confirmed/progress/unresolved)
`root.json` (根目录视图) | `directories` 表 (generation=0 的根目录)
`recent/active.jsonl` | `messages` 表, 经 `getRecent()` 过滤
`generations/g0/g1/g2` | `directories` 表 (generation 字段 0→1→2)
`sources/messages.jsonl` | `messages` 表 (不可变追加)
`searches/search-{id}/` | `search_tasks` 表 (持久化游标)
Directory → Chunk → Source 下钻 | `HistoryRetriever.drillDown()` → `openSource()`
自然边界归档 | `ArchiveManager` + `findNaturalBoundary()`
代际目录压缩 | `GenerationCompactor.checkAndCompact()`
Context Compiler | `compileContext()` — 文本视图生成
Memory Action Validator | `MemoryActionSchema` (Zod) + `commit()`

**关键差异**：原始文档描述 `.lynage/` 目录结构（JSON/JSONL 文件），但按 `开发工具与项目起点.md` §5-6 的设计，**SQLite 是唯一事实来源**：

```
SQLite → Context Compiler → Markdown/TXT → 模型
```

JSON 和 Markdown 仅作为运行时生成的视图，不同步维护多套数据。

---

## 6. 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **Source Store** | `storage-sqlite/src/store.ts` | SQLite 不可变消息追加，WAL + FTS5 |
| **Recent Context** | `core/src/turn.ts` | `startTurn/finishTurn` 生命周期 |
| **Working Memory** | `core/src/memory.ts` | `commit()` / `upsertWorkingMemory()` |
| **Archive Manager** | `core/src/archive-manager.ts` | 阈值触发 → 边界检测 → Chunk 归档 |
| **Boundary Detector** | `core/src/boundary-detector.ts` | 自然对话边界 (不破坏 Q&A 对 / Tool 序列) |
| **Generation Compactor** | `core/src/generation-compactor.ts` | G0 满 → G1 → G2 目录压缩 |
| **History Retriever** | `core/src/history-retriever.ts` | FTS + 目录下钻 + openSource |
| **Search Task Manager** | `core/src/search-task-manager.ts` | 持久化模糊搜索 (游标 + 分批) |
| **Context Compiler** | `core/src/context-compiler.ts` | 存储数据 → 模型可读 Prompt 文本 |
| **Memory Validator** | `core/src/schemas.ts` | Zod 校验 AI 输出的摘要/记忆操作 |

---

## 7. 与普通 Memory 的区别

传统 Memory 只保存 **Agent 应该记住什么**。

Lynage Memory 还保留：

| 维度 | 传统 Memory | Lynage Memory |
|------|-------------|---------------|
| 保存什么 | 决策结论 | 结论 + 产生过程 |
| 为什么 | ❌ | ✅ 为什么选择、替代了什么 |
| 属于哪个阶段 | ❌ | ✅ 时间位置 + 项目阶段 |
| 改变了什么 | ❌ | ✅ 哪些旧决策被修改 |
| 如何影响当前 | ❌ | ✅ 跨阶段引用关系 |
| 去哪读原文 | ❌ | ✅ sourceFromId → sourceToId |

核心价值：

> 记忆不会脱离上下文成为孤立事实，Agent 可以持续恢复项目进度、决策过程和原始信息。

---

## 8. 仓库结构

```
lynage-memory/
├── apps/
│   └── reference-agent/       # AI SDK Agent 测试宿主
├── packages/
│   ├── core/                  # @lynage/core    类型 / 接口 / Zod / 核心逻辑
│   ├── storage-sqlite/        # @lynage/storage-sqlite   Drizzle + better-sqlite3
│   ├── adapter-ai-sdk/        # @lynage/ai-sdk           Vercel AI SDK 适配
│   └── mcp-server/            # @lynage/mcp              MCP Server (5 tools)
├── benchmarks/baseline/       # Lynage vs Summary vs NoMemory
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### 包依赖

```
@lynage/core (zod)
    ↑                ↑
@lynage/storage-sqlite    @lynage/ai-sdk
(better-sqlite3, drizzle)  (ai, zod)
    ↑                ↑
    +────────┬───────+
             ↓
    @lynage/mcp ← apps/reference-agent
```

---

## 9. 快速开始

```bash
git clone https://github.com/qiao-coding/lynage-memory.git
cd lynage-memory
pnpm install

# 复制并编辑 .env, 填入 OPENAI_API_KEY
cp apps/reference-agent/.env.example apps/reference-agent/.env

# 单轮对话
cd apps/reference-agent && pnpm dev "你好"

# 开发
pnpm -r typecheck    # 6/6 包类型检查
pnpm test            # 22/22 测试
pnpm -r build        # 构建
```

---

## 10. 开发阶段

| M | 功能 | 状态 |
|----|------|------|
| M0 | 基线 Agent + SQLite 消息记录 | ✅ |
| M1 | Turn 生命周期 (startTurn/finishTurn) | ✅ |
| M2 | 单层归档 (Context Chunk + Directory Summary) | ✅ |
| M3 | 原文恢复 (search → openSource → compile) | ✅ |
| M4 | 对比 Benchmark (Lynage 100% vs Summary 80% vs NoMemory 0%) | ✅ |
| M5 | 代际目录树 (G0→G1→G2 压缩) | ✅ |
| M6 | 持久化模糊搜索 (游标 + 分批) | ✅ |
| M7 | 生态 Adapter (MCP Server 5 tools) | ✅ |
| P0 | User Memory 独立存储 | ✅ |
| P1a | Source Verifier | ✅ |
| P1b | Context Compiler 6 视图 | ✅ |
| P2/M8 | Shared-Context Parallel Memory | ✅ |

---

## 11. 技术栈

| 选择 | 原因 |
|------|------|
| SQLite + WAL | 零配置、FTS5、单文件 |
| Drizzle ORM | TS schema、类型推断、迁移 |
| Zod | AI 输出校验 |
| Vercel AI SDK v4 | generateObject + streamText |
| better-sqlite3 | 同步 API、WAL 友好 |
| tsx / tsdown | 开发运行 / 库构建 (CJS+ESM) |
| Vitest + fast-check | 单元测试 + 属性测试 |

## 12. MVP 明确不做的

- 向量数据库 / Embedding
- 自动项目语义分类
- 多用户云同步
- 多 Agent 共享记忆
- 分布式存储
- 复杂权限系统
- 完整 Agent Runtime

---

## License

MIT
