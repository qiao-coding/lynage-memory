# 全程推演：一次对话的完整生命周期

> 场景：用户正在用 Lynage 辅助开发一个组件库项目。假设归档阈值 = 2000 tokens（便于演示）。

---

## 第 1 轮 · 项目启动

```
用户: "我要做一个 React 组件库，帮我设计技术方案"
AI:   "建议用 TypeScript + Vite 构建，组件用函数式写法..."
```

**此时各层状态：**

```
Messages:                 Working Memory:
  msg-1  (user)             (空)
  msg-2  (assistant)

Directories:              Context:
  (无)                      总 Token: ~80
                            阈值: 2000
                            → 不归档
```

---

## 第 30 轮 · 第一个决策确定

经过 30 轮讨论，确定了技术选型。Agent 自动更新了 Working Memory。

```
用户: "那就用 CSS Modules 吧，简单"
AI:   "好的。已在 Working Memory 中记录。"

memoryActions:
  append confirmed: "使用 CSS Modules"
  append confirmed: "TypeScript + Vite 构建"
  append currentTask: "开发 React 组件库"
```

**此时各层状态：**

```
┌─────────────────────────────────────────────┐
│ Working Memory                              │
├─────────────────────────────────────────────┤
│ currentTask    开发 React 组件库              │
│ confirmed      使用 CSS Modules              │
│ confirmed      TypeScript + Vite 构建         │
└─────────────────────────────────────────────┘

Messages:                   Context:
  msg-1 ... msg-60            总 Token: ~1600
  (60 条消息)                 阈值: 2000
                              → 接近阈值，还没触发
```

---

## 第 50 轮 · 第一次归档

消息 Token 突破 2000，触发第一次归档。

```
用户: "Button 组件的 hover 效果不太好"
AI:   "需要调整 CSS transition..."

finishTurn() 之后:
  总 Token: 2100 > 2000 → 触发归档
```

**归档后各层状态：**

```
┌──────────────────────────────────────────────────────────┐
│                   Directory 树                            │
│                                                          │
│    Root                                                  │
│    └── G0 Directory (id: dir-001)                        │
│          └── Chunk-001                                   │
│                summary: "第1-42轮讨论了技术选型..."         │
│                sourceFrom: msg-1                         │
│                sourceTo:   msg-84                        │
│                                                          │
│                   Recent Messages                        │
│                   msg-85 ... msg-100                     │
│                   (最近 16 条，~400 tokens)               │
└──────────────────────────────────────────────────────────┘

Working Memory:             Messages 表:
  currentTask: 开发组件库       msg-1 ~ msg-100 (全部保留)
  confirmed: CSS Modules         Chunk-001 只是导航标签
  confirmed: TS + Vite           原文一条没丢
```

---

## 第 80 轮 · 方案变更

讨论了 30 轮后，决定从 CSS Modules 切换到 Tailwind。

```
用户:  "CSS Modules 用起来太麻烦了，切 Tailwind 吧"
AI:    "理解。需要重构 15 个已有组件。"

memoryActions:
  remove confirmed: "使用 CSS Modules"
  append confirmed: "使用 Tailwind CSS"
  append importantChange: "CSS Modules → Tailwind (第80轮)"
```

**Working Memory 变化：**

```
之前:                          之后:
┌──────────────────────┐      ┌──────────────────────────┐
│ confirmed:            │      │ confirmed:                │
│  CSS Modules          │      │  Tailwind CSS    ← 新     │
│  TS + Vite            │      │  TS + Vite               │
│                       │      │                          │
│                       │      │ recentChanges:           │
│                       │      │  CSS→Tailwind   ← 新     │
└──────────────────────┘      └──────────────────────────┘
```

---

## 第 100 轮 · 目录树开始生长

又触发了 2 次归档，G0 下已有 3 个 Chunk。

**此时各层状态：**

