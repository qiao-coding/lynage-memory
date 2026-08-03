// ---------------------------------------------------------------------------
// ArchiveManager — triggers archiving when recent context exceeds threshold
//
// Flow:
//   recent exceeds threshold
//   → find natural boundary
//   → create Context Chunk from old messages
//   → ask model to summarize the chunk
//   → add chunk to G0 directory (or create G0 if none)
//   → if directory exceeds capacity, trigger directory summary update
//   → recent context retains only the newer portion
// ---------------------------------------------------------------------------

import type { Message } from "./types.js";
import type { LynageStore } from "./store.js";
import type { LynageModel, DirectorySummary, ChunkSummary } from "./model.js";
import { findNaturalBoundary } from "./boundary-detector.js";
import { estimateMessagesTokenCount, estimateTokenCount } from "./token-counter.js";
import { GenerationCompactor } from "./generation-compactor.js";

export interface ArchiveConfig {
  /** Token threshold to trigger archiving */
  tokenThreshold: number;
  /** Tokens to retain after archiving */
  retainTokens: number;
  /** Max children per G0 directory before compaction warning */
  directoryCapacity: number;
}

export interface ArchiveResult {
  archived: boolean;
  chunkId?: string;
  directoryId?: string;
  keptMessageCount: number;
  archivedMessageCount: number;
}

export class ArchiveManager {
  private store: LynageStore;
  private model: LynageModel;
  private config: ArchiveConfig;
  private compactor: GenerationCompactor;
  /** Per-session archiving state — at most one running task per session */
  private sessionBusy = new Set<string>();
  private sessionDirty = new Set<string>();
  private sessionTask = new Map<string, Promise<void>>();
  /** Per-session archive pass counter — throttles full directory re-summarization */
  private sessionPass = new Map<string, number>();
  /** Full directory re-summarization frequency (every K archive passes) */
  private static readonly DIR_SUMMARY_EVERY = 5;

  constructor(store: LynageStore, model: LynageModel, config: ArchiveConfig) {
    this.store = store;
    this.model = model;
    this.config = config;
    this.compactor = new GenerationCompactor(store, model, config.directoryCapacity);
  }

  /**
   * Fire-and-forget archiving, merged per session.
   * At most ONE archiving task runs per session. New turns while running
   * only mark the session dirty — the running task re-checks when done.
   * Prevents a 10k-turn loop from queuing 10k serial AI calls.
   */
  queueArchive(sessionId: string): void {
    if (this.sessionBusy.has(sessionId)) {
      this.sessionDirty.add(sessionId); // re-check after current run finishes
      return;
    }
    this.sessionBusy.add(sessionId);
    const task = (async () => {
      try {
        do {
          this.sessionDirty.delete(sessionId);
          await this.checkAndArchive(sessionId);
        } while (this.sessionDirty.has(sessionId));
      } catch (err) {
        console.error(`Archiving failed for ${sessionId}:`, err instanceof Error ? err.message : err);
      } finally {
        this.sessionBusy.delete(sessionId);
        this.sessionTask.delete(sessionId);
      }
    })();
    this.sessionTask.set(sessionId, task);
  }

  /** Await background archiving to drain for a session (for tests / shutdown). */
  waitForIdle(sessionId: string): Promise<void> {
    return this.sessionTask.get(sessionId) ?? Promise.resolve();
  }

