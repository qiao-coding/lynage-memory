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

## 长上下文优势

### 实测：10,000 轮对话（DeepSeek V4 Flash）

测试方法：10,000 轮中文对话，50 个事实点，抽样 10 题回答。Lynage 真实 AI 归档（38 chunks），Hermes Agent `get_messages_around` 窗口上下文。

| 指标 | Lynage | Hermes Agent |
| --- | --- | --- |
| 准确率 | **100%**（10/10） | 100%（10/10） |
| 幻觉率 | 0% | 0% |
| 输入 Token（10 题） | **2,929** | 23,564 |
| 输出 Token（10 题） | 1,455 | 2,299 |
| 总 Token（10 题） | **4,384** | 25,863 |
| 搜索延迟 | **6ms** | 12ms |
| 存储时间 | 46s（含 AI 归档） | 19s |
| 回答时间 | ~30s | 44s |
| 回答成本 | **¥0.006** | ¥0.028 |
| 归档结构 | 阶段目录 | 无（平面消息） |

> **公平对比**：两个系统均返回完整上下文（不截断）、不限制输出、相同模型。准确率打平（100%），差异在 token 消耗：
>
> - **Lynage 输入 2,929 token（~293/题）** — 搜索命中后返回精准的 chunk 语义片段，只含与问题相关的对话。
> - **Hermes 输入 23,564 token（~2,356/题）** — `get_messages_around` 返回命中消息 ±3 条的固定窗口，含大量无关消息。
>
> Lynage 成本是 Hermes 的 **1/4.7**，搜索快 2 倍。代价是存储更慢（阶段树归档需 AI 摘要，异步不阻塞回答）。

### 失忆式提问测试（反常识 + 过程性）

用户不记得细节的提问方式：「我们当时是怎么定的？一开始是不是用了别的方案？中间是不是换了什么？最后定的哪个？」——答案需要检索**完整决策过程**（尝试主流 → 发现问题 → 放弃 → 选反常识方案），且正确答案违背常识（styled-components、MongoDB 等）。

| 指标 | Lynage | Hermes Agent |
| --- | --- | --- |
| 准确率 | **90%**（9/10） | 0%（0/10） |
| 幻觉率 | 0% | 0% |
| 回答质量 | 完整叙述过程（一开始→中间→最终） | 声称「历史中完全没有提到」 |

> **差距原因（检索鲁棒性差异）**：10,000 轮里普通消息频繁出现主题词（如「样式方案」出现在组件讨论中），淹没事实决策消息。
>
> - **Hermes** `search_messages` 只返回 **top 5 匹配**，事实决策被普通消息挤出 → 上下文窗口全是无关内容 → 无法回答。
> - **Lynage** 搜索返回**所有 FTS 匹配**（含未归档 recent 消息），事实消息总能命中 → `getMessagesAround` 取到完整决策过程。
>
> 此测试模拟真实场景：长对话中事实被噪声淹没，用户模糊回忆。Lynage 的「不丢匹配」检索在此场景下是决定性的。Hermes 的 0% 部分源于 top-5 截断（调整排序/数量可能改善），但 Lynage 的机制本身更鲁棒。

### 测试数据的方法论说明

> **本测试使用程序生成的模板对话**，而非真实用户对话。数据从真实 API 调用采集（token 计数、延迟、回答均为实测），但对话内容为合成，存在以下局限：
>
> 1. **事实关键词原样出现在消息中**（如「PostgreSQL」「Docker」）——这降低了两个系统的检索难度。
> 2. **消息高度相似**——真实对话的话题漂移、无关闲聊、打断在模板数据中不存在。
> 3. **未做真实含糊表述测试**——「上次那个方案」「把数据库换了」这类真实表述对两个系统的影响均未量化。
>
> 该测试验证了两个系统在**关键词丰富、结构均匀**的对话下的相对表现。真实对话下的准确率、延迟、成本均可能不同，结论不应外推到真实场景。用真实对话数据重测是必要的后续工作。

### 测试题目设计

为避免「关键词直接命中 + 模型常识补全」导致准确率失真，基准测试使用**精确 + 反常识**的测试题：

- **反常识选择** — 每个技术决策的正确答案违背主流惯例（如组件库用 styled-components 而非 CSS Modules）。模型靠常识推理必然答错。
- **精确细节** — 每题需原文中的精确事实（具体库、具体 API、具体配置），不存在于模型训练常识中。
- **含糊表述** — 问题只给主题线索，不含答案关键词。检索必须依赖语义导航（AI 摘要 + 阶段树），而非关键词命中。

完整 10 道测试题见 **[docs/benchmark-questions.md](docs/benchmark-questions.md)**。

### 对话规模扩展性

| 对话规模 | 传统压缩 | Hermes / Mem0 | Lynage |
| --- | --- | --- | --- |
| 500 轮 | ⚠️ 摘要开始丢失细节 | 平面搜索信噪比下降 | ✅ 按 token 切窗口，精度保持 |
| 2,000 轮 | ❌ 摘要退化为骨架 | ❌ 返回片段越来越长，输入膨胀 | ✅ 多层阶段目录，并行钻取 |
| 10,000 轮 | ❌ 无法运行 | ❌ 上下文被原始片段淹没 | ✅ 阶段树 log₂₀(N) 深度，Token 固定 |

**Lynage 的长上下文能力来自三个机制：**

1. **自动切窗** — 按 token 阈值（默认 8000）把长对话切成窗口，每个窗口 AI 生成摘要 + 原文指针。窗口之间用阶段目录组织，无需预定义分类。

2. **原文永不丢失** — 摘要只是导航索引。即使摘要不完整，`openSource` 总能打开原文验证。压缩方案丢弃原文后，信息不可恢复。

3. **上下文预算固定** — LLM 每次只收到工作记忆 + 相关阶段的摘要 + 验证后的原文片段。目录树深度 log₂₀(N)，10000 窗口仅 3 层。对话增长时，LLM 上下文不增长。

### 搜索复杂度

搜索只沿**相关分支**下钻，跳过无关子树：

- 每个目录先计算摘要相关性，无关则整个子树跳过（O(相关分支) 而非 O(全目录)）
- chunk 元数据批量拉取，替代逐条 DB 调用
- 并行 Worker 并发搜索多目录，主进程汇总验证

| 指标 | 100 轮 | 1,000 轮 | 10,000 轮 |
| --- | --- | --- | --- |
| 阶段目录深度 | 0-1 | 2 | 3（log₂₀ 10000） |
| 搜索延迟 | ~4ms | ~6ms | ~6ms |
| LLM 输入 Token | ~800 | ~800 | ~800（固定） |
| 目录元数据 Token | ~0（未升代） | ~200（G1 摘要） | ~400（G2 压缩摘要） |
| 原文可恢复 | ✅ | ✅ | ✅ |

> 搜索延迟不随对话规模线性增长——只遍历相关路径。LLM 输入固定——历史再多也只进 SQLite，不消耗 Token。

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
