// ---------------------------------------------------------------------------
// Deep diagnostic: why does Lynage miss "TypeScript" for "favorite language"?
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = "D:/coding/lynage-memory";

// Load env
const envPath = path.resolve(PROJECT_ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("="); if (idx < 0) continue;
    if (!process.env[t.slice(0,idx).trim()]) process.env[t.slice(0,idx).trim()] = t.slice(idx+1).trim();
  }
}

const state = JSON.parse(fs.readFileSync(
  "D:/coding/lynage-memory/benchmarks/longmemeval/results/.lynage-setup-state.json", "utf-8"
));

// --- Part 1: DB direct inspection ---
console.log("=".repeat(60));
console.log("PART 1: Raw DB contents");
console.log("=".repeat(60));

const db = new Database(state.dbPath, { readonly: true });

// Show table schemas first
console.log("\n--- Table schemas ---");
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all() as any[];
for (const t of tables) {
  console.log(`  ${t.name}: ${t.sql?.slice(0, 200)}`);
}

// Show all messages
console.log("\n--- All Messages ---");
const msgCols = db.prepare("PRAGMA table_info(messages)").all() as any[];
console.log("  columns:", msgCols.map((c:any) => c.name).join(", "));
const msgs = db.prepare("SELECT * FROM messages LIMIT 24").all() as any[];
for (const m of msgs) {
  const content = typeof m.content === 'string' ? m.content.slice(0,100) : JSON.stringify(m).slice(0,100);
  const role = m.role || '?';
  console.log(`  [${role}] ${content}`);
}

// Show all chunks
console.log("\n--- All Chunks ---");
const chunkCols = db.prepare("PRAGMA table_info(context_chunks)").all() as any[];
console.log("  columns:", chunkCols.map((c:any) => c.name).join(", "));
const chunks = db.prepare("SELECT * FROM context_chunks").all() as any[];
for (const c of chunks) {
  console.log(`\n  Chunk ${c.id?.slice(0,8)}:`);
  console.log(`    summary: ${c.summary}`);
  console.log(`    keywords: ${JSON.stringify(c.keywords)}`);
  console.log(`    conclusions: ${JSON.stringify(c.conclusions)}`);
  console.log(`    source: ${c.sourceFromId?.slice(0,8)}..${c.sourceToId?.slice(0,8)}`);
}

// Find which chunk contains the "TypeScript" message
console.log("\n--- Which chunk has 'TypeScript' message? ---");
for (const c of chunks) {
  const chunkMsgs = db.prepare(
    "SELECT role, substr(content,1,80) as content FROM messages WHERE id >= ? AND id <= ?"
  ).all(c.sourceFromId, c.sourceToId) as any[];
  const hasTypeScript = chunkMsgs.some((m: any) => m.content.toLowerCase().includes("typescript"));
  if (hasTypeScript) {
    console.log(`  ✅ Chunk ${c.id?.slice(0,8)} has TypeScript!`);
    console.log(`     summary: ${c.summary}`);
    console.log(`     keywords: ${JSON.stringify(c.keywords)}`);
  }
}

// --- Part 2: FTS search test ---
console.log("\n" + "=".repeat(60));
console.log("PART 2: FTS raw search (no AI, pure trigram)");
console.log("=".repeat(60));

// Direct FTS on messages
const ftsQueries = [
  "favorite programming language",
  "TypeScript",
  "deployment platform",
  "Vercel Docker",
];

for (const q of ftsQueries) {
  console.log(`\n--- FTS query: "${q}" ---`);
  try {
    const ftsResults = db.prepare(
      `SELECT content, rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT 5`
    ).all(q) as any[];
    for (const r of ftsResults) {
      console.log(`  rank=${r.rank?.toFixed(2)}: ${r.content?.slice(0, 80)}`);
    }
    if (ftsResults.length === 0) console.log("  (no results)");
  } catch(e: any) {
    console.log(`  FTS error: ${e.message}`);
  }
}

// Also search chunks_fts
console.log("\n--- Chunks FTS ---");
for (const q of ftsQueries) {
  console.log(`\n  Query: "${q}"`);
  try {
    const ftsResults = db.prepare(
      `SELECT summary, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 3`
    ).all(q) as any[];
    for (const r of ftsResults) {
      console.log(`    rank=${r.rank?.toFixed(2)}: ${r.summary?.slice(0, 80)}`);
    }
    if (ftsResults.length === 0) console.log("    (no results)");
  } catch(e: any) {
    console.log(`    FTS error: ${e.message}`);
  }
}

// --- Part 3: Lynage search API test ---
console.log("\n" + "=".repeat(60));
console.log("PART 3: Lynage search() API");
console.log("=".repeat(60));

const deepseek = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" });
const model = deepseek("deepseek-v4-flash");
const memory = createLynageMemory({
  model: new AiSdkModel(model, undefined, { useToolChoice: false }),
  dbPath: state.dbPath,
});

const testQueries = [
  "What is the user's favorite programming language?",
  "Which deployment platform did the user choose?",
];

for (const q of testQueries) {
  console.log(`\n--- search("${q.slice(0,60)}") ---`);
  const sr = await memory.search({ query: q, sessionId: state.sessionId });
  console.log(`  status: ${sr.status}`);
  console.log(`  candidates: ${sr.candidates.length}`);
  console.log(`  searchedDirectories: ${sr.searchedDirectories}`);
  console.log(`  totalChunksChecked: ${sr.totalChunksChecked}`);
  console.log(`  suggestion: ${sr.suggestion || "(none)"}`);

  for (let i = 0; i < Math.min(sr.candidates.length, 3); i++) {
    const c = sr.candidates[i]!;
    console.log(`  [${i}] relevance=${c.relevance} summary="${c.summary?.slice(0, 80)}"`);
    const open = await memory.openSource(c.contextId);
    if (open) {
      for (const m of open.messages) {
        console.log(`      [${m.role}] ${m.content.slice(0, 100)}`);
      }
    }
  }
}

db.close();
console.log("\n✅ Diagnostic complete");
