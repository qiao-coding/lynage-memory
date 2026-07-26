# 结论与概述：怎么从消息里提炼出来

> 术语见 [00-terminology.md](00-terminology.md)
>
> 这篇回答一个核心问题：**从对话消息到最终结论，中间经过了哪些步骤？每一步谁来做、怎么做、怎么验证？**

---

## 一图看懂：三层提炼

```
消息 (原文)                窗口摘要              阶段概述            最终结论
────────────────────────────────────────────────────────────────────────────

msg-1: "用CSS Modules吧"                           📁 阶段: 前期开发
msg-2: "好的，CSS很适合"   → AI读全部消息 →        overallContent:     ← AI读20个窗口
msg-3: "Button怎么做?"     "讨论了技术选型，          "从技术选型开始，     摘要→合成
...                        确定CSS+TS+Vite，        经历了样式迁移，
msg-42: "迁移完成"         开始组件开发"            最终确定Tailwind"    → AI读阶段概述
                           
                           🗂 窗口 #1               mainConclusions:     + 打开原文验证
                           summary: "技术选型"       [CSS→Tailwind]      → 得出结论:
                           progress: "已确定技术栈"  importantChanges:    "样式方案经历
                           keywords: [CSS, TS]      [样式迁移]           了CSS→Tailwind
                                                                        的演变"
```

**每一层都是一次 AI 提炼，提炼结果只做导航。最终结论必须回到原文验证。**

---

## 第一层：消息 → 窗口摘要

### 什么时候触发

当前对话的 Token 超出阈值 → 旧消息被冻结成窗口 → 立即调用 AI 为这个窗口生成摘要。

### 怎么做

```
ArchiveManager.checkAndArchive()
  │
  ├─ 把 msg-1 ~ msg-84 的全部原文发给 AI
  │
  └─ AI 被要求输出三样东西:
      ┌─────────────────────────────────────────────┐
      │ summary:   "讨论了React组件库的技术选型，      │
      │            确定使用CSS Modules + TypeScript   │
      │             + Vite 作为技术栈，开始开发        │
      │             Button 和 Input 组件"             │
      │                                             │
      │ progress:  "技术选型完成，进入组件开发阶段"     │
      │                                             │
      │ keywords:  ["React", "CSS Modules",          │
      │             "TypeScript", "Vite", "Button"]  │
      └─────────────────────────────────────────────┘
```

### AI 看到什么

AI 看到的是这个窗口里的**全部原文**。系统把 msg-1 到 msg-84 的完整对话拼在一起，加上一段指令：

```
Summarize the following conversation segment.

Focus on:
- What was discussed and decided
- How the work progressed (not just topics, but the flow of decisions)
- Key terms and concepts mentioned

[USER] 我要做一个 React 组件库...
[ASSISTANT] 建议用 TypeScript + Vite...
[USER] CSS Modules 怎么样？
[ASSISTANT] CSS Modules 适合，零运行时开销...
[USER] 那就用 CSS Modules 吧
[ASSISTANT] 好的，已记录
...
[USER] Button 组件 hover 效果不好
...
```

### 输出怎么校验

AI 的输出经过 Zod Schema 校验：

```ts
ChunkSummarySchema = z.object({
  summary:  z.string().min(1),           // 不能为空
  progress: z.string().min(1),           // 不能为空
  keywords: z.array(z.string()).min(1),  // 至少一个关键词
})
```

校验不通过 → 重试（最多 3 次）。3 次都不通过 → 回退方案：用 `generateText` 让 AI 自由输出，再尝试解析 JSON。

### 这个摘要的用途

**导航，不是替代品。** 它的作用是：
1. 搜索时快速匹配关键词 → 找到相关窗口
2. 给后续的阶段概述提供素材
3. 让用户一眼知道"这个窗口里大概讲了什么"

它**不能**作为最终事实依据。最终事实必须打开窗口原文验证。

---

## 第二层：窗口摘要 → 阶段概述

### 什么时候触发

一个阶段下的窗口数达到容量上限（默认 20 个），触发升代。升代过程需要为新创建的父阶段生成概述。

### 怎么做

```
GenerationCompactor.compact()
  │
  ├─ 收集 20 个窗口的摘要
  │    窗口 #1 summary: "技术选型讨论..."
  │    窗口 #2 summary: "Button组件开发..."
  │    窗口 #3 summary: "样式迁移决策..."
  │    ...
  │
  └─ AI 被要求输出四样东西:
      ┌─────────────────────────────────────────────┐
      │ overallContent: "这一阶段从技术选型开始，      │
      │   经历了20轮组件开发，中途发现CSS Modules      │
      │   在动态样式上的局限，经过4轮讨论后决定迁移     │
      │   到Tailwind CSS。整体推进了基础组件库的搭建。" │
      │                                             │
      │ progress: "完成技术选型和基础组件开发，         │
      │   正在进行样式迁移"                            │
      │                                             │
      │ mainConclusions: [                           │
      │   "CSS Modules适合静态样式但不支持动态主题",    │
      │   "Tailwind CSS是更好的长期方案",              │
      │   "组件API设计采用函数式+forwardRef模式"       │
      │ ]                                           │
      │                                             │
      │ importantChanges: [                          │
      │   "CSS Modules → Tailwind CSS (第80轮)"      │
      │ ]                                           │
      └─────────────────────────────────────────────┘
```

### AI 看到什么

