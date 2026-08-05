// Flat FTS baseline for the forget benchmark — message-level keyword search,
// NO tree, NO compression. Uses the SAME conversations/questions/judge as
// bench-forget.ts so the Lynage-vs-flat forget comparison is reproducible
// in-repo (README previously cited an externally-sourced 0% for flat).
//
// Usage (cwd = benchmarks/baseline):
//   TURNS=2000 pnpm tsx bench-flat-forget.ts
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import fs from "node:fs";
import path from "node:path";
const ep = path.resolve(process.cwd(), "..", "..", ".env");
if (fs.existsSync(ep)) for (const l of fs.readFileSync(ep, "utf-8").split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); if (i < 0) continue; if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim(); }
const ds = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" }); const m = ds("deepseek-v4-flash");
const IC = 1 / 1e6, OC = 2 / 1e6;
let _s = 42; function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; } const pk = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
async function ask(p: string, retries = 5) { for (let ri = 0; ri < retries; ri++) { try { const r = await generateText({ model: m, prompt: p }); const u = await r.usage; return { text: r.text, input: u?.promptTokens ?? 0, output: u?.completionTokens ?? 0 }; } catch (e) { if (ri === retries - 1) return { text: "(api error)", input: 0, output: 0 }; await new Promise(r => setTimeout(r, 3000 * (ri + 1))); } } return { text: "", input: 0, output: 0 }; }

