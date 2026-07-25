# Lynage Memory 文档

## 架构与概念

| 文档 | 内容 |
|------|------|
| [01-architecture.md](01-architecture.md) | 架构全景图、7 层结构、搜索流程 |
| [02-walkthrough.md](02-walkthrough.md) | 全程推演：第 1 轮到第 200 轮，每层如何变化 |

## 核心技术详解

| 文档 | 技术点 |
|------|--------|
| [03-event-sourcing.md](03-event-sourcing.md) | Event Sourcing（不可变追加）<br>Context Lineage（谱系追踪链）<br>Natural Boundary Detection（自然边界检测） |
| [04-directory-system.md](04-directory-system.md) | Directory Tree（目录树）<br>Generational Compaction（代际压缩）<br>Hybrid Search（FTS + 目录下钻混合检索） |
| [05-memory-layer.md](05-memory-layer.md) | Working Memory vs User Memory<br>Context Compiler（6 视图）<br>Memory Action Validation（三层校验） |
| [06-parallel-search.md](06-parallel-search.md) | Shared-Context Parallel Search（共享上下文并行搜索）<br>Source Verification（原文验证 + 演变链重建） |

## 亮点技术一览

| 技术 | 一句话 |
|------|--------|
| **Event Sourcing** | 消息追加写入，从不修改删除 |
| **Context Lineage** | sourceFromId → sourceToId 精确追溯原文 |
| **Natural Boundary** | Q&A 对和 Tool 调用原子性保护，不切断对话 |
| **Generational Compaction** | 目录满后升代（G0→G1→G2），压缩导航不压原文 |
| **Hybrid Search** | FTS5 全文搜索 + 目录树逐层下钻，双路径互补 |
| **Source Verification** | 搜索结果打开原文验证，过滤误报 + 重建演变链 |
| **Shared-Context Parallel** | 主进程创建快照 → N 个 Worker 并发读不同目录 |
| **6-View Compiler** | normal-chat / project-work / history-search 等 6 种视图 |
| **3-Layer Validation** | JSON → Zod → Lynage 语义校验 AI 写回操作 |
| **Read-Only Workers** | 并行 Worker 只返回证据位置，主进程统一写入 |
