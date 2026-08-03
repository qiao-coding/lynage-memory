# Structured Navigation Fix Plan

## 目标

让目录级导航与窗口级导航对等——LLM 用结构化字段（结论/目标/概要）判断目录相关性，像翻书目录一样决定钻进哪个子树。

## 改动清单（6 个文件）

### 1. `packages/core/src/model.ts` — DirectoryRelevanceInput 结构化

```
当前:
  directorySummary: string   // 拼在一行的文本

改为:
  overallContent: string
  mainConclusions: string[]
  importantChanges: string[]
  goals: string[]
  // question + intent 不变
```

### 2. `packages/core/src/history-retriever.ts` — 主检索器（4 处改动）

**A. DirectoryContext 加 goals**
```
当前: mainConclusions, importantChanges
改为: + goals: string[]
```

**B. SearchCandidate 加 conclusions/goals**
```
当前: summary, progress, keywords
改为: + conclusions: string[], goals: string[]
```

**C. drillDown() — 结构化传参给 isDirectoryRelevant**
```
当前: isDirectoryRelevant({ directorySummary: dirText, ... })
改为: isDirectoryRelevant({ overallContent, mainConclusions, importantChanges, goals, ... })
同时删除 dirText 拼接变量，回退时以内联方式拼接
```

**D. computeRelevance() — 纳入 conclusions/goals 参与评分**
```
当前: (query, text, keywords)
改为: (query, text, keywords, conclusions?, goals?)
在评分逻辑中搜索 conclusions/goals 数组中的匹配项
```

**E. search() 候选构建 — 带上 conclusions/goals**
```
从 chunk 构建 SearchCandidate 时，填充 conclusions/goals
```

**F. openSource() — directoryContext 带 goals**

### 3. `packages/adapter-ai-sdk/src/model.ts` — isDirectoryRelevant 实现

**Prompt 结构化**
```
当前: Directory summary (parent context): "一大坨拼接文本"
改为:
  Directory overview: "..."
  Directory conclusions: "..."
  Directory goals: "..."
  Important changes: "..."
```

**回退结构化**
```
当前: terms.some(t => input.directorySummary.includes(t))
改为: 搜索 overallContent + conclusions + goals
```

### 4. `packages/core/src/parallel-search-coordinator.ts` — 并行搜索器

**directoryContext 构造加 goals**
```
当前: { directoryId, generation, overallContent, progress, mainConclusions, importantChanges }
改为: + goals: dir.goals ?? []
```

**SearchCandidate 构造加 conclusions/goals**
```
当前: { contextId, summary, progress, keywords, ... }
改为: + conclusions: [], goals: []
```

### 5. `packages/core/src/source-verifier.test.ts` — makeCandidate 默认值

```
当前: { contextId, summary, progress, keywords, sourceRange, timeRange, relevance }
改为: + conclusions: [], goals: []
```

### 6. `packages/core/src/archive-manager.test.ts` — Mock（无需改动）

`isDirectoryRelevant() { return true; }` — 签名变了但 mock 忽略参数，兼容。

## 执行顺序

1. model.ts（类型定义，其他文件依赖）
2. history-retriever.ts（核心改动，体积最大）
3. adapter-ai-sdk/model.ts（实现类）
4. parallel-search-coordinator.ts（跟随改动）
5. source-verifier.test.ts（测试桩）
6. pnpm typecheck + pnpm test 验证