// --- same FACTS / turns / questions as bench-forget.ts ---
const FACTS: [string, string, string, string, string, string][] = [
  ["样式方案", "CSS Modules", "Tailwind CSS", "styled-components", "CSS Modules 在大型项目里样式碎片化严重，Tailwind 又太依赖工具类约定", "主题通过 ThemeProvider 从根组件注入"],
  ["数据库", "PostgreSQL", "SQLite", "MongoDB", "PostgreSQL 的关系型 schema 对我们非结构化文档不合适，SQLite 并发太弱", "部署在 Atlas M10 实例，3 节点副本集"],
  ["部署方案", "Docker", "自托管服务器", "Vercel", "Docker 需要团队自己维护运维，我们没有专职运维人员", "API 用 Functions 而非 Edge Functions"],
  ["状态管理", "Zustand", "MobX", "Redux Toolkit", "Zustand 的异步流处理能力弱，MobX 生态不够活跃", "用 createSlice 定义 reducer，RTK Query 管理异步状态"],
  ["认证方案", "NextAuth", "Auth0", "Supabase Auth", "NextAuth 的自定义用户表支持有限，Auth0 太贵", "邮箱验证 + JWT，token 有效期 7 天"],
  ["Monorepo", "Turborepo", "Lerna", "Nx", "Turborepo 的跨包类型检查依赖图不够细，Lerna 维护不活跃", "用 affected 命令做增量构建和测试"],
  ["测试框架", "Vitest", "Jest", "Cypress 组件测试", "Vitest 主要覆盖单元层，我们的 UI 交互逻辑复杂需要组件级覆盖", "用组件测试而非 e2e 覆盖 UI 层"],
  ["路由方案", "App Router", "React Router", "TanStack Router", "App Router 的 search params 没有类型安全，React Router 不够类型化", "search params 类型安全是选它的核心理由"],
  ["构建工具", "Vite", "Webpack", "esbuild", "Vite 的打包控制粒度不够细，Webpack 配置太重", "用自定义 plugin 处理 CSS 提取"],
  ["设计系统", "shadcn/ui", "自建组件库", "Ant Design", "shadcn/ui 缺少企业级复杂组件，自建成本太高", "用 ConfigProvider 定制设计 token"],
];
const T = Number(process.env.TURNS) || 10000, QN = FACTS.length;
const factStartTurns: number[] = []; for (let i = 0; i < QN; i++) factStartTurns.push(Math.floor((i + 1) * T / (QN + 1)) - 1);
const turns: Array<{ u: string; a: string }> = [];
const factTurnSet = new Set<number>();
for (const t of factStartTurns) { factTurnSet.add(t); factTurnSet.add(t + 1); factTurnSet.add(t + 2); }
let fi = 0;
for (let i = 1; i <= T; i++) {
  if (factTurnSet.has(i)) {
    const fiIdx = factStartTurns.findIndex(t => i >= t && i <= t + 2);
    const [n, mainstream, tried, chosen, problem, detail] = FACTS[fiIdx]!;
    if (i === factStartTurns[fiIdx]) {
      turns.push({ u: `关于${n}，我们一开始按主流做法选了${mainstream}。你帮我看看这个方案对我们的场景合适吗？`, a: `${mainstream} 是通用选择，但我们要先试用评估。考虑到项目场景，先按${mainstream}搭一版看看效果，同时留意它的问题。` });
    } else if (i === factStartTurns[fiIdx] + 1) {
      turns.push({ u: `${mainstream} 用下来有问题。我听说${tried}可能更合适，要不要试试？`, a: `${tried} 的问题也很明显：${tried} 在某些方面有优势，但${tried}并不完全匹配。${problem}。${mainstream}和${tried}都淘汰了，我们重新评估。` });
    } else {
      turns.push({ u: `那两个都不行。你觉得${chosen}这个方案怎么样？`, a: `经过评估，${chosen}最合适。${detail}。${chosen}虽然不主流，但解决了${mainstream}和${tried}的问题。最终决定用${chosen}，不用${mainstream}也不用${tried}。` });
    }
    fi++;
  } else {
    const c = pk(["Button", "Table", "Modal", "Form", "Input", "Select", "Card", "Dialog", "Tabs", "Toast"]);
    const a = pk(["重构", "性能优化", "边界处理", "无障碍适配", "测试覆盖", "暗色模式", "响应式", "国际化"]);
    const detail = pk(["这次改动涉及三个核心模块，包括组件的基础样式、交互逻辑和对外暴露的 API 接口。我们在设计评审中讨论了 props 命名规范和默认值策略，最终决定保持与现有组件库一致的命名风格，避免引入额外的学习成本。同时需要补充相应的单元测试用例，覆盖正常的渲染路径和边界情况，确保在后续迭代中不会引入回归问题。", "在实现过程中发现了一个与事件冒泡相关的交互缺陷，具体表现为当用户在快速点击时，组件的状态更新存在竞态条件，导致 UI 与内部状态不同步。经过排查，根因是异步回调中的状态引用问题。我们计划通过引入统一的 reducer 模式来管理组件状态，并在关键的交互路径上增加防抖处理，以提升整体的响应稳定性。", "设计稿里要求的暗色模式适配涉及所有颜色 token 的迁移。我们已经梳理出完整的颜色变量清单，包括背景、前景、边框、阴影等十几个维度。为了平滑过渡，将采用 CSS 变量的方案，在根节点上切换 data-theme 属性。同时需要处理图表、图片等非文本内容的对比度问题，确保在暗色模式下依然有良好的可读性。", "性能优化方面，当前的瓶颈在列表渲染。当数据量超过一万条时，每次滚动都会触发大量的重渲染，导致明显的卡顿。初步方案是采用虚拟滚动，只渲染可视区域内的条目，配合稳定的 key 值避免不必要的 DOM 复用。此外还计划对频繁调用的计算函数做 memo 化处理，将计算复杂度从 O(n²) 降低到 O(n)。", "这次国际化改造涉及 i18n 资源文件的组织方式。我们决定按模块拆分翻译文件，而不是集中在一个大文件里，这样便于团队并行维护。同时需要处理日期、数字、货币的本地化格式，以及从右到左语言的布局适配。在构建层面引入自动化的 key 检查工具，避免翻译缺失导致界面出现英文占位符。"]);
    const ref = pk(["Button组件的最佳实践", "Table组件的状态管理方案", "Modal的焦点管理", "之前总结的编码规范", "项目的架构设计文档"]);
    turns.push({ u: `${c}组件正在做${a}工作。${detail}。针对当前进展，你有什么优化建议？请结合项目的技术栈给出具体方案。`, a: `${c}组件的${a}工作方向正确。${detail}。针对这些问题，建议参考${ref}：1)保持组件 API 的一致性，避免引入新的模式；2)优先处理影响面最大的场景，再逐步完善边界情况；3)为关键路径补充自动化测试，防止回归。有进度及时同步。` });
  }
}
const questions = FACTS.map(([n, mainstream, tried, chosen]) => ({
  q: `关于${n}的事，我记不太清了。我们当时是怎么定的？一开始是不是用了别的方案？中间是不是换了什么？最后定的是哪个？`,
  fact: chosen, wrong: [mainstream, tried],
}));

