// @lynage/storage-sqlite — SQLite + Drizzle ORM implementation

import { LynageMemory, type LynageModel, type LynageConfig } from "@lynage/core";
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
}

/**
 * One-line setup. Creates SQLite database, tables, and returns a ready-to-use LynageMemory.
 *
 * ```ts
 * import { createLynageMemory } from "@lynage/storage-sqlite";
 * import { AiSdkModel } from "@lynage/ai-sdk";
 *
 * const memory = createLynageMemory({ model: new AiSdkModel(yourLLM) });
 * ```
 *
 * If model is not provided at creation time, you can set it later.
 * Without a model, archiving (AI summary generation) won't work.
 */
export function createLynageMemory(options: CreateLynageMemoryOptions = {}): LynageMemory {
  const dbPath = options.dbPath ?? "./data/lynage.db";

  const { db, raw } = createDatabase(dbPath);
  ensureTables(raw);
  const store = new SqliteStore(db, raw);

  if (!options.model) {
    // Return without model — basic message storage works, archiving won't
    return new LynageMemory({ store, model: {} as LynageModel, config: options.config });
  }

  return new LynageMemory({ store, model: options.model, config: options.config });
}
