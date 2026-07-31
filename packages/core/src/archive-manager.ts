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
import type { LynageModel } from "./model.js";
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

  constructor(store: LynageStore, model: LynageModel, config: ArchiveConfig) {
    this.store = store;
    this.model = model;
    this.config = config;
    this.compactor = new GenerationCompactor(store, model, config.directoryCapacity);
  }

  /**
   * Check if recent context exceeds the threshold, and archive if so.
   */
  async checkAndArchive(sessionId: string): Promise<ArchiveResult> {
    // 0. Find the last archived timestamp to avoid re-archiving
    const existingChunks = await this.store.listChunks(sessionId);
    const lastArchiveTime = existingChunks.length > 0
      ? Math.max(...existingChunks.map((c) => c.timeRangeEnd))
      : 0;

    // 1. Get only messages newer than the last archive
    const recent = await this.store.getRecent({
      sessionId,
      since: lastArchiveTime,
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

    // 7. Generate chunk summary from the model
    const summary = await this.model.summarizeChunk({
      messages: toArchive,
    });

    // 8. Create the Context Chunk
    const chunk = await this.store.createChunk({
      sessionId,
      timeRangeStart: toArchive[0]!.createdAt,
      timeRangeEnd: toArchive[toArchive.length - 1]!.createdAt,
      summary: summary.summary,
      progress: summary.progress,
      keywords: summary.keywords,
      sourceFromId: toArchive[0]!.id,
      sourceToId: toArchive[toArchive.length - 1]!.id,
    });

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

    // 10. Add chunk as child of the G0 directory
    const children = await this.store.getDirectoryChildren(g0Dir.id);
    await this.store.addChildToDirectory({
      id: generateId(),
      directoryId: g0Dir.id,
      childType: "chunk",
      childId: chunk.id,
      sortOrder: children.length,
    });

    // 11. Persist the chunk's directory association
    await this.store.updateChunkDirectory(chunk.id, g0Dir.id);

    // 12. Check generational compaction for all root dirs (M5)
    const allRootDirs = await this.store.getRootDirectories(sessionId);
    for (const rootDir of allRootDirs) {
      await this.compactor.checkAndCompact(rootDir.id);
    }

    return {
      archived: true,
      chunkId: chunk.id,
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