```
┌──────────────────────────────────────────────────────────────┐
│ Messages 表 (200 条，全部保留)                                │
│                                                              │
│ msg-1   "我要做一个 React 组件库..."     ← 在 Chunk-001 里     │
│ msg-85  "...Button hover 效果..."        ← 在 Chunk-002 里     │
│ msg-165 "...切 Tailwind..."              ← 在 Chunk-003 里     │
│ msg-185 "..."                            ← Recent 里          │
│ ...                                                          │
│ msg-200 "..."                            ← Recent 里          │
├──────────────────────────────────────────────────────────────┤
│ Directory 树                                                 │
│                                                              │
│    Root                                                      │
│    └── G0 Directory (dir-001)                                │
│          ├── Chunk-001 (第1-42轮: 技术选型)                    │
│          ├── Chunk-002 (第43-82轮: 初期开发)                   │
│          └── Chunk-003 (第83-92轮: 切换到Tailwind)             │
│                                                              │
│    Recent: msg-185 ~ msg-200 (16条, ~400 tokens)             │
├──────────────────────────────────────────────────────────────┤
│ Working Memory                                               │
│   currentTask: 开发 React 组件库                               │
│   confirmed:   Tailwind CSS, TS + Vite, 函数式组件              │
│   progress:    已完成基础组件开发, 正在迁移样式                   │
│   recentChanges: CSS Modules → Tailwind                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 第 120 轮 · G0 装满 → 第一次升代 (G0→G1)

G0 下积累了 20 个 Chunk，触发第一次代际压缩。

```
┌──────────── 之前 ────────────┐    ┌──────────── 之后 ────────────┐
│                              │    │                              │
│  Root                        │    │  Root                        │
│  └── G0 (dir-001)            │    │  └── G1 (dir-002) ← 新!      │
│        ├── Chunk-001         │    │        │                     │
│        ├── Chunk-002         │    │        └── G0 (dir-001)      │
│        ├── ...               │    │              ├── Chunk-001   │
│        └── Chunk-020         │    │              ├── Chunk-002   │
│                              │    │              ├── ...         │
│                              │    │              └── Chunk-020   │
│                              │    │                              │
│                              │    │  G1 自动生成摘要:              │
│                              │    │  "前期开发阶段，完成了技术选型、  │
│                              │    │   基础组件开发、样式迁移。"      │
└──────────────────────────────┘    └──────────────────────────────┘
```

**升代过程**：AI 读取 20 个 Chunk 的摘要 → 生成 G1 的 `overallContent` 和 `mainConclusions`。

---

## 第 160 轮 · 架构大变更

团队壮大，重新讨论 monorepo 方案。

```
用户:  "团队 5 个人了，之前那个 monorepo 方案现在可以做了"
AI:    "是的，之前在第 25 轮时认为时机不成熟。
        现在是时候了，我帮你查一下当时的讨论..."

(Agent 调用 lynageSearch("monorepo"))
  → FTS 搜索找到 8 条匹配消息
  → 定位到 Chunk-001: "第 3-5 轮讨论过 monorepo 但放弃了"
  → SourceVerifier 打开 msg-40 ~ msg-52 原文验证
  → 置信度 90%

AI:    "找到了。第 25 轮时我们决定不做 monorepo，
        理由是'只有 3 个包，拆 monorepo 是过早优化'。
        现在有 5 个包了，条件已满足。"
```

**搜索过程图示：**

```
lynageSearch("monorepo")
    │
    ├─ ① FTS5: 在 messages.content 中搜 "monorepo"
    │      → 命中 msg-40, msg-45, msg-48, msg-52, ...
    │
    ├─ ② 匹配 Chunk: 这些消息的时间范围在 Chunk-001 内
    │      → Chunk-001.summary: "第1-42轮: 技术选型讨论"
    │
    ├─ ③ 目录下钻: Root → G1 → G0 → Chunk-001
    │      → 确认 Chunk-001 确实在目录树里
    │
    ├─ ④ 原文验证 (SourceVerifier):
    │      打开 msg-40 ~ msg-52 原文
    │      query "monorepo" 匹配到原文中 4 处
    │      → verified: true, confidence: 0.9
    │
    └─ ⑤ 编译结果给 LLM:
           "发现相关讨论: Chunk-001 第 25 轮,
            决定不做 monorepo（过早优化）。
            原文: msg-40 ~ msg-52"
