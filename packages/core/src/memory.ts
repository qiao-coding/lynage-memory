// ---------------------------------------------------------------------------
// LynageMemory — main public API
// Composes Store + Model + TurnManager into a coherent memory system.
// ---------------------------------------------------------------------------

import type { LynageStore, WorkingMemoryInput, UserMemoryInput } from "./store.js";
import type { LynageModel } from "./model.js";
import type { LynageConfig, MessageInput } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { TurnManager, type TurnHandle } from "./turn.js";
import { ArchiveManager } from "./archive-manager.js";
import { HistoryRetriever, type SearchParams, type SearchResult, type DirectoryTreeNode, type SearchCandidate } from "./history-retriever.js";
import { SearchTaskManager, type StartSearchInput, type SearchBatch, type SearchAnalysis } from "./search-task-manager.js";
import { SourceVerifier, type VerifiedCandidate } from "./source-verifier.js";
import { ParallelSearchCoordinator, type ProjectSnapshot, type ParallelSearchResult } from "./parallel-search-coordinator.js";
import type { MemoryAction } from "./schemas.js";
import type { SearchTask } from "./types.js";

export interface LynageMemoryOptions {
  store: LynageStore;
  model: LynageModel;
  config?: Partial<LynageConfig>;
}

export class LynageMemory {
  private _store: LynageStore;
  private _model: LynageModel;
  private _config: LynageConfig;
  private _turnManager: TurnManager;
  private _historyRetriever: HistoryRetriever;
  private _searchTaskManager: SearchTaskManager;
  private _sourceVerifier: SourceVerifier;
  private _parallelSearch: ParallelSearchCoordinator;

  constructor(options: LynageMemoryOptions) {
    this._store = options.store;
    this._model = options.model;
    this._config = { ...DEFAULT_CONFIG, ...options.config };
    const archiveManager = new ArchiveManager(this._store, this._model, {
      tokenThreshold: this._config.archiveThreshold,
      retainTokens: this._config.retainTokens,
      directoryCapacity: this._config.directoryCapacity,
    });
    this._turnManager = new TurnManager(this._store, archiveManager);
    this._historyRetriever = new HistoryRetriever(this._store);
    this._searchTaskManager = new SearchTaskManager(this._store);
    this._sourceVerifier = new SourceVerifier(this._store);
    this._parallelSearch = new ParallelSearchCoordinator(this._store, this._historyRetriever);
  }

  /** Access the underlying store (for direct operations) */
  get store(): LynageStore {
    return this._store;
  }

  /** Access the underlying model */
  get model(): LynageModel {
    return this._model;
  }

  /** Access the configuration */
  get config(): LynageConfig {
    return this._config;
  }

  // ---- Turn Lifecycle ----

  async startTurn(
    sessionId: string,
    userId: string | undefined,
    input: string,
  ): Promise<TurnHandle> {
    return this._turnManager.startTurn(sessionId, userId, input);
  }

  // ---- Message Operations ----

  async appendMessage(input: MessageInput) {
    return this._store.appendMessage(input);
  }

  // ---- Working Memory ----

  async getWorkingMemory(sessionId: string) {
    return this._store.getWorkingMemory(sessionId);
  }

  async upsertWorkingMemory(input: WorkingMemoryInput) {
    return this._store.upsertWorkingMemory(input);
  }

  // ---- User Memory (cross-task stable preferences) ----

  async getUserMemory(userId: string) {
    return this._store.getUserMemory(userId);
  }

  async upsertUserMemory(input: UserMemoryInput) {
    return this._store.upsertUserMemory(input);
  }

  // ---- Memory Write-Back ----

