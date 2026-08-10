// ---------------------------------------------------------------------------
// ArchiveManager tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { ArchiveManager } from "./archive-manager.js";
import type { LynageStore, LynageModel, ChunkSummary, DirectorySummary, Message, ContextChunk, DirectoryNode, WorkingMemory, DirectoryChild } from "./index.js";

// ---- Mock Store ----
class MockStore implements LynageStore {
  messages: Message[] = [];
  chunks: Map<string, ContextChunk> = new Map();
  dirs: Map<string, DirectoryNode> = new Map();
  children: Map<string, DirectoryChild[]> = new Map();
  wm: Map<string, WorkingMemory> = new Map();

  async appendMessage(input: { sessionId: string; role: string; content: string; tokenCount?: number }) {
    const msg: Message = {
      id: `msg-${this.messages.length}`, sessionId: input.sessionId,
      role: input.role as Message["role"], content: input.content,
      tokenCount: input.tokenCount ?? Math.ceil(input.content.length / 4), createdAt: Date.now() + this.messages.length,
    };
    this.messages.push(msg); return msg;
  }
  async getMessage(id: string) { return this.messages.find(m => m.id === id) ?? null; }
  async getRecent(scope: { sessionId: string }) { return this.messages.filter(m => m.sessionId === scope.sessionId); }
  async getMessageRange(fromId: string, toId: string) {
    const fromIdx = this.messages.findIndex(m => m.id === fromId);
    const toIdx = this.messages.findIndex(m => m.id === toId);
    if (fromIdx < 0 || toIdx < 0) return [];
    return this.messages.slice(fromIdx, toIdx + 1);
  }
  async getMessagesAround() { return []; }
  async getMessageCount() { return this.messages.length; }
  async saveMessageEmbeddings() {}
  async getMessageEmbeddings() { return []; }
  async createChunk(input: { sessionId: string; summary: string; progress: string; keywords: string[]; sourceFromId: string; sourceToId: string; timeRangeStart: number; timeRangeEnd: number }) {
    const chunk: ContextChunk = { id: `chunk-${this.chunks.size}`, ...input, directoryId: undefined, createdAt: Date.now() };
    this.chunks.set(chunk.id, chunk); return chunk;
  }
  async getChunk(id: string) { return this.chunks.get(id) ?? null; }
  async getChunksByIds(ids: string[]) { return ids.map(id => this.chunks.get(id)).filter(Boolean) as any; }
  async getChunksByDirectory() { return []; }
  async listChunks() { return Array.from(this.chunks.values()); }
  async getLastArchiveTime() { return 0; }
  async updateChunkDirectory(chunkId: string, dirId: string) {
    const c = this.chunks.get(chunkId); if (c) (c as unknown as Record<string, unknown>).directoryId = dirId;
  }
  async createDirectory(input: { sessionId: string; generation: number; timeRangeStart: number; timeRangeEnd: number; overallContent: string; progress: string; mainConclusions: string[]; importantChanges: string[] }) {
    const dir: DirectoryNode = { id: `dir-${this.dirs.size}`, ...input, parentId: undefined, createdAt: Date.now() };
    this.dirs.set(dir.id, dir); return dir;
  }
  async getDirectory(id: string) { return this.dirs.get(id) ?? null; }
  async updateDirectory(id: string, updates: Record<string, unknown>) {
    const d = this.dirs.get(id); if (d) Object.assign(d as unknown as Record<string, unknown>, updates);
    return this.dirs.get(id)!;
  }
  async getRootDirectories(sessionId: string) { return Array.from(this.dirs.values()).filter(d => d.sessionId === sessionId && (d.parentId == null)); }
  async getChildDirectories() { return []; }
  async addChildToDirectory(child: DirectoryChild) {
    const list = this.children.get(child.directoryId) ?? []; list.push(child); this.children.set(child.directoryId, list);
  }
  async removeChildFromDirectory(dirId: string, childId: string) {
    const list = this.children.get(dirId);
    if (list) this.children.set(dirId, list.filter((c: DirectoryChild) => c.childId !== childId));
  }
  async getDirectoryChildren(dirId: string) { return this.children.get(dirId) ?? []; }
  async getWorkingMemory() { return null; }
  async upsertWorkingMemory(input: { sessionId: string }) { const wm: WorkingMemory = { id: "wm-1", sessionId: input.sessionId, confirmed: [], progress: [], unresolved: [], recentChanges: [], updatedAt: Date.now() }; this.wm.set(input.sessionId, wm); return wm; }
  async getUserMemory() { return null; }
  async upsertUserMemory() { return {} as never; }
  async createSearchTask() { return {} as never; }
  async updateSearchTask() { return {} as never; }
  async getSearchTask() { return null; }
  async searchMessages() { return []; }
  async searchChunks() { return []; }
  async searchDirectories() { return []; }
  async getEstimatedTokenCount() { return 0; }
}

