// ---------------------------------------------------------------------------
// LongMemEval Setup: Pre-ingest all haystack_sessions into Lynage
//
// Reads longmemeval_s.json, feeds every turn through Lynage, waits for
// archiving, saves the DB for later eval runs.
//
// Usage: pnpm tsx benchmarks/longmemeval/setup.ts
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs";
import path from "node:path";

// ---- Config ----
const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..", "..");
const DATA_DIR = path.resolve(import.meta.dirname || __dirname, "..", "data");
const RESULTS_DIR = path.resolve(import.meta.dirname || __dirname, "results");
const DATASET_PATH = path.join(DATA_DIR, "longmemeval_s_cleaned.json");
const DB_PATH = path.join(DATA_DIR, "longmemeval-setup.db");
const STATE_PATH = path.join(RESULTS_DIR, ".lynage-setup-state.json");

// ---- Load env ----
const envPath = path.resolve(PROJECT_ROOT, ".env");
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
if (!API_KEY) {
  console.error("❌ DEEPSEEK_API_KEY not set.");
  process.exit(1);
}

// ---- Types ----
interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: SessionTurn[][];
  answer_session_ids: string[];
}

// ---- Main ----
async function main() {
  console.log("🔧 LongMemEval Setup: Pre-ingesting into Lynage\n");

  // Check dataset
  if (!fs.existsSync(DATASET_PATH)) {
    console.error(`❌ Dataset not found: ${DATASET_PATH}`);
    console.error("   Run: pnpm tsx benchmarks/data/fetch-datasets.ts");
    process.exit(1);
  }

  // Load dataset
  const raw = fs.readFileSync(DATASET_PATH, "utf-8");
  const dataset: LongMemEvalInstance[] = JSON.parse(raw);
  console.log(`📄 Loaded ${dataset.length} instances from longmemeval_s.json`);

  // Collect all unique sessions (haystack_sessions are shared across instances)
  const sessionMap = new Map<string, SessionTurn[]>();
  for (const inst of dataset) {
    for (let i = 0; i < inst.haystack_session_ids.length; i++) {
      const sid = inst.haystack_session_ids[i]!;
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, inst.haystack_sessions[i]!);
      }
    }
  }
  console.log(`📊 ${sessionMap.size} unique sessions, sorted by date\n`);

  // Sort sessions by their index in the first instance (chronological)
  const firstInst = dataset[0]!;
  const sortedSessions = firstInst.haystack_session_ids
    .map((sid, i) => ({ id: sid, turns: sessionMap.get(sid)! }))
    .filter(s => s.turns);

  // Clean old DB
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + "-shm"); } catch {}
  try { fs.unlinkSync(DB_PATH + "-wal"); } catch {}

  // Create Lynage
  const deepseek = createOpenAI({ apiKey: API_KEY, baseURL: "https://api.deepseek.com/v1" });
  const model = deepseek("deepseek-v4-flash");
  const memory = createLynageMemory({
    model: new AiSdkModel(model, undefined, { useToolChoice: false }),
    dbPath: DB_PATH,
    config: {
      archiveThreshold: 6000,
      retainTokens: 4000,
      directoryCapacity: 10,
    },
  });

  const SESSION_ID = "longmemeval-s1";
  const USER_ID = "eval-user";

  // Feed all sessions as proper USER-ASSISTANT turn pairs
  const startTime = performance.now();
  let totalTurns = 0;
  for (const session of sortedSessions) {
    const turns = session.turns;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      if (turn.role === "user") {
        totalTurns++;
        const assistantTurn = turns[i + 1];
        const turnHandle = await memory.startTurn(SESSION_ID, USER_ID, turn.content);
        if (assistantTurn && assistantTurn.role === "assistant") {
          await turnHandle.finish({ response: assistantTurn.content });
          i++; // skip assistant turn (consumed)
        } else {
          await turnHandle.finish({ response: "(no response)" });
        }
      }
    }
  }

  // Wait for archiving to complete
  console.log(`  Fed ${totalTurns} turns, waiting for archiving...`);
  await memory.waitForArchiving(SESSION_ID);

  // Assert tree built
  const stats = await memory.getArchiveStats(SESSION_ID);
  const tree = await memory.getDirectoryTree(SESSION_ID);
  let maxGen = 0;
  (function walk(nodes: any[], d: number) {
    for (const n of nodes) {
      if (d > maxGen) maxGen = d;
      if (n.children?.length) walk(n.children, d + 1);
    }
  })(tree, 0);

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(0);
  console.log(`✅ Setup complete in ${elapsed}s`);
  console.log(`   Messages: ${stats.messageCount} | Chunks: ${stats.chunkCount} | Dirs: ${stats.directoryCount} | Depth: ${maxGen}`);

  if (stats.chunkCount < 1) {
    console.error("❌ No chunks created — archiving may have failed.");
    process.exit(1);
  }

  // Save state for eval script
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    dbPath: DB_PATH,
    sessionId: SESSION_ID,
    userId: USER_ID,
    sessionCount: sortedSessions.length,
    totalTurns,
    chunks: stats.chunkCount,
    dirs: stats.directoryCount,
    treeDepth: maxGen,
    setupTimeS: Number(elapsed),
  }, null, 2));

  console.log(`   State saved: ${STATE_PATH}`);
}

main().catch((err) => {
  console.error("❌ Setup failed:", err);
  process.exit(1);
});
