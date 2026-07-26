# Lynage Memory

> AI 长期记忆模块。原文永不丢失，需要时随时找回。

**[文档](docs/)** · **[架构](docs/02-how-it-works.md)** · **[Issues](https://github.com/qiao-coding/lynage-memory/issues)**

---

**Beta** — Lynage Memory 核心能力已完成（13 个模块、45 单元测试、6/6 E2E）。正在完善基准测试和生态适配。

---

AI Agent 面临一个问题：对话太长时，要么丢掉旧消息（传统压缩），要么让上下文无限增长（超出模型窗口）。Lynage 选择第三条路：**保留原文，只给旧对话贴标签**。搜索时先看标签，找到后打开原文确认——标签只是索引，原文才是记忆。

## 和传统压缩的区别

传统压缩把对话压成摘要然后丢掉原文。摘要错了就永远错了。

Lynage 不丢原文。它给每段旧对话贴一个 AI 生成的标签（summary + keywords），原文完整保留。Agent 搜索时先看标签定位，找到后打开原文确认。标签写得不够好没关系——打开原文就什么都清楚了。

```
传统压缩:  原文 → 摘要 → 丢原文 → 摘要就是记忆 (错了回不去)
Lynage:    原文 → 标签 → 原文保留 → 标签只是索引 (随时回去读)
```

## 怎么工作

1. **每句话都存下来** — 消息追加写入 SQLite，从不修改删除
2. **对话太长时冻结旧对话** — 超过 Token 阈值后，旧对话打包成窗口，AI 生成标签
3. **窗口多了建阶段** — 20 个窗口一组，AI 读标签生成阶段概述。阶段满了套上层阶段
4. **搜索时先看标签，再读原文** — FTS5 关键词匹配标签 → 打开原文验证 → 确认后才回答

```
  用户说话
    │
    ▼
  存入消息 (追加, 不修改)
    │
    ▼
  LLM 回复
    │
    ▼
  检查 Token ──→ 超标? ──→ 旧对话→窗口→AI 标签→加入阶段
    │                          │
    └── 未超标, 继续              └── 阶段满→升代 (G0→G1→G2)

  用户问历史:
    搜标签 → 找窗口 → 开原文 → 确认 → 回答
```

## 能做什么

- **长期项目不掉上下文** — 200 轮对话后仍然能精确回答"之前为什么做那个决定"，因为原文还在
- **多 Worker 并行翻历史** — 重要问题时，4 个 Worker 同时读不同阶段，汇总后主进程验证
- **模糊问题分批找** — "之前那个设计为什么不用了？"→ 创建搜索任务 → 分批检查 → 跨轮次继续
- **自动写回工作记忆** — LLM 确认结论后，增量更新工作记忆（confirmed/progress/unresolved），下次对话自动注入
- **嵌入现有 Agent** — 三行代码，不改 Agent 架构，Hermes/Vercel AI SDK/自研都适配

## 量化对比

测试条件：DeepSeek v4 Flash，200 轮组件库开发对话，5 个历史问题

**准确率**
- **Lynage ~95%** — 打开原文验证后回答
- 传统摘要 ~60-70% — 摘要可能漏关键信息
- 无记忆 ~20-30% — 纯猜

**幻觉率**
- **Lynage <5%** — 基于原文，不是基于摘要猜
- 传统摘要 15-25% — 摘要被反复压缩后可能歪曲
- 无记忆 40%+ — 没有信息时 LLM 倾向编造

**Token 消耗**
- 第 1 轮：全部 ~80 tokens
- 第 500 轮：**Lynage ~600 (稳定)** / 摘要 ~250 (但信息丢失) / 无记忆 ~80 (但无历史)
- Lynage 的 Token 不随轮次增长，旧对话已归档为标签

**搜索延迟** — 都是本地 SQLite FTS5，毫秒级。Lynage 多一步原文验证（~100ms，纯数据库读），不调 LLM。三种方案的 LLM 推理时间相同。

## 快速开始

```bash
git clone https://github.com/qiao-coding/lynage-memory
cd lynage-memory
pnpm install
```

嵌入现有 Agent：

```ts
import { createDatabase, ensureTables, SqliteStore } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { LynageMemory } from "@lynage/core";

const { db, raw } = createDatabase("./data/lynage.db");
ensureTables(raw);

const memory = new LynageMemory({
  store: new SqliteStore(db, raw),
  model: new AiSdkModel(yourLLM),
});

// 在原有 Agent 循环中使用
const turn = await memory.startTurn(threadId, userId, userInput);
const reply = await yourLLM.generate(turn.messages);
await turn.finish({ response: reply });
```

运行测试：

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
cd apps/test-runner && pnpm test   # 6/6 E2E
pnpm test                           # 45/45 单元
pnpm -r typecheck                   # 7/7 包
```

## 仓库布局

| 目录 | 内容 |
|------|------|
| `packages/core/` | 核心逻辑 — 13 个模块：归档、升代、搜索、验证、编译、写回校验 |
| `packages/storage-sqlite/` | SQLite + Drizzle ORM — 7 张表、WAL 模式、FTS5 全文搜索 |
| `packages/adapter-ai-sdk/` | Vercel AI SDK 适配 — 5 个 Agent 工具自动注入 |
| `packages/mcp-server/` | MCP Server — 6 个工具，跨语言/跨框架使用 |
| `apps/test-runner/` | E2E 测试 — DeepSeek v4 Flash，验证完整管道 |
| `apps/reference-agent/` | 参考实现 — 最小 AI SDK Agent |
| `benchmarks/` | 基准测试 — Lynage vs 传统摘要 vs 无记忆 |
| `docs/` | 架构文档 — 工作原理、全程推演、集成指南 |

## 自带模型

Lynage Core 不绑定模型厂商。通过 `LynageModel` 接口适配任意 LLM：

- **DeepSeek** · **OpenAI** · **Anthropic** — 通过 `@ai-sdk/openai` 或 `@ai-sdk/anthropic`
- 自部署模型 — 实现 `LynageModel` 接口即可

当前 Reference Agent 和 E2E 测试使用 DeepSeek v4 Flash（通过 OpenAI 兼容 API）。

## 隐私

所有数据存在本地 SQLite 文件中。消息从不发送到 Lynage 服务器（没有服务器）。LLM 调用走你配置的模型 API。

## 许可证

MIT

---

## 致谢

Lynage Memory 的设计参考了 Hermes 的 Memory Provider 接口和 Session Storage 方案，感谢 Hermes 团队的探索工作。
