// ---------------------------------------------------------------------------
// @lynage/mcp — MCP Server for Lynage Memory
//
// Provides lynage_memory_* tools via the Model Context Protocol.
// Usage:
//   npx lynage-memory serve --db ./data/lynage.db --port 4318
//   npx lynage-memory mcp
// ---------------------------------------------------------------------------

import { LynageMemory } from "@lynage/core";
import { createDatabase, SqliteStore } from "@lynage/storage-sqlite";
import type { LynageModel } from "@lynage/core";
import { createLynageMcpTools } from "./tools.js";

export interface McpServerOptions {
  dbPath: string;
  model: LynageModel;
  config?: {
    archiveThreshold?: number;
    retainTokens?: number;
    directoryCapacity?: number;
  };
}

/**
 * Create a Lynage Memory MCP server-ready instance with all tools.
 * The caller is responsible for connecting this to an MCP transport.
 */
export function createLynageMcpServer(options: McpServerOptions) {
  const { db, raw } = createDatabase(options.dbPath);
  const store = new SqliteStore(db, raw);

  const memory = new LynageMemory({
    store,
    model: options.model,
    config: options.config,
  });

  const tools = createLynageMcpTools(memory);

  return { memory, tools };
}

// Re-export for convenience
export { createLynageMcpTools } from "./tools.js";