```

---

## 第 180 轮 · 第二次升代 (G1→G2)

第 2 个 G0 又装满了 20 个 Chunk → 生成第 2 个 G1。现在有 2 个 G1，又触发升代到 G2。

**此时目录树：**

```
    Root
    └── G2 (dir-005) ← 新!
          │ 摘要: "组件库项目从零到完整，经历技术选型、
          │        样式迁移、monorepo 重构三个阶段。"
          │
          ├── G1 (dir-002) ← "前期开发阶段"
          │     └── G0 (dir-001, 20 Chunks)
          │
          └── G1 (dir-004) ← "架构重构阶段"
                └── G0 (dir-003, 20 Chunks)

    活跃区:
    └── G0 (dir-006) ← 新的 Chunk 往这里加
          ├── Chunk-041 (最新)
          └── Chunk-042 (最新)
```

**Working Memory 当前状态：**

```
┌────────────────────────────────────┐
│ Working Memory                     │
├────────────────────────────────────┤
│ currentTask    组件库 v2.0 重构     │
│ confirmed      monorepo 架构        │
│ confirmed      Tailwind CSS         │
│ confirmed      TS + Vite + Drizzle  │
│ progress      已完成 80% 组件迁移    │
│ unresolved    v2.0 文档何时发布?    │
│               状态管理选什么?        │
│ recentChanges  单包→monorepo        │
│                CSS→Tailwind         │
└────────────────────────────────────┘
```

---

## 第 200 轮 · 用户问历史问题

用户问了一个模糊的问题，触发持久化搜索。

```
用户:  "之前那个样式方案为什么不用了？"
       (非常模糊——没说哪个方案、什么时候)

Agent: "我不确定你指的是哪个变更。我先搜一下..."

lynageSearch("样式方案 不用了")
  → FTS 匹配: 5 条消息，分散在 3 个 Chunk
  → 候选太多，不确定是哪个
  → 创建 SearchTask (持久化搜索)

┌──────────────────────────────────────┐
│ SearchTask (id: search-003)          │
├──────────────────────────────────────┤
│ query:       "样式方案 不用了"         │
│ understanding: "用户可能在问 CSS      │
│   Modules 或 Tailwind 相关变更"       │
│ checkedDirs:  [dir-001]              │
│ candidates:   [Chunk-001]            │
│ cursor:       dir-002                │
│ status:       in_progress            │
└──────────────────────────────────────┘

Agent: "找到了两个相关的变更：
         1. CSS Modules → Tailwind (第80轮)
         2. 放弃语义项目分类 (第7轮)
        你指的是哪一个？"
```

---

## 全景对比：第 1 轮 vs 第 200 轮

```
                     第 1 轮                    第 200 轮
                   ─────────                  ──────────
Messages           2 条                       400 条 (全部保留)

Chunks             0                          42 个

Directory          无                           G2
                                               ├── G1
                                               │    └── G0 (20 chunks)
                                               ├── G1
                                               │    └── G0 (20 chunks)
                                               └── G0 (2 chunks 活跃)

Working Memory     空                          已记录 3 个决策
                                               2 个未决问题
                                               2 次重大变更

Recent Context     2 条消息 (~80 tokens)        16 条消息 (~400 tokens)
                                               (一直保持稳定)

LLM 看到的         # User Preferences          # User Preferences
                   - 简洁直接                   - 简洁直接
                   [user] 我要做组件库...        - 技术严谨
                                               
                                               # Working Memory
                                               Current: 组件库 v2.0
                                               Confirmed: monorepo, Tailwind...
                                               
                                               # Project History
                                               G2: 组件库项目从零到完整...
                                               
                                               [user] 那个样式方案...
                                               [assistant] 我不确定...  ←最近16条原文
```

---

## 关键数据不变量

无论目录树多深、Chunk 多少：

```
  任何 Chunk.sourceFromId ──→ messages 表中的精确位置
  任何 Chunk.sourceToId   ──→ messages 表中的精确位置

  搜索路径:  Root → G2 → G1 → G0 → Chunk → 原文
            (目录树提供导航)              (数据库提供事实)
```

**原文永不丢失。目录只是地图。**
