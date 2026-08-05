// @lynage/storage-sqlite — SQLite + Drizzle ORM implementation

import { LynageMemory, type LynageModel, type LynageConfig, type Embedder } from "@lynage/core";
import { createDatabase, ensureTables } from "./connection.js";
import { SqliteStore } from "./store.js";

export { createDatabase, ensureTables, closeDatabase } from "./connection.js";
export { SqliteStore } from "./store.js";
export * as schema from "./schema.js";

// ---- Quick-start factory ----

export interface CreateLynageMemoryOptions {
  /** LLM instance (implement LynageModel from @lynage/core) */
  model?: LynageModel;
  /** Path to SQLite database file (default: ./data/lynage.db) */
  dbPath?: string;
  /** Optional config overrides */
  config?: Partial<LynageConfig>;
  /** Semantic search embedder (Phase 2). Defaults to FTS-only. */
  embedder?: Embedder;
}

/**
 * One-line setup with sensible defaults.
 *
 * ```ts
 * import { createLynageMemory } from "@lynage/storage-sqlite";
 * const memory = createLynageMemory();
 * // → SQLite at ./data/lynage.db, tables auto-created, WAL + FTS5 enabled
 * ```
 *
 * Add a model to enable AI-powered archiving and search:
 * ```ts
 * import { AiSdkModel } from "@lynage/ai-sdk";
 * const memory = createLynageMemory({ model: new AiSdkModel(yourLLM) });
 * ```
 */
export function createLynageMemory(options: CreateLynageMemoryOptions = {}): LynageMemory {
  const dbPath = options.dbPath ?? "./data/lynage.db";

  const { db, raw } = createDatabase(dbPath);
  ensureTables(raw);
  const store = new SqliteStore(db, raw);

  return new LynageMemory({
    store,
    model: options.model ?? ({} as LynageModel),
    config: options.config,
    embedder: options.embedder,
  });
}
