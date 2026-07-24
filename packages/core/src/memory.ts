// ---------------------------------------------------------------------------
// LynageMemory — main public API
// Composes Store + Model + TurnManager into a coherent memory system.
// ---------------------------------------------------------------------------

import type { LynageStore, WorkingMemoryInput } from "./store.js";
import type { LynageModel } from "./model.js";
import type { LynageConfig, MessageInput } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { TurnManager, type TurnHandle } from "./turn.js";
import { ArchiveManager } from "./archive-manager.js";
import type { MemoryAction } from "./schemas.js";

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

  // ---- Memory Write-Back ----

  /**
   * Commit memory actions proposed by the model.
   * Validates each action before applying.
   */
  async commit(actions: MemoryAction[]): Promise<void> {
    for (const action of actions) {
      if (!action.target || !action.operation || !action.section || !action.value) {
        continue;
      }

      if (action.target === "workingMemory") {
        const wm = await this._store.getWorkingMemory("default");
        const current = wm ?? {
          id: "",
          sessionId: "default",
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
          sessionId: "default",
          currentTask: current.currentTask,
          confirmed: current.confirmed,
          progress: current.progress,
          unresolved: current.unresolved,
          recentChanges: current.recentChanges,
        });
      }
    }
  }

  // ---- History Search (stub — full implementation in M3) ----

  async search(options: { query: string; sessionId?: string }) {
    return this._store.searchMessages(options.query, options.sessionId);
  }

  async openSource(contextId: string) {
    const chunk = await this._store.getChunk(contextId);
    if (!chunk) return null;
    return this._store.getMessageRange(chunk.sourceFromId, chunk.sourceToId);
  }
}
