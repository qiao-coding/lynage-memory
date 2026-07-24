# lynage-memory

> 面向长期运行 Agent 的上下文谱系记忆模块 (Context Lineage Memory)

## 核心定位

Lynage Memory 是独立的 Agent Memory 模块。它不绑定特定 Agent 框架或模型厂商。

**核心原则**: 原文 = Source of Truth，摘要 = Navigation。原始消息永久保存，目录只做导航。

## 架构

```
原文无损存储
+ 最近完整上下文
+ 当前工作记忆
+ 代际目录压缩
+ 可下钻历史检索
+ 持久化模糊搜索
+ Prompt 上下文编译
```

## 仓库结构

```
lynage-memory/
├── apps/reference-agent/       # 最小 AI SDK Agent（测试宿主）
├── packages/
│   ├── core/                   # @lynage/core (接口/类型/Zod schemas)
│   ├── storage-sqlite/         # @lynage/storage-sqlite (Drizzle + better-sqlite3)
│   └── adapter-ai-sdk/         # @lynage/ai-sdk (Vercel AI SDK 适配)
├── benchmarks/                 # 基准测试
└── docs/                       # 架构文档
```

## 开发

```bash
pnpm install
pnpm -r typecheck
pnpm test
pnpm -r build
```

## 开发阶段

- ✅ M0: 基线 Agent
- ✅ M1: Turn 生命周期 (startTurn/finishTurn)
- ✅ M2: 单层归档 (Context Chunk + Directory)
- ⬜ M3: 原文恢复
- ⬜ M4: 与普通压缩对比 Benchmark
- ⬜ M5: 代际目录树
- ⬜ M6: 持久化模糊搜索
- ⬜ M7: 生态 Adapter

## License

MIT
