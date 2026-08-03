# FTS-First 廉价优先检索计划

## 问题

当前搜索**每轮都走 LLM 树导航（~28s）**，只有失败才回落 FTS（6ms）——层级反了。
长上下文下搜索是 28s 不是 6ms，树形导航成了负债。

**根因**: `chunks_fts` 不存在——context_chunks 的结构化摘要（summary/conclusions/goals）
没有 FTS 索引，廉价路径无法检索摘要。FTS 只覆盖原始消息。

## 设计：三层廉价优先

```
① FTS 结构化摘要 (chunks_fts)   ~6ms  ← 主路径
② FTS 原始消息 (messages_fts)    ~6ms  ← 补充召回
③ LLM 树导航                      ~28s  ← 仅当 ①② 空/弱时才走
```

trigram 分词器让**查询任意 3 字子串命中**——摘要/conclusions 里的词就是检索锚点，
"我们当时怎么定的数据库方案" 能命中结论 "最终决定用 MongoDB" 所在 chunk。

## 改动清单（3 个文件）

### 1. `storage-sqlite/src/connection.ts` — 新增 chunks_fts

```
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  summary, keywords, conclusions, goals,        -- 4 列，trigram
  content='' , content_rowid='rowid'
);
```
- 用外部内容表? 简化：独立 FTS5（无 content=），触发器同步
- trigram 分词器（同 messages_fts）
- INSERT/UPDATE/DELETE 触发器同步 context_chunks → chunks_fts
- conclusions/goals 是 JSON 数组 → 触发器中用 json_extract 或直接存原始 JSON 文本
  （trigram 对 JSON 里的词也能命中，够用；或存 replace 掉引号的纯文本）

### 2. `storage-sqlite/src/store.ts` — 加 searchChunks

```ts
async searchChunks(query: string, sessionId: string): Promise<string[]> {
  // chunks_fts MATCH query, 按 rank 排序, 返回 chunk id
  // trigram MATCH 语法: 'query' OR 直接用 bm25 排序
}
```
- 先拿 FTS 命中的 rowid → 关联回 context_chunks.id
- 返回按 bm25 排序的 chunk id 数组

### 3. `core/src/history-retriever.ts` — 反转 search() 层级

```
新流程:
  1. analyzeSearchQuery (仅当需要语义) ← 可选，先保留
  2. 【主】searchChunks(query) → FTS 摘要命中 → 候选 chunks    ~6ms
  3. 【补充】searchMessages(query) → 未归档 recent 消息         ~6ms
  4. 【兜底】若 ② 空 → LLM 树导航 (现有 navigateDirectory 逻辑)  ~28s
  5. 合并候选 → openSource 验证
```

- FTS 命中即用（不再强制 LLM 导航）
- LLM 导航保留为完全抽象查询的兜底
- tree_usage_pct 依然统计（LLM 兜底时才 >0，如实反映）

## 验证标准

| 场景 | 期望 |
|------|------|
| fair 查询（关键词） | 搜索 < 50ms，100% 准确 |
| forget 模糊查询（含主题词） | 搜索 < 50ms（FTS 命中摘要），准确率 ≥ 90% |
| 完全抽象查询 | 回落 LLM 导航 ~28s |
| 2000 轮验证 | chunks≥20, maxGen≥1 依旧成立 |

## 验收
- [ ] chunks_fts 建立且触发器同步
- [ ] searchChunks 返回正确 chunk
- [ ] 2000 轮 fair：搜索 < 50ms，准确率不降
- [ ] forget：准确率 ≥ 90%（FTS 摘要路径）
- [ ] 单元测试通过
