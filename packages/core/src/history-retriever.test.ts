// ---------------------------------------------------------------------------
// HistoryRetriever tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { HistoryRetriever, type SearchResult } from "./history-retriever.js";
import type { LynageStore, Message, ContextChunk, DirectoryNode, WorkingMemory } from "./index.js";
import type { Embedder } from "./embedder.js";
import { NoopEmbedder } from "./embedder.js";
import type { LynageModel } from "./model.js";

// Embedder mock: records every text it was asked to embed, returns a fixed
// similarity. Used to test the rerank-collapse semantics without a real model.
class RecordingEmbedder implements Embedder {
  readonly name = "mock";
  readonly dimensions = 8;
  confidenceThreshold: number;
  private sim: number;
  seen: string[] = [];
  constructor(sim: number, threshold = 0.4) { this.sim = sim; this.confidenceThreshold = threshold; }
  async embed(text: string): Promise<Float32Array> { this.seen.push(text); return new Float32Array([1, 0]); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> { return texts.map(t => { this.seen.push(t); return new Float32Array([1, 0]); }); }
  similarity(): number { return this.sim; }
}

// Model mock: rerank always returns NO relevant candidates (the failure mode
// that used to collapse the pool to a single chunk).
const rerankEmptyModel = {
  rerankCandidates: async () => ({ relevantIds: [] as string[], reasoning: "none" }),
} as unknown as LynageModel;

// Model mock that COUNTS rerank invocations — used to assert the confidence
// gate skips the LLM call on unambiguous queries and hits the cache on repeats.
class CountingRerankModel {
  rerankCalls = 0;
  rerankCandidates = async () => { this.rerankCalls++; return { relevantIds: [] as string[], reasoning: "counted" }; };
}

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
  async saveMessageEmbeddings() {}
  async getMessageEmbeddings(): Promise<{ messageId: string; vector: Float32Array; createdAt: number }[]> { return []; }
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
  async searchChunks(query: string) {
    return Array.from(this.chunks.values())
      .filter((c) => (c.summary + c.keywords.join(" ") + (c.conclusions ?? []).join(" ") + (c.goals ?? []).join(" ")).toLowerCase().includes(query.toLowerCase()))
      .map((c) => c.id);
  }
  async searchDirectories(query: string) {
    return Array.from(this.dirs.values())
      .filter((d) => (d.overallContent + d.mainConclusions.join(" ") + (d.goals ?? []).join(" ")).toLowerCase().includes(query.toLowerCase()))
      .map((d) => d.id);
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

// ---------------------------------------------------------------------------
// Rerank-collapse semantics (LongMemEval regression): a rerank that returns
// empty used to collapse the candidate pool to ONE chunk, burying proper-noun
// answers ("Summer Vibes") that the rerank's snippet prompt could not see.
// ---------------------------------------------------------------------------

function seedTwoChunks(store: MockStoreForSearch) {
  store.messages = [
    { id: "m1", sessionId: "s1", role: "user", content: "What playlist should I pick?", createdAt: 1000 },
    { id: "m2", sessionId: "s1", role: "assistant", content: "We created a spotify playlist called summer vibes", createdAt: 2000 },
    { id: "m3", sessionId: "s1", role: "user", content: "Which playlist works best?", createdAt: 3000 },
    { id: "m4", sessionId: "s1", role: "assistant", content: "The other playlist is fine too", createdAt: 4000 },
  ];
  store.chunks.set("c1", {
    id: "c1", sessionId: "s1", timeRangeStart: 1000, timeRangeEnd: 2000,
    summary: "discussed the playlist choices", progress: "", keywords: ["playlist"],
    conclusions: [], goals: [], sourceFromId: "m1", sourceToId: "m2", createdAt: 5000,
  });
  store.chunks.set("c2", {
    id: "c2", sessionId: "s1", timeRangeStart: 3000, timeRangeEnd: 4000,
    summary: "playlist preferences", progress: "", keywords: ["playlist"],
    conclusions: [], goals: [], sourceFromId: "m3", sourceToId: "m4", createdAt: 6000,
  });
}

describe("HistoryRetriever rerank-collapse", () => {
  it("keeps the candidate pool when embedding finds strong matches and rerank returns empty", async () => {
    const store = new MockStoreForSearch();
    seedTwoChunks(store);
    const recorder = new RecordingEmbedder(0.5); // sim ≥ threshold → genuine matches
    const retriever = new HistoryRetriever(store, rerankEmptyModel, recorder);

    const result = await retriever.search({ query: "what is the name of the spotify playlist", sessionId: "s1" });

    // Pool preserved instead of collapsing to 1 — the answer chunk stays reachable.
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("collapses to one candidate when embedding finds only weak matches (abstention)", async () => {
    const store = new MockStoreForSearch();
    seedTwoChunks(store);
    const recorder = new RecordingEmbedder(0.2, 0.4); // sim 0.2 < threshold 0.4
    const retriever = new HistoryRetriever(store, rerankEmptyModel, recorder);

    const result = await retriever.search({ query: "what is the name of the spotify playlist", sessionId: "s1" });

    // No genuine semantic match → single best keyword candidate, minimal noise.
    expect(result.candidates.length).toBe(1);
  });

  it("embeds chunk raw messages, not just the AI summary", async () => {
    const store = new MockStoreForSearch();
    // Summary does NOT mention the answer topic — only the raw message does.
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "I made a spotify playlist called summer vibes", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "Nice choice", createdAt: 2000 },
    ];
    store.chunks.set("c1", {
      id: "c1", sessionId: "s1", timeRangeStart: 1000, timeRangeEnd: 2000,
      summary: "bamboo cutting board", progress: "", keywords: [],
      conclusions: [], goals: [], sourceFromId: "m1", sourceToId: "m2", createdAt: 3000,
    });
    const recorder = new RecordingEmbedder(0.5);
    const retriever = new HistoryRetriever(store, rerankEmptyModel, recorder);

    await retriever.search({ query: "what is the name of the spotify playlist", sessionId: "s1" });

    // The embedding channel must have read the chunk's source messages
    // (getMessageRange), so the answer text appears in what was embedded.
    expect(recorder.seen.some((t) => t.includes("summer vibes"))).toBe(true);
  });

  it("uses the message-level index when it exists (no per-chunk embedding)", async () => {
    const store = new MockStoreForSearch();
    seedTwoChunks(store);
    // Precomputed message index: m1 → c1 (createdAt 1000), m3 → c2 (3000).
    store.getMessageEmbeddings = async () => [
      { messageId: "m1", vector: new Float32Array([1, 0]), createdAt: 1000 },
      { messageId: "m3", vector: new Float32Array([1, 0]), createdAt: 3000 },
    ];
    const recorder = new RecordingEmbedder(0.5);
    const retriever = new HistoryRetriever(store, rerankEmptyModel, recorder);

    const result = await retriever.search({ query: "what is the name of the spotify playlist", sessionId: "s1" });

    // Message index path: ONLY the query was embedded — no per-chunk embeds.
    expect(recorder.seen.length).toBe(1);
    expect(recorder.seen[0]).toBe("what is the name of the spotify playlist");
    // Both chunks matched via their embedded messages.
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    // The top message ids are recorded on the candidates (Phase B input).
    expect(result.candidates.some((c) => (c.topMessageIds ?? []).includes("m1"))).toBe(true);
    expect(result.candidates.some((c) => (c.topMessageIds ?? []).includes("m3"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Confidence gate (search latency): the ~5s LLM rerank must be skipped when
// retrieval already has a clear leader, and cached for repeated ambiguous
// queries. `ambiguous=true` seeds two near-identical chunks so the blended
// scores tie; `false` seeds a clear winner.
// ---------------------------------------------------------------------------

function seedGateStore(store: MockStoreForSearch, ambiguous: boolean) {
  store.messages = [
    { id: "m1", sessionId: "s1", role: "user", content: "we chose the spotify playlist", createdAt: 1000 },
    { id: "m2", sessionId: "s1", role: "assistant", content: "good call", createdAt: 2000 },
    { id: "m3", sessionId: "s1", role: "user", content: ambiguous ? "the spotify playlist option" : "about the playlist preference", createdAt: 3000 },
    { id: "m4", sessionId: "s1", role: "assistant", content: "ok", createdAt: 4000 },
  ];
  const mk = (id: string, summary: string, from: string, to: string, ts: number): ContextChunk => ({
    id, sessionId: "s1", timeRangeStart: ts, timeRangeEnd: ts + 1000,
    summary, progress: "", keywords: [], conclusions: [], goals: [],
    sourceFromId: from, sourceToId: to, createdAt: ts + 2000,
  });
  store.chunks.set("c1", mk("c1", ambiguous ? "the spotify playlist decision" : "the spotify playlist decision was made", "m1", "m2", 1000));
  store.chunks.set("c2", mk("c2", ambiguous ? "the playlist spotify choice" : "playlist preferences", "m3", "m4", 3000));
  // Fillers keep the FTS match rate below 40% so the 1a-bis refinement doesn't
  // collapse the pool before the gate can be exercised.
  for (let i = 0; i < 6; i++) {
    store.chunks.set(`f${i}`, mk(`f${i}`, `filler topic ${i}`, `fx${i}`, `fy${i}`, 10000 + i * 1000));
  }
}

describe("HistoryRetriever rerank confidence gate", () => {
  it("skips the LLM rerank when retrieval is confident", async () => {
    const store = new MockStoreForSearch();
    seedGateStore(store, false);
    const counting = new CountingRerankModel();
    const retriever = new HistoryRetriever(store, counting as unknown as LynageModel, new NoopEmbedder());

    const result = await retriever.search({ query: "spotify playlist", sessionId: "s1" });

    expect(counting.rerankCalls).toBe(0);
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("runs the LLM rerank when candidates are ambiguous", async () => {
    const store = new MockStoreForSearch();
    seedGateStore(store, true);
    const counting = new CountingRerankModel();
    const retriever = new HistoryRetriever(store, counting as unknown as LynageModel, new NoopEmbedder());

    await retriever.search({ query: "spotify playlist", sessionId: "s1" });

    expect(counting.rerankCalls).toBe(1);
  });

  it("serves repeated ambiguous queries from cache (one rerank call total)", async () => {
    const store = new MockStoreForSearch();
    seedGateStore(store, true);
    const counting = new CountingRerankModel();
    const retriever = new HistoryRetriever(store, counting as unknown as LynageModel, new NoopEmbedder());

    await retriever.search({ query: "spotify playlist", sessionId: "s1" });
    await retriever.search({ query: "spotify playlist", sessionId: "s1" });

    expect(counting.rerankCalls).toBe(1);
  });

  it("honors a strict rerankTolerance (clear leader still reranks)", async () => {
    // seedGateStore(false) has a clear leader (top1=0.5, margin=0.25). A strict
    // tolerance (top1 >= 0.6) makes it NOT confident → rerank runs.
    const store = new MockStoreForSearch();
    seedGateStore(store, false);
    const counting = new CountingRerankModel();
    const retriever = new HistoryRetriever(store, counting as unknown as LynageModel, new NoopEmbedder());

    await retriever.search({ query: "spotify playlist", sessionId: "s1", rerankTolerance: { top1: 0.6, margin: 0.4 } });

    expect(counting.rerankCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Search optimizations: binary-search message bucketing (1b) + context options
// ---------------------------------------------------------------------------

describe("HistoryRetriever optimizations", () => {
  it("buckets FTS messages into chunks by time range (binary search, not full filter)", async () => {
    const store = new MockStoreForSearch();
    store.messages = [
      { id: "m1", sessionId: "s1", role: "user", content: "common word alpha", createdAt: 1000 },
      { id: "m2", sessionId: "s1", role: "assistant", content: "common word beta", createdAt: 2000 },
      { id: "m3", sessionId: "s1", role: "user", content: "common word gamma", createdAt: 5000 },
      { id: "m4", sessionId: "s1", role: "assistant", content: "common word delta", createdAt: 6000 },
    ];
    const mk = (id: string, from: string, to: string, s: number, e: number): ContextChunk => ({
      id, sessionId: "s1", timeRangeStart: s, timeRangeEnd: e,
      summary: `${id} summary`, progress: "", keywords: [], conclusions: [], goals: [],
      sourceFromId: from, sourceToId: to, createdAt: e + 1000,
    });
    store.chunks.set("c1", mk("c1", "m1", "m2", 1000, 2000));
    store.chunks.set("c2", mk("c2", "m3", "m4", 5000, 6000));
    store.chunks.set("c3", mk("c3", "m9", "m10", 9000, 10000)); // empty range — no messages
    const retriever = new HistoryRetriever(store);

    const result = await retriever.search({ query: "common word", sessionId: "s1" });

    const ids = result.candidates.map((c) => c.contextId).sort();
    expect(ids).toEqual(["c1", "c2"]); // c3 has no messages in range → excluded
  });

  it("compileRetrievedContext caps candidates via maxCandidates", () => {
    const retriever = new HistoryRetriever(new MockStoreForSearch());
    const result: SearchResult = {
      status: "found",
      candidates: [0, 1, 2, 3].map((i) => ({
        contextId: `c${i}`,
        summary: `summary ${i}`,
        progress: "",
        keywords: [],
        conclusions: [],
        goals: [],
        sourceRange: { from: "m", to: "m" },
        timeRange: { start: 1000 + i, end: 2000 + i },
        relevance: 0.9 - i * 0.1,
      })),
      searchedDirectories: 0,
      totalChunksChecked: 0,
    };

    const text = retriever.compileRetrievedContext(result, undefined, 2);
    expect(text.match(/## Result/g)?.length).toBe(2);
  });

  it("compileRetrievedContext truncates long summaries via maxSummaryChars", () => {
    const retriever = new HistoryRetriever(new MockStoreForSearch());
    const result: SearchResult = {
      status: "found",
      candidates: [{
        contextId: "c0",
        summary: "A".repeat(500),
        progress: "",
        keywords: [],
        conclusions: [],
        goals: [],
        sourceRange: { from: "m", to: "m" },
        timeRange: { start: 1000, end: 2000 },
        relevance: 0.9,
      }],
      searchedDirectories: 0,
      totalChunksChecked: 0,
    };

    const text = retriever.compileRetrievedContext(result, undefined, 1, 100);
    expect(text.length).toBeLessThan(300); // 100-char summary + scaffolding, not 500
    expect(text.includes("A".repeat(500))).toBe(false);
  });
});