  /**
   * Commit memory actions proposed by the model.
   * Validates each action before applying.
   */
  async commit(actions: MemoryAction[], sessionId = "default"): Promise<void> {
    for (const action of actions) {
      if (!action.target || !action.operation || !action.section || !action.value) {
        continue;
      }

      if (action.target === "workingMemory") {
        const wm = await this._store.getWorkingMemory(sessionId);
        const current = wm ?? {
          id: "",
          sessionId,
          confirmed: [] as string[],
          progress: [] as string[],
          unresolved: [] as string[],
          recentChanges: [] as string[],
          updatedAt: 0,
        };

        if (action.operation === "append") {
          const section = action.section as keyof typeof current;
          const val = current[section];
          if (Array.isArray(val)) {
            val.push(action.value);
          } else if (typeof val === "string") {
            (current as unknown as Record<string, unknown>)[section] = action.value;
          }
        } else if (action.operation === "remove") {
          const section = action.section as keyof typeof current;
          const val = current[section];
          if (Array.isArray(val)) {
            (current as unknown as Record<string, unknown>)[section] =
              val.filter((v) => v !== action.value);
          }
        }

        await this._store.upsertWorkingMemory({
          sessionId,
          currentTask: current.currentTask,
          confirmed: current.confirmed,
          progress: current.progress,
          unresolved: current.unresolved,
          recentChanges: current.recentChanges,
        });
      } else if (action.target === "userMemory") {
        const userId = sessionId; // In many cases userId === sessionId
        const um = await this._store.getUserMemory(userId);
        const current = um ?? {
          id: "",
          userId,
          preferences: [] as string[],
          longTermGoals: [] as string[],
          constraints: [] as string[],
          updatedAt: 0,
        };

        if (action.operation === "append") {
          const section = action.section as keyof typeof current;
          const val = current[section];
          if (Array.isArray(val)) {
            val.push(action.value);
          } else if (typeof val === "string" || val === undefined) {
            (current as unknown as Record<string, unknown>)[section] = action.value;
          }
        } else if (action.operation === "remove") {
          const section = action.section as keyof typeof current;
          const val = current[section];
          if (Array.isArray(val)) {
            (current as unknown as Record<string, unknown>)[section] =
              val.filter((v) => v !== action.value);
          }
        }

        await this._store.upsertUserMemory({
          userId,
          preferences: current.preferences,
          longTermGoals: current.longTermGoals,
          constraints: current.constraints,
          background: current.background,
        });
      }
    }
  }

  // ---- History Search (M3: full implementation) ----

  /** Hybrid search: FTS + directory drill-down */
  async search(options: SearchParams): Promise<SearchResult> {
    return this._historyRetriever.search(options);
  }

  /** Verify search results against original messages */
  async verifySearch(
    candidates: SearchCandidate[],
    query: string,
  ): Promise<VerifiedCandidate[]> {
    return this._sourceVerifier.verifyBatch(candidates, query);
  }

  /** Deep verify with context expansion and evolution chain */
  async deepVerifySearch(candidates: SearchCandidate[], query: string) {
    return this._sourceVerifier.deepVerify(candidates, query);
  }

  /** Shared-context parallel search across directory trees (M8) */
  async parallelSearch(
    sessionId: string,
    snapshot: ProjectSnapshot,
  ): Promise<ParallelSearchResult> {
    return this._parallelSearch.search(sessionId, snapshot);
  }

  /** Open original source messages for a chunk */
  async openSource(contextId: string) {
    return this._historyRetriever.openSource(contextId);
  }

  /** Get directory tree for a session */
  async getDirectoryTree(sessionId: string): Promise<DirectoryTreeNode[]> {
    return this._historyRetriever.getDirectoryTree(sessionId);
  }

  /** Compile search results into model-readable text */
  compileRetrievedContext(result: SearchResult): string {
    return this._historyRetriever.compileRetrievedContext(result);
  }

  // ---- Persistent Search (M6) ----

  /** Start a persistent fuzzy-search task */
  async startSearch(input: StartSearchInput): Promise<SearchTask> {
    return this._searchTaskManager.startSearch(input);
  }

  /** Continue a search task (next batch) */
  async continueSearch(taskId: string, batchSize?: number): Promise<SearchBatch> {
    return this._searchTaskManager.nextBatch(taskId, batchSize);
  }

  /** Analyze completed search results */
  async analyzeSearch(taskId: string): Promise<SearchAnalysis> {
    return this._searchTaskManager.analyzeResults(taskId);
  }

  /** Get search progress */
  async getSearchProgress(taskId: string): Promise<string> {
    return this._searchTaskManager.getProgress(taskId);
  }

  // ---- Archive Statistics ----

  async getArchiveStats(sessionId: string) {
    const msgCount = await this._store.getMessageCount(sessionId);
    const chunks = await this._store.listChunks(sessionId);
    const dirs = await this._store.getRootDirectories(sessionId);
    return { sessionId, messageCount: msgCount, chunkCount: chunks.length, directoryCount: dirs.length };
  }
}
