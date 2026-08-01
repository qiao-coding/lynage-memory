// ---------------------------------------------------------------------------
// LynageStore — storage abstraction interface
// ---------------------------------------------------------------------------

import type {
  Message,
  MessageInput,
  Scope,
  ContextChunk,
  DirectoryNode,
  DirectoryChild,
  WorkingMemory,
  UserMemory,
  SearchTask,
  SourceRange,
} from "./types.js";

// ---- input types for creation ----

export interface CreateChunkInput {
  sessionId: string;
  timeRangeStart: number;
  timeRangeEnd: number;
  summary: string;
  progress: string;
  keywords: string[];
  sourceFromId: string;
  sourceToId: string;
  directoryId?: string;
}

export interface CreateDirectoryInput {
  sessionId: string;
  parentId?: string;
  generation: number;
  timeRangeStart: number;
  timeRangeEnd: number;
  overallContent: string;
  progress: string;
  mainConclusions: string[];
  importantChanges: string[];
}

export interface WorkingMemoryInput {
  sessionId: string;
  currentTask?: string;
  confirmed?: string[];
  progress?: string[];
  unresolved?: string[];
  recentChanges?: string[];
}

export interface UserMemoryInput {
  userId: string;
  preferences?: string[];
  longTermGoals?: string[];
  constraints?: string[];
  background?: string;
}

export interface SearchTaskInput {
  sessionId: string;
  query: string;
  understanding?: string;
  strategy?: string;
}

// ---- store interface ----

export interface LynageStore {
  // messages
  appendMessage(input: MessageInput): Promise<Message>;
  getMessage(id: string): Promise<Message | null>;
  getRecent(scope: Scope): Promise<Message[]>;
  getMessageRange(fromId: string, toId: string): Promise<Message[]>;
  getMessageCount(sessionId: string): Promise<number>;

  // context chunks
  createChunk(input: CreateChunkInput): Promise<ContextChunk>;
  getChunk(id: string): Promise<ContextChunk | null>;
  getChunksByIds(ids: string[]): Promise<ContextChunk[]>;
  getChunksByDirectory(directoryId: string): Promise<ContextChunk[]>;
  listChunks(sessionId: string): Promise<ContextChunk[]>;
  getLastArchiveTime(sessionId: string): Promise<number>;
  updateChunkDirectory(chunkId: string, directoryId: string): Promise<void>;

  // directories
  createDirectory(input: CreateDirectoryInput): Promise<DirectoryNode>;
  getDirectory(id: string): Promise<DirectoryNode | null>;
  updateDirectory(
    id: string,
    updates: Partial<CreateDirectoryInput>,
  ): Promise<DirectoryNode>;
  getRootDirectories(sessionId: string): Promise<DirectoryNode[]>;
  getChildDirectories(parentId: string): Promise<DirectoryNode[]>;
  addChildToDirectory(child: DirectoryChild): Promise<void>;
  removeChildFromDirectory(directoryId: string, childId: string): Promise<void>;
  getDirectoryChildren(directoryId: string): Promise<DirectoryChild[]>;

  // working memory
  getWorkingMemory(sessionId: string): Promise<WorkingMemory | null>;
  upsertWorkingMemory(input: WorkingMemoryInput): Promise<WorkingMemory>;

  // user memory (cross-task stable preferences)
  getUserMemory(userId: string): Promise<UserMemory | null>;
  upsertUserMemory(input: UserMemoryInput): Promise<UserMemory>;

  // search tasks
  createSearchTask(input: SearchTaskInput): Promise<SearchTask>;
  updateSearchTask(
    id: string,
    updates: Partial<SearchTask>,
  ): Promise<SearchTask>;
  getSearchTask(id: string): Promise<SearchTask | null>;

  // utility
  searchMessages(query: string, sessionId?: string): Promise<Message[]>;
  getEstimatedTokenCount(
    sessionId: string,
    sinceId?: string,
  ): Promise<number>;
}