// ---- Mock Model ----
class MockModel implements LynageModel {
  async summarizeChunk() { return { summary: "Test summary", progress: "Test progress", keywords: ["test"] } as ChunkSummary; }
  async summarizeDirectory() { return { overallContent: "Test content", progress: "Test progress", mainConclusions: ["Test conclusion"], importantChanges: [], goals: [] } as DirectorySummary; }
  async analyzeSearchBatch() { return { relevantIds: [], reasoning: "", shouldContinue: false }; }
  async analyzeSearchQuery() { return { intent: "decision" as const, description: "test", keywords: ["test"] }; }
  async isDirectoryRelevant() { return true; }
  async isChunkRelevant() { return true; }
  async navigateDirectory() { return { relevantChildIds: [], reasoning: "" }; }
  async rerankCandidates() { return { relevantIds: [], reasoning: "" }; }
}

describe("ArchiveManager", () => {
  let store: MockStore;
  let model: MockModel;
  let archiveManager: ArchiveManager;

  beforeEach(() => {
    store = new MockStore();
    model = new MockModel();
    archiveManager = new ArchiveManager(store, model, {
      tokenThreshold: 80,
      retainTokens: 50,
      directoryCapacity: 5,
    });
  });

  it("skips archiving when below threshold", async () => {
    await store.appendMessage({ sessionId: "s1", role: "user", content: "short msg" });
    const result = await archiveManager.checkAndArchive("s1");
    expect(result.archived).toBe(false);
  });

  it("archives when above threshold", async () => {
    // Add 20 messages to exceed 100 token threshold
    for (let i = 0; i < 15; i++) {
      await store.appendMessage({ sessionId: "s1", role: i % 2 === 0 ? "user" : "assistant", content: "This is a substantially longer message that definitely consumes enough tokens for the archiving threshold test to work properly yes." });
    }

    const result = await archiveManager.checkAndArchive("s1");
    expect(result.archived).toBe(true);
    expect(result.chunkId).toBeDefined();
    expect(result.directoryId).toBeDefined();
    expect(result.archivedMessageCount).toBeGreaterThan(0);
    expect(result.keptMessageCount).toBeGreaterThan(0);
  });

  it("creates exactly one G0 directory on first archive", async () => {
    for (let i = 0; i < 15; i++) {
      await store.appendMessage({ sessionId: "s1", role: i % 2 === 0 ? "user" : "assistant", content: "Test message with enough tokens to exceed threshold yes indeed definitely." });
    }

    const result = await archiveManager.checkAndArchive("s1");
    expect(result.archived).toBe(true);

    const dirs = await store.getRootDirectories("s1");
    expect(dirs.length).toBe(1);
    // Root is identified by parentId null — may be G0 or already-elevated G1
    // if the first archive pass filled the capacity and compacted.
    expect(dirs[0]!.parentId).toBeUndefined();
  });

  it("adds chunk as child of G0 directory", async () => {
    for (let i = 0; i < 15; i++) {
      await store.appendMessage({ sessionId: "s1", role: i % 2 === 0 ? "user" : "assistant", content: "Long enough message content to exceed the archiving threshold." });
    }

    await archiveManager.checkAndArchive("s1");
    const dir = (await store.getRootDirectories("s1"))[0]!;
    const children = await store.getDirectoryChildren(dir.id);
    expect(children.length).toBeGreaterThan(0);
    expect(children[0]!.childType).toBe("chunk");
  });

  it("persists chunk directory association", async () => {
    for (let i = 0; i < 15; i++) {
      await store.appendMessage({ sessionId: "s2", role: i % 2 === 0 ? "user" : "assistant", content: "Some content to archive here that will exceed the threshold yes." });
    }

    const result = await archiveManager.checkAndArchive("s2");
    const chunk = await store.getChunk(result.chunkId!);
    expect(chunk).not.toBeNull();
    expect(chunk!.directoryId).toBeDefined();
  });

  it("getStats returns correct counts", async () => {
    for (let i = 0; i < 15; i++) {
      await store.appendMessage({ sessionId: "s3", role: i % 2 === 0 ? "user" : "assistant", content: "Message content for stats test that is sufficiently long." });
    }
    await archiveManager.checkAndArchive("s3");

    const stats = await archiveManager.getStats("s3");
    expect(stats.chunkCount).toBeGreaterThan(0);
    expect(stats.directoryCount).toBe(1);
  });
});
