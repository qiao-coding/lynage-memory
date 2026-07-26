# 并行搜索 · 原文验证

> 术语见 [00-terminology.md](00-terminology.md)
>
> 多个 Worker 怎么同时搜？搜完怎么验证？
>
> **前置理解**：Worker 拿到项目快照 + 分配的几个窗口，只读不写，返回证据位置。

---

## 1. 并行搜索

### 问题

一个重要问题需要翻遍全部历史（比如 80 个目录，400 条消息）。一个 Worker 串行检查 → O(N) 时间。

### 方案

主进程创建统一快照 → 分配给 N 个 Worker → 并发执行 → 汇总。

```
┌─────────────────── 主进程 ───────────────────┐
│                                               │
│  创建 ProjectSnapshot:                         │
│  ┌─────────────────────────────────────────┐  │
│  │ snapshotId:    "snap-001"               │  │
│  │ projectGoal:   "设计 Lynage Memory"      │  │
│  │ currentProgress: "确定并行搜索方案"       │  │
│  │ knownDecisions: ["原文不可变",            │  │
│  │   "目录摘要只用于导航"]                   │  │
│  │ question:      "之前为什么放弃那个方案？"  │  │
│  │ searchGoal:    "寻找方案提出和废弃过程"    │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  分发目录:                                      │
│    Worker A ← dir-A, dir-E, dir-I              │
│    Worker B ← dir-B, dir-F, dir-J              │
│    Worker C ← dir-C, dir-G, dir-K              │
│    Worker D ← dir-D, dir-H, dir-L              │
│                                               │
└───────────────────┬───────────────────────────┘
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
┌─────────┐   ┌─────────┐   ┌─────────┐
│Worker A │   │Worker B │   │Worker C │  ...
│         │   │         │   │         │
│读 dir-A │   │读 dir-B │   │读 dir-C │
│读 dir-E │   │读 dir-F │   │读 dir-G │
│读 dir-I │   │读 dir-J │   │读 dir-K │
│         │   │         │   │         │
│返回:    │   │返回:    │   │返回:    │
│ 3 候选  │   │ 0 候选  │   │ 2 候选  │
└────┬────┘   └────┬────┘   └────┬────┘
     │              │              │
     └──────────────┼──────────────┘
                    ▼
┌─────────────────── 主进程 ───────────────────┐
│                                               │
│  合并: [候选A1, A2, A3, C1, C2]               │
│  去重: 5 个唯一候选                             │
│                                               │
│  SourceVerifier.verifyBatch(5 候选, query)     │
│    ├── 候选 1: 打开原文验证 → 置信度 0.9 ✅     │
│    ├── 候选 2: 打开原文验证 → 置信度 0.3 ❌     │
│    ├── 候选 3: 打开原文验证 → 置信度 0.85 ✅    │
│    ├── 候选 4: 打开原文验证 → 置信度 0.5 ❌     │
│    └── 候选 5: 打开原文验证 → 置信度 0.75 ✅    │
│                                               │
│  过滤: 仅保留 ≥ 0.6 的 3 个候选                 │
│                                               │
│  扩展上下文 (expandContext):                    │
│    读每个候选前后 3 条消息 → 找关联 Chunk        │
│                                               │
│  重建演变链:                                    │
│    方案首次提出 (dir-A)                         │
│    → 讨论尝试 (dir-E)                           │
│    → 暴露问题 (dir-I)                           │
│    → 正式废弃 (dir-C)                           │
│    → 新方案替代 (dir-K)                         │
│                                               │
│  输出: 3 个验证候选 + 5 步演变链                 │
│                                               │
└───────────────────────────────────────────────┘
```

### Worker 的约束

```
每个 Worker:
  ✅ 共享同一个 ProjectSnapshot     知道在找什么
  ✅ 只读自己分配的目录              不越界
  ❌ 不修改 Working Memory          不产生副作用
  ❌ 不生成最终答案                  只返回证据
  ✅ 只返回证据位置                  { sourceRange, reason, confidence }
```

### 为什么 Worker 只读

```
如果 Worker 可以写:
  Worker A: append confirmed "方案X被废弃"  ← 从 dir-A 看到的
  Worker B: append confirmed "方案X 正在用"  ← 从 dir-B 看到的（更新的信息）
  → Working Memory 里两个矛盾的 confirmed
  → 主进程需要判断哪个是对的

Worker 只读:
  主进程拿到 A 和 B 的所有候选
  → 打开原文验证
  → 发现 A 说的是旧信息（第 50 轮），B 说的是更新信息（第 150 轮）
  → 主进程只 append B 的结论
  → Working Memory 干净
```

---

## 2. 原文验证

### 问题

目录摘要可能不准确。AI 生成的摘要写"讨论了数据库方案"，但原文可能只是顺带提了一句。**不能只看摘要就相信。**

### 方案：每个搜索候选都要打开原文验证

```
SearchCandidate {
  summary: "决定使用 SQLite 作为数据库"
  sourceRange: { from: "msg-820", to: "msg-847" }
  relevance: 0.8
}
        │
        ▼
SourceVerifier.verify(candidate, "数据库方案")
        │
        ├─ ① 打开原文: msg-820 ~ msg-847
        │
        ├─ ② 检查 query 关键词是否在原文出现
        │     query: "数据库 方案"
        │     原文: "我们用 SQLite 吧，不需要 PostgreSQL 那么重..."
        │     → "数据库" 出现 3 次, "方案" 出现 2 次
        │     → matchedTerms: 2/2
        │
        ├─ ③ 计算置信度
        │     termRatio: 2/2 = 1.0 × 0.6 = 0.6
        │     summaryMatch: 是 (+0.4)
        │     confidence: 1.0
        │
        └─ ④ 返回验证结果
              verified: true
              confidence: 1.0
              actualContent: "我们用 SQLite 吧，不需要 PostgreSQL..."
              reason: "Matched 2/2 query terms in original messages."
```

### 验证的三个等级

```
Level 1: verify()          单个候选验证
  → 打开原文 → 查关键词 → 算置信度

Level 2: verifyBatch()     批量验证 + 过滤
  → 逐个验证 → 低于阈值(0.3)的丢弃 → 按置信度排序

Level 3: deepVerify()      深度验证 + 演变链
  → verifyBatch()
  → expandContext() 读前后消息 + 找关联 Chunk
  → 重建时间线: 方案提出 → 讨论 → 废弃 → 替代
  → 返回验证候选 + 演变链
```

### 例子：deepVerify 重建演变链

```
query: "样式方案为什么改了？"

候选 1: Chunk-003 (第 76-85 轮)
  原文: msg-76 "CSS Modules hover 难调" → msg-85 "开始 Tailwind 迁移"
  verify: confidence 0.9 ✅

候选 2: Chunk-001 (第 1-42 轮)
  原文: msg-40 "用 CSS Modules 吧" → msg-42 "CSS Modules 适合"
  verify: confidence 0.85 ✅

候选 3: Chunk-005 (第 120-130 轮)
  原文: msg-240 "Tailwind 用起来真快" → msg-245 "重构完成"
  verify: confidence 0.7 ✅

expandContext(候选 1):
  前后 3 条消息: msg-73 ~ msg-88
  关联 Chunk: Chunk-003, Chunk-004 (时间重叠)

演变链:
  [7/23] 决定使用 CSS Modules (Chunk-001)
  [7/25] CSS Modules 遇到问题 (Chunk-003)
  [7/25] 切换到 Tailwind CSS (Chunk-003)
  [7/26] Tailwind 迁移完成 (Chunk-005)

finalConfidence: (0.9 + 0.85 + 0.7) / 3 = 0.82
```
