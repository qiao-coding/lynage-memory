# Lynage Memory 架构详解

## 核心思想

```
传统方案：  消息 → 太多了 → 压缩成摘要 → 原文丢弃 ❌
Lynage：   消息 → 太多了 → 原文归档 → 只给摘要做导航 → 需要时找回原文 ✅
```

## 全景数据流

```
                         ┌──────────────────────┐
   用户输入 ──────────→  │    lynageStreamText   │
                         │                      │
                         │  ① startTurn()       │──→ 保存 user 消息
                         │  ② streamText()      │──→ 调用 LLM
                         │  ③ finishTurn()      │──→ 保存 assistant 消息
                         │       └── 检查归档    │
                         └──────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              ┌──────────┐  ┌──────────┐  ┌──────────────┐
              │ Messages │  │ Context  │  │  Directories │
              │  (原文)   │  │ Chunks   │  │   (目录树)    │
              └──────────┘  │ (档案袋)  │  └──────────────┘
                            └──────────┘
                                   │
                            ┌──────┴──────┐
                            ▼             ▼
                     ┌────────────┐ ┌────────────┐
                     │  Working   │ │    User    │
                     │  Memory    │ │   Memory   │
                     │ (项目状态)  │ │ (用户偏好)  │
                     └────────────┘ └────────────┘
                                   │
                                   ▼
                         ┌──────────────────┐
                         │ Context Compiler │──→ 模型看到的文本
                         └──────────────────┘
```

---

## 七层结构（自底向上）

```
  Layer 7  Context Compiler    给模型看的"精简视图"
  Layer 6  User Memory         长期不变的"用户画像"
  Layer 5  Working Memory      Agent 的"便签纸"
  Layer 4  Generations         代际目录（G0→G1→G2）
  Layer 3  Directories         目录柜（管理 Chunk）
  Layer 2  Context Chunks      档案袋（归档的旧对话）
  Layer 1  Messages            原文地基（永不丢失）
```

---

## Layer 1：Messages — 永不丢失的原文

每条消息追加写入，从不修改、从不删除。

```
┌──────────────────────────────────────────────────┐
│ messages 表                                       │
├────────┬──────────┬─────────┬────────────────────┤
│ id     │ role     │ content │ createdAt          │
├────────┼──────────┼─────────┼────────────────────┤
│ msg-1  │ user     │ 你好     │ 2026-07-25 09:00  │
│ msg-2  │ assistant│ 你好！   │ 2026-07-25 09:01  │
│ msg-3  │ user     │ 帮我...  │ 2026-07-25 09:02  │
│ ...    │ ...      │ ...     │ ...                │
│ msg-N  │ ...      │ ...     │ ...                │
└────────┴──────────┴─────────┴────────────────────┘
```

**关键字段**：`sourceFromId` / `sourceToId` 形成精确定位链，确保可以找回任意一段原文。

---

## Layer 2：Context Chunk — 把旧消息"装袋"

当 Recent 消息总 Token 超过阈值，旧消息被打包成 Chunk。

```
        消息太多（> 16K tokens）
              │
              ▼
    ┌─────────────────────┐
    │ 找自然边界            │  不能切断 Q&A 对
    │ (boundary-detector) │  不能切断 Tool调用/结果
    └────────┬────────────┘
              │
              ▼
    ┌─────────────────────┐
    │ 旧消息 → Chunk       │  保留 sourceFromId
    │ AI 生成摘要标签       │  保留 sourceToId
    └────────┬────────────┘
              │
              ▼
    ┌──────────────────────────────────────────────┐
    │ Context Chunk                                │
    ├──────────────────────────────────────────────┤
    │ summary:    "讨论数据库方案，决定用 SQLite"     │
    │ keywords:   ["SQLite", "WAL", "Drizzle"]     │
    │ sourceFrom: msg-820                          │
    │ sourceTo:   msg-847                          │
    └──────────────────────────────────────────────┘
```

**摘要只是导航标签。原文在 messages 表中原封不动。**

---

## Layer 3：Directory — 把档案袋装进目录柜

