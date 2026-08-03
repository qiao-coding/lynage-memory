# Benchmark 可靠性修复计划

## 目标

让 benchmark **真正建出多代树 + 调用 navigateDirectory**，产出可信的 Lynage vs Hermes 对比数据。

## 根因诊断

| # | 现象 | 根因 |
|---|------|------|
| 1 | `10k_fair` 10000 轮只有 **1 chunk** | 归档任务在首个重负载 pass 中被**瞬时 AI 错误杀死**（adapter `summarizeChunk` 的 `generateText` 无兜底 try/catch，抛错→`queueArchive` catch→任务终止）；bench 用脆弱的 `stable>=5` 轮询判定"归档完成"，实际是任务已死 |
| 2 | `10k` 1009 chunks 但 **5.5 小时** | 每次 `checkAndArchive` 都 `listChunks(全部)` + `summarizeDirectory(全部 chunk)`——目录摘要 prompt **随 chunk 数线性增长**，O(N²) 总成本 |
| 3 | `forget` **0%** | 归档可靠性修复前的旧版本跑出的坏数据，污染了对比 |

## 核心洞察

现有 bench 的 `10/10 = 100%` 靠 FTS 直接命中未归档消息，**树根本没建 → navigateDirectory 零调用**。不修根因，怎么跑都是假阳性。

---

## Phase 1 — 归档鲁棒性（2 个核心改动）

### A. `adapter-ai-sdk/src/model.ts` — summarizeChunk 兜底
`generateText` 外层加 try/catch → 失败返回 keyword fallback：
```ts
{ summary: input.messages.map(m => m.content).join(" ").slice(0, 200),
  progress: "Unknown", keywords: [], conclusions: [], goals: [] }
```
同步给 `summarizeDirectory` 的 `generateText` 段补同样的兜底（已有 generateObject 的 retry，但 generateText 段裸奔）。

### B. `core/src/archive-manager.ts` — 目录摘要节流
step 11 的 `summarizeDirectory(全部 chunks)` 改为 **每 K 次 pass 才全量重摘要**（K=5），其余 pass 用增量合并：
- 新 chunk 的 conclusions/goals 直接 append 进现有 dirSummary
- 或干脆跳过（保留旧摘要），等第 K 次再刷新
- 消除 O(N²) → O(N/K)

## Phase 2 — 可信 benchmark 断言（bench 脚本）

### C. `bench-10k.ts` / `bench-forget.ts` — 建树断言
回答问题前**必须先验证树建起来了**，否则 `exit(1)` 拒绝发布数据：
```
chunkCount >= 20          // 至少 20 个窗口
directoryCount >= 2       // 至少 G0→G1 两级
```
在 bench 里 poll 到满足 或 5 分钟超时 → 超时就报错退出。

### D. `bench-10k.ts` — 导航覆盖率统计
在搜索循环里记录 `searchedDirectories` / `totalChunksChecked`（SearchResult 已返回），
判定每次搜索是否真的走树路径（`checked > 0`），统计 `treeHits / total`。
输出里加 `tree_usage_pct` 字段——用数据证明 navigateDirectory 被调用了。

### E. `bench-10k.ts` — 用 waitForArchiving + 硬超时替代脆弱轮询
- turn 循环结束后 `await mem.waitForArchiving("s1")`（bench-forget 已用，可靠）
- 再 poll chunkCount >= minChunks，超时即失败

## Phase 3 — 阈值调优（让树在合理时间内长成 G0→G1→G2）

### F. `bench-10k.ts` / `bench-forget.ts` — 配置
```
archiveThreshold: 8000   // 不变，保证 chunk 内容有真实决策
retainTokens: 2000       // 降低 → 每 pass 出更多 chunk，树长得快
directoryCapacity: 10    // 降低 → 更快触发 G0→G1 升代
```
预期：10000 轮 → ~100+ chunks → 目录容量 10 → ~10 个 G1 子目录。
（配合 Phase1B 节流后，~50 pass × ~4s = ~4 分钟可行，不再 5.5 小时）

## Phase 4 — 跑分 + 对比 + 更新 README

### G. 跑 3 个 benchmark
1. `10k fair`（关键词直接命中类问题）→ 验证 accuracy + tree_usage_pct
2. `10k forget`（失忆式过程类问题）→ 验证语义导航的差异化
3. `100-turn bench_final` 对照 → 确认小规模不回归

### H. Hermes 对比数据
- 现有 JSON 无 Hermes 10k 数据，README 数字是外部采集的
- 检查是否有 hermes bench 脚本可跑；没有则如实标注"README 引用外部采集值，本仓未复现"

### I. 更新 README
- 用新数据覆盖旧数字
- 标注 tree_usage_pct 证明树导航确实生效
- 删除/标注 forget 0% 的坏数据

## 执行顺序

```
Phase 1A (adapter 兜底)     — 小改，消除任务被杀的根因
Phase 1B (目录摘要节流)     — 中改，消除 O(N²)
Phase 2C/D/E (bench 断言)   — 脚本层，确保可信
Phase 3F (阈值调优)         — 脚本层
Phase 4G/H/I (跑分+对比+README)
```

## 验收标准

- [ ] 10000 轮 bench 后 chunkCount >= 20 且 directoryCount >= 2
- [ ] search 结果 tree_usage_pct > 0（navigateDirectory 真被调用）
- [ ] 存储时间 < 15 分钟（不再是 5.5 小时）
- [ ] README 数据与 JSON 一致，forget 0% 坏数据已处理
