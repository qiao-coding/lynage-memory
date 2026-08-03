# drillDown 批量导航重构计划

## 目标

将 `drillDown` 从「逐个孩子问LLM」改为「一次性扫目录页」——

```
当前:  isDirectoryRelevant → isChunkRelevant(1) → isChunkRelevant(2) → ... (N次LLM调用)
目标:  isDirectoryRelevant → navigateDirectory(目录+所有孩子) → 只开命中的 (1次LLM调用)
```

## 新增类型和接口

### 1. `core/model.ts` — 新增

```ts
export interface NavigateDirectoryInput {
  directoryId: string;
  overallContent: string;
  mainConclusions: string[];
  goals: string[];
  question: string;
  intent: string;
  children: Array<{
    childId: string;
    childType: "chunk" | "directory";
    summary: string;
    conclusions: string[];
    goals: string[];
    keywords?: string[];
  }>;
}

export interface NavigateDirectoryResult {
  relevantChildIds: string[];
  reasoning: string;
}
```

`LynageModel` 加可选方法:
```ts
navigateDirectory?(input: NavigateDirectoryInput): Promise<NavigateDirectoryResult>;
```

### 2. `core/schemas.ts` — 新增 Zod schema

```ts
export const NavigateDirectoryResultSchema = z.object({
  relevantChildIds: z.array(z.string()),
  reasoning: z.string(),
});
```

## 改动清单（5 个文件）

### A. `core/model.ts`
- 添加 `NavigateDirectoryInput`、`NavigateDirectoryResult`
- `LynageModel` 添加 `navigateDirectory?`

### B. `core/schemas.ts`
- 添加 `NavigateDirectoryResultSchema`

### C. `core/history-retriever.ts` — drillDown 核心重构

**新流程:**
```
drillDown(dirId, query, understanding):
  1. getDirectory(dirId)
  2. isDirectoryRelevant() — 子树剪枝（保留现有逻辑）
  3. 目录不相关 → 跳过所有子节点
  4. 目录相关:
     a. getDirectoryChildren(dirId)
     b. 分离 chunks 和 sub-dirs
     c. 批量取所有子节点元数据（chunks + sub-dirs）
     d. if model.navigateDirectory:
          ONE LLM call → relevantChildIds
        else:
          逐个 isChunkRelevant（现有回退逻辑）
     e. 命中的 chunks → 加到 candidates
     f. 命中的 sub-dirs → 递归 drillDown
```

### D. `adapter-ai-sdk/model.ts` — 实现 navigateDirectory

```
Prompt:
  Directory: overallContent / conclusions / goals
  Question: ... / Intent: ...
  Children:
    [idx] Type: window/phase | Summary: ... | Conclusions: ... | Goals: ...
  
  Return: { relevantChildIds, reasoning }
```

回退: keyword overlap on children's summary+conclusions+goals

### E. `core/archive-manager.test.ts` — Mock 补方法

```ts
async navigateDirectory() { return { relevantChildIds: [], reasoning: "" }; }
```

## 复杂度收益

| 场景 | 当前 | 改后 |
|------|------|------|
| B=20 分支，全相关 | 21次LLM调用 (1 dir + 20 chunk) | 2次 (1 dir + 1 batch) |
| B=20 分支，30%相关 | 21次LLM调用 | 2次 |
| 深3层全遍历 | ~60次 | ~6次 |

## 执行顺序

1. model.ts + schemas.ts（类型定义）
2. adapter-ai-sdk/model.ts（实现 navigateDirectory）
3. history-retriever.ts（drillDown 重构）
4. archive-manager.test.ts（Mock 更新）
5. pnpm typecheck + pnpm test
