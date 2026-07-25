# Memory Layer · Context Compiler · Memory Action Validation

> 记忆怎么分层？模型看到的是什么？怎么安全地写回？

---

## 1. 两层记忆：Working vs User

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   User Memory           Working Memory              │
│   (跨任务稳定)           (当前任务动态)                │
│                                                     │
│   "用户偏好简洁"         "正在设计数据库方案"          │
│   "不用向量数据库"        "已确定 SQLite + WAL"        │
│   "7年全栈开发"          "还没确定: 阈值设多少?"       │
│                                                     │
│   很少变                 每轮都可能变                  │
│   userId 作为 key        sessionId 作为 key          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 为什么分两层

```
场景: 用户在 3 个不同项目中使用 Lynage

不分层的话:
  session-1 (组件库项目): "threshold=16000" ← 这个偏好是项目级的
  session-2 (博客项目):   "threshold=8000"  ← 还是用户级的?
  session-3 (Agent 项目): "threshold=32000" ← 混乱

分层后:
  User Memory (user-001):
    "回答简洁直接"              ← 跨项目，存在 user_memory 表
    "技术判断必须严谨"

  Working Memory (session-1):   Working Memory (session-2):
    currentTask: 开发组件库       currentTask: 优化博客
    confirmed: SQLite            confirmed: Markdown
    threshold: 16000             threshold: 8000

  Working Memory 每个 session 独立，User Memory 跨 session 共享
```

---

## 2. Context Compiler（上下文编译）

### 问题

数据库 7 张表、几百条记录。LLM 一次只能看有限 token。**怎么筛选？**

### 方案：6 种视图，不同场景选不同内容

```
场景                   给 LLM 看什么                   为什么
────────────────────────────────────────────────────────────────
normal-chat           User + Working + Recent        日常对话不需要历史目录
                       (~500 tokens)

project-work          加上 Directory 摘要              项目模式下需要知道
                       (~800 tokens)                  过去做了什么决定

history-search        验证过的候选 + 原文摘录           搜索结果需要原文作证
                       (~1000 tokens)

source-verification   候选原文全文 + query 对照         验证时需要精读原文
                       (~2000 tokens)

archive-indexing      一段 Chunk 的原文                生成摘要时的输入格式
                       (~3000 tokens)                  (给 AI 做总结用)

worker-search         项目快照 + 单个子目录摘要          并行 Worker 只读自己
                       (~400 tokens)                  负责的目录
```

### 例子

```
场景: normal-chat（用户说 "继续开发 Button 组件"）

编译结果:
┌──────────────────────────────────────────────┐
│ # User Preferences                           │
│ - 回答简洁直接                                │
│ - 技术判断必须严谨                             │
│                                              │
│ # Working Memory                             │
│ ## Current Task                              │
│ 开发 React 组件库                             │
│ ## Confirmed Decisions                       │
│ - Tailwind CSS                               │
│ - TypeScript + Vite                          │
│ ## Progress                                  │
│ 已完成 Button、Input、Modal 基础组件            │
│                                              │
│ [user] 继续开发 Button 组件...                 │
│ [assistant] 好的，上次完成了 hover 效果...      │
│ [user] 加上 loading 状态                      │
│ [...最近 16 条消息...]                         │
└──────────────────────────────────────────────┘

模型只需 ~500 tokens 就能理解上下文，不需要翻 200 轮的历史。

────────────────────────────────────────────────

场景: project-work（用户说 "回顾一下这个项目的重大决策"）

编译结果:
┌──────────────────────────────────────────────┐
│ # User Preferences                           │
│ ...                                          │
│ # Working Memory                             │
│ ...                                          │
│                                              │
│ # Project History                            │
│ ## G2: 组件库项目从零到完整                     │
│                                              │
│ ## G1 (前期): 技术选型和基础架构                │
│ Key conclusions: SQLite + WAL, Tailwind CSS   │
│ Important changes: CSS Modules → Tailwind     │
│                                              │
│ ## G1 (后期): 架构重构和功能扩展                │
│ Key conclusions: monorepo 架构                │
│ Important changes: 单包 → monorepo            │
│                                              │
│ ## ⚠️ Unresolved Issues                      │
│ - v2.0 文档何时发布?                          │
│ - 状态管理选什么?                              │
│                                              │
│ [user] 回顾一下这个项目的重大决策               │
└──────────────────────────────────────────────┘

模型能看到完整的项目历史摘要，可以准确回答项目决策问题。
```

---

## 3. Memory Action Validation（记忆写回校验）

### 问题

LLM 是**不可信的**——它可能输出格式错误、尝试覆盖原文、把推测当事实。

### 方案：三层校验

```
AI 回复附带 memoryActions
        │
        ▼
  ① JSON 解析
     格式不对? → 拒绝，记录错误
        │
        ▼
  ② Zod Schema 校验
     target 不是 "workingMemory" 或 "userMemory"? → 拒绝
     operation 不是 "append" 或 "remove"?          → 拒绝
     section 或 value 为空?                        → 拒绝
        │
        ▼
  ③ Lynage 语义校验
     尝试修改原始消息?                           → 拒绝
     尝试删除整个目录?                           → 拒绝
     sourceFromId 指向不存在的消息?              → 拒绝
     推测性内容写为 confirmed 而没有标记?         → 警告
        │
        ▼
  ④ 数据库事务写入
     target="workingMemory" → working_memory 表
     target="userMemory"    → user_memory 表
```

### 例子：合法 vs 非法操作

```
✅ 合法:
{
  "target": "workingMemory",
  "operation": "append",
  "section": "confirmed",
  "value": "归档阈值设为 16000 tokens"
}
→ 追加到 working_memory.confirmed[]

────────────────────────────────

✅ 合法:
{
  "target": "workingMemory",
  "operation": "remove",
  "section": "unresolved",
  "value": "归档阈值设为多少？"
}
→ 从 working_memory.unresolved[] 中移除

────────────────────────────────

❌ 非法 — 尝试修改原文:
{
  "target": "messages",       ← 没有这个 target
  "operation": "update",
  "section": "content",
  "value": "修改后的内容"
}
→ Zod 校验: target 不在枚举中 → 拒绝

────────────────────────────────

❌ 非法 — 推测当事实:
{
  "target": "workingMemory",
  "operation": "append",
  "section": "confirmed",
  "value": "用户应该会选择 PostgreSQL"  ← "应该会" = 推测
}
→ Lynage 语义校验: 包含推测词 → 降级为 progress 而非 confirmed
```
