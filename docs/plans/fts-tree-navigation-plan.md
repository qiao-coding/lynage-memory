# FTS 目录树导航计划：把 28s 的 LLM 逐层判断换成 ~10ms 的索引剪枝

## 问题

目录导航慢的根源是**每层 1 次 LLM 调用**（navigateDirectory ~5-7s × 4-5 层 = 28s），
不是树本身（SQLite 查询是毫秒级）。树该用廉价信号（FTS/embedding）剪枝。

## 设计

```
目录导航 (应该 ~10-20ms):
  Level 0: FTS trigram 匹配根目录摘要   → 6ms
  Level 1: 只 FTS-钻匹配的子目录        → 6ms
  Leaf:   FTS 匹配该目录的 chunk 摘要   → 6ms  (chunks_fts 已存在)
  LLM: 只在极端歧义时兜底 (rerank)
```

目录摘要 ~100 tokens，trigram FTS 命中"主题词在摘要里"就是语义剪枝的廉价版。

## 改动清单

### 1. `storage-sqlite/src/connection.ts` — directories_fts

与 chunks_fts 同模式（contentless, trigram, 触发器）：
- 索引列: overallContent, mainConclusions, goals, importantChanges
- INSERT/UPDATE/DELETE 触发器同步 directories → directories_fts

### 2. `storage-sqlite/src/store.ts` + `core/src/store.ts` — searchDirectories

```ts
searchDirectories(query, sessionId): string[]  // bm25 排序的 directory id
```
镜像 searchChunks（trigram FTS + LIKE 回退 + bm25 排序）。

### 3. `core/src/history-retriever.ts` — drillDown 改为 FTS 剪枝

```
drillDown(directoryId, query, understanding?):
  1. getDirectoryChildren(directoryId)
  2. FTS-匹配子目录摘要 (searchDirectories 限定本目录范围) → 只递归匹配的子目录
  3. FTS-匹配本目录 chunk 摘要 (searchChunks) → 候选 chunks
  4. navigateDirectory(LLM) 降级为可选深兜底（仅当 FTS 完全无匹配）
```
删除每层的 LLM navigateDirectory 调用。

### 4. `search()` — FTS 树导航替代 LLM 兜底

```
当前: Step2 (LLM 树导航, 仅 FTS 空时)   ~28s
改为: Step2 (FTS 树导航, 仅 FTS 空时)   ~20ms
     Step3 (LLM rerank, >1 候选噪音)    保留 (~5s)
```

### 5. 测试
- searchDirectories 单元测试
- drillDown FTS 剪枝测试
- typecheck + 45 测试

## 延迟预期

| 场景 | 当前 | 改后 |
|------|------|------|
| 干净查询 | 5-14ms | 5-14ms（不变） |
| 模糊查询（FTS 空 → 树兜底） | **28s** (LLM) | **~20ms** (FTS) |
| 极端噪音（100 候选） | ~5.5s (rerank) | ~5.5s（rerank 保留，独立问题） |

## 验收
- [ ] directories_fts 建表 + 触发器同步
- [ ] searchDirectories 返回正确目录
- [ ] drillDown 用 FTS 剪枝，不再逐层 LLM
- [ ] typecheck + 45 测试通过
- [ ] 模糊查询搜索 < 50ms
