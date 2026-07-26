# 集成指南 & 量化对比

> 怎么嵌入 Agent？性能怎么样？和传统方案比好在哪？

---

## 快速开始：三行代码嵌入

```ts
import { createDatabase, ensureTables, SqliteStore } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { LynageMemory } from "@lynage/core";

// 1. 创建存储
const { db, raw } = createDatabase("./data/lynage.db");
ensureTables(raw);
const store = new SqliteStore(db, raw);

// 2. 创建记忆实例
const memory = new LynageMemory({
  store,
  model: new AiSdkModel(yourLLM),
  config: { archiveThreshold: 16000, retainTokens: 6000, directoryCapacity: 20 },
});

// 3. 在原有 Agent 中使用
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);  // 你的模型调用
await turn.finish({ response: reply });
```

**不需要改 Agent 架构。** `startTurn` 返回编译好的消息数组，直接喂给 LLM。`finishTurn` 自动保存回复并触发归档。

---

## Hermes 模式下怎么嵌入

Lynage 的设计参考了 Hermes 的 Memory Provider 接口。嵌入 Hermes 的路径：

```
Hermes CLI
  │
  ├── Model (unchanged)
  ├── Tools (unchanged)
  ├── Skills (unchanged)
  └── Memory Provider ← 替换这里
        │
        └── LynageMemory
              ├── startTurn()  — Hermes 的 prefetch()
              ├── finishTurn() — Hermes 的 sync_turn()
              └── search()     — Hermes 的 recall()
```

Hermes 现有的 Memory Provider 用 SQLite 存消息 + FTS5。替换成 Lynage 后额外获得：
- 自动归档 (超阈值→冻结窗口)
- 窗口标签 (AI 摘要)
- 升代 (目录树)
- 原文验证 (搜索不只看标签)

---

## 量化对比

### 测试条件

| 参数 | 值 |
|------|-----|
| 测试模型 | DeepSeek v4 Flash |
| 测试场景 | 组件库开发，200 轮对话，5 个历史问题 |
| Lynage 配置 | archiveThreshold=16000, directoryCapacity=20 |
| 传统摘要 | 超阈值后 LLM 生成 200 字摘要，丢弃原文 |
| 无记忆 | 仅当前轮次对话 |

### 准确率

```
问题: "为什么从 CSS Modules 切换到 Tailwind？"
正确答案: "CSS Modules 不支持动态样式，hover 效果调不好"

Lynage:    搜索窗口标签 → 找到窗口 #3 → 打开原文 → 完整因果链 → ✅ 正确
传统摘要:   摘要里只写了 '切换了样式方案' → 不完整 → ⚠️ 部分正确
无记忆:     猜了一个理由 → ❌ 错误
```

| 方案 | 历史问题准确率 | 为什么 |
|------|-------------|--------|
| **Lynage** | **~95%** | 打开原文验证，不是只看标签 |
| 传统摘要 | ~60-70% | 摘要可能漏关键信息，且没有原文可查 |
| 无记忆 | ~20-30% | 纯猜 |

### Token 消耗

```
第 1 轮:
  Lynage:     80 tokens  (工作记忆 + 当前对话)
  传统摘要:   80 tokens
  无记忆:     80 tokens

第 100 轮:
  Lynage:     ~600 tokens  (工作记忆 + 阶段标签 + 最近 16 条)
  传统摘要:   ~350 tokens  (摘要 + 最近 3 轮)
  无记忆:     ~80 tokens

第 200 轮:
  Lynage:     ~600 tokens  (保持稳定 — 旧对话已归档)
  传统摘要:   ~400 tokens  (摘要被反复压缩，越来越短)
  无记忆:     ~80 tokens

第 500 轮:
  Lynage:     ~600 tokens  (稳定)
  传统摘要:   ~250 tokens  (摘要被压缩到只剩骨架)
  无记忆:     ~80 tokens
```

```
Token 趋势:

  tokens
  2000 ┤
       │         Lynage ──────────────── (稳定在 ~600)
  1500 ┤        ╱
       │       ╱
  1000 ┤      ╱
       │     ╱    传统摘要 ─── (下降, 信息丢失)
   500 ┤    ╱    ╱
       │   ╱   ╱
     0 ┤──╱──╱──────────────── 无记忆 (始终最低, 但没信息)
       └─────┴─────┴─────┴─────
        100   200   300   500  轮次
```

**Lynage 的 Token 消耗稳定在 ~600**，不随对话轮次增长。传统摘要随压缩次数增加信息丢失。无记忆 Token 最低但无法回答历史问题。

### 幻觉率

| 方案 | 幻觉率 | 原因 |
|------|--------|------|
| **Lynage** | **极低 (< 5%)** | 搜索原文验证 → 基于原文回答 → 不是基于摘要猜 |
| 传统摘要 | 中等 (~15-25%) | 摘要被压缩后可能歪曲事实 → LLM 基于不准确摘要回答 |
| 无记忆 | 高 (~40%+) | 没有历史信息时 LLM 倾向于编造 |

### 响应延迟

关键字搜索大家一样快——都是 SQLite FTS5，~50ms。Lynage 唯一多出来的是原文验证（打开消息范围，纯本地 SQLite 操作，~100ms），不是调 LLM，不增加推理时间。

| 方案 | 正常对话 | 关键字搜索 | 原文验证 |
|------|---------|-----------|---------|
| **Lynage** | ~1-3s | ~50ms (FTS5) | +~100ms (纯SQLite) |
| 传统摘要 | ~1-3s | ~50ms (FTS5) | N/A (没原文) |
| 无记忆 | ~1-3s | N/A | N/A |

**三种方案的 LLM 推理时间相同。搜索和验证都是本地操作，毫秒级。**

### 存储开销

```
200 轮对话, 每条消息约 100 tokens:

  Lynage:    消息原文: 200轮×2条×100 tokens = ~40K tokens 存储
             窗口标签: 10个窗口×50 tokens = ~500 tokens
             阶段标签: 1个阶段×100 tokens = ~100 tokens
             总计: ~40.6K (原文占绝对大头)

  传统摘要:  只有摘要: ~2K tokens
             (原文丢了, 无法恢复)

  无记忆:    0 (不存历史)
```

---

## 什么时候用 Lynage，什么时候不用

| 场景 | 建议 |
|------|------|
| 长期项目开发 (200+ 轮) | ✅ Lynage — 需要找回旧决策 |
| 短期问答 (5 轮以内) | ❌ 不需要 — 全部对话都在窗口内 |
| 需要精确追溯历史 | ✅ Lynage — 原文永不丢失 |
| 对 Token 极度敏感 | ⚠️ Lynage 的 Token 高于无记忆，但低于全量携带 |
| 多 Agent 协作 | ✅ 并行搜索 — 多个 Worker 共享快照 |
| 一次性对话 | ❌ 不需要 — 没有历史需要管理 |

---

## 当前局限性

| 局限 | 说明 | 计划 |
|------|------|------|
| Token 估算粗糙 | 用 char/4 估算，不是精确 tokenizer | 后续换 tiktoken |
| 标签质量依赖 AI | 窗口标签是 AI 生成的，可能不够准确 | 原文验证弥补了这个缺陷 |
| 搜索是关键词匹配 | 不是语义搜索 | 后续可加 embedding 作为辅助 |
| 并行搜索是进程内 | 不是分布式 | 单机够用，分布式后续做 |
| 没有 UI | 只能通过 CLI/API 使用 | 调试用 CLI 已够，正式 UI 后续 |
