# 阶段/窗口结构 · 升代 · 混合搜索

> 术语见 [00-terminology.md](00-terminology.md)
>
> 窗口多了怎么管？怎么快速找到历史？
>
> **前置理解**：每个窗口 = 一段冻结的对话。阶段 = 窗口的容器，可嵌套。

---

## 1. 阶段/窗口结构

### 问题

40 个 Chunk 摊在地上，搜索时需要遍历全部 40 个。

### 方案

用**树结构**组织 Chunk。每个 Directory 最多容纳 `B` 个子节点（默认 20）。

```
扁平:                             树形:
Chunk-001                          G0 Directory
Chunk-002                           ├── Chunk-001
Chunk-003                           ├── Chunk-002
...                                ├── ...
Chunk-040                           └── Chunk-020
                                  
搜索: O(40)                        搜索: O(log₂₀ 40) = 向下钻 2 层
```

### Directory 记录什么

```
┌──────────────────────────────────────────────────────┐
│ Directory (id: dir-005)                              │
├──────────────────────────────────────────────────────┤
│ timeRange:     7/23 — 7/25                          │
│ overallContent: "这个阶段从技术选型开始，经历了       │
│                 样式迁移和 monorepo 重构。"            │
│ progress:       "已完成架构设计，正在功能开发"         │
│ mainConclusions:                                     │
│   - 使用 SQLite + WAL + FTS5                        │
│   - 采用代际目录压缩方案                              │
│ importantChanges:                                    │
│   - CSS Modules → Tailwind (第80轮)                  │
│   - 单包 → monorepo (第160轮)                        │
├──────────────────────────────────────────────────────┤
│ children:                                            │
│   ├── Chunk-001  (第1-42轮技术选型)                   │
│   ├── Chunk-002  (第43-82轮初期开发)                  │
│   └── Chunk-003  (第83-92轮样式迁移)                  │
└──────────────────────────────────────────────────────┘
```

每个 Directory 不仅知道"里面有什么"，还知道"整个阶段推进了什么、形成了什么结论、改变了什么"。这是搜索时快速定位的关键。

---

## 2. 升代

### 问题

G0 装满 20 个节点后，再归档怎么办？删除旧的？把旧的平摊到新目录？

### 方案：不删，升代

G0 满了 → 创建 G1 作为父目录 → G0 降级为 G1 的子节点。

### 逐步演示

```
状态 ①: G0 刚开始
  Root
  └── G0 (dir-A, 0 个孩子)

状态 ②: 归档了 3 次
  Root
  └── G0 (dir-A)
        ├── Chunk-001 (技术选型)
        ├── Chunk-002 (初期开发)
        └── Chunk-003 (样式迁移)

状态 ③: 归档了 20 次 → G0 满了 → 触发升代
  Root
  └── G1 (dir-B) ← 新建
        │  AI 读取 20 个 Chunk 摘要后生成:
        │  overallContent: "前期开发阶段，完成技术选型、
        │                   基础架构搭建和样式方案确定"
        │  mainConclusions: [SQLite, Tailwind, ...]
        │
        └── G0 (dir-A) ← 降级为子节点
              ├── Chunk-001
              ├── ...
              └── Chunk-020

状态 ④: 新建 G0，继续归档
  Root
  ├── G1 (dir-B, "前期开发阶段")
  │     └── G0 (dir-A, 20 Chunks)
  └── G0 (dir-C, "新阶段") ← 归档往这里加
        ├── Chunk-021
        └── Chunk-022

状态 ⑤: dir-C 又装满 20 个 → 生成第 2 个 G1
  Root
  ├── G1 (dir-B, "前期开发")
  │     └── G0 (dir-A, 20 Chunks)
  └── G1 (dir-D, "功能开发") ← 第 2 个 G1
        └── G0 (dir-C, 20 Chunks)

状态 ⑥: 2 个 G1 → 触发升代到 G2
  Root
  └── G2 (dir-E) ← AI 读 2 个 G1 摘要后生成
        │  "组件库项目从零到完整，经历前期开发和功能开发两个阶段"
        │
        ├── G1 (dir-B, "前期开发")
        │     └── G0 (dir-A, 20 Chunks)
        └── G1 (dir-D, "功能开发")
              └── G0 (dir-C, 20 Chunks)
```

### 为什么不直接删旧的

```
删除旧 Chunk ──→ 原文还在 messages 表里 ──→ 但导航断了
  search() 找不到 msg-40，因为 Chunk 被删了
  openSource() 无法定位范围

降级旧目录 ──→ 导航路径变长，但仍可到达
  Root → G2 → G1 → G0 → Chunk → msg-40
  (多走 2 层，但一定能找到)
```

**压缩的是导航深度，不是原文。** 最底层 Chunk 的 `sourceFromId` → `sourceToId` 始终有效。

---

## 3. 混合搜索

### 问题

纯 FTS 搜索：搜"CSS"返回 50 条消息，但不知道它们属于哪个决策过程。

纯目录下钻：从 Root 逐层看摘要，太慢。

### 方案：两条路同时走，结果合并

```
lynageSearch("为什么放弃 CSS Modules？")
          │
    ┌─────┴─────┐
    ▼           ▼
  路径 A       路径 B
  (FTS)       (目录下钻)
    │           │
    ▼           ▼
 搜 messages  从 Root 开始
 .content      读 G2 摘要 → 相关?
    │          读 G1 摘要 → 相关?
    ▼          读 G0 摘要 → 相关?
  找到 8 条    读 Chunk 摘要 → 相关?
  匹配消息        │
    │          找到 3 个候选 Chunk
    ▼           │
  定位到         │
  Chunk-003      │
    │           │
    └─────┬─────┘
          ▼
    合并候选，去重
    FTS 命中 + 目录命中 → 提高置信度
          │
          ▼
    SourceVerifier.verify()
    打开 msg-76 ~ msg-85 原文
    确认 "CSS Modules" 确实在原文出现
          │
          ▼
    返回: [
      { contextId: "Chunk-003", summary: "切换Tailwind",
        sourceRange: { from: "msg-76", to: "msg-85" },
        relevance: 0.9, verified: true }
    ]
```

### 例子

```
搜索 "monorepo":

FTS 路径:
  messages.content LIKE "%monorepo%"
  → msg-40, msg-160, msg-165  (3 条匹配)

  时间范围匹配 Chunk:
  msg-40  (createdAt: 7/23 14:00) → 在 Chunk-001 范围内
  msg-160 (createdAt: 7/25 16:00) → 在 Chunk-008 范围内
  msg-165 (createdAt: 7/25 18:00) → 在 Chunk-008 范围内

目录路径:
  Root
  ├── G1 (dir-B) "前期开发" → "monorepo" 匹配!
  │     └── G0 (dir-A) → "第 3-5 轮讨论 monorepo 但放弃"
  └── G1 (dir-D) "功能开发" → "monorepo" 匹配!
        └── G0 (dir-C) → "第 160 轮重启 monorepo"

合并:
  FTS 找到: Chunk-001, Chunk-008
  目录找到: Chunk-001, Chunk-008
  两者一致 → Chunk-001 置信度提升
  两者一致 → Chunk-008 置信度提升

结果:
  [0] Chunk-001 (relevance: 0.85): "第 25 轮放弃 monorepo — 过早优化"
  [1] Chunk-008 (relevance: 0.90): "第 160 轮重启 monorepo — 条件成熟"
```