  /**
   * Check if recent context exceeds the threshold, and archive if so.
   */
  async checkAndArchive(sessionId: string): Promise<ArchiveResult> {
    // 0. Find the last archived timestamp to avoid re-archiving (single MAX query)
    const lastArchiveTime = await this.store.getLastArchiveTime(sessionId);

    // 1. Get only messages newer than the last archive.
    //    Traverse OLDEST-first from the cursor so ALL unarchived messages
    //    get covered — not just the most recent 100. Batch of 200 per pass.
    const recent = await this.store.getRecent({
      sessionId,
      since: lastArchiveTime,
      limit: 200,
      asc: true,
    });

    // 2. Compute token estimate
    const totalTokens = estimateMessagesTokenCount(recent);

    // 3. Below threshold — skip
    if (totalTokens < this.config.tokenThreshold) {
      return { archived: false, keptMessageCount: recent.length, archivedMessageCount: 0 };
    }

    // 4. Find where to split: keep retainTokens worth of messages
    const splitIndex = findRetainIndex(recent, this.config.retainTokens);

    // 5. Find natural boundary near the split
    const boundaryIndex = findNaturalBoundary(recent, splitIndex);

    // If boundary is too close to start or end, skip archiving
    if (boundaryIndex <= 0 || boundaryIndex >= recent.length - 1) {
      return { archived: false, keptMessageCount: recent.length, archivedMessageCount: 0 };
    }

    // 6. Split messages
    const toArchive = recent.slice(0, boundaryIndex);

    if (toArchive.length === 0) {
      return { archived: false, keptMessageCount: recent.length, archivedMessageCount: 0 };
    }

    // 7. Split into chunk-sized batches (~4000 tokens each) and summarize
    //    in PARALLEL — this is the throughput bottleneck (AI call ~3-5s each).
    const batches = splitByTokens(toArchive, this.config.retainTokens);
    const CONCURRENCY = 4;
    const summaries: ChunkSummary[] = [];
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((batch) => this.model.summarizeChunk({ messages: batch })),
      );
      summaries.push(...results);
    }

    // 8. Create Context Chunks (one per batch)
    const chunks = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const summary = summaries[i]!;
      const chunk = await this.store.createChunk({
        sessionId,
        timeRangeStart: batch[0]!.createdAt,
        timeRangeEnd: batch[batch.length - 1]!.createdAt,
        summary: summary.summary,
        progress: summary.progress,
        // Normalize — LLM may return non-array; Drizzle json mode breaks
        keywords: Array.isArray(summary.keywords) ? summary.keywords : [],
        conclusions: Array.isArray(summary.conclusions) ? summary.conclusions : [],
        goals: Array.isArray(summary.goals) ? summary.goals : [],
        sourceFromId: batch[0]!.id,
        sourceToId: batch[batch.length - 1]!.id,
      });
      chunks.push(chunk);
    }

    // 9. Find or create the G0 root directory for this session
    const g0Dirs = await this.store.getRootDirectories(sessionId);
    let g0Dir = g0Dirs[0];

    if (!g0Dir) {
      g0Dir = await this.store.createDirectory({
        sessionId,
        generation: 0,
        timeRangeStart: toArchive[0]!.createdAt,
        timeRangeEnd: toArchive[toArchive.length - 1]!.createdAt,
        overallContent: "Active session context chunks.",
        progress: "Session in progress.",
        mainConclusions: [],
        importantChanges: [],
      });
    } else {
      // Update directory time range
      await this.store.updateDirectory(g0Dir.id, {
        timeRangeStart: Math.min(g0Dir.timeRangeStart, toArchive[0]!.createdAt),
        timeRangeEnd: Math.max(g0Dir.timeRangeEnd, toArchive[toArchive.length - 1]!.createdAt),
      });
    }

    // 10. Add chunks as children of the G0 directory
    const children = await this.store.getDirectoryChildren(g0Dir.id);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await this.store.addChildToDirectory({
        id: generateId(),
        directoryId: g0Dir.id,
        childType: "chunk",
        childId: chunk.id,
        sortOrder: children.length + i,
      });
      await this.store.updateChunkDirectory(chunk.id, g0Dir.id);
    }

    // 11. Update the G0 directory summary so the parent context actually
    //     reflects the chunk contents (search drill-down matches on this).
    //     Use LLM summarizeDirectory for a coherent summary (like G1+).
    //
    //     THROTTLED: full LLM re-summarization over ALL chunks is O(N²) as
    //     chunks grow. Only do it every DIR_SUMMARY_EVERY passes; intermediate
    //     passes cheaply merge the NEW chunks' keywords/conclusions into the
    //     existing summary.
    const pass = (this.sessionPass.get(sessionId) ?? 0) + 1;
    this.sessionPass.set(sessionId, pass);

    let dirSummary: DirectorySummary;
    if (pass % ArchiveManager.DIR_SUMMARY_EVERY === 0) {
      const allChunks = await this.store.listChunks(sessionId);
      const childDescriptions = allChunks.map((c) => ({
        id: c.id,
        type: "chunk" as const,
        summary: c.summary,
        progress: c.progress,
        conclusions: c.conclusions ?? [],
        importantChanges: [],
        keywords: c.keywords,
        // DirectorySummaryInput has no goals field on child; pass via keywords extra
      }));
      try {
        dirSummary = await this.model.summarizeDirectory({
          directoryId: g0Dir.id,
          timeRangeStart: g0Dir.timeRangeStart,
          timeRangeEnd: g0Dir.timeRangeEnd,
          childDescriptions,
        });
      } catch {
        // Fallback: keyword aggregation
        const dirKeywords = [...new Set(allChunks.flatMap((c) => c.keywords))];
        const dirConclusions = [...new Set(allChunks.flatMap((c) => c.conclusions ?? []))];
        dirSummary = {
          overallContent: "Phases covered: " + dirKeywords.slice(0, 30).join(", "),
          progress: `Archived ${allChunks.length} windows`,
          mainConclusions: dirConclusions.slice(0, 20),
          importantChanges: [],
          goals: [],
        };
      }
    } else {
      // Cheap incremental merge: fold NEW chunks' conclusions/goals/keywords
      // into the existing summary. No AI call, no O(N) re-scan.
      const newConclusions = [...new Set(chunks.flatMap((c) => c.conclusions ?? []))];
      const newGoals = [...new Set(chunks.flatMap((c) => c.goals ?? []))];
      const newKeywords = [...new Set(chunks.flatMap((c) => c.keywords))];
      dirSummary = {
        overallContent: g0Dir.overallContent,
        progress: g0Dir.progress,
        mainConclusions: [...new Set([...g0Dir.mainConclusions, ...newConclusions])].slice(0, 20),
        importantChanges: g0Dir.importantChanges,
        goals: [...new Set([...g0Dir.goals ?? [], ...newGoals])].slice(0, 20),
      };
      if (newKeywords.length > 0) {
        dirSummary.overallContent += " [recent: " + newKeywords.slice(0, 8).join(", ") + "]";
      }
    }
    await this.store.updateDirectory(g0Dir.id, {
      overallContent: dirSummary.overallContent,
      progress: dirSummary.progress,
      // Normalize — LLM may return strings; Drizzle json mode breaks on raw strings
      mainConclusions: Array.isArray(dirSummary.mainConclusions) ? dirSummary.mainConclusions : [],
      importantChanges: Array.isArray(dirSummary.importantChanges) ? dirSummary.importantChanges : [],
      goals: Array.isArray(dirSummary.goals) ? dirSummary.goals : [],
    });

    // 12. Check generational compaction for all root dirs (M5)
    const allRootDirs = await this.store.getRootDirectories(sessionId);
    for (const rootDir of allRootDirs) {
      await this.compactor.checkAndCompact(rootDir.id);
    }

    return {
      archived: true,
      chunkId: chunks[0]?.id,
      directoryId: g0Dir.id,
      keptMessageCount: recent.length - toArchive.length,
      archivedMessageCount: toArchive.length,
    };
  }

  /** Get archive statistics for a session */
  async getStats(sessionId: string) {
    const chunkCount = (await this.store.listChunks(sessionId)).length;
    const dirs = await this.store.getRootDirectories(sessionId);
    const messageCount = await this.store.getMessageCount(sessionId);
    return {
      sessionId,
      chunkCount,
      directoryCount: dirs.length,
      totalMessages: messageCount,
    };
  }
}

// ---- Helpers ----

let _idCounter = 0;
function generateId(): string {
  return `id-${Date.now()}-${++_idCounter}`;
}

/**
 * Split messages into batches each up to `batchTokens` worth of tokens.
 * Used to parallelize AI summarization into multiple chunks.
 */
function splitByTokens(messages: Message[], batchTokens: number): Message[][] {
  const batches: Message[][] = [];
  let current: Message[] = [];
  let tokens = 0;
  for (const msg of messages) {
    const t = msg.tokenCount ?? estimateTokenCount(msg.content);
    if (current.length > 0 && tokens + t > batchTokens) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(msg);
    tokens += t;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Find the index (exclusive) of messages to keep, counting tokens
 * from the end backwards to retain at least `retainTokens` worth.
 */
function findRetainIndex(messages: Message[], retainTokens: number): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    // Use recorded tokenCount if available, otherwise CJK-aware estimate
    tokens += msg.tokenCount ?? estimateTokenCount(msg.content);
    if (tokens >= retainTokens) {
      return i;
    }
  }
  return 0;
}
