// Fix message timestamps for temporal reasoning.
// Run AFTER setup.ts completes — Lynage must release the DB lock.
// Usage: pnpm tsx benchmarks/longmemeval/fix-timestamps.ts

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname || __dirname, "..", "data");
const RESULTS_DIR = path.resolve(import.meta.dirname || __dirname, "results");
const DATASET_PATH = path.join(DATA_DIR, "longmemeval_s.json");
const STATE_PATH = path.join(RESULTS_DIR, ".lynage-setup-state.json");

if (!fs.existsSync(STATE_PATH)) {
  console.error("❌ Setup not run. Run: pnpm tsx benchmarks/longmemeval/setup.ts");
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));

// Build session_id → date mapping from dataset
const firstInst = dataset[0];
const sessionDates: Record<string, string> = {};
for (let i = 0; i < firstInst.haystack_session_ids.length; i++) {
  sessionDates[firstInst.haystack_session_ids[i]] = firstInst.haystack_dates[i];
}

// Count messages per session
const sessionMsgCounts = firstInst.haystack_sessions.map((s: any[]) => s.length);

console.log("Fixing timestamps...");
const db = new Database(state.dbPath);

// FTS sync triggers on messages block UPDATE. Drop them temporarily,
// do the timestamp updates, then we don't need them (eval is read-only).
db.exec("DROP TRIGGER IF EXISTS messages_fts_update");
db.exec("DROP TRIGGER IF EXISTS messages_fts_insert");
db.exec("DROP TRIGGER IF EXISTS messages_fts_delete");

// List messages in insertion order
const rows = db.prepare(
  `SELECT id FROM messages WHERE session_id = ? ORDER BY created_at`
).all(state.sessionId) as Array<{ id: string }>;

console.log(`  Messages: ${rows.length}, Sessions: ${sessionMsgCounts.length}`);

let offset = 0;
for (let si = 0; si < sessionMsgCounts.length; si++) {
  const date = sessionDates[firstInst.haystack_session_ids[si]] || "2024-06-10";
  const ts = new Date(date).getTime();
  const count = sessionMsgCounts[si];
  const batch = rows.slice(offset, offset + count);
  for (const r of batch) {
    db.exec(`UPDATE messages SET created_at = ${ts} WHERE id = '${r.id}'`);
  }
  offset += count;
  console.log(`  Session ${si}: ${batch.length} msgs → ${date}`);
}

db.close();
console.log(`✅ Done: ${rows.length} messages across ${sessionMsgCounts.length} sessions`);
