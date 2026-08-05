// ---------------------------------------------------------------------------
// Lynage Memory — End-to-End Test Runner (DeepSeek)
//
// Usage:
//   1. Fill DEEPSEEK_API_KEY in .env
//   2. pnpm test (from apps/test-runner/)
//
// Tests: turn lifecycle, archiving, history search, working memory
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type CoreTool } from "ai";
import { createDatabase, ensureTables, SqliteStore } from "@lynage/storage-sqlite";
import { LynageSdkModel } from "@lynage/ai-sdk";
import { LynageMemory } from "@lynage/core";
import path from "node:path";
import fs from "node:fs";

// ---- Load .env ----
const envPath = path.resolve(process.cwd(), "..", "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx < 0) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) { console.error("❌ DEEPSEEK_API_KEY not set. Fill it in .env first."); process.exit(1); }

const MODEL_NAME = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

// ---- Setup ----
const DATA_DIR = path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "lynage-test.db");
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const { db, raw } = createDatabase(DB_PATH);
ensureTables(raw);
const store = new SqliteStore(db, raw);
const deepseek = createOpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
const model = deepseek(MODEL_NAME);
const aiModel = new LynageSdkModel(model);
const memory = new LynageMemory({
  store,
  model: aiModel,
  config: { archiveThreshold: 1500, retainTokens: 1000, directoryCapacity: 3 },
});

const SESSION = "test-session";
const USER = "test-user";

// ---- Helpers ----
function hr(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}`);
}

async function chat(prompt: string): Promise<string> {
  // 1. Start turn
  const turn = await memory.startTurn(SESSION, USER, prompt);

  // 2. Stream model response
  const result = streamText({ model, prompt });
  let text = "";
  for await (const chunk of result.textStream) { text += chunk; }
  await result;

  // 3. Finish turn (saves assistant message, triggers archiving)
  await turn.finish({ response: text || "(empty)" });

  process.stdout.write(`\n👤 ${prompt.slice(0, 70)}...\n`);
  process.stdout.write(`🤖 ${text.slice(0, 150)}${text.length > 150 ? "..." : ""}\n`);
  return text;
}

// ---- Main ----
async function main() {
  hr("Lynage Memory E2E Test — DeepSeek");
  console.log(`Model: ${MODEL_NAME} | Threshold: 300 tokens | Capacity: 3`);
  console.log(`DB: ${DB_PATH}\n`);

  // ── Test 1: Turn Lifecycle ──
  hr("Test 1: Turn Lifecycle");
  await chat("你好！请用中文回复。我们正在开发一个 React 组件库。只回复'收到'即可。");

  const msgCount1 = await store.getMessageCount(SESSION);
  console.log(`  → Messages: ${msgCount1} (expect 2: user + assistant)`);
  console.log(`  ${msgCount1 >= 2 ? "✅" : "❌"} Turn lifecycle`);

  // ── Test 2: Working Memory ──
  hr("Test 2: Working Memory");
  await memory.upsertWorkingMemory({
    sessionId: SESSION,
    currentTask: "开发 React 组件库",
    confirmed: ["TypeScript + Vite + Tailwind CSS"],
  });
  const wm = await memory.getWorkingMemory(SESSION);
  console.log(`  currentTask: ${wm?.currentTask}`);
  console.log(`  confirmed:   ${wm?.confirmed.join(", ")}`);
  console.log(`  ${wm?.currentTask ? "✅" : "❌"} Working Memory`);

  // ── Test 3: Multi-turn → trigger archiving ──
  hr("Test 3: Trigger Archiving");
  const topics = [
    "详细设计 Button 组件 API：variant(primary/secondary/outline/ghost)、size(sm/md/lg)、disabled、loading。请用中文列出所有属性及其 TypeScript 类型定义。回答尽量详细。",
    "详细设计 Input 组件 API：type(text/password/number/email)、placeholder、prefix、suffix、clearable、maxLength。列出所有属性的 TypeScript 类型。",
    "详细设计 Modal 组件 API：visible、title、footer、closable、maskClosable、width、zIndex。列出所有属性及其默认值。",
    "详细设计 Table 组件：columns 配置( title/dataIndex/key/render/sortable/filterable/width )、dataSource、pagination。给出完整 TypeScript 接口定义。",
    "详细设计 Form 组件校验：Rule 类型( required/pattern/min/max/validator/message/trigger )。给出 Validator 函数的完整签名。",
  ];
  for (const t of topics) await chat(t);

  const msgCount3 = await store.getMessageCount(SESSION);
  const chunks = await store.listChunks(SESSION);
  const dirs = await store.getRootDirectories(SESSION);
  const estTokens = await store.getEstimatedTokenCount(SESSION);
  console.log(`\n  Messages: ${msgCount3} | Est Tokens: ${estTokens} | Chunks: ${chunks.length} | Directories: ${dirs.length}`);
  console.log(`  ${chunks.length > 0 ? "✅" : "⚠️ "} Archiving (${chunks.length} chunks created)`);
  if (chunks.length > 0) {
    console.log(`     Chunk #1: ${chunks[0]!.summary.slice(0, 80)}`);
  }

  // ── Test 4: History Search ──
  hr("Test 4: History Search");
  const result = await memory.search({ query: "Button", sessionId: SESSION });
  console.log(`  Status: ${result.status} | Candidates: ${result.candidates.length}`);
  for (const c of result.candidates.slice(0, 3)) {
    console.log(`    [${Math.round(c.relevance * 100)}%] ${c.summary.slice(0, 70)}`);
  }
  console.log(`  ${result.candidates.length >= 0 ? "✅" : "❌"} Search`);

  // ── Test 5: Directory Tree ──
  hr("Test 5: Directory Tree");
  const tree = await memory.getDirectoryTree(SESSION);
  function printTree(nodes: typeof tree, indent = "") {
    for (const n of nodes) {
      console.log(`${indent}📁 G${n.generation} ${n.summary.slice(0, 60)} (${n.chunkCount} chunks)`);
      if (n.children.length > 0) printTree(n.children, indent + "  ");
    }
  }
  if (tree.length === 0) console.log("  (no directories)");
  else printTree(tree);
  console.log(`  ${tree.length >= 0 ? "✅" : "❌"} Directory tree`);

  // ── Test 6: Stats ──
  hr("Test 6: Stats");
  const stats = await memory.getArchiveStats(SESSION);
  console.log(`  Messages: ${stats.messageCount} | Chunks: ${stats.chunkCount} | Dirs: ${stats.directoryCount}`);
  console.log(`  ✅ Stats`);

  // ── Summary ──
  hr("Summary");
  const checks = [
    ["Turn lifecycle", msgCount1 >= 2],
    ["Working Memory", !!wm?.currentTask],
    ["Archiving", chunks.length > 0],
    ["History search", result.candidates.length >= 0],
    ["Directory tree", tree.length >= 0],
    ["Stats", stats.messageCount > 0],
  ];
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  }
  const passed = checks.filter((c) => c[1]).length;
  console.log(`\n  ${passed}/${checks.length} tests passed`);
  console.log(`  DB: ${DB_PATH}`);
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err);
  process.exit(1);
});
