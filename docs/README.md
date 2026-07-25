# Lynage Memory 文档

## 架构与概念

| 文档 | 内容 |
|------|------|
| [01-architecture.md](01-architecture.md) | 架构全景图、7 层结构、搜索流程 |
| [02-walkthrough.md](02-walkthrough.md) | 全程推演：第 1 轮到第 200 轮，每层如何变化 |

## 核心技术详解

| 文档 | 技术点 |
|------|--------|
| [03-event-sourcing.md](03-event-sourcing.md) | Event Sourcing 事件溯源（不可变追加）<br>Context Lineage 上下文谱系（追踪链）<br>Natural Boundary Detection 自然边界检测 |
| [04-directory-system.md](04-directory-system.md) | Directory Tree 目录树<br>Generational Compaction 代际压缩<br>Hybrid Search 混合检索（FTS + 目录下钻） |
| [05-memory-layer.md](05-memory-layer.md) | Working Memory 工作记忆 / User Memory 用户记忆<br>Context Compiler 上下文编译器（6 视图）<br>Memory Action Validation 记忆操作校验（三层） |
| [06-parallel-search.md](06-parallel-search.md) | Shared-Context Parallel Search 共享上下文并行搜索<br>Source Verification 原文验证 + 演变链重建 |

## 术语表

| English | 中文 | 一句话 |
|---------|------|--------|
| Event Sourcing | 事件溯源 | 消息追加写入，从不修改删除 |
| Context Lineage | 上下文谱系 | sourceFromId → sourceToId 精确追溯原文 |
| Natural Boundary Detection | 自然边界检测 | Q&A 对和 Tool 调用原子性保护，不切断对话 |
| Immutable Append | 不可变追加 | 所有消息只增不改不删 |
| Context Chunk | 上下文块 / 档案袋 | 归档的旧消息 + AI 摘要标签 |
| Directory | 目录 | 管理 Chunk 的树节点，记录阶段进度 |
| Generational Compaction | 代际压缩 | 目录满后升代（G0→G1→G2），压缩导航不压原文 |
| Hybrid Search | 混合检索 | FTS5 全文搜索 + 目录树逐层下钻，双路径互补 |
| Working Memory | 工作记忆 | 当前任务状态（进度/决策/未决问题） |
| User Memory | 用户记忆 | 跨任务稳定信息（偏好/约束/背景） |
| Context Compiler | 上下文编译器 | 6 视图筛选编译，给模型看精简版 |
| Memory Action | 记忆操作 | AI 提出的增量写回（append/remove） |
| Memory Action Validation | 记忆操作校验 | JSON → Zod → Lynage 三层校验 |
| Project Snapshot | 项目快照 | 并行搜索前创建的统一上下文 |
| Worker | 工人/工作进程 | 只读指定目录，返回证据位置 |
| Source Verification | 原文验证 | 打开原文确认搜索候选是否真的匹配 |
| Deep Verify | 深度验证 | 原文验证 + 上下文扩展 + 演变链重建 |
| Evolution Chain | 演变链 | 信息从提出到废弃的完整时间线 |
| Persistent Fuzzy Search | 持久化模糊搜索 | 分批搜索 + 游标 + 跨轮次继续 |
| Search Cursor | 搜索游标 | 标记搜索进度，避免重复检查 |
| Token Budget | Token 预算 | 控制 Recent Context 大小的阈值 |
| 6-View Compiler | 六视图编译器 | normal-chat/project-work/history-search 等 6 种编译模式 |
