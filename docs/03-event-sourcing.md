# Event Sourcing 事件溯源 · Context Lineage 上下文谱系 · Natural Boundary 自然边界

> Lynage 最底层的三项核心技术：消息不可变追加、谱系追踪链、对话切分算法。

---

## 1. Event Sourcing 事件溯源

### 是什么

所有消息以**追加**方式写入，**从不修改、从不删除**。每一条 user 消息、assistant 回复、tool 调用、tool 结果都是不可变事件。

### 为什么

```
传统做法:                          Event Sourcing:
                                  
  msg-5 的内容错了                   msg-5 的内容错了
    → 直接修改 msg-5.content          → 追加 msg-5-correction
    → 历史丢失 ❌                      → 原文 + 修正都保留 ✅
```

修改旧记录意味着丢失历史。追加新记录意味着**任何时候都能看到完整的演变过程**。

### 例子

```
messages 表（追加写入，只增不减）:
┌────────┬──────┬─────────────────────────────────┐
│ id     │ role │ content                         │
├────────┼──────┼─────────────────────────────────┤
│ msg-40 │ user │ "用 CSS Modules 吧"              │
│ msg-41 │ asst │ "好的，CSS Modules 适合这个项目"   │
│  ...   │ ...  │ ...                             │
│ msg-82 │ user │ "CSS Modules 太麻烦了，切Tailwind"│  ← 这是新记录
│ msg-83 │ asst │ "理解，开始迁移"                  │  ← 不是覆盖 msg-40
│ msg-84 │ tool │ lynage_commit(remove "CSS...")   │  ← WorkingMemory 也追加修正
└────────┴──────┴─────────────────────────────────┘
```

即使 msg-40 说的"用 CSS Modules"已经被后续决策推翻，msg-40 **本身不会变**。需要纠正时，追加新的纠正记录。

---

## 2. Context Lineage 上下文谱系

### 是什么

每条归档信息（Chunk）保留它**从哪条原始消息来、到哪条原始消息去**。形成一条可追溯的链：

```
Chunk ──sourceFromId──→ 原始消息范围的起点
Chunk ──sourceToId────→ 原始消息范围的终点
```

### 为什么

传统 Memory 只保存 "Agent 决定用 Tailwind"。你无法知道：
- 这个决定是在什么上下文产生的？
- 之前讨论过什么替代方案？
- 为什么放弃了替代方案？
- 谁说了什么？

Lynage 的回答是：**保留指针**。想知道详情？顺着 `sourceFromId` → `sourceToId` 打开原文。

### 例子

```
你问: "为什么不用 CSS Modules 了？"

lynageSearch("CSS Modules")
  → 找到 Chunk-003:
      summary: "第 80 轮：从 CSS Modules 切换到 Tailwind"
      sourceFromId: msg-76
      sourceToId:   msg-85

lynageOpenSource("Chunk-003")
  → 打开 msg-76 ~ msg-85 原文:

    msg-76 [user]   "Button hover 效果怎么这么难调？"
    msg-77 [asst]   "CSS Modules 不支持动态样式..."
    msg-78 [user]   "有没有更好的方案？"
    msg-79 [asst]   "Tailwind 可以做动态样式，但需要迁移"
    msg-80 [user]   "迁移要多久？"
    msg-81 [asst]   "约 3-4 天"
    msg-82 [user]   "那就切吧"
    msg-83 [asst]   "好的，开始迁移 Tailwind"
    msg-84 [tool]   lynage_commit(remove "CSS Modules")
    msg-85 [tool]   lynage_commit(append "Tailwind CSS")

  现在你不仅知道结果（用了 Tailwind），还知道:
    - 为什么改: "CSS Modules 不支持动态样式"
    - 怎么决策的: 讨论了 4 轮，评估了迁移成本
    - 哪几条消息是决策过程: msg-76 ~ msg-85
```

---

## 3. Natural Boundary Detection 自然边界检测

### 是什么

归档旧消息时，不能随便在中间切断。必须找到**完整的对话回合边界**。

### 为什么

```
❌ 错误切分:
  msg-40 [user]   "帮我算 2+2"
  msg-41 [asst]   "好的，用计算器..."        ← 在这切断！
  msg-42 [tool]   calculate("2+2")           ← 工具调用和结果被分开
  msg-43 [tool]   result: "4"                ← 上下文断裂
  msg-44 [asst]   "答案是 4"

  → 如果 msg-41 被归档，msg-42~44 留在 Recent
  → msg-42 是一个没有前文 context 的工具调用
  → LLM 看不懂
```

```
✅ 正确切分: 等整个工具链完成后在回合边界切

  第 20 轮:                          ← 在这切断 ✅
    msg-39 [asst] "Button 组件完成了"
  ───────────── 归档线 ─────────────
  第 21 轮:
    msg-40 [user] "帮我算 2+2"
    msg-41 [asst] "好的..."
    msg-42 [tool] calculate("2+2")
    msg-43 [tool] result: "4"
    msg-44 [asst] "答案是 4"
```

### 算法规则

```
isNaturalBoundary(position):
  
  ① 不能切在 user 消息后     → user 的下一句是 assistant 回答，必须成对
  ② 不能切在 tool 调用中间   → tool call 和 tool result 必须同在一个 Chunk
  ③ 不能切在 assistant 触发  → 如果 assistant 后面跟着 tool 调用，
     tool 调用之前             等所有 tool 结果返回后才能切
  
  ④ 可以切在 assistant 说完   → 一轮完整对话结束
     且所有 tool 返回后
  ⑤ 可以切在下一条 user 之前   → 新问题开始前
```

### 例子

```
消息序列:                          可切?
─────────────────────────────────────────
msg-1  [user]   "..."               ❌ user 后不能切
msg-2  [asst]  "..."               ✅ 完整回合结束
msg-3  [user]   "..."               ❌ user 后不能切
msg-4  [asst]  "用工具算一下..."      ❌ 后面有 tool 调用
msg-5  [tool]  calculate(...)       ❌ tool 调用和结果不能分开
msg-6  [tool]  result: "42"         ❌ 同上
msg-7  [asst]  "答案是 42"          ✅ 工具链完成，回合结束
msg-8  [user]   "再算一个..."        ❌ user 后不能切
```

`findNaturalBoundary` 从 targetIndex 向后扫描，找到最近的 ✅ 位置。
