# Lynage Memory

**[文档](docs/)** · **[架构](docs/02-how-it-works.md)** · **[Issues](https://github.com/qiao-coding/lynage-memory/issues)**

## 是什么？

Lynage Memory 是 Agent 的记忆模块。它保存每一句对话原文，给旧对话贴上摘要标签方便查找，需要时打开原文确认事实——**摘要只是索引，原文才是记忆。**

### MVP 状态

| 检查项 | 状态 |
| --- | --- |
| Typecheck（7 包） + 单元测试（45 用例） | ✅ |
| 100 轮对话准确率 | 100%（5/5） |
| MCP Server（Claude Code 接入） | ✅ |
| `pnpm add lynage-memory` 三行接入 | ✅ |
| 未归档消息搜索 | ✅ FTS5 直接返回 recent 消息 |
| 目录压缩升代 | ✅ 合成 keywords + importantChanges |
| 上下文预算控制 | ✅ 搜索 ≤500 token，原文 ≤500 token |
| 已知限制 | 超长对话（10000+ 轮）目录元数据可能超出窗口，逐代压缩/工作区引用规划中 |

**可用，但有前提。** 如果你的 Agent 对话在 500 轮以内，Lynage 和一段 LLM 摘要效果差不多——前者更贵但保留原文，后者便宜但丢了原文。如果你的对话会到 1000+ 轮，Lynage 的阶段树是目前唯一能保持精度的方案。

### 为什么选 Lynage

和同类方案的根本区别：

| | Lynage | Hermes/Mem0/压缩 | 你真正关心的 |
|---|---|---|---|
| 对话长了怎么办 | **阶段树**自动分层 | 平面搜索，信噪比下降 | 100 轮没区别，500+ 轮是唯一解 |
| 原文丢了没 | **追加写，永不删除** | 压缩方案丢弃原文 | 你需要三个月前的一个细节——Lynage 能找到原文，压缩只有模糊摘要 |
| 需要什么基础设施 | **一个 SQLite 文件** | 向量数据库/云服务 | 零依赖部署 |
| 短对话表现 | 等于全量保留（未达阈值不归档） | — | 和不用记忆模块一样快 |

**Lynage 唯一不可替代的点：阶段树。** 没有其他记忆系统会自动按 token 切窗口、给窗口生成摘要、窗口满了自动升代。Hermes、Mem0、LangChain——全是平面存储+搜索。Lynage 有层次结构。

但说实话：**这个优势只在长对话（500+ 轮）时成立。** 短对话用一段 LLM 摘要就够了，更便宜。

<br />

每一个长对话 Agent 都会遇到同一个问题：上下文窗口有限，历史对话怎么存？

两种传统做法都不够好：

- **全部保留** — Token 随对话线性增长，超出窗口就截断，最早的信息丢失
- **上下文压缩** — 旧对话 → LLM 摘要 → 丢弃原文。问题：摘要可能漏掉关键信息，反复压缩后语义漂移，一旦丢了原文就永远回不去

Lynage 选择第三条路：**原文全部保留，AI 为每段旧对话生成总结、进度和结论。**

## 为什么不需要上下文压缩

Lynage 的设计前提是：**原文不可替代。** 上下文压缩生成的摘要会丢失信息——你无法提前知道未来会问什么，也就无法知道摘要里该保留什么。

所以 Lynage 不做上下文压缩。它做三件事：

1. **原文全部存下来** — 每一条消息追加写入 SQLite，从不修改删除
2. **为旧对话生成总结和结论** — 对话太长 → 旧对话冻结成"窗口" → AI 读完全部原文，生成这段对话的总结（summary）、进度（progress）、关键词、重要变更和关键结论
3. **需要时打开原文** — Agent 搜索时先看总结定位 → 找到相关窗口 → 打开原文阅读 → 基于原文回答

```
传统压缩:                          Lynage:

原文 → 摘要 → 丢掉原文            原文 → 摘要标签 → 原文保留
       ↑                                  ↑         ↑
  摘要就是记忆                        标签只是索引   原文才是记忆
  (原文丢了，回不去了)                 (原文永远在)   (随时可以回去读)
```

打个比方：

- **传统压缩** = 读完一本书，把书还回图书馆，只留一张读书笔记。往后你只能信笔记上写的——笔记写对了就对，写漏了就漏了，没法回去翻原文确认。
- **Lynage** = 给每本书贴个标签，书还在书架上。想看的时候顺着标签找到书，翻开来读，还能清楚书架的左右有什么书，书架上不同的书之间的关联，以及你是从哪一个书架拿的书。

标签可以写得不够好、漏了一些信息——没关系。找到书架打开书就什么都清楚了。

## 架构亮点

Lynage 不需要上下文压缩，是因为底层架构保证了四件事：

**不可变消息存储**
每一条消息都是追加写入的事件。没有 UPDATE、没有 DELETE。原文永远在原位。这是所有上层能力的基础。

**窗口 = 总结 + 进度 + 结论，不是压缩**
旧对话被冻结成窗口时，AI 读完全部原文，生成总结（这段时间聊了什么）、进度（项目推进到什么程度）、关键结论和重要变更。窗口保留 `sourceFrom → sourceTo` 指针指向原文。这些内容只用来搜索和导航——搜到了就打开原文确认，不是替代原文。

**阶段树 = 不用提前分类**
窗口多了自动建阶段，阶段满了自动升代（G0→G1→G2→...，递归升代）。升代时 AI 读下层窗口的总结和结论，合成上层的阶段概述。不依赖开发者预先建好项目分类——结构按时间和容量自然生长。越旧的信息层级越深，但原文始终可达。

**原文验证 = 不依赖 AI 总结的准确性**
搜索返回候选窗口后，不是直接相信 AI 生成的总结。打开窗口原文，检查用户问题中的关键词是否真的出现在原文中。置信度低的候选被过滤掉。最终答案基于原文，不是基于总结。

**搜索附带阶段上下文**
每个窗口属于一个阶段（Phase），搜索时自动附带父阶段的摘要、结论和重要变更。AI 打开一个窗口时，同时看到它属于哪个阶段——不需要再从单个窗口的碎片摘要中推测全貌。这就像找到了书架上的书，也看到了这个书架的分类标签和书架处于什么位置。

```
消息 (原文，永不丢失)
  │
  ├─ 归档 → 窗口 (总结+进度+结论 + 原文指针 + 阶段上下文)
  │           │
  │           └─ 升代 → 阶段 → 再满 → 递归升代 (G0→G1→G2→...)
  │
  ├─ 搜索 → 总结匹配 → 找到候选窗口 + 阶段上下文
  │           │
  │           └─ 打开原文 → 确认 → 回答
  │
  └─ 写回 → 确认的结论更新工作记忆
```

## 量化对比

实测条件：DeepSeek V4 Flash，100 轮中文对话，5 个事实性问题，真实 AI 归档。

| 指标 | Lynage | 传统压缩 |
| --- | --- | --- |
| 准确率 | **100%**（5/5） | **100%**（5/5） |
| 幻觉率 | 0% | 0% |
| 输入 Token | 4,196 | 1,184 |
| 输出 Token | 398 | 268 |
| 总成本（5 题） | ¥0.005 | ¥0.002 |
| 搜索延迟 | **4ms** | N/A |
| 归档 | 4 chunks，1 阶段目录（G0） | 1 次 LLM 摘要 |

> **100 轮两者打平。** 100 轮对压缩的上下文窗口来说还很轻松——一次 LLM 摘要全覆盖。Lynage 的 token 消耗更高（返回完整原文），但搜索仅 4ms。

### 什么时候 Lynage 不可替代

| 对话规模 | 压缩 | Lynage |
| --- | --- | --- |
| 100 轮 | ✅ 摘要全覆盖 | ✅ 阶段树命中 |
| 500 轮 | ⚠️ 摘要开始丢细节 | ✅ 按 token 切窗口，精度不降 |
| 2000 轮 | ❌ 摘要退化到骨架 | ✅ 多层阶段目录，并行钻取 |
| 10,000 轮 | ❌ 无法运行 | ✅ 阶段树 log₂₀(N) 深度，Token 固定 |

> 压缩的摘要是一次性的——对话越长，摘要越模糊，最后只剩骨架。Lynage 的阶段树按 token 阈值自动切窗口，每个窗口保留原文指针，搜索时钻取树找原文。100 轮看不出差距，500 轮后是唯一可用方案。

### 系统状态

| 测试项 | 结果 |
| --- | --- |
| Typecheck（7 包） | ✅ |
| 单元测试（8 文件，45 用例） | ✅ |
| FTS5 CJK 搜索 | ✅ trigram tokenizer |
| `openSource` 阶段上下文 | ✅ 父目录摘要+结论 |
| 归档摘要 | ✅ 非贪婪 JSON 解析 |

### 历史索引大了怎么办：并行 Agent 共享记忆

有人会问：历史积累到几万轮，索引本身不会庞大吗？搜索不会变慢吗？

**不会。索引存在本地 SQLite，不是发给 LLM。** FTS5 对百万级文本的关键词搜索仍然是毫秒级。阶段树按 B=20 分支，10000 个窗口的深度只有 log₂₀(10000) ≈ 3 层——从根节点到任意窗口，最多下钻 3 步。

当需要大范围排查时，多个 Worker 并发搜索：

```
共享项目记忆                    并行 Worker (本地，只读)         LLM 收到的
┌──────────────┐     ┌──────────┐ ┌──────────┐      ┌─────────────────┐
│ 项目目标      │     │ Worker A │ │ Worker B │      │ 工作记忆 ~100    │
│ 已知决策      │──→  │ 读窗口1-5 │ │ 读窗口6-10│ ──→  │ 验证后的原文 ~400 │
│ 搜索目标      │     │ 返回3证据 │ │ 返回2证据 │      │ 当前问题 ~100    │
└──────────────┘     └──────────┘ └──────────┘      │ 总计 ~600 tokens │
                     ┌──────────┐ ┌──────────┐      │ 固定，不随历史增长 │
                     │ Worker C │ │ Worker D │      └─────────────────┘
                     │ 读窗口11-│ │ 读窗口16-│
                     │ 15      │ │ 20      │
                     └──────────┘ └──────────┘

每个 Worker 共享同一份项目记忆（知道项目目标、已知决策、要找什么），
只读分配给自己的窗口，返回证据位置。主进程汇总验证后才发给 LLM。
```

**无论历史多大，LLM 看到的始终是 \~600 tokens 的精选上下文。**

## 能做什么

- **长上下文零 Token 增长** — 5000 轮对话后，LLM 收到的上下文仍然是 \~500 tokens。历史索引存在本地 SQLite，不消耗 LLM Token
- **基于事实回答，避免推理猜测** — 先在本地精确定位相关原文，LLM 看到原文直接回答。不靠猜，不靠模糊摘要，推理 Token 远低于猜测模式
- **多 Worker 共享项目记忆并行搜索** — 同一份项目记忆（目标、已知决策、搜索目标），多个 Worker 并发读不同窗口，主进程汇总验证后才发给 LLM
- **模糊问题分批查找** — "之前那个设计为什么不用了？"→ 创建搜索任务 → 分批检查 → 跨轮次继续
- **自动写回工作记忆** — LLM 确认结论后，增量更新（confirmed/progress/unresolved），下次对话自动注入
- **嵌入现有 Agent** — 三行代码，不改 Agent 架构

## 快速开始

## 安装

```bash
pnpm add lynage-memory
```

### 代码嵌入

```bash
pnpm add lynage-memory
```

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
