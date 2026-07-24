# Lynage Memory

> 面向长期运行 Agent 的上下文谱系记忆模块 (Context Lineage Memory)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-orange)](https://pnpm.io/)
[![Vitest](https://img.shields.io/badge/test-vitest-green)](https://vitest.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## 为什么需要 Lynage Memory？

传统 Agent 记忆方案使用**摘要压缩**——对话达到上下文上限后生成压缩摘要，丢弃原文。这导致：

- 摘要遗漏重要关系，多次压缩造成语义漂移
- 记忆成为孤立事实，不知道结论从何产生
- 模糊历史问题无法准确回答

Lynage Memory 改为**原文永久保存 + 目录导航**：

```
传统方案：原文 → 压缩摘要 → 再压缩 → 孤立事实
Lynage：  原文 → 归档 → 导航目录 → 需要时逐层下钻读取原文
```

**核心原则**: 原文 = Source of Truth，摘要 = Navigation。

---

## 核心架构

```
原文无损存储  →  最近完整上下文  →  当前工作记忆
    ↓                  ↓
代际目录压缩  →  可下钻历史检索  →  持久化模糊搜索
                      ↓
              Prompt 上下文编译  →  Agent Model
```

### 数据流

```text
对话进行中
    │
    ├─ 最近 N 轮完整保留 (Recent Context)
    │
    └─ 超过 Token 阈值
        →  找到自然边界 (不在 Q&A 对 / Tool 调用中间切断)
        →  旧消息归档为 Context Chunk
        →  AI 生成 Chunk 导航摘要
        →  加入 G0 目录
        →  目录满后升代为 G1
        →  需要时: Root → Dir → Chunk → 原始消息
```

### 存储结构

```
.lynage/
├── recent/              # 最近完整上下文 (active.jsonl)
├── generations/         # 代际目录树 (g0/ → g1/ → g2/)
├── sources/             # 原始消息不可变追加日志
└── searches/            # 模糊搜索任务持久化
```

SQLite 是唯一事实来源，JSON/Markdown 仅为模型阅读视图。

---

## 仓库结构

```
lynage-memory/
├── apps/
│   └── reference-agent/       # 最小 AI SDK Agent（测试宿主）
├── packages/
│   ├── core/                  # @lynage/core   接口 / 类型 / Zod / 核心逻辑
│   ├── storage-sqlite/        # @lynage/storage-sqlite   Drizzle + better-sqlite3
│   └── adapter-ai-sdk/        # @lynage/ai-sdk           Vercel AI SDK 适配
├── benchmarks/                # 基准测试
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.workspace.ts
```

### 包依赖关系

```
@lynage/core (zod)
    ↑              ↑
@lynage/storage-sqlite    @lynage/ai-sdk
(better-sqlite3, drizzle)  (ai)
    ↑              ↑
    +──────┬───────+
           ↓
    apps/reference-agent
```

---

## 快速开始

### 安装

```bash
git clone https://github.com/qiao-coding/lynage-memory.git
cd lynage-memory
pnpm install
```

### 运行 Reference Agent

```bash
# 复制环境变量
cp apps/reference-agent/.env.example apps/reference-agent/.env
# 编辑 .env 填入 OPENAI_API_KEY

# 单轮对话
cd apps/reference-agent && pnpm dev "你好，请介绍一下自己"

# 多轮对话会记住上下文
pnpm dev "我刚才问了什么？"
```

### 开发命令

```bash
pnpm -r typecheck    # 全量类型检查
pnpm test            # 运行所有测试
pnpm -r build        # 构建所有包
```

---

## 开发路线

| 阶段 | 功能 | 状态 |
|------|------|------|
| M0 | 基线 Agent + SQLite 消息记录 | ✅ |
| M1 | Turn 生命周期 (startTurn/finishTurn) | ✅ |
| M2 | 单层归档 (Context Chunk + Directory Summary) | ✅ |
| M3 | 原文恢复 (search → openSource → compile) | ✅ |
| M4 | 与普通压缩对比 Benchmark | ✅ |
| M5 | 代际目录树 (G0→G1→G2 压缩) | ✅ |
| M6 | 持久化模糊搜索 (task.md + search.md) | ✅ |
| M7 | 生态 Adapter (MCP Server) | ✅ |

### M0 基线
最小 Vercel AI SDK Agent，SQLite 记录每条消息——不做压缩，不做归档。获取裸 Agent 的性能基线（延迟、Token、准确率）。

### M1 Turn 生命周期
`startTurn()` → 编译上下文 → `streamText()` → `finishTurn()` → 自动保存全部消息类型（user / assistant / tool-call / tool-result）及 Token 用量。

### M2 单层归档 ★
第一个真正有价值的 Lynage 特性。超过 Token 阈值后：
- 在自然边界切断（不破坏 Q&A 对 / 未完成 Tool 调用）
- 旧消息归档为 Context Chunk
- AI 生成导航摘要
- 加入 G0 目录
- Recent Context 保持稳定大小

### M3 原文恢复
Agent 可以检索历史并恢复原始对话：
- `memory.search()` — 按关键词 + 目录路径搜索
- `memory.openSource()` — 从 Chunk 定位原始消息范围
- `compileContext()` — 将检索结果编译进模型 Prompt

### M4 Benchmark
与普通摘要压缩方案进行对照实验：
- LongMemEval 长期记忆评测
- 自建项目连续性数据集（设计变更 / 方案废弃 / 跨阶段引用）
- 指标：历史准确率 / Token 消耗 / 检索延迟 / 错误记忆率

### M5 代际目录树
G0 目录节点达到容量上限后自动升代：
```
G0 满 → 创建 G1 Directory → G0 降级为子节点
G1 满 → 创建 G2 Directory → G1 降级
```
越旧的信息层级越深，但原文始终存在。

### M6 持久化模糊搜索
极度模糊查询（"之前那个设计为什么不用了？"）的解决方案：
- 创建 `task.md` + `search.md` 持久化搜索任务
- 分批检查目录，保存游标避免重复
- 支持跨轮次继续搜索

### M7 生态适配
按优先级发布 Adapter：
1. `@lynage/ai-sdk` — Vercel AI SDK（已完成）
2. `@lynage/mastra` — Mastra Memory Provider
3. `@lynage/langgraph` — LangGraph Checkpointer
4. `@lynage/mcp` — MCP Server（跨语言 / CLI 使用）

---

## 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 数据库 | SQLite + WAL | 单文件、零配置、FTS5 全文搜索 |
| ORM | Drizzle | TypeScript schema、类型推断、迁移工具 |
| Token 估算 | char/4 | M0-M2 够用；接口预留 tiktoken 替换 |
| 模型输出校验 | Zod + 3 次重试 | 不可信输入必须验证 |
| 构建 | tsdown | 面向 TS 库构建，CJS/ESM 双格式 |
| 测试 | Vitest + fast-check | 快速 + 属性测试 |
| 包管理 | pnpm workspace | 本地包即时链接、严格依赖管理 |

## 技术栈

- **Runtime**: Node.js + TypeScript 5.7 strict
- **Database**: SQLite + better-sqlite3 + Drizzle ORM
- **Validation**: Zod
- **AI SDK**: Vercel AI SDK (`ai` v4)
- **Testing**: Vitest + fast-check
- **Build**: tsdown

---

## License

MIT
