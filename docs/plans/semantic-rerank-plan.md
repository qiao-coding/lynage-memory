# 语义重排计划：FTS 候选 + LLM 重排

## 问题

FTS-first 后，噪音淹没回归：通用消息"Table组件的状态管理方案"（顺带提及）淹没真正的决策 chunk。
FTS 按词频 → 决策 chunk 排名被压到 top-5 外。2000 轮 forget 的 Q4/Q6 因此失败。

## 设计：分层检索 + 语义重排

```
① FTS 候选生成 (6ms)      → top-K chunks（含噪音，决策 chunk 通常在里面只是排名低）
② LLM 批量重排 (1 次调用)  → 从候选里选"真的关于X的决策过程"的 chunk
③ 只读重排后的 top-N       → openSource 全文验证
```

- 清晰查询（fair, 单候选）：走 ① 直达 2ms，不触发重排
- 噪音/模糊查询（forget, 多候选）：走 ①② ~5s
- 决策 chunk 已确认在 FTS 结果里（message-FTS 命中事实消息 → 映射到 chunk），只是排名低 → 重排把它提到 top

## 改动清单（5 个文件）

### 1. `core/src/model.ts` — 新增类型 + 接口方法

```ts
export interface RerankInput {
  query: string;              // 原始问题
  intent: string;             // 查询意图（来自 analyzeSearchQuery 或 'unknown'）
  candidates: Array<{
    contextId: string;
    summary: string;
    conclusions: string[];
    goals: string[];
    keywords?: string[];
  }>;
}

export interface RerankResult {
  relevantIds: string[];      // 真正相关的候选 id
  reasoning: string;
}
```
`LynageModel` 加可选方法 `rerankCandidates?(input): Promise<RerankResult>`

### 2. `core/src/schemas.ts` — `RerankResultSchema`

### 3. `core/src/index.ts` — 导出类型 + schema

### 4. `adapter-ai-sdk/src/model.ts` — 实现 rerankCandidates

```
Prompt:
  You are a precise memory search reranker. Given a user question and search
  candidates, select ONLY candidates genuinely about the question — NOT
  incidental mentions.
  Question: "..."
  Candidates:
    [i] Summary: ... Conclusions: ... Goals: ...
  Return relevantIds.
```
用现有 `structured()` helper（generateObject→generateText+JSON）。
Keyword fallback：候选 summary+conclusions 含查询主题词才保留。

### 5. `core/src/history-retriever.ts` — search() 加重排步骤

```
Step 1.5 (RERANK): 
  if matchedChunkIds.size > 1 && model.rerankCandidates:
    chunks = getChunksByIds(matchedChunkIds)
    result = rerankCandidates({ query, intent, candidates: chunks })
    matchedChunkIds = new Set(result.relevantIds)   // 过滤噪音
  // 重排为空 → 回退保持原候选（不丢结果）
```

注意：
- 未归档消息候选（direct candidates）不参与重排（已是原始消息，地面真相）
- 重排失败 → 静默保持原排序（关键字 fallback 或保留全部）
- 清晰单候选查询不触发重排（2ms 直达）

### 测试桩
`archive-manager.test.ts` 等 mock 加 `rerankCandidates()` 桩

## 验收

- [ ] 2000 轮 forget：Q4/Q6 恢复，准确率 ≥ 9/10
- [ ] fair 2000 轮不回归（单候选查询仍 2ms）
- [ ] typecheck + 45 测试通过
- [ ] 搜索延迟：单候选 2ms / 多候选 ~5s（1 次 LLM）
