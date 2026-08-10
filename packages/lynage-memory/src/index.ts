// ---------------------------------------------------------------------------
// lynage-memory — single-package entry point
// Bundles @lynage/core + @lynage/storage-sqlite + @lynage/ai-sdk + @lynage/mcp
// so `pnpm add lynage-memory` covers the whole library.
// ---------------------------------------------------------------------------

// Core: types, classes, embedders, helpers
export * from "@lynage/core";

// Storage + one-line factory
export {
  createLynageMemory,
  createDatabase,
  ensureTables,
  closeDatabase,
  SqliteStore,
  schema,
} from "@lynage/storage-sqlite";
export type { CreateLynageMemoryOptions } from "@lynage/storage-sqlite";

// Vercel AI SDK adapter
export { LynageSdkModel, lynageStreamText } from "@lynage/ai-sdk";
export type { LynageSdkModelOptions, LynageStreamTextOptions } from "@lynage/ai-sdk";

// MCP server
export { createLynageMcpServer, createLynageMcpTools } from "@lynage/mcp";
export type { McpServerOptions } from "@lynage/mcp";
