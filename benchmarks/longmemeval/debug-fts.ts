// Quick FTS debug: what does searchChunks actually return?
import Database from "better-sqlite3";
import fs from "node:fs";

const state = JSON.parse(fs.readFileSync(
  "D:/coding/lynage-memory/benchmarks/longmemeval/results/.lynage-setup-state.json", "utf-8"
));
const db = new Database(state.dbPath, { readonly: true });

// Check if chunks_fts exists
const ftsTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'").all() as any[];
console.log("FTS tables:", ftsTables.map((t:any) => t.name));

// Check what chunks_fts actually indexes
if (ftsTables.some((t:any) => t.name === 'chunks_fts')) {
  console.log("\n=== chunks_fts schema ===");
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='chunks_fts'").get() as any;
  console.log(schema?.sql?.slice(0, 500));

  // Try searching for "deployment"
  console.log("\n=== chunks_fts search: 'deployment' ===");
  try {
    const results = db.prepare("SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH 'deployment' ORDER BY rank LIMIT 10").all() as any[];
    console.log("Results:", results.length);
    for (const r of results) {
      // Get the actual chunk
      const chunk = db.prepare("SELECT id, substr(summary,1,80) as s FROM context_chunks WHERE rowid = ?").get(r.rowid) as any;
      console.log(`  rowid=${r.rowid} rank=${r.rank?.toFixed(2)} id=${chunk?.id?.slice(0,8)} summary="${chunk?.s}"`);
    }
  } catch(e: any) {
    console.log("Error:", e.message);
  }

  // Try searching for "programming"
  console.log("\n=== chunks_fts search: 'programming' ===");
  try {
    const results = db.prepare("SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH 'programming' ORDER BY rank LIMIT 10").all() as any[];
    console.log("Results:", results.length);
    for (const r of results) {
      const chunk = db.prepare("SELECT id, substr(summary,1,80) as s FROM context_chunks WHERE rowid = ?").get(r.rowid) as any;
      console.log(`  rowid=${r.rowid} rank=${r.rank?.toFixed(2)} id=${chunk?.id?.slice(0,8)} summary="${chunk?.s}"`);
    }
  } catch(e: any) {
    console.log("Error:", e.message);
  }
}

// Also check messages_fts
console.log("\n=== messages_fts search: 'deployment' ===");
try {
  const results = db.prepare("SELECT rowid, rank FROM messages_fts WHERE messages_fts MATCH 'deployment' ORDER BY rank LIMIT 10").all() as any[];
  console.log("Results:", results.length);
  for (const r of results) {
    const msg = db.prepare("SELECT substr(content,1,80) as c FROM messages WHERE rowid = ?").get(r.rowid) as any;
    console.log(`  rowid=${r.rowid} rank=${r.rank?.toFixed(2)} msg="${msg?.c}"`);
  }
} catch(e: any) {
  console.log("Error:", e.message);
}

db.close();
