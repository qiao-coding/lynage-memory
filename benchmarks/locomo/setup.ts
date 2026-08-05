// ---------------------------------------------------------------------------
// LoCoMo Setup: Pre-ingest LoCoMo conversations into Lynage
//
// Each of the 10 conversations is ingested into its own Lynage DB.
// Saves state for eval script.
//
// Usage: pnpm tsx benchmarks/locomo/setup.ts [--conversation N]
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { LynageSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..", "..");
const DATA_DIR = path.resolve(import.meta.dirname || __dirname, "..", "data");
const RESULTS_DIR = path.resolve(import.meta.dirname || __dirname, "results");
const DATASET_PATH = path.join(DATA_DIR, "locomo10.json");
const STATE_DIR = path.join(RESULTS_DIR);

// Load env
const envPath = path.resolve(PROJECT_ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx < 0) continue;
    if (!process.env[t.slice(0, idx).trim()]) process.env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("❌ DEEPSEEK_API_KEY not set.");
  process.exit(1);
}

// Types
interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  img_url?: string;
  blip_caption?: string;
  search_query?: string;
}

interface LoCoMoConversation {
  conversation: Record<string, LoCoMoTurn[]>;
  speaker_a: string;
  speaker_b: string;
  qa: Array<{
    question: string;
    answer: string;
    category: string;
    evidence: string[];
  }>;
  event_summary?: any;
  observation?: any;
  session_summary?: any;
}

interface LoCoMoDataset {
  [key: string]: LoCoMoConversation;
}

async function ingestConversation(
  convKey: string,
  conv: LoCoMoConversation,
  model: any,
  targetConversation?: number,
) {
  // Filter to specific conversation if requested
  const convNum = parseInt(convKey.replace("conv_", ""));
  if (targetConversation !== undefined && convNum !== targetConversation) return null;

  console.log(`\n📥 Ingesting ${convKey}...`);

  const DB_PATH = path.join(DATA_DIR, `locomo-${convKey}.db`);
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + "-shm"); } catch {}
  try { fs.unlinkSync(DB_PATH + "-wal"); } catch {}

  const memory = createLynageMemory({
    model: new LynageSdkModel(model, undefined, { useToolChoice: false }),
    dbPath: DB_PATH,
    config: { archiveThreshold: 600, retainTokens: 250, directoryCapacity: 5 },
  });

  const SESSION_ID = `locomo-${convKey}`;
  const USER_ID = "eval-user";

  // Extract session keys sorted by number
  const sessionKeys = Object.keys(conv.conversation)
    .filter(k => k.startsWith("session_"))
    .sort((a, b) => {
      const na = parseInt(a.replace("session_", ""));
      const nb = parseInt(b.replace("session_", ""));
      return na - nb;
    });

  console.log(`  ${sessionKeys.length} sessions, ${conv.qa.length} QA pairs`);

  let totalTurns = 0;
  const startTime = performance.now();

  for (const sk of sessionKeys) {
    const turns = conv.conversation[sk]!;
    // Turns alternate between speaker_a and speaker_b
    // Map: speaker_a → assistant, speaker_b → user
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const isUser = turn.speaker === conv.speaker_b; // speaker_b = user
      const content = turn.img_url
        ? `${turn.text} [Image: ${turn.blip_caption || turn.search_query || ""}]`
        : turn.text;

      if (isUser && i + 1 < turns.length && turns[i + 1]!.speaker === conv.speaker_a) {
        // User turn followed by assistant turn
        totalTurns++;
        const nextTurn = turns[i + 1]!;
        const handle = await memory.startTurn(SESSION_ID, USER_ID, content);
        const nextContent = nextTurn.img_url
          ? `${nextTurn.text} [Image: ${nextTurn.blip_caption || nextTurn.search_query || ""}]`
          : nextTurn.text;
        await handle.finish({ response: nextContent });
        i++; // consumed assistant turn
      }
    }
  }

  await memory.waitForArchiving(SESSION_ID);

  const stats = await memory.getArchiveStats(SESSION_ID);
  const tree = await memory.getDirectoryTree(SESSION_ID);
  let maxGen = 0;
  (function walk(nodes: any[], d: number) {
    for (const n of nodes) { if (d > maxGen) maxGen = d; if (n.children?.length) walk(n.children, d + 1); }
  })(tree, 0);

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(0);
  console.log(`  ✅ ${elapsed}s | ${stats.messageCount} msgs | ${stats.chunkCount} chunks | ${stats.directoryCount} dirs | depth ${maxGen}`);

  return {
    dbPath: DB_PATH,
    sessionId: SESSION_ID,
    userId: USER_ID,
    stats: { messages: stats.messageCount, chunks: stats.chunkCount, dirs: stats.directoryCount, depth: maxGen },
    qa: conv.qa,
    speakerA: conv.speaker_a,
    speakerB: conv.speaker_b,
  };
}

async function main() {
  console.log("🔧 LoCoMo Setup: Pre-ingesting conversations into Lynage\n");

  if (!fs.existsSync(DATASET_PATH)) {
    console.error(`❌ Dataset not found: ${DATASET_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(DATASET_PATH, "utf-8");
  const dataset: LoCoMoDataset = JSON.parse(raw);
  const convKeys = Object.keys(dataset).filter(k => k.startsWith("conv_"));
  console.log(`📄 ${convKeys.length} conversations in locomo10.json`);

  const targetConv = process.argv.includes("--conversation")
    ? parseInt(process.argv[process.argv.indexOf("--conversation") + 1]!)
    : undefined;

  const deepseek = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" });
  const model = deepseek("deepseek-v4-flash");

  const states: any[] = [];
  for (const ck of convKeys) {
    const state = await ingestConversation(ck, dataset[ck]!, model, targetConv);
    if (state) states.push(state);
  }

  // Save state
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const statePath = path.join(STATE_DIR, ".locomo-setup-state.json");
  fs.writeFileSync(statePath, JSON.stringify(states, null, 2));

  console.log(`\n✅ All done. ${states.length} conversations ingested.`);
  console.log(`   State: ${statePath}`);
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
