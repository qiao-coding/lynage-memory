// ---------------------------------------------------------------------------
// Database connection factory
// Creates a better-sqlite3-backed Drizzle instance with WAL mode + FTS5.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

let dbInstance: BetterSQLite3Database<typeof schema> | null = null;
let rawDb: Database.Database | null = null;

/**
 * Create or open a Lynage SQLite database.
 * Enables WAL mode and creates FTS5 index if not present.
 * Returns a singleton per process (by dbPath).
 */
export function createDatabase(
  dbPath: string,
): { db: BetterSQLite3Database<typeof schema>; raw: Database.Database } {
  // If reconnecting to the same path, reuse the instance
  if (dbInstance && rawDb) {
    return { db: dbInstance, raw: rawDb };
  }

  rawDb = new Database(dbPath);

  // Performance: enable WAL mode
  rawDb.pragma("journal_mode = WAL");
  rawDb.pragma("busy_timeout = 5000");
  rawDb.pragma("foreign_keys = ON");

  // FTS5 for full-text search on message content
  setupFts(rawDb);

  dbInstance = drizzle(rawDb, { schema });

  return { db: dbInstance, raw: rawDb };
}

/**
 * Ensure the messages_fts virtual table exists and is kept in sync.
 */
function setupFts(raw: Database.Database): void {
  // Create FTS5 virtual table (if not exists)
  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content_rowid='rowid'
    );
  `);

  // Trigger: after INSERT on messages → insert into FTS
  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  // Trigger: after DELETE on messages → delete from FTS
  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
  `);

  // Trigger: after UPDATE on messages → update FTS
  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
}

/**
 * Close the database connection.
 */
export function closeDatabase(): void {
  if (rawDb) {
    rawDb.close();
    rawDb = null;
    dbInstance = null;
  }
}