```
Chunk-001
Chunk-002     }──→  太多了，建个目录
Chunk-003
Chunk-004
Chunk-005

变成：

    G0 Directory
    ├── Chunk-001
    ├── Chunk-002
    ├── Chunk-003
    ├── Chunk-004
    └── Chunk-005
```

**目录 = 管理 Chunk 的容器**。每个目录记录了这段时间项目推进了什么、形成了什么结论。

---

## Layer 4：代际压缩 — 柜子套柜子

G0 装满 20 个孩子 → 升代。

```
之前：                         之后：
  Root                          Root
  └── G0 (20 Chunks)            └── G1 (摘要："架构设计阶段")
                                      └── G0 (20 Chunks，降级为子节点)

再归档 → G0 又装满 20 个 → 再升代：

  Root
  └── G2 (摘要："项目前半段")
        ├── G1 (架构设计阶段)
        │     └── G0 (20 Chunks)
        └── G1 (功能开发阶段)
              └── G0 (20 Chunks)
```

**关键**：压缩的是导航结构。最底层 Chunk 的 `sourceFromId` → `sourceToId` 始终指向原文。

---

## Layer 5：Working Memory — Agent 的便签纸

记录"现在做到哪了"，每轮对话自动注入。

```
┌─────────────────────────────────┐
│ Working Memory                  │
├─────────────────────────────────┤
│ currentTask    设计数据库方案     │
│ confirmed      SQLite + WAL     │
│ confirmed      Drizzle ORM      │
│ progress       已确定存储方案     │
│ unresolved     阈值设为多少？     │
└─────────────────────────────────┘
         │
         ▼  每次调用 LLM 时自动注入
    "# Working Memory
     Current Task: 设计数据库方案
     Confirmed: SQLite + WAL, Drizzle ORM
     ..."
```

---

## Layer 6：User Memory — 长期不变的用户画像

跨任务、跨会话的稳定信息。

```
┌─────────────────────────────────┐
│ User Memory (user-001)          │
├─────────────────────────────────┤
│ preferences    回答简洁直接       │
│ preferences    技术判断严谨       │
│ constraints    不用向量数据库     │
│ constraints    不绑定特定厂商     │
│ background     7年全栈开发       │
└─────────────────────────────────┘
```

**和 Working Memory 的区别**：User Memory 很少变（用户偏好、长期约束），Working Memory 每轮都可能变（当前进度、未决问题）。

---

## Layer 7：Context Compiler — 编译给模型看的视图

6 种场景，编译不同内容：

```
场景                 编译内容
──────────────────────────────────────────
normal-chat         User + Working + Recent Messages
project-work        加上 Directory 摘要 + 未解决问题
history-search      验证后的候选原文 + 置信度
source-verification 候选原文全文 + query 对照
archive-indexing    Chunk 原文 → 摘要 Prompt
worker-search       项目快照 + 子目录（并行搜索用）
```

---

## 搜索流程

```
lynageSearch("为什么放弃语义分类？")
        │
        ├─ ① FTS5 搜 messages.cont  ent → 找到匹配消息
        ├─ ② 定位消息所属 Chunk →   Chunk-028
        ├─ ③ 目录下钻 Root → G0 → Chunk-028
        ├─ ④ SourceVerifier 打开原文验证 → 置信度 85%
        └─ ⑤ 编译结果 → 注入下一轮 LLM 上下文
```

**模糊搜索**：创建 SearchTask → 分批检查目录 → 保存游标 → 跨轮次继续。

**并行搜索**：主进程创建快照 → N 个 Worker 并发读不同目录 → 合并去重 → 原文验证 → 演变链重建。

---

## 记忆写回

```
AI 回复附带 memoryActions
        │
        ▼
  ① JSON 解析
  ② Zod Schema 校验（target/operation/section/value）
  ③ Lynage 语义校验（不能覆盖原文、不能删目录、不能推测当事实）
  ④ 数据库事务写入
        │
        ├─ target="workingMemory" → working_memory 表
        └─ target="userMemory"    → user_memory 表
```
