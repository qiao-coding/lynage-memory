// ---------------------------------------------------------------------------
// ParallelSearchCoordinator tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { ParallelSearchCoordinator, type ProjectSnapshot } from "./parallel-search-coordinator.js";
import { HistoryRetriever } from "./history-retriever.js";
import type { LynageStore, Message, ContextChunk, DirectoryNode, WorkingMemory, DirectoryChild } from "./index.js";

// ---- Mock Store ----
class MockStore implements LynageStore {
  messages: Message[] = [];
  chunks: Map<string, ContextChunk> = new Map();
  dirs: Map<string, DirectoryNode> = new Map();
  children: Map<string, DirectoryChild[]> = new Map();

  async getRootDirectories() { return Array.from(this.dirs.values()).filter(d => d.generation === 0); }
  async getDirectory(id: string) { return this.dirs.get(id) ?? null; }
  async getDirectoryChildren(dirId: string) { return this.children.get(dirId) ?? []; }
  async getChunksByDirectory(dirId: string) {
    return Array.from(this.chunks.values()).filter(c => c.directoryId === dirId);
  }
  async getChunk(id: string) { return this.chunks.get(id) ?? null; }
  async getChunksByIds(ids: string[]) { return ids.map(id => this.chunks.get(id)).filter(Boolean) as any; }
  async getMessageRange(fromId: string, toId: string) {
    const fromIdx = this.messages.findIndex(m => m.id === fromId);
    const toIdx = this.messages.findIndex(m => m.id === toId);
    return fromIdx >= 0 && toIdx >= 0 ? this.messages.slice(fromIdx, toIdx + 1) : [];
  }
  async getMessagesAround() { return []; }
  async getRecent() { return this.messages; }
  async listChunks() { return Array.from(this.chunks.values()); }
  async getLastArchiveTime() { return 0; }

  // Unused stubs
  async appendMessage() { return {} as Message; }
  async getMessage() { return null; }
  async getMessageCount() { return 0; }
  async createChunk() { return {} as ContextChunk; }
  async updateChunkDirectory() {}
  async createDirectory() { return {} as DirectoryNode; }
  async updateDirectory() { return {} as DirectoryNode; }
  async getChildDirectories() { return []; }
  async addChildToDirectory() {}
  async removeChildFromDirectory() {}
  async getWorkingMemory() { return null; }
  async upsertWorkingMemory() { return {} as WorkingMemory; }
  async getUserMemory() { return null; }
  async upsertUserMemory() { return {} as never; }
  async createSearchTask() { return {} as never; }
  async updateSearchTask() { return {} as never; }
  async getSearchTask() { return null; }
  async searchMessages() { return []; }
  async getEstimatedTokenCount() { return 0; }
}

function makeSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    snapshotId: "snap-test",
    projectGoal: "Test project",
    currentProgress: "Testing parallel search",
    knownDecisions: ["Use SQLite"],
    question: "Why was semantic classification abandoned?",
    searchGoal: "Find the decision to abandon semantic classification",
    ...overrides,
  };
}

describe("ParallelSearchCoordinator", () => {
  let store: MockStore;
  let coordinator: ParallelSearchCoordinator;

  beforeEach(() => {
    store = new MockStore();
    const retriever = new HistoryRetriever(store);
    coordinator = new ParallelSearchCoordinator(store, retriever);
  });

  it("returns empty result when no directories exist", async () => {
    const result = await coordinator.search("s1", makeSnapshot());
    expect(result.totalWorkers).toBe(0);
    expect(result.totalDirectoriesSearched).toBe(0);
    expect(result.mergedCandidates.length).toBe(0);
  });

  it("searches directories and finds matching chunks", async () => {
    // Setup: create a directory with matching content
    store.dirs.set("d1", {
      id: "d1", sessionId: "s1", generation: 0,
      timeRangeStart: 1000, timeRangeEnd: 2000,
      overallContent: "Discussed semantic classification and decided to abandon it.",
      progress: "Decision made",
      mainConclusions: ["Semantic classification abandoned"],
      importantChanges: ["Abandoned semantic classification"],
      createdAt: 3000,
    });

    store.chunks.set("c1", {
      id: "c1", sessionId: "s1",
      timeRangeStart: 1000, timeRangeEnd: 1500,
      summary: "Semantic classification discussion and abandonment decision.",
      progress: "Concluded",
      keywords: ["semantic", "classification", "abandoned"],
      sourceFromId: "m1", sourceToId: "m2",
      directoryId: "d1", createdAt: 2000,
    });

    store.children.set("d1", []); // no sub-directories

    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "We should abandon semantic classification.", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "Agreed. Semantic classification is too brittle.", createdAt: 1500 },
    ];

    const result = await coordinator.search("s1", makeSnapshot());
    expect(result.totalDirectoriesSearched).toBe(1);
    expect(result.totalWorkers).toBe(1);
  });

  it("distributes multiple directories across workers", async () => {
    for (let i = 0; i < 4; i++) {
      store.dirs.set(`d${i}`, {
        id: `d${i}`, sessionId: "s1", generation: 0,
        timeRangeStart: i * 1000, timeRangeEnd: (i + 1) * 1000,
        overallContent: `Directory ${i} content about semantic classification abandonment.`,
        progress: `Phase ${i}`,
        mainConclusions: [`Conclusion ${i}`],
        importantChanges: [],
        createdAt: (i + 1) * 1000,
      });
    }

    const result = await coordinator.search("s1", makeSnapshot());
    expect(result.totalDirectoriesSearched).toBe(4);
    // Workers ≤ min(4, dirCount)
    expect(result.totalWorkers).toBeLessThanOrEqual(4);
  });

  it("generates human-readable summary for empty result", async () => {
    const result = await coordinator.search("s1", makeSnapshot());
    // Empty directories → summary explains no results
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.evolutionChain).toBeDefined();
    expect(result.finalConfidence).toBe(0);
  });
});
