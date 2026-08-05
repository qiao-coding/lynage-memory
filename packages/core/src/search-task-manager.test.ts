// ---------------------------------------------------------------------------
// SearchTaskManager tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { SearchTaskManager } from "./search-task-manager.js";
import type { LynageStore, Message, ContextChunk, DirectoryNode, WorkingMemory, SearchTask } from "./index.js";

// ---- Mock Store ----
class MockStore implements LynageStore {
  messages: Message[] = [];
  chunks: Map<string, ContextChunk> = new Map();
  dirs: Map<string, DirectoryNode> = new Map();
  searchTasks: Map<string, SearchTask> = new Map();

  async createSearchTask(input: { sessionId: string; query: string; understanding?: string; strategy?: string }) {
    const task: SearchTask = {
      id: `search-${this.searchTasks.size}`, sessionId: input.sessionId,
      query: input.query, understanding: input.understanding, strategy: input.strategy,
      checkedDirectories: [], candidates: [], status: "pending",
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.searchTasks.set(task.id, task); return task;
  }
  async updateSearchTask(id: string, updates: Partial<SearchTask>) {
    const t = this.searchTasks.get(id); if (t) Object.assign(t, updates, { updatedAt: Date.now() });
    return this.searchTasks.get(id)!;
  }
  async getSearchTask(id: string) { return this.searchTasks.get(id) ?? null; }
  async getRootDirectories() { return Array.from(this.dirs.values()).filter(d => d.parentId == null); }
  async getDirectory(id: string) { return this.dirs.get(id) ?? null; }
  async getDirectoryChildren() { return []; }

  // Unused stubs
  async appendMessage() { return {} as Message; }
  async getMessage() { return null; }
  async getRecent() { return []; }
  async getMessageRange() { return []; }
  async getMessagesAround() { return []; }
  async getMessageCount() { return 0; }
  async saveMessageEmbeddings() {}
  async getMessageEmbeddings() { return []; }
  async createChunk() { return {} as ContextChunk; }
  async getChunk() { return null; }
  async getChunksByIds() { return []; }
  async getChunksByDirectory() { return []; }
  async listChunks() { return []; }
  async getLastArchiveTime() { return 0; }
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
  async searchMessages() { return []; }
  async searchChunks() { return []; }
  async searchDirectories() { return []; }
  async getEstimatedTokenCount() { return 0; }
}

describe("SearchTaskManager", () => {
  let store: MockStore;
  let manager: SearchTaskManager;

  beforeEach(() => {
    store = new MockStore();
    manager = new SearchTaskManager(store);
  });

  it("creates a new search task", async () => {
    const task = await manager.startSearch({
      sessionId: "s1",
      query: "之前为什么放弃语义分类？",
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("pending");
    expect(task.query).toContain("语义分类");
    expect(task.understanding).toBeDefined();
    expect(task.strategy).toBeDefined();
  });

  it("nextBatch returns progress and candidates", async () => {
    const task = await manager.startSearch({
      sessionId: "s1",
      query: "design decision",
    });

    const batch = await manager.nextBatch(task.id, 3);
    expect(batch.taskId).toBe(task.id);
    expect(batch.checkedDirectories).toBeDefined();
    expect(batch.progress).toBeDefined();
  });

  it("completes search when all directories checked", async () => {
    const task = await manager.startSearch({
      sessionId: "s1",
      query: "architecture",
    });

    // No directories → should complete immediately
    const batch = await manager.nextBatch(task.id, 3);
    expect(batch.status).toBe("not_found");
    expect(batch.shouldContinue).toBe(false);
  });

  it("finds candidates when directory summary matches", async () => {
    store.dirs.set("d1", {
      id: "d1", sessionId: "s1", generation: 0,
      timeRangeStart: 1000, timeRangeEnd: 2000,
      overallContent: "Decided to abandon semantic classification approach.",
      progress: "Phase complete",
      mainConclusions: ["Semantic classification abandoned"],
      importantChanges: ["Abandoned semantic classification"],
      createdAt: 3000,
    });

    const task = await manager.startSearch({
      sessionId: "s1",
      query: "semantic classification",
    });

    const batch = await manager.nextBatch(task.id, 3);
    expect(batch.newCandidates.length).toBeGreaterThan(0);
    expect(batch.newCandidates[0]!.summary).toContain("semantic classification");
  });

  it("getProgress returns readable status", async () => {
    const task = await manager.startSearch({
      sessionId: "s1",
      query: "test query",
    });

    const progress = await manager.getProgress(task.id);
    expect(progress).toContain("test query");
    expect(progress).toContain("pending");
  });

  it("analyzeResults summarizes completed search", async () => {
    store.dirs.set("d1", {
      id: "d1", sessionId: "s1", generation: 0,
      timeRangeStart: 1000, timeRangeEnd: 2000,
      overallContent: "Switched from CSS Modules to Tailwind CSS for the design system.",
      progress: "Migration complete",
      mainConclusions: ["Tailwind adopted"],
      importantChanges: ["Abandoned CSS Modules"],
      createdAt: 3000,
    });

    const task = await manager.startSearch({
      sessionId: "s1",
      query: "Tailwind CSS",
    });

    await manager.nextBatch(task.id, 3); // finds the dir in batch
    const analysis = await manager.analyzeResults(task.id);
    expect(analysis.status).toBeDefined();
    expect(analysis.summary).toContain("Tailwind");
  });
});
