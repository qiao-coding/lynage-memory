// Repro chunks_fts trigger failure
import { createDatabase, ensureTables, closeDatabase } from "@lynage/storage-sqlite";
import fs from "node:fs"; import path from "node:path";
const dbPath = path.resolve(process.cwd(), "data", "fts-repro.db");
try { fs.unlinkSync(dbPath); } catch {}
const { raw, db } = createDatabase(dbPath);
ensureTables(raw);
try {
  // insert chunk (fires chunks_fts_insert)
  const ins = raw.prepare(`INSERT INTO context_chunks (id, session_id, time_range_start, time_range_end, summary, progress, keywords, conclusions, goals, source_from_id, source_to_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run("c1","s1",1,2,"数据库决策", "选了MongoDB","[\"数据库\"]","[\"最终决定用 MongoDB\"]","[\"选型\"]","m1","m2",100);
  console.log("INSERT ok");
  // update (fires chunks_fts_update: delete+insert)
  raw.prepare(`UPDATE context_chunks SET summary=? WHERE id=?`).run("数据库决策 v2","c1");
  console.log("UPDATE ok");
  // query
  const rows = raw.prepare(`SELECT c.id FROM context_chunks c JOIN chunks_fts f ON f.rowid=c.rowid WHERE chunks_fts MATCH ?`).all("数据库");
  console.log("SEARCH ok:", JSON.stringify(rows));
  // delete (fires chunks_fts_delete)
  raw.prepare(`DELETE FROM context_chunks WHERE id=?`).run("c1");
  console.log("DELETE ok");
} catch (e) {
  console.error("FAILED:", (e as Error).message);
}
closeDatabase(dbPath);