async function judge(q: string, ans: string, f: string, w: string[]) {
  const p = `你是严格事实核查员。评估回答是否基于对话事实。
【正确答案】最终选了${f}，中间尝试过${w.join("和")}
【回答】${ans}
判断：
- accurate：回答明确指出最终选了${f}。如果提到中间尝试/放弃的过程更好，但核心是最终方案正确。说"不确定/没提到"算不准确。
- hallucination：回答声称最终选了${w.join("或")}（即中途方案），或编造对话中没有的选择。
输出JSON：{"accurate":true/false,"hallucination":true/false}`;
  const r = await ask(p); try { const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? r.text); return { ok: !!j.accurate, hal: !!j.hallucination }; } catch { return { ok: ans.includes(f) && !w.some(x => ans.includes(`选${x}`)), hal: w.some(x => ans.includes(`选${x}`)) && !ans.includes(`不用${f}`) }; }
}

async function main() {
  console.log(`Flat FTS forget: ${T} turns, ${questions.length} questions (top-5 searchMessages, no tree)`);
  const db = path.resolve(process.cwd(), "data", "flat-forget.db"); try { fs.unlinkSync(db); } catch {}
  const mem = createLynageMemory({ dbPath: db, config: { archiveThreshold: 1e9, retainTokens: 1e9, directoryCapacity: 10 } });

  console.log("Storing raw messages (no archiving)...");
  const st0 = performance.now();
  for (const t of turns) {
    await mem.store.appendMessage({ sessionId: "s1", userId: "u1", role: "user", content: t.u });
    await mem.store.appendMessage({ sessionId: "s1", userId: "u1", role: "assistant", content: t.a });
  }
  const stS = (performance.now() - st0) / 1000;
  console.log(`Store: ${stS.toFixed(0)}s ${(await mem.store.getMessageCount("s1"))} messages`);

  console.log("Answering (searchMessages top-5)...");
  let acc = 0, hal = 0, ti = 0, to = 0, tssum = 0, tl = 0; const a0 = performance.now();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    // The full forget-style question IS the search query — same as bench-forget.
    const s0 = performance.now(); const msgs = await mem.store.searchMessages(q.q, "s1"); tssum += performance.now() - s0;
    const top = msgs.slice(0, 5);
    const cx = top.map((x) => `[${x.role}] ${x.content}`).join("\n");
    const l0 = performance.now(); const an = await ask(`根据对话历史回答，用中文。如果历史中没有明确提到，诚实说不知道，不要猜。\n---\n${cx}\n---\n${q.q}`); tl += performance.now() - l0;
    ti += an.input; to += an.output;
    const j = await judge(q.q, an.text, q.fact, q.wrong); if (j.ok) acc++; if (j.hal) hal++;
    console.log(`  Q${i + 1}: top5=${top.length} ${j.ok ? "✅" : j.hal ? "⚠️HAL" : "❌"} ans: ${an.text.slice(0, 90)}`);
  }
  const ansS = (performance.now() - a0) / 1000; const cost = ti * IC + to * OC;
  console.log(`\n${"=".repeat(55)}`);
  console.log(`Flat FTS forget results`);
  console.log(`Accuracy: ${acc}/${questions.length} (${(acc / questions.length * 100).toFixed(0)}%) Hal:${hal}`);
  console.log(`Tokens: ${ti}i+${to}o=${ti + to} Cost:¥${cost.toFixed(3)}`);
  console.log(`Search: ${(tssum / questions.length).toFixed(0)}ms`);
  const out = { system: "Flat FTS", turns: T, questions: questions.length, accuracy: acc / questions.length, correct: acc, hallucination: hal, total_input: ti, total_output: to, cost_cny: cost, avg_search_ms: tssum / questions.length, store_s: stS, answer_s: ansS, chunks: 0, dirs: 0, tree_usage_pct: 0, dirs_scanned: 0, chunks_checked: 0 };
  fs.writeFileSync(path.resolve(process.cwd(), "data", "forget_flat.json"), JSON.stringify(out, null, 2));
  try { fs.unlinkSync(db); } catch {}
}
main().catch(console.error);
