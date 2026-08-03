# 完整语义导航修复计划

## 三个缺口

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | `isDirectoryRelevant` + `navigateDirectory` 双重 LLM | drillDown 先判断目录相关性再扫描子节点 | 删除 `isDirectoryRelevant` 调用，`navigateDirectory` 返回空 = 不相关 |
| 2 | 根目录逐个检查 | search() 对每个根目录独立调 drillDown | 根目录批量构建为一个虚拟 `navigateDirectory` 调用 |
| 3 | 递归丢失父上下文 | drillDown(childId) 不传父目录信息 | 加 `parentContext` 参数，递归时传递 |

## 改动清单（4 个文件）

### 1. `core/model.ts` — NavigateDirectoryInput 加 parentContext

```ts
export interface NavigateDirectoryInput {
  directoryId: string;
  overallContent: string;
  mainConclusions: string[];
  goals: string[];
  /** Parent directory breadcrumb — guides recursive navigation */
  parentContext?: {
    overallContent: string;
    mainConclusions: string[];
    goals: string[];
  };
  question: string;
  intent: string;
  children: Array<{...}>;  // 不变
}
```

### 2. `core/history-retriever.ts` — 两处重构

**A. `search()` — 根目录批量选择**

```
旧: for (const dir of rootDirs) { drillDown(dir.id, ...) }
新:
  1. 取所有根目录元数据
  2. 构建 virtual NavigateDirectoryInput:
     - directoryId: "__root__"
     - overallContent: "Entire conversation history"
     - children: 根目录列表（各目录的 overallContent/conclusions/goals）
  3. 一次 navigateDirectory → relevantRootIds
  4. 仅 drillDown 选中的根目录
  (如果 model 无 navigateDirectory，回退到逐个 isDirectoryRelevant + 递归)
```

**B. `drillDown()` — 删 isDirectoryRelevant，加 parentContext**

```
新签名: drillDown(directoryId, query, understanding, parentContext?)

新流程:
  1. getDirectory(dirId)  ← 不再判 dirRelevant
  2. getDirectoryChildren(dirId)
  3. 取所有子节点元数据 (chunks + sub-dirs)
  4. navigateDirectory({..., parentContext, children})  ← 一次LLM
     - 返回空 → 目录不相关 → return
  5. relevant chunks → candidates
  6. relevant sub-dirs → drillDown(childId, ..., parentContext=当前目录)
```

### 3. `adapter-ai-sdk/model.ts` — prompt 加 parentContext

```
当前:
  Directory context (section overview):
    Overview: "..."

改为:
  (有 parentContext 时先输出面包屑)
  Parent context:
    Overview: "..."
    Conclusions: ...
    Goals: ...
  
  This directory:
    Overview: "..."
    ...
```

### 4. `core/archive-manager.test.ts` — Mock 不变（已有桩）

## LLM 调用次数对比

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 3 根目录，1 层深，全相关 | 1 + 3×2 + 3×1 = 10 | 1 + 1 + 3 = 5 |
| 3 根目录，2 层深(B=20)，全相关 | 1 + 3×2 + 60×2 = 127 | 1 + 1 + 3 + 60 = 65 |
| 3 根目录，30% 相关 | 10（全判+剪枝部分） | 5（只钻相关根，其余跳过） |

最终：每层 1 次 navigateDirectory，含 parentContext 面包屑。

## 执行顺序

1. model.ts — parentContext 字段
2. history-retriever.ts — search() 批量根目录 + drillDown() 重构
3. adapter-ai-sdk/model.ts — prompt 更新
4. typecheck + test
