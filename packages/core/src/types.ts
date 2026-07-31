// ---------------------------------------------------------------------------
// Core data types for Lynage Memory
// ---------------------------------------------------------------------------

/** Role of a message in the conversation */
export type MessageRole = "user" | "assistant" | "tool" | "system";

/** A single saved message (immutable append-only record) */
export interface Message {
  id: string;
  sessionId: string;
  userId?: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  tokenCount?: number;
  createdAt: number; // unix ms
}

/** Input for appending a new message (id + createdAt auto-generated) */
export interface MessageInput {
  sessionId: string;
  userId?: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  tokenCount?: number;
}

/** Range of source messages */
export interface SourceRange {
  fromId: string;
  toId: string;
}

/** An archived chunk of conversation */
export interface ContextChunk {
  id: string;
  sessionId: string;
  timeRangeStart: number;
  timeRangeEnd: number;
  summary: string;
  progress: string;
  keywords: string[];
  sourceFromId: string;
  sourceToId: string;
  directoryId?: string;
  createdAt: number;
}

/** A directory node in the generational tree */
export interface DirectoryNode {
  id: string;
  sessionId: string;
  parentId?: string;
  generation: number;
  timeRangeStart: number;
  timeRangeEnd: number;
  overallContent: string;
  progress: string;
  mainConclusions: string[];
  importantChanges: string[];
  createdAt: number;
}

/** Link between directory and its children (chunks or sub-directories) */
export interface DirectoryChild {
  id: string;
  directoryId: string;
  childType: "chunk" | "directory";
  childId: string;
  sortOrder: number;
}

/** Working memory for a session — tracks current task state */
export interface WorkingMemory {
  id: string;
  sessionId: string;
  currentTask?: string;
  confirmed: string[];
  progress: string[];
  unresolved: string[];
  recentChanges: string[];
  updatedAt: number;
}

/** User memory — cross-task stable preferences and background */
export interface UserMemory {
  id: string;
  userId: string;
  preferences: string[];
  longTermGoals: string[];
  constraints: string[];
  background?: string;
  updatedAt: number;
}

/** Persistent fuzzy-search task */
export type SearchStatus = "pending" | "in_progress" | "completed" | "not_found";

export interface SearchTask {
  id: string;
  sessionId: string;
  query: string;
  understanding?: string;
  strategy?: string;
  checkedDirectories: string[];
  candidates: string[];
  nextBatch?: string;
  status: SearchStatus;
  createdAt: number;
  updatedAt: number;
}

/** Scope for querying recent messages */
export interface Scope {
  sessionId: string;
  limit?: number;
  beforeId?: string;
  afterId?: string;
  /** Only return messages created after this timestamp (prevents re-archiving) */
  since?: number;
}

/** Token budget tracking */
export interface TokenBudget {
  used: number;
  total: number;
  threshold: number;
}

// ---------------------------------------------------------------------------
// Lynage configuration
// ---------------------------------------------------------------------------

export interface LynageConfig {
  /** Token threshold for triggering archive (default 8_000) */
  archiveThreshold: number;
  /** Tokens to retain in recent context after archive (default 4_000) */
  retainTokens: number;
  /** Max children per directory before generation compaction (default 20) */
  directoryCapacity: number;
}

export const DEFAULT_CONFIG: LynageConfig = {
  archiveThreshold: 8_000,
  retainTokens: 4_000,
  directoryCapacity: 20,
};
