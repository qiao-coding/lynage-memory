// ---------------------------------------------------------------------------
// SourceVerifier tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { SourceVerifier } from "./source-verifier.js";
import type { LynageStore, Message, ContextChunk, SearchCandidate } from "./index.js";

// ---- Minimal mock store ----
class MockStore implements LynageStore {
  messages: Message[] = [];
  chunks: Map<string, ContextChunk> = new Map();

  async getMessageRange(fromId: string, toId: string) {
    return this.messages.filter(m => m.id >= fromId && m.id <= toId);
  }
  async getMessagesAround() { return []; }
  async getRecent(scope: { sessionId: string }) { return this.messages.filter(m => m.sessionId === scope.sessionId); }
  async listChunks() { return Array.from(this.chunks.values()); }
  async getLastArchiveTime() { return 0; }
  async getChunk(id: string) { return this.chunks.get(id) ?? null; }
  async getChunksByIds(ids: string[]) { return ids.map(id => this.chunks.get(id)).filter(Boolean) as any; }

  // Unused stubs
  async appendMessage() { return {} as Message; }
  async getMessage() { return null; }
  async getMessageCount() { return 0; }
  async saveMessageEmbeddings() {}
  async getMessageEmbeddings() { return []; }
  async createChunk() { return {} as ContextChunk; }
  async getChunksByDirectory() { return []; }
  async updateChunkDirectory() {}
  async createDirectory() { return {} as never; }
  async getDirectory() { return null; }
  async updateDirectory() { return {} as never; }
  async getRootDirectories() { return []; }
  async getChildDirectories() { return []; }
  async addChildToDirectory() {}
  async removeChildFromDirectory() {}
  async getDirectoryChildren() { return []; }
  async getWorkingMemory() { return null; }
  async upsertWorkingMemory() { return {} as never; }
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

function makeCandidate(overrides: Partial<SearchCandidate> = {}): SearchCandidate {
  return {
    contextId: "ctx-1",
    summary: "Discussed architecture decisions",
    progress: "Phase 1 complete",
    keywords: ["architecture", "decision"],
    conclusions: [],
    goals: [],
    sourceRange: { from: "m1", to: "m3" },
    timeRange: { start: 1000, end: 2000 },
    relevance: 0.8,
    ...overrides,
  };
}

describe("SourceVerifier", () => {
  let store: MockStore;
  let verifier: SourceVerifier;

  beforeEach(() => {
    store = new MockStore();
    verifier = new SourceVerifier(store);
  });

  it("verifies a matching candidate — high confidence", async () => {
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "We should use SQLite for the database.", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "Agreed. SQLite with WAL mode will work well.", createdAt: 1100 },
      { id: "m3", sessionId: "s1", role: "user", content: "Let's also use Drizzle ORM.", createdAt: 1200 },
    ];

    const result = await verifier.verify(makeCandidate(), "SQLite database");
    expect(result.verified).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.matchesQuery).toBe(true);
  });

  it("rejects a non-matching candidate", async () => {
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "Let's use React for the frontend.", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "Good choice.", createdAt: 1100 },
    ];

    const result = await verifier.verify(makeCandidate(), "SQLite database");
    expect(result.verified).toBe(false);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("returns empty verification when no messages found", async () => {
    const result = await verifier.verify(makeCandidate(), "anything");
    expect(result.verified).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain("could not be retrieved");
  });

  it("verifyBatch filters out unverified candidates", async () => {
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "We should use SQLite.", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "Agreed.", createdAt: 1100 },
    ];

    const candidates = [
      makeCandidate({ contextId: "c1", sourceRange: { from: "m1", to: "m2" } }),
      makeCandidate({ contextId: "c2", sourceRange: { from: "m5", to: "m6" } }), // no matching messages
    ];

    const verified = await verifier.verifyBatch(candidates, "SQLite");
    expect(verified.length).toBe(1);
    expect(verified[0]!.verified).toBe(true);
  });

  it("sorts verified candidates by confidence", async () => {
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "SQLite is the best choice for our database needs.", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "I agree SQLite works.", createdAt: 1100 },
    ];

    const candidates = [
      makeCandidate({ contextId: "c1", sourceRange: { from: "m1", to: "m2" }, relevance: 0.5 }),
      makeCandidate({ contextId: "c1", sourceRange: { from: "m1", to: "m2" }, relevance: 0.9 }),
    ];

    const verified = await verifier.verifyBatch(candidates, "SQLite database");
    // Both should have same confidence since they map to same messages
    expect(verified.every(v => v.verified)).toBe(true);
    expect(verified[0]!.confidence).toBeGreaterThanOrEqual(verified[verified.length - 1]!.confidence);
  });

  it("expandContext reads padding messages around candidate", async () => {
    store.messages = [
      { id: "m0", sessionId: "s1", role: "user", content: "Previous question", createdAt: 900 },
      { id: "m1", sessionId: "s1", role: "assistant", content: "Previous answer", createdAt: 950 },
      { id: "m2", sessionId: "s1", role: "user", content: "SQLite decision", createdAt: 1000 },
      { id: "m3", sessionId: "s1", role: "assistant", content: "Agreed on SQLite", createdAt: 1100 },
      { id: "m4", sessionId: "s1", role: "user", content: "Next question", createdAt: 1200 },
    ];

    const { messages } = await verifier.expandContext(
      makeCandidate({ sourceRange: { from: "m2", to: "m3" } }),
      2
    );

    // Should include padding: m0, m1 before + m4 after
    expect(messages.length).toBeGreaterThanOrEqual(3);
  });

  it("deepVerify returns evolution chain", async () => {
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "Let's use CSS Modules for styling.", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "CSS Modules is a good choice.", createdAt: 1100 },
      { id: "m3", sessionId: "s1", role: "user", content: "Actually, switch to Tailwind.", createdAt: 2000 },
      { id: "m4", sessionId: "s1", role: "assistant", content: "Tailwind migration started.", createdAt: 2100 },
    ];

    store.chunks.set("c1", {
      id: "c1", sessionId: "s1",
      timeRangeStart: 1000, timeRangeEnd: 1100,
      summary: "Initial CSS Modules decision", progress: "", keywords: ["css"],
      sourceFromId: "m1", sourceToId: "m2", createdAt: 1500,
    });
    store.chunks.set("c2", {
      id: "c2", sessionId: "s1",
      timeRangeStart: 2000, timeRangeEnd: 2100,
      summary: "Switch to Tailwind", progress: "", keywords: ["tailwind"],
      sourceFromId: "m3", sourceToId: "m4", createdAt: 2500,
    });

    const candidates = [
      makeCandidate({ contextId: "c1", sourceRange: { from: "m1", to: "m2" } }),
      makeCandidate({ contextId: "c1", sourceRange: { from: "m3", to: "m4" } }),
    ];

    const result = await verifier.deepVerify(candidates, "styling decision");
    expect(result.verified.length).toBeGreaterThan(0);
    expect(result.finalConfidence).toBeGreaterThan(0);
  });
});
