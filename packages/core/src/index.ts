// @lynage/core — Agent memory & context lineage module

// Types
export type {
  Message,
  MessageInput,
  MessageRole,
  ContextChunk,
  DirectoryNode,
  DirectoryChild,
  WorkingMemory,
  SearchTask,
  SearchStatus,
  Scope,
  SourceRange,
  TokenBudget,
  LynageConfig,
} from "./types.js";

export { DEFAULT_CONFIG } from "./types.js";

// Store interface
export type {
  LynageStore,
  CreateChunkInput,
  CreateDirectoryInput,
  WorkingMemoryInput,
  SearchTaskInput,
} from "./store.js";

// Model interface
export type {
  LynageModel,
  ChunkSummaryInput,
  ChunkSummary,
  DirectorySummaryInput,
  DirectorySummary,
  SearchBatchInput,
  SearchBatchResult,
} from "./model.js";

// Schemas & validation
export {
  ChunkSummarySchema,
  DirectorySummarySchema,
  SearchBatchResultSchema,
  MemoryActionSchema,
  MemoryActionsSchema,
  validateChunkSummary,
  validateDirectorySummary,
  validateSearchBatchResult,
  validateMemoryActions,
} from "./schemas.js";

export type { MemoryAction, MemoryActionTarget, MemoryActionOperation } from "./schemas.js";

// Token counter
export {
  estimateTokenCount,
  estimateMessagesTokenCount,
  formatTokens,
} from "./token-counter.js";

// Turn lifecycle
export { TurnManager } from "./turn.js";
export type {
  TurnHandle,
  FinishTurnInput,
  TurnResult,
  TurnManagerConfig,
} from "./turn.js";

// Main memory API
export { LynageMemory } from "./memory.js";
export type { LynageMemoryOptions } from "./memory.js";

// Archiving
export { ArchiveManager } from "./archive-manager.js";
export type { ArchiveConfig, ArchiveResult } from "./archive-manager.js";
export { findNaturalBoundary } from "./boundary-detector.js";
export { compileContext } from "./context-compiler.js";
export type { CompileOptions, CompiledContext } from "./context-compiler.js";
