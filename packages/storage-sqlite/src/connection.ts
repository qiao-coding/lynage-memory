// ---------------------------------------------------------------------------
// Database connection factory
// Creates a better-sqlite3-backed Drizzle instance with WAL mode + FTS5.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const dbCache = new Map<string, { db: BetterSQLite3Database<typeof schema>; raw: Database.Database }>();

/**
 * Create or open a Lynage SQLite database.
 * Enables WAL mode. Call ensureTables() after to create tables + FTS.
 * Caches by dbPath — calling twice with the same path returns the same instance.
 */
export function createDatabase(
  dbPath: string,
): { db: BetterSQLite3Database<typeof schema>; raw: Database.Database } {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  const rawDb = new Database(dbPath);
  rawDb.pragma("journal_mode = WAL");
  rawDb.pragma("busy_timeout = 5000");
  rawDb.pragma("foreign_keys = ON");

  const db = drizzle(rawDb, { schema });
  const result = { db, raw: rawDb };
  dbCache.set(dbPath, result);

  return result;
}

/**
 * Ensure all tables exist and FTS5 is set up.
 * Call once after createDatabase(). Idempotent.
 */
export function ensureTables(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_call_id TEXT,
      tool_name TEXT,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_range_start INTEGER NOT NULL,
      time_range_end INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      progress TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '[]',
      source_from_id TEXT NOT NULL,
      source_to_id TEXT NOT NULL,
      directory_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS directories (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_id TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      time_range_start INTEGER NOT NULL,
      time_range_end INTEGER NOT NULL,
      overall_content TEXT NOT NULL DEFAULT '',
      progress TEXT NOT NULL DEFAULT '',
      main_conclusions TEXT NOT NULL DEFAULT '[]',
      important_changes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS directory_children (
      id TEXT PRIMARY KEY,
      directory_id TEXT NOT NULL,
      child_type TEXT NOT NULL,
      child_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS working_memory (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      current_task TEXT,
      confirmed TEXT NOT NULL DEFAULT '[]',
      progress TEXT NOT NULL DEFAULT '[]',
      unresolved TEXT NOT NULL DEFAULT '[]',
      recent_changes TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      preferences TEXT NOT NULL DEFAULT '[]',
      long_term_goals TEXT NOT NULL DEFAULT '[]',
      constraints TEXT NOT NULL DEFAULT '[]',
      background TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      query TEXT NOT NULL,
      understanding TEXT,
      strategy TEXT,
      checked_directories TEXT NOT NULL DEFAULT '[]',
      candidates TEXT NOT NULL DEFAULT '[]',
      next_batch TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Indexes for hot query columns
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_session ON context_chunks(session_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_directory ON context_chunks(directory_id);
    CREATE INDEX IF NOT EXISTS idx_dir_children_dir ON directory_children(directory_id);
    CREATE INDEX IF NOT EXISTS idx_directories_parent ON directories(parent_id);
    CREATE INDEX IF NOT EXISTS idx_directories_session ON directories(session_id);
  `);

  // FTS5: full-text search on messages.content
  setupFts(raw);
}

/**
 * Create FTS5 virtual table and sync triggers.
 */
function setupFts(raw: Database.Database): void {
  // Use trigram tokenizer for CJK + Latin support.
  // unicode61 tokenizer does not index CJK on some SQLite builds (Windows).
  // trigram splits into overlapping 3-char sequences, working for all languages.
  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content_rowid='rowid',
      tokenize='trigram'
    );
  `);

  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
  `);

  raw.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
}

/**
 * Close all database connections.
 */
export function closeDatabase(dbPath?: string): void {
  if (dbPath) {
    const cached = dbCache.get(dbPath);
    if (cached) {
      cached.raw.close();
      dbCache.delete(dbPath);
    }
  } else {
    for (const [, entry] of dbCache) {
      entry.raw.close();
    }
    dbCache.clear();
  }
}
