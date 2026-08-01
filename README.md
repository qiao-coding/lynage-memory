# Lynage Memory

**[文档](docs/)** · **[架构](docs/02-how-it-works.md)** · **[Issues](https://github.com/qiao-coding/lynage-memory/issues)**

Lynage Memory 是面向长对话 Agent 的持久化记忆模块。核心设计：**消息原文永久保留，AI 生成摘要作为检索索引，需要时从原文精确验证。**

## 问题背景

大语言模型的上下文窗口有限。长对话 Agent 必须决定如何处理超出窗口的历史：

- **全量保留** — 上下文随对话线性膨胀，超出窗口即截断，最早的信息永久丢失
- **上下文压缩** — 旧对话经 LLM 摘要后丢弃原文。摘要一旦不完整或语义漂移，信息无法恢复

Lynage 采用第三条路径：**原文全部持久化，AI 为每个对话片段生成摘要作为导航索引，检索命中后打开原文验证。**

## 架构

Lynage 的核心是一个**自动生长的阶段树**（Generation Tree）：

```
消息 (不可变，追加写)
  │
  ├─ 归档 → 窗口 (摘要 + 进度 + 结论 + sourceFrom→sourceTo 原文指针)
  │           │
  │           └─ 升代 → 阶段目录 → 再满 → 递归升代 (G0→G1→G2→...)
  │
  ├─ 搜索 → FTS5 摘要匹配 → 候选窗口 + 阶段上下文
  │           │
  │           └─ openSource → 原文验证 → 回答
  │
  └─ 写回 → 确认的结论更新工作记忆
```

**四个设计原则：**

1. **不可变消息存储** — 每条消息追加写入 SQLite，无 UPDATE/DELETE。原文永远可恢复。
2. **窗口 = 摘要索引，不是压缩** — 归档时 AI 读取全部原文，生成总结/进度/结论。窗口保留 `sourceFrom→sourceTo` 指针指向原文，摘要仅用于搜索导航。
3. **阶段树自动生长** — 窗口达到容量阈值自动建阶段，阶段满自动升代（G0→G1→G2）。不需要开发者预定义分类。B=20 分支，10000 窗口深度仅 log₂₀(10000) ≈ 3 层。
4. **原文验证** — 搜索候选不直接信任 AI 摘要。`openSource` 打开原文，关键词匹配验证，低置信度候选被过滤。

## 与现有方案的对比

| 维度 | Lynage | Hermes / Mem0 | 传统压缩 |
|------|--------|---------------|---------|
| 存储 | SQLite 追加写 | SQLite / 向量库 | 无（丢弃原文） |
| 检索结构 | **阶段树分层钻取** | 平面 FTS5 / 向量相似度 | LLM 摘要 |
| 上下文注入 | 阶段摘要 + 原文片段（有 token 预算） | snippet / 匹配结果 | 一次性摘要 |
| 原文保留 | ✅ 永久 | ✅ 永久 | ❌ |
| 基础设施 | 单个 SQLite 文件 | 向量库 / 云服务 | 无 |
| 短对话（<500 轮） | 与全量保留等价（未达阈值不归档） | — | 一次摘要全覆盖 |
| 长对话（500+ 轮） | 阶段树保持精度，Token 固定 | 平面搜索信噪比下降 | 摘要退化到骨架 |

**Lynage 的差异化在于阶段树**——自动按 token 切窗口、为窗口生成摘要、窗口满自动升代。这是其他记忆系统（平面存储+搜索）所不具备的层次结构。该优势在长对话（500+ 轮）场景才显现；短对话场景下，简单的 LLM 摘要即可达到同等效果且成本更低。

## 量化对比

### 短对话（100 轮，真实 AI 归档）

测试方法：DeepSeek V4 Flash，100 轮中文对话，5 个事实性问题，同题同数据。

| 指标 | Lynage | 传统压缩 |
| --- | --- | --- |
| 准确率 | 100%（5/5） | 100%（5/5） |
| 幻觉率 | 0% | 0% |
| 输入 Token | 4,196 | 1,184 |
| 输出 Token | 398 | 268 |
| 总成本（5 题） | ¥0.005 | ¥0.002 |
| 搜索延迟 | **4ms** | N/A |

> 短对话场景下两者打平：100 轮内容一次 LLM 摘要即可全覆盖。Lynage 的 token 消耗较高（返回完整原文），但搜索延迟 4ms。此规模不足以体现 Lynage 的差异化。

### 对话规模扩展性

| 对话规模 | 传统压缩 | Lynage |
| --- | --- | --- |
| 100 轮 | ✅ 摘要全覆盖 | ✅ 阶段树命中 |
| 500 轮 | ⚠️ 摘要开始丢失细节 | ✅ 按 token 切窗口，精度保持 |
| 2000 轮 | ❌ 摘要退化为骨架 | ✅ 多层阶段目录，并行钻取 |
| 10,000 轮 | ❌ 无法运行 | ✅ 阶段树 log₂₀(N) 深度，Token 固定 |

> 压缩摘要是一次性生成——对话越长，摘要越模糊，最终只剩骨架。Lynage 的阶段树按 token 阈值自动切窗口，每个窗口保留原文指针，搜索时在树中定位。100 轮内两者无差异，500 轮后 Lynage 是保持精度的唯一方案。

## 性能与扩展性

### 搜索复杂度

索引存储在本地 SQLite（FTS5 全文索引），不进入 LLM 上下文。阶段树按 B=20 分支，10000 个窗口的深度为 log₂₀(10000) ≈ 3 层——从根到任意窗口最多 3 次下钻。搜索具备：

- **子树剪枝** — 目录摘要与查询无关时跳过该子树
- **批量查询** — chunk 元数据批量拉取，替代逐条 DB 调用
- **并行钻取** — 多目录并发搜索，Worker 返回证据位置，主进程汇总验证

实测搜索延迟：**4ms**（100 轮会话），随对话规模对数增长而非线性。

### 上下文预算控制

| 层级 | 控制 |
| --- | --- |
| 搜索候选 | `compileRetrievedContext(result, maxTokens)` 截断 |
| 原文提取 | `openSource(chunkId, { maxTokens })` 截断 |
| 目录深度 | log₂₀(N)，每层摘要 ~100 token |
| 常驻上下文 | 仅工作记忆 + 最近消息，目录树不注入 |

无论对话多长，LLM 收到的上下文保持在预算内。

## 功能特性

- **Token 固定** — 5000 轮对话后 LLM 上下文仍是 ~500 token，历史存 SQLite 不消耗 LLM Token
- **基于原文回答** — 本地定位相关原文，LLM 直接引用事实，不推测
- **并行搜索** — 多 Worker 并发读不同窗口，主进程汇总验证
- **模糊问题分批查找** — 跨轮次逐步缩小搜索范围
- **工作记忆写回** — 确认的结论增量更新（confirmed/progress/unresolved），下次对话自动注入
- **零架构侵入** — 三行代码接入，不改 Agent 架构

## 快速开始

### 安装

```bash
pnpm add lynage-memory
```

### 代码嵌入

```ts
import { createLynageMemory } from "lynage-memory";

// 一行初始化，SQLite 自动创建
const memory = createLynageMemory();

// Agent 循环中使用
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });

// 搜索历史
const result = await memory.search({ query: "数据库方案", sessionId: threadId });
const messages = await memory.openSource(result.candidates[0].contextId);
```

接入 LLM 后启用 AI 归档和搜索（可选）：

```ts
import { AiSdkModel } from "@lynage/ai-sdk";
const memory = createLynageMemory({ model: new AiSdkModel(yourLLM) });
```

### MCP Server / Claude Code 集成

Lynage 自带 MCP Server，一行命令接入 Claude Code 或其他 MCP 客户端：

```bash
# Stdio 模式（Claude Code 默认）
npx lynage-memory mcp --db ./lynage.db --provider deepseek --model deepseek-v4-flash

# HTTP 模式（远程客户端 / 浏览器）
npx lynage-memory serve --db ./lynage.db --port 4318 --provider openai --model gpt-4o-mini
```

**Claude Code 配置** — 在 `.claude/settings.json` 或 `~/.claude/claude.json` 中：

```json
{
  "mcpServers": {
    "lynage": {
      "command": "npx",
      "args": ["lynage-memory", "mcp", "--db", "./lynage.db", "--provider", "deepseek", "--model", "deepseek-v4-flash"]
    }
  }
}
```

配置后 Claude Code 自动获得 6 个记忆工具：

| 工具                          | 功能                     |
| --------------------------- | ---------------------- |
| `lynage_memory_read`        | 读取当前工作记忆（任务/进度/未解决）    |
| `lynage_memory_search`      | 搜索对话历史，返回匹配窗口+摘要+阶段上下文 |
| `lynage_memory_open_source` | 打开窗口读取原始消息+父阶段摘要/结论    |
| `lynage_memory_commit`      | 写入工作记忆（追加/移除）          |
| `lynage_memory_read_user`   | 读取跨任务的用户记忆             |
| `lynage_memory_stats`       | 查看会话存档统计               |

**支持的 Provider：**

| Provider  | 环境变量                | 需安装                 |
| --------- | ------------------- | ------------------- |
| DeepSeek  | `DEEPSEEK_API_KEY`  | `@ai-sdk/deepseek`  |
| OpenAI    | `OPENAI_API_KEY`    | `@ai-sdk/openai`    |
| Anthropic | `ANTHROPIC_API_KEY` | `@ai-sdk/anthropic` |

也可用 `--api-key` 和 `--base-url` 参数直接传值（兼容自定义端点）。

### API 一览

| 方法                                                  | 做什么                             |
| --------------------------------------------------- | ------------------------------- |
| `memory.startTurn(threadId, userId, input)`         | 保存用户消息，返回编译好的上下文（含工作记忆+历史）      |
| `turn.finish({ response, toolCalls, toolResults })` | 保存回复和工具调用，自动触发归档                |
| `memory.search({ query, sessionId })`               | 搜索历史窗口（FTS5 + 目录深入），返回候选+阶段上下文  |
| `memory.openSource(contextId)`                      | 打开窗口读原始消息 + 父阶段摘要/结论            |
| `memory.commit(actions, sessionId, userId?)`        | 增量写回工作记忆/用户记忆                   |
| `memory.getWorkingMemory(sessionId)`                | 读取当前工作记忆（任务/进度/未解决）             |
| `memory.getUserMemory(userId)`                      | 读取跨任务的用户偏好和约束                   |
| `memory.getDirectoryTree(sessionId)`                | 查看阶段树结构                         |
| `lynageStreamText({ memory, model, prompt, ... })`  | 一行接入 AI SDK，自动管理 turn 生命周期+工具注入 |

运行测试：

```bash
cd apps/test-runner && pnpm test   # 6/6 E2E (需 DEEPSEEK_API_KEY)
pnpm test                           # 45/45 单元
pnpm typecheck                      # 7 包全部通过
```

## 仓库布局

| 目录                         | 内容                                    |
| -------------------------- | ------------------------------------- |
| `packages/core/`           | 核心逻辑 — 13 个模块：归档、升代、搜索、验证、编译、写回校验     |
| `packages/storage-sqlite/` | SQLite + Drizzle — 7 张表、WAL、FTS5 全文搜索 |
| `packages/adapter-ai-sdk/` | Vercel AI SDK 适配 — 5 个 Agent 工具自动注入   |
| `packages/mcp-server/`     | MCP Server — 6 个工具，跨语言/跨框架            |
| `apps/test-runner/`        | E2E 测试 — DeepSeek v4 Flash，完整管道验证     |
| `benchmarks/`              | 基准测试 — Lynage vs 压缩 vs 无记忆            |
| `docs/`                    | 架构文档 — 工作原理、全程推演、集成指南                 |

## 自带模型

Core 不绑定模型厂商。通过 `LynageModel` 接口适配任意 LLM。

当前测试使用 DeepSeek v4 Flash（OpenAI 兼容 API）。也支持 OpenAI · Anthropic · 自部署模型。

## 隐私

所有数据存在本地 SQLite。没有 Lynage 服务器。LLM 调用走你配置的 API。

## 许可证

MIT