AI **不看原文**——只看 20 个窗口的摘要列表。这是升代的核心效率来源：

```
Create a directory summary that synthesizes the following segments.

Child segments:
[1] Type: chunk
    Summary: 讨论了技术选型，确定CSS Modules + TS + Vite
    Progress: 技术选型完成
    Conclusions: 

[2] Type: chunk
    Summary: Button组件开发，遇到hover样式问题
    Progress: Button组件基本完成
    Conclusions: 

[3] Type: chunk
    Summary: CSS Modules动态样式局限暴露，讨论替代方案
    Progress: 发现CSS Modules瓶颈
    Conclusions: 

...（共20个）

Produce:
- overallContent: 叙述这一段的整体推进过程
- progress: 推进到什么程度
- mainConclusions: 关键结论
- importantChanges: 方向变化或被放弃的方案
```

### 关键设计

> **升代时 AI 只读摘要，不读原文。** 原文只在搜索验证时才被打开。
> 这保证了：
> - 升代速度快（读 20 段摘要 vs 读 400 条消息）
> - Token 消耗可控
> - 但代价是**上层概述可能不准确**（摘要本身可能漏掉重要信息）

这就是为什么搜索时必须做原文验证——不能只看阶段概述就下结论。

---

## 第三层：阶段概述 → 更上层概述

升代继续：G1 满了 → G2。G2 的概述又是基于 G1 的摘要生成的。

```
G2: "组件库项目从零到完整，经历前期开发和架构重构两个阶段"
  │
  │  AI 读了 2 个 G1 的 overallContent + mainConclusions:
  │
  ├─ G1 "前期开发": 技术选型→组件开发→样式迁移
  └─ G1 "架构重构": monorepo重构→团队扩展→v2.0
```

越上层越概括，越底层越具体。**但最底层窗口的原文始终可以打开。**

---

## 第四层：用户提问 → 搜索结果 → 结论

这是最重要的场景：用户问了一个历史问题，系统怎么给出结论？

### 完整流程

```
用户: "为什么不用 CSS Modules 了？"
  │
  ├─ ① 搜索（混合检索）
  │     FTS5 搜消息原文 + 搜所有窗口摘要
  │     → 找到 3 个候选窗口
  │
  ├─ ② 原文验证（SourceVerifier）
  │     打开每个候选窗口的原文
  │     检查 "CSS Modules" 在原文中出现的上下文
  │     → 窗口 #3 置信度 0.9（原文确实在讨论切换）
  │     → 窗口 #1 置信度 0.5（只是提了一句，不是重点）
  │     → 过滤掉窗口 #1
  │
  ├─ ③ 深读（deepVerify）
  │     打开窗口 #3 原文 + 前后 3 条消息
  │     msg-73 "hover效果不好调"
  │     msg-74 "CSS Modules不支持动态样式"
  │     msg-75 "有没有更好的方案？"
  │     msg-76 "Tailwind可以做动态样式"
  │     msg-77 "迁移要多久？"
  │     msg-78 "3-4天"
  │     msg-79 "那就切吧"
  │     → 重建演变链: "hover问题→发现CSS局限→评估Tailwind→决定迁移"
  │
  └─ ④ 编译结果注入 LLM 上下文
        LLM 拿到:
        - 窗口 #3 的 7 条原文
        - 演变链摘要
        - 用户当前问题
        → LLM 生成最终回答:
        "在第73-79轮讨论中，因为CSS Modules不支持动态样式，
         导致hover效果难以调整。经过评估，Tailwind CSS可以
         解决这个问题，迁移成本约3-4天，于是决定切换。"
```

### 结论的可信度

```
窗口摘要说: "切换到 Tailwind"        ← 可信度: 中 (AI生成的摘要)
原文验证后: msg-73~79 确认了这个事实   ← 可信度: 高 (原始对话)
演变链重建: 问题→分析→决策→执行       ← 可信度: 最高 (完整因果链)
```

**越靠近原文，可信度越高。** 这是 Lynage 和纯摘要方案的核心区别。

---

## 写回：LLM 怎么更新结论

LLM 确认结论后，通过写回更新工作记忆：

```
LLM 回复中附带:
┌─────────────────────────────────────────────┐
│ memoryActions: [                             │
│   {                                          │
│     target: "workingMemory",                 │
│     operation: "append",                     │
│     section: "confirmed",                    │
│     value: "CSS→Tailwind因为动态样式需求"      │
│   },                                         │
│   {                                          │
│     target: "workingMemory",                 │
│     operation: "remove",                     │
│     section: "confirmed",                    │
│     value: "使用CSS Modules"                  │
│   }                                          │
│ ]                                            │
└─────────────────────────────────────────────┘
        │
        ▼
  ① JSON 解析
  ② Zod Schema 校验（target/operation/section/value 合法性）
  ③ Lynage 语义校验（不能覆盖原文、不能推测当事实）
  ④ 数据库事务写入
```

---

## 总结：提炼管道的完整视图

```
                        AI 只读摘要
  消息 ──→ 窗口摘要 ──→ 阶段概述 ──→ 更上层概述
   ↑                      │
   │                      │ 升代时不断向上提炼
   │                      │
   └──────────────────────┘
     用户提问时:
       搜索窗口摘要 → 打开原文验证 → 得出结论 → 写回工作记忆
       
     原文是事实，摘要只是索引。
     结论必须经过原文验证才能确认。
```
