// ---------------------------------------------------------------------------
// HistoryRetriever tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { HistoryRetriever, type SearchResult } from "./history-retriever.js";
import type { LynageStore, Message, ContextChunk, DirectoryNode, WorkingMemory } from "./index.js";

// Minimal mock store for testing
class MockStoreForSearch implements LynageStore {
  messages: Message[] = [];
  chunks: Map<string, ContextChunk> = new Map();
  dirs: Map<string, DirectoryNode> = new Map();
  children: Map<string, Array<{ childType: string; childId: string }>> = new Map();

  async appendMessage() { return {} as Message; }
  async getMessage() { return null; }
  async getRecent() { return []; }
  async getMessageRange(fromId: string, toId: string) {
    return this.messages.filter(
      (m) => m.id >= fromId && m.id <= toId,
    );
  }
  async getMessagesAround() { return []; }
  async getMessageCount() { return this.messages.length; }
  async createChunk() { return {} as ContextChunk; }
  async getChunk(id: string) { return this.chunks.get(id) ?? null; }
  async getChunksByIds(ids: string[]) { return ids.map(id => this.chunks.get(id)).filter((c): c is NonNullable<typeof c> => c != null); }
  async getChunksByDirectory() { return []; }
  async listChunks() { return Array.from(this.chunks.values()); }
  async getLastArchiveTime() { return 0; }
  async updateChunkDirectory() {}
  async createDirectory() { return {} as DirectoryNode; }
  async getDirectory(id: string) { return this.dirs.get(id) ?? null; }
  async updateDirectory() { return {} as DirectoryNode; }
  async getRootDirectories() {
    return Array.from(this.dirs.values()).filter((d) => d.parentId == null);
  }
  async getChildDirectories(parentId: string) {
    const childIds = this.children.get(parentId) ?? [];
    return childIds
      .filter((c) => c.childType === "directory")
      .map((c) => this.dirs.get(c.childId))
      .filter(Boolean) as DirectoryNode[];
  }
  async addChildToDirectory() {}
  async removeChildFromDirectory() {}
  async getDirectoryChildren(dirId: string) {
    const kids = this.children.get(dirId) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return kids.map((k, i) => ({
      id: `dc-${i}`,
      directoryId: dirId,
      childType: k.childType as "chunk" | "directory",
      childId: k.childId,
      sortOrder: i,
    }));
  }
  async getWorkingMemory() { return null; }
  async upsertWorkingMemory() { return {} as WorkingMemory; }
  async getUserMemory() { return null; }
  async upsertUserMemory() { return {} as never; }
  async createSearchTask() { return {} as never; }
  async updateSearchTask() { return {} as never; }
  async getSearchTask() { return null; }
  async searchMessages(query: string) {
    return this.messages.filter((m) =>
      m.content.toLowerCase().includes(query.toLowerCase()),
    );
  }
  async getEstimatedTokenCount() { return 0; }
}

describe("HistoryRetriever", () => {
  let store: MockStoreForSearch;
  let retriever: HistoryRetriever;

  beforeEach(() => {
    store = new MockStoreForSearch();
    retriever = new HistoryRetriever(store);
  });

  it("returns not_found when no matches exist", async () => {
    const result = await retriever.search({
      query: "nonexistent",
      sessionId: "s1",
    });
    expect(result.status).toBe("not_found");
    expect(result.candidates.length).toBe(0);
  });

  it("finds messages via FTS keyword search", async () => {
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "We should abandon semantic classification", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "Agreed, it's too brittle", createdAt: 2000 },
    ];

    store.chunks.set("c1", {
      id: "c1",
      sessionId: "s1",
      timeRangeStart: 1000,
      timeRangeEnd: 2000,
      summary: "Discussed and abandoned semantic classification",
      progress: "Decision made to abandon",
      keywords: ["semantic classification", "abandoned"],
      sourceFromId: "m1",
      sourceToId: "m2",
      createdAt: 3000,
    });

    const result = await retriever.search({
      query: "semantic classification",
      sessionId: "s1",
    });

    expect(result.status).toBe("found");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]?.summary).toContain("semantic");
  });

  it("openSource returns original messages", async () => {
    store.messages = [
      { id: "m10", sessionId: "s1", role: "user", content: "Let's change the architecture", createdAt: 5000 },
      { id: "m11", sessionId: "s1", role: "assistant", content: "OK, what approach?", createdAt: 6000 },
    ];

    store.chunks.set("c2", {
      id: "c2",
      sessionId: "s1",
      timeRangeStart: 5000,
      timeRangeEnd: 6000,
      summary: "Architecture change discussion",
      progress: "Exploring options",
      keywords: ["architecture"],
      sourceFromId: "m10",
      sourceToId: "m11",
      createdAt: 7000,
    });

    const result = await retriever.openSource("c2");
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBe(2);
    expect(result!.messages[0]?.content).toContain("architecture");
  });

  it("compileRetrievedContext produces readable text", () => {
    const result: SearchResult = {
      status: "found",
      candidates: [
        {
          contextId: "c1",
          summary: "Architecture decision",
          progress: "Phase complete",
          keywords: ["architecture", "decision"],
          conclusions: [],
          goals: [],
          sourceRange: { from: "m1", to: "m2" },
          timeRange: { start: 1000, end: 2000 },
          relevance: 0.8,
        },
      ],
      searchedDirectories: 1,
      totalChunksChecked: 3,
    };

    const text = retriever.compileRetrievedContext(result);
    expect(text).toContain("Architecture decision");
    expect(text).toContain("relevance: 80%");
    expect(text).toContain("Context ID: c1");
  });

  it("returns directory tree", async () => {
    store.dirs.set("d1", {
      id: "d1", sessionId: "s1", generation: 0,
      timeRangeStart: 1000, timeRangeEnd: 5000,
      overallContent: "Root directory", progress: "Active",
      mainConclusions: [], importantChanges: [], createdAt: 6000,
    });

    const tree = await retriever.getDirectoryTree("s1");
    expect(tree.length).toBe(1);
    expect(tree[0]?.summary).toBe("Root directory");
  });
});
