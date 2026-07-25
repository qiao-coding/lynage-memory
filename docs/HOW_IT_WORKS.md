# Lynage Memory 工作原理

> 从底层消息到上层记忆——每一层做什么、为什么这样做、数据怎么流动。

---

## 目录

1. [一句话概括](#1-一句话概括)
2. [全景图：数据如何流动](#2-全景图数据如何流动)
3. [第一层：Messages — 永不丢失的原文](#3-第一层messages--永不丢失的原文)
4. [第二层：Context Chunk — 对话的"档案袋"](#4-第二层context-chunk--对话的档案袋)
5. [第三层：Directory — 档案袋的"目录柜"](#5-第三层directory--档案袋的目录柜)
6. [第四层：代际压缩 — 目录柜满了怎么办](#6-第四层代际压缩--目录柜满了怎么办)
7. [第五层：Working Memory — Agent 的"便签纸"](#7-第五层working-memory--agent-的便签纸)
8. [第六层：User Memory — 长期不变的"用户画像"](#8-第六层user-memory--长期不变的用户画像)
9. [第七层：Context Compiler — 给模型看的"精简版"](#9-第七层context-compiler--给模型看的精简版)
10. [搜索流程：怎么找回历史](#10-搜索流程怎么找回历史)
11. [并行搜索：多个工人同时翻档案](#11-并行搜索多个工人同时翻档案)
12. [记忆写回：Agent 怎么更新记忆](#12-记忆写回agent-怎么更新记忆)
13. [完整对话示例](#13-完整对话示例)

---

## 1. 一句话概括

Lynage Memory 像是一个**永远不丢原件的档案馆**：

- 每一句话都原样保存（Messages）
- 旧的对话装进档案袋（Context Chunk），贴上摘要标签
- 档案袋放进目录柜（Directory），按时间排列
- 柜子满了就换更大的柜子（代际压缩）
- Agent 需要时，从标签找到档案袋，打开读原文（搜索+恢复）

**核心原则：摘要只是导航标签，原文才是事实。**

---

## 2. 全景图：数据如何流动

```
用户说了一句话
      │
      ▼
  ┌─────────────────────────────────────────────┐
  │  lynageStreamText()                         │
  │                                             │
  │  1. startTurn()──→ 保存 user message ────────┐
  │  2. streamText()──→ 调用模型                  │
  │  3. finishTurn()──→ 保存 assistant + tools ──┤
  │       │                                      │
  │       └──→ ArchiveManager.checkAndArchive()  │
  │              │                               │
  │              ├─ 检查 Token 是否超标           │
  │              ├─ 找到自然边界（不切断对话）      │
  │              ├─ 旧消息 → Context Chunk        │
  │              ├─ AI 生成导航摘要               │
  │              └─ 加入 G0 目录                  │
  │                   │                          │
  │                   └─ G0 满 → G1 → G2 ...      │
  └─────────────────────────────────────────────┘
      │
      ▼
  模型收到回答所需的最小上下文
  (Working Memory + User Memory + Recent Messages)
```

**存储层**：所有数据存在 SQLite 数据库中（7 张表），JSON/Markdown 只是给模型看的"视图"。

---

## 3. 第一层：Messages — 永不丢失的原文

### 是什么

Messages 表是 Lynage 的**地基**。每一条用户消息、AI 回复、工具调用、工具结果都以追加方式保存，从不修改、从不删除。

### 一条消息长什么样

```json
{
  "id": "msg-1042",
  "sessionId": "session-28",
  "userId": "user-001",
  "role": "user",
  "content": "那就用 lynage-memory 这个名字吧",
  "tokenCount": 8,
  "createdAt": 1752883200000
}
```

每条消息记录 7 个信息：

| 字段 | 含义 | 为什么需要 |
|------|------|-----------|
| `id` | 唯一标识 | 用来精确引用"从 msg-820 到 msg-910" |
| `sessionId` | 属于哪次会话 | 一次对话=一个 session |
| `role` | 谁说的 | user / assistant / tool / system |
| `content` | 说了什么 | **这是原文，永不被摘要覆盖** |
| `tokenCount` | 大约多少个 token | 用来判断"是不是该归档了" |
| `createdAt` | 什么时候说的 | 用来按时间排序和分阶段 |
| `toolCallId` | 关联哪个工具调用 | 区分"工具调用"和"工具结果" |

### 为什么 messages 不直接给模型看

如果每次对话都把全部 messages 塞给模型：

```
第 1 轮：1 条消息（30 tokens）
第 10 轮：20 条消息（600 tokens）
第 50 轮：100 条消息（3000 tokens）
第 200 轮：400 条消息（12000 tokens）← 快满了
第 500 轮：1000 条消息（30000 tokens）← 超出窗口！
```

模型有上下文窗口限制（比如 16000 tokens）。当消息太多，必须**选择**哪些放进窗口。

**Lynage 的做法**：旧消息归档→生成摘要→最新的消息继续原样保留。

---

## 4. 第二层：Context Chunk — 对话的"档案袋"

### 是什么

当对话太长、Token 快超标时，Lynage 把**较旧的消息打包成一个 Context Chunk**——就像把一叠旧文件装进档案袋，贴上摘要标签。

### 一个 Chunk 长什么样

```json
{
  "id": "ctx-028",
  "sessionId": "session-28",
  "timeRangeStart": 1752880000000,
  "timeRangeEnd": 1752883200000,
  "summary": "讨论 Lynage Memory 的定位和命名。确定包名为 lynage-memory。",
  "progress": "将 Lynage 从完整 Agent 修正为 Memory 模块。",
  "keywords": ["Lynage Memory", "命名", "定位", "Hermes"],
  "sourceFromId": "msg-980",
  "sourceToId": "msg-1042",
  "directoryId": "dir-005"
}
```

| 字段 | 含义 |
|------|------|
| `summary` | **AI 生成的导航摘要**——一句话告诉你这个档案袋里有什么 |
| `progress` | 这个阶段项目推进了什么 |
| `keywords` | 关键词，用来搜索时快速匹配 |
| `sourceFromId` / `sourceToId` | **原文在哪**——从哪条消息到哪条消息 |

### 归档是怎么触发的

```
Recent Messages 总 Token > 16000
        │
        ▼
  第一步：找自然边界
  ┌──────────────────────────────┐
  │ 不能在这里切断：              │
  │ ❌ 用户问题和 AI 回答之间      │
  │ ❌ 工具调用和工具结果之间      │
  │ ❌ 未完成的决策过程中间        │
  │                              │
  │ 只能在这里切断：              │
  │ ✅ 一轮完整对话结束后          │
  │ ✅ 所有工具调用都已返回结果后   │
  └──────────────────────────────┘
        │
        ▼
  第二步：打包旧消息
  旧消息（比如前 50 条）→ 装进 Chunk
  新消息（比如后 30 条）→ 继续留在 Recent
        │
        ▼
  第三步：AI 生成摘要
  把 Chunk 里的所有原文发给 AI：
  "帮我把这段对话总结成一段导航描述"
  AI 返回 summary + progress + keywords
        │
        ▼
  第四步：存起来
  Chunk 写入数据库
  原文（messages）依然保留，不动
```

### 关键点

> **Chunk 里的 summary 只是"导航标签"，不是"替代品"。**
> 如果 Agent 需要知道详情，它可以根据 `sourceFromId` 和 `sourceToId`
> 直接打开原始 messages，读到每一个字。

---

## 5. 第三层：Directory — 档案袋的"目录柜"

### 是什么

Chunk 多了以后，需要一个**目录**来管理它们。Directory 就像档案室的柜子——每个柜子里放着一些档案袋（Chunks）或更小的柜子（子目录）。

### 一个 Directory 长什么样

```json
{
  "id": "dir-005",
  "sessionId": "session-28",
  "generation": 0,
  "parentId": null,
  "timeRangeStart": 1752800000000,
  "timeRangeEnd": 1752900000000,
  "overallContent": "这一阶段从比较 Hermes 的上下文压缩问题开始，随后放弃语义项目分类，确定使用时间和容量驱动的代际目录。",
  "progress": "已将 Lynage 定位为独立 Agent Memory 模块。",
  "mainConclusions": [
    "原始消息永久保存",
    "目录摘要只用于导航",
    "目录按容量逐代压缩"
  ],
  "importantChanges": [
    "放弃语义项目分类",
    "将产品定位从完整 Agent 修正为 Memory 模块"
  ]
}
```

### 目录树是怎么长出来的

```
一开始：
  Root
  └── G0 Directory (空的，等 Chunk 进来)

第 1 次归档：
  Root
  └── G0 Directory
        └── Chunk-001 (第 1-20 轮对话)

第 5 次归档：
  Root
  └── G0 Directory
        ├── Chunk-001 (第 1-20 轮)
        ├── Chunk-002 (第 21-40 轮)
        ├── Chunk-003 (第 41-60 轮)
        ├── Chunk-004 (第 61-80 轮)
        └── Chunk-005 (第 81-100 轮)
```

### 目录的作用

1. **导航**：搜索时从 Root → Directory → Chunk，不用遍历所有消息
2. **容量管理**：一个目录最多放 20 个子节点，满了就触发压缩
3. **进度追踪**：目录的 `progress` 和 `mainConclusions` 记录了项目在某个阶段的变化

---

## 6. 第四层：代际压缩 — 目录柜满了怎么办

### 问题

G0 目录装满了 20 个 Chunk 后，再归档时怎么办？

### 方案：升代

```
G0 满了（20 个孩子）
        │
        ▼
  创建 G1 Directory（新的父目录）
  原来的 G0 降级为 G1 的子节点
  G1 成为 Root 的新直属节点
  AI 根据 20 个 Chunk 的摘要，生成 G1 的摘要
```

### 示例

```
之前：
  Root
  └── G0 Directory (20 个 Chunk)

之后：
  Root
  └── G1 Directory（摘要："这 20 段对话完成了架构设计..."）
        └── G0 Directory（20 个 Chunk）

继续归档：
  Root
  ├── G1 Directory（架构设计阶段）
  │     └── G0 Directory（20 个 Chunk）
  └── G0 Directory（新 Chunk，开始新阶段）
        ├── Chunk-021
        └── Chunk-022

G0 又满了：
  Root
  └── G2 Directory（整个项目的前半段）
        ├── G1 Directory（架构设计阶段）
        │     └── G0 Directory（20 个 Chunk）
        └── G1 Directory（功能开发阶段）
              └── G0 Directory（20 个 Chunk）
```

### 关键点

> **压缩的是导航结构，不是原文。**
> 即使在 G3 目录最深处，最底层的 Chunk 仍然有 `sourceFromId` 和 `sourceToId`，
> 可以一路追溯到原始的 messages。

---

## 7. 第五层：Working Memory — Agent 的"便签纸"

### 是什么

Working Memory 是 Agent **当前正在做的事**的记录。它不是历史档案，而是"现在进行到哪了"。

### 一张便签纸长什么样

```json
{
  "id": "wm-session-28",
  "sessionId": "session-28",
  "currentTask": "设计 Lynage Memory 架构",
  "confirmed": [
    "原文不可变保存",
    "目录按时间和容量压缩",
    "摘要用于导航，原文是事实"
  ],
  "progress": [
    "已完成消息层设计",
    "已确定代际压缩方案",
    "正在设计并行搜索"
  ],
  "unresolved": [
    "归档阈值设为多少？",
    "目录容量 20 是否合适？"
  ],
  "recentChanges": [
    "产品定位从完整 Agent 修正为 Memory 模块"
  ]
}
```

| 字段 | 含义 | 举例 |
|------|------|------|
| `currentTask` | 当前在做什么 | "设计 Lynage Memory 架构" |
| `confirmed` | 已经确定的结论 | "原文不可变保存" |
| `progress` | 进行到哪一步 | "已确定代际压缩方案" |
| `unresolved` | 还没解决的问题 | "归档阈值设为多少？" |
| `recentChanges` | 最近有什么变化 | "定位从 Agent 修正为 Memory" |

### 什么时候更新

每次 AI 回复时，可以附带记忆操作：

```json
{
  "reply": "已确定归档阈值为 16000 tokens。",
  "memoryActions": [
    {
      "target": "workingMemory",
      "operation": "append",
      "section": "confirmed",
      "value": "归档阈值设为 16000 tokens"
    },
    {
      "target": "workingMemory",
      "operation": "remove",
      "section": "unresolved",
      "value": "归档阈值设为多少？"
    }
  ]
}
```

Lynage 解析这段 JSON → 校验格式 → 追加到 `confirmed` → 从 `unresolved` 删除。

### 关键点

> Working Memory 让 Agent **每次对话都知道自己在做什么**，
> 不需要重新翻历史来回忆"上次做到哪了"。
> 它自动注入进每次模型调用的上下文中。

---

## 8. 第六层：User Memory — 长期不变的"用户画像"

### 是什么

User Memory 保存**跨任务、跨会话**的稳定信息。一个人的偏好不会因为换个任务就改变。

### 用户画像长什么样

```json
{
  "id": "um-user-001",
  "userId": "user-001",
  "preferences": [
    "回答简洁直接",
    "技术判断必须严谨",
    "不喜欢复杂流程图式编辑器"
  ],
  "longTermGoals": [
    "构建完整的 Agent 开发生态"
  ],
  "constraints": [
    "不使用向量数据库",
    "不绑定特定模型厂商",
    "第一版不做云同步"
  ],
  "background": "7 年全栈开发，专注 AI Agent 和前端工具链"
}
```

### 和 Working Memory 的区别

| | Working Memory | User Memory |
|---|---|---|
| 范围 | 当前任务 | 跨任务 |
| 变化频率 | 每轮对话可能变 | 很少变 |
| 举例 | "正在设计并行搜索" | "回答要简洁直接" |
| 存储键 | `sessionId` | `userId` |
| 谁更新 | Agent 对话中自动更新 | 开发者手动配置或 Agent 确认后更新 |

---

## 9. 第七层：Context Compiler — 给模型看的"精简版"

### 问题

数据库里有 7 张表、成百上千条记录。但模型一次只能看有限的文本。**怎么筛选和编译？**

### 编译流程

```
数据库
  │
  ▼
Context Selection（选什么？）
  ├── User Memory       ← 每次都带，但内容很少
  ├── Working Memory    ← 每次都带
  ├── Recent Messages   ← 最近 30 条原样
  └── Directory 摘要    ← 只在"项目模式"时带
  │
  ▼
Context Compiler（怎么编译？）
  根据场景选择不同视图：
  ├── normal-chat：       UserMemory + WorkingMemory + Recent
  ├── project-work：      加上 Directory 摘要 + 未解决问题
  ├── history-search：    检索结果原文 + 置信度
  ├── source-verification：候选原文全文
  ├── archive-indexing：  Chunk 消息 → 摘要 Prompt
  └── worker-search：     项目快照 + 单个子目录（预留）
  │
  ▼
模型收到的内容（示例 normal-chat）

# User Preferences
- 回答简洁直接
- 技术判断必须严谨

# Working Memory
## Current Task
设计 Lynage Memory 架构

## Confirmed Decisions
- 原文不可变保存
- 目录按时间和容量压缩

## Progress
- 已确定代际压缩方案

## Unresolved
- 目录容量 20 是否合适？

[user] 那我们继续设计并行搜索方案...
[assistant] 好的，并行搜索需要解决几个问题...
[user] 上一个问题你还没回答...
```

### 关键点

> **Context Compiler 是"筛选器"**——从 7 张表里挑出当前场景需要的内容，
> 编译成一段精简文本给模型。模型不需要知道数据库的存在。

---

## 10. 搜索流程：怎么找回历史

### 明确的问题（普通搜索）

```
用户问："之前为什么放弃语义分类？"
        │
        ▼
  lynageSearch("语义分类")
    │
    ├── 第一步：FTS5 全文搜索
    │   在 messages.content 里搜"语义分类"
    │   → 找到 3 条匹配消息
    │
    ├── 第二步：找到消息属于哪个 Chunk
    │   3 条消息的时间范围在 Chunk-028 里
    │   → Chunk-028: "讨论并放弃语义项目分类"
    │
    ├── 第三步：目录下钻
    │   Root → G0 Directory → Chunk-028
    │   → 确认这个 Chunk 确实在目录里
    │
    ├── 第四步：原文验证 (SourceVerifier)
    │   打开 Chunk-028 的原文（msg-820 到 msg-847）
    │   → 确认"语义分类"确实出现在原文中
    │   → 置信度 85%
    │
    └── 第五步：编译结果
        把验证过的候选 + 原文摘要 → 编译成文本
        → 注入到模型下一轮上下文中
```

### 模糊的问题（持久化搜索）

```
用户问："之前那个设计为什么不用了？"
        │
        ▼
  问题太模糊 → 创建 SearchTask

  ┌────────────────────────────────┐
  │ SearchTask                     │
  │ query: "之前那个设计为什么..."    │
  │ understanding: "用户在问一个被   │
  │   放弃的设计方案，但没说是哪个"   │
  │ checkedDirectories: []          │
  │ candidates: []                  │
  │ status: pending                 │
  └────────────────────────────────┘
        │
        ▼
  第 1 批：检查 3 个目录
    dir-028：讨论产品命名 — 无关
    dir-027：出现定位修正 — 可能相关 ⭐
    dir-026：放弃语义分类 — 可能相关 ⭐
  保存进度 → status: in_progress
        │
        ▼
  第 2 批：继续检查 3 个目录
    dir-025：讨论存储方案 — 无关
    dir-024：确定代际目录 — 相关 ⭐
    ...

  全部检查完 → status: completed
        │
        ▼
  分析结果：
    候选 1: Lynage 从 Agent 修正为 Memory 模块
    候选 2: 放弃语义项目分类
    候选 3: 代际目录方案确定

  Agent 回复："可能是指这 3 个变更中的某一个，你想了解哪个？"
```

### 关键点

> 模糊搜索允许 Agent **分批次、保存进度、跨轮次**进行。
> 不会因为一次搜索时间太长而超时，也不会重复检查已经看过的目录。

---

## 11. 并行搜索：多个工人同时翻档案

### 场景

当问题非常重要、需要彻底翻遍所有历史时，一个工人（Worker）挨个检查太慢了。

### 并行搜索怎么工作

```
主进程创建项目快照
┌─────────────────────────────────────┐
│ ProjectSnapshot                     │
│ projectGoal: "设计 Lynage Memory"   │
│ currentProgress: "确定并行历史检索"   │
│ knownDecisions: ["原文不可变", ...]  │
│ question: "之前为什么放弃那个方案？"   │
│ searchGoal: "寻找方案提出和废弃过程"   │
└─────────────────────────────────────┘
        │
        ├──→ Worker A：检查目录 A（第 1-20 轮）
        ├──→ Worker B：检查目录 B（第 21-40 轮）
        ├──→ Worker C：检查目录 C（第 41-60 轮）
        └──→ Worker D：检查目录 D（第 61-80 轮）
        │
        ▼
  所有 Worker 并发执行
  每个 Worker：
    ✅ 共享同一个项目快照（知道在找什么）
    ✅ 只读自己分配到的目录
    ✅ 不修改 Working Memory
    ✅ 不生成最终答案
    ✅ 只返回证据位置
        │
        ▼
  主进程收集所有结果
    ├── 合并候选（去重）
    ├── 原文验证（SourceVerifier）
    ├── 读前后消息（扩展上下文）
    ├── 重建信息演变链
    │    方案提出 → 讨论尝试 → 暴露问题 → 正式废弃 → 新方案替代
    └── 输出最终结论
```

### 为什么叫"Shared-Context"

每个 Worker 都拿到**同一份项目快照**——它们对"项目在做什么、已经确定了什么、要找什么"有相同的理解。但它们读的**历史数据不同**——各自负责不同的时间段。

就像 4 个研究员拿到同样的研究问题，分别去不同的档案室翻资料，最后把笔记汇总给主编。

---

## 12. 记忆写回：Agent 怎么更新记忆

### 流程

```
AI 回复中附带 memoryActions
        │
        ▼
  JSON 解析
        │
        ▼
  Zod Schema 校验
  ├── target 必须是 "workingMemory" 或 "userMemory"
  ├── operation 必须是 "append" 或 "remove"
  └── section 和 value 不能为空
        │
        ▼
  语义校验（Lynage 检查）
  ├── 不能覆盖整个 memory
  ├── 不能修改原始消息
  ├── 不能删除完整目录
  └── 推测不能写成确定事实
        │
        ▼
  数据库事务写入
  ├── target=workingMemory → working_memory 表
  └── target=userMemory → user_memory 表
```

### 示例

```json
// AI 回复
{
  "reply": "共享上下文并行检索方案已确定。",
  "memoryActions": [
    {
      "target": "workingMemory",
      "operation": "append",
      "section": "confirmed",
      "value": "Worker 共享同一个项目上下文快照"
    },
    {
      "target": "workingMemory",
      "operation": "remove",
      "section": "unresolved",
      "value": "Worker 之间如何共享上下文？"
    }
  ]
}

// 执行后 Working Memory 的变化
// confirmed: [..., "Worker 共享同一个项目上下文快照"]  ← 新增
// unresolved: ["归档阈值？"]  ← "Worker 之间..." 被删除
```

### 模型不能做的事

- ❌ 替换整个 memory.json
- ❌ 修改原始消息（messages 表不可变）
- ❌ 删除完整历史目录
- ❌ 将推测写为确定事实
- ❌ 破坏 sourceFromId / sourceToId 引用

---

## 13. 完整对话示例

让我们跟踪一次完整的对话，看看各层如何运作。

### 场景

用户正在用 Lynage 辅助开发一个项目。

### 第 1 轮

```
用户："帮我设计一个数据库方案"

┌─ startTurn() ──────────────────────────┐
│ 1. 保存 user message:                  │
│    role: "user"                        │
│    content: "帮我设计一个数据库方案"      │
│                                        │
│ 2. 编译上下文（目前只有 User Memory）：   │
│    # User Preferences                  │
│    - 简洁直接                          │
│    - 技术严谨                          │
│                                        │
│    [user] 帮我设计一个数据库方案         │
└────────────────────────────────────────┘

┌─ streamText() ─────────────────────────┐
│ 模型收到上面的上下文                      │
│ 模型回复："推荐 SQLite + WAL 模式..."    │
└────────────────────────────────────────┘

┌─ finishTurn() ────────────────────────┐
│ 保存 assistant message:               │
│   role: "assistant"                   │
│   content: "推荐 SQLite + WAL 模式..." │
│                                       │
│ checkAndArchive():                    │
│   当前总 Token: 80                     │
│   阈值: 16000                         │
│   → 80 < 16000，不归档                │
└───────────────────────────────────────┘
```

### 第 200 轮

```
用户："之前那个数据库方案有没有更好的替代？"

┌─ startTurn() ──────────────────────────┐
│ 编译上下文：                            │
│                                        │
│ # User Preferences                     │
│ - 简洁直接                             │
│ - 技术严谨                             │
│                                        │
│ # Working Memory                       │
│ ## Current Task                        │
│ 设计数据库方案                          │
│ ## Confirmed Decisions                 │
│ - 使用 SQLite + WAL 模式               │
│ - 使用 Drizzle ORM                     │
│ - 使用 FTS5 全文搜索                   │
│                                        │
│ # Project History                      │
│ ## 7/23 — 7/24                         │
│ 讨论了 SQLite vs PostgreSQL 的权衡...   │
│                                        │
│ [user] 之前那个数据库方案有没有更好的替代？│
│ [... 最近 30 条消息原样保留 ...]         │
└────────────────────────────────────────┘

┌─ Agent 自动调用 lynageSearch() ────────┐
│ 搜索"数据库方案 替代"                    │
│ → FTS5 在 messages 里找到 5 条匹配消息   │
│ → 定位到 Chunk-005: "数据库选型讨论"    │
│ → SourceVerifier 验证原文               │
│ → 置信度 92%                           │
│                                        │
│ 返回给模型：                            │
│ "发现相关讨论：在第 5-15 轮对话中，      │
│  比较了 SQLite、PostgreSQL 和 libSQL，  │
│  最终因零配置和 FTS5 选择了 SQLite。"    │
└────────────────────────────────────────┘

模型回复（基于检索到的历史）：
  "我们之前比较过 SQLite、PostgreSQL 和 libSQL。
   当时选择 SQLite 是因为零配置和 FTS5 全文搜索。
   如果要考虑替代方案，libSQL 可以保持 SQLite 兼容
   的同时支持远程复制，但会增加运维复杂度。
   
   考虑到你的约束'不使用分布式存储'，
   我建议继续使用 SQLite。"
```

### 这轮对话的数据变化

```
Working Memory:
  unresolved: [
    + "是否需要将 SQLite 替换为 libSQL？"
  ]

Recent Messages:
  + 第 200 轮的 user / assistant 消息

不归档（还没到阈值）:
  第 1-199 轮的消息已经在之前的归档中变成了 Chunks
  只有第 170-200 轮的消息还在 Recent Context 里
```

---

## 总结

```
                    ┌──────────────────────┐
                    │    Context Compiler   │  ← 筛选编译
                    │  (给模型看的精简版)     │
                    └──────────┬───────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  User Memory  │    │Working Memory │    │Recent Messages│
│  (长期不变)    │    │  (当前任务)    │    │  (最近对话)    │
└───────────────┘    └───────────────┘    └───────┬───────┘
                                                   │
                                         超过阈值 → 归档
                                                   │
                                          ┌────────▼────────┐
                                          │  Context Chunk  │
                                          │  (档案袋+摘要)    │
                                          └────────┬────────┘
                                                   │
                                          Chunk 多了 → 建目录
                                                   │
                                          ┌────────▼────────┐
                                          │   Directory     │
                                          │  (目录柜 G0)     │
                                          └────────┬────────┘
                                                   │
                                          G0 满了 → 升代
                                                   │
                                          ┌────────▼────────┐
                                          │ G1 → G2 → G3   │
                                          │  (更大的柜子)    │
                                          └─────────────────┘

                     所有层的底层：
              ┌──────────────────────┐
              │   Messages 表 (SQLite) │  ← 原文永不丢失
              │   WAL + FTS5          │
              └──────────────────────┘
```

**一句话总结**：

> Lynage Memory 是一个从底层原文到上层记忆视图的完整体系——
> 底层 messages 永远不变，中层 Chunk 和 Directory 只做导航，
> 上层 Working Memory 和 User Memory 告诉 Agent "现在在做什么"和"用户是谁"，
> Context Compiler 把这一切编译成模型能理解的精简文本。
