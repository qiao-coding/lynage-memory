// ---------------------------------------------------------------------------
// ParallelSearchCoordinator — shared-context parallel memory search
//
// Per architecture.md §10-§11:
//   1. Create unified project snapshot (goal, progress, decisions, question)
//   2. Dispatch workers — each reads a different directory subtree
//   3. Workers return evidence positions only (no WM modification)
//   4. Main process merges, deduplicates, verifies, and rebuilds
//      the information evolution chain
//
// Workers are concurrent async tasks (in-process), not OS processes.
// ---------------------------------------------------------------------------

import type { LynageStore } from "./store.js";
import type { Message, DirectoryNode, ContextChunk } from "./types.js";
import type { HistoryRetriever, SearchCandidate, DirectoryContext } from "./history-retriever.js";
import { SourceVerifier, type VerifiedCandidate } from "./source-verifier.js";

// ---- Types ----

export interface ProjectSnapshot {
  snapshotId: string;
  projectGoal: string;
  currentProgress: string;
  knownDecisions: string[];
  question: string;
  searchGoal: string;
}

export interface WorkerInput {
  workerId: string;
  snapshot: ProjectSnapshot;
  directoryId: string;
}

export interface WorkerResult {
  workerId: string;
  checkedNodes: string[];
  candidates: Array<{
    chunkId: string;
    sourceRange: { from: string; to: string };
    reason: string;
    confidence: number;
  }>;
}

export interface ParallelSearchResult {
  snapshot: ProjectSnapshot;
  totalWorkers: number;
  totalDirectoriesSearched: number;
  mergedCandidates: VerifiedCandidate[];
  evolutionChain: string[];
  finalConfidence: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// ParallelSearchCoordinator
// ---------------------------------------------------------------------------

export class ParallelSearchCoordinator {
  private store: LynageStore;
  private historyRetriever: HistoryRetriever;
  private verifier: SourceVerifier;

  constructor(store: LynageStore, historyRetriever: HistoryRetriever) {
    this.store = store;
    this.historyRetriever = historyRetriever;
    this.verifier = new SourceVerifier(store);
  }

  /**
   * Execute a parallel search across multiple directory trees.
   *
   * 1. Collect all root directories
   * 2. Distribute among workers
   * 3. Run workers concurrently
   * 4. Merge, deduplicate, verify
   * 5. Rebuild evolution chain
   */
  async search(
    sessionId: string,
    snapshot: ProjectSnapshot,
  ): Promise<ParallelSearchResult> {
    // ---- Step 1: Collect all directory IDs to search ----
    const rootDirs = await this.store.getRootDirectories(sessionId);
    const allDirIds = await this.flattenDirectoryTree(
      rootDirs.map((d) => d.id),
    );

    if (allDirIds.length === 0) {
      return {
        snapshot,
        totalWorkers: 0,
        totalDirectoriesSearched: 0,
        mergedCandidates: [],
        evolutionChain: [],
        finalConfidence: 0,
        summary: "No directories to search.",
      };
    }

    // ---- Step 2: Distribute directories among workers ----
    const workerCount = Math.min(4, allDirIds.length);
    const dirsPerWorker = Math.ceil(allDirIds.length / workerCount);

    const workerInputs: WorkerInput[] = [];
    for (let w = 0; w < workerCount; w++) {
      const start = w * dirsPerWorker;
      const end = Math.min(start + dirsPerWorker, allDirIds.length);
      const dirIds = allDirIds.slice(start, end);

      // Each worker gets a distinct directory
      for (const dirId of dirIds) {
        workerInputs.push({
          workerId: `worker-${w}`,
          snapshot,
          directoryId: dirId,
        });
      }
    }

    // ---- Step 3: Run workers concurrently ----
    const workerPromises = workerInputs.map((input) =>
      this.runWorker(input),
    );
    const workerResults = await Promise.all(workerPromises);

    // ---- Step 4: Merge and deduplicate ----
    const allCandidates = workerResults.flatMap((r) => r.candidates);
    const deduped = this.deduplicateCandidates(allCandidates);

    // ---- Step 5: Verify candidates against original messages ----
    const searchCandidates: SearchCandidate[] = await Promise.all(
      deduped.map(async (c) => {
        let directoryContext: DirectoryContext | undefined;
        const chunk = await this.store.getChunk(c.chunkId);
        if (chunk?.directoryId) {
          const dir = await this.store.getDirectory(chunk.directoryId);
          if (dir) {
            directoryContext = {
              directoryId: dir.id,
              generation: dir.generation,
              overallContent: dir.overallContent,
              progress: dir.progress,
              mainConclusions: dir.mainConclusions,
              importantChanges: dir.importantChanges,
            };
          }
        }
        return {
          contextId: c.chunkId,
          summary: c.reason,
          progress: "",
          keywords: [],
          sourceRange: c.sourceRange,
          timeRange: { start: 0, end: 0 },
          relevance: c.confidence,
          directoryContext,
        };
      }),
    );

    const verified = await this.verifier.verifyBatch(
      searchCandidates,
      snapshot.question,
    );

    // ---- Step 6: Rebuild evolution chain ----
    const { evolutionChain, finalConfidence } =
      await this.rebuildEvolutionChain(verified, sessionId);

    // ---- Step 7: Generate summary ----
    const summary = this.generateSummary(
      snapshot,
      verified,
      workerResults.length,
      allDirIds.length,
    );

    return {
      snapshot,
      totalWorkers: workerCount,
      totalDirectoriesSearched: allDirIds.length,
      mergedCandidates: verified,
      evolutionChain,
      finalConfidence,
      summary,
    };
  }

  /**
   * Single worker: reads one directory, searches for evidence matching the snapshot question.
   * Returns only evidence positions — does NOT modify Working Memory.
   */
  private async runWorker(input: WorkerInput, visited = new Set<string>()): Promise<WorkerResult> {
    const checkedNodes: string[] = [];
    const candidates: WorkerResult["candidates"] = [];

    if (visited.has(input.directoryId)) return { workerId: input.workerId, checkedNodes: [], candidates: [] }; // Prevent cycles
    visited.add(input.directoryId);

    const dir = await this.store.getDirectory(input.directoryId);
    if (!dir) {
      return {
        workerId: input.workerId,
        checkedNodes: [input.directoryId],
        candidates: [],
      };
    }

    checkedNodes.push(input.directoryId);

    // Check directory summary against the question
    const relevance = this.computeRelevance(
      input.snapshot.question,
      dir.overallContent,
    );

    if (relevance > 0.2) {
      // Search chunks within this directory
      const chunks = await this.store.getChunksByDirectory(input.directoryId);

      for (const chunk of chunks) {
        const chunkRelevance = this.computeRelevance(
          input.snapshot.question,
          chunk.summary + " " + chunk.keywords.join(" "),
        );

        if (chunkRelevance > 0.3) {
          candidates.push({
            chunkId: chunk.id,
            sourceRange: {
              from: chunk.sourceFromId,
              to: chunk.sourceToId,
            },
            reason: `Found in ${input.directoryId}: ${chunk.summary}`,
            confidence: chunkRelevance,
          });
        }
      }
    }

    // Recursively check child directories
    const children = await this.store.getDirectoryChildren(input.directoryId);
    for (const child of children) {
      if (child.childType === "directory") {
        const subResult = await this.runWorker({
          workerId: input.workerId,
          snapshot: input.snapshot,
          directoryId: child.childId,
        });
        checkedNodes.push(...subResult.checkedNodes);
        candidates.push(...subResult.candidates);
      }
    }

    return {
      workerId: input.workerId,
      checkedNodes,
      candidates,
    };
  }

  /**
   * Deduplicate candidates with overlapping source ranges.
   */
  private deduplicateCandidates(
    candidates: WorkerResult["candidates"],
  ): WorkerResult["candidates"] {
    const seen = new Set<string>();
    const deduped: WorkerResult["candidates"] = [];

    for (const c of candidates) {
      const key = `${c.sourceRange.from}-${c.sourceRange.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(c);
      } else {
        // Merge: take the higher confidence
        const existing = deduped.find(
          (d) =>
            d.sourceRange.from === c.sourceRange.from &&
            d.sourceRange.to === c.sourceRange.to,
        );
        if (existing && c.confidence > existing.confidence) {
          existing.confidence = c.confidence;
          existing.reason = c.reason;
        }
      }
    }

    return deduped.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Rebuild the information evolution chain from verified candidates
   * and related chunks. Satisfies architecture.md §11.
   */
  private async rebuildEvolutionChain(
    verified: VerifiedCandidate[],
    sessionId: string,
  ): Promise<{ evolutionChain: string[]; finalConfidence: number }> {
    const chain: string[] = [];
    const allChunks = await this.store.listChunks(sessionId);
    const seenIds = new Set<string>();

    for (const vc of verified) {
      // Find related chunks by time proximity
      const related = allChunks.filter(
        (c) =>
          !seenIds.has(c.id) &&
          c.id !== vc.contextId &&
          Math.abs(c.timeRangeStart - vc.timeRange.start) < 3600000, // within 1 hour
      );

      for (const r of related.slice(0, 3)) {
        seenIds.add(r.id);
        chain.push(
          `[${new Date(r.timeRangeStart).toLocaleString()}] ${r.summary}`,
        );
      }

      if (!seenIds.has(vc.contextId)) {
        seenIds.add(vc.contextId);
        chain.push(
          `[${new Date(vc.timeRange.start).toLocaleString()}] ${vc.summary} (confidence: ${Math.round(vc.confidence * 100)}%)`,
        );
      }
    }

    // Sort chronologically
    chain.sort();

    const finalConfidence =
      verified.length > 0
        ? verified.reduce((s, c) => s + c.confidence, 0) / verified.length
        : 0;

    return { evolutionChain: chain, finalConfidence };
  }

  /**
   * Generate a human-readable summary of the parallel search.
   */
  private generateSummary(
    snapshot: ProjectSnapshot,
    verified: VerifiedCandidate[],
    workerCount: number,
    dirCount: number,
  ): string {
    if (verified.length === 0) {
      return `Parallel search complete. ${workerCount} workers searched ${dirCount} directories. No matching evidence found for: "${snapshot.question}"`;
    }

    return [
      `Parallel search complete. ${workerCount} workers searched ${dirCount} directories.`,
      `Found ${verified.length} verified candidates for: "${snapshot.question}"`,
      `Top result: ${verified[0]?.summary ?? "N/A"} (confidence: ${Math.round((verified[0]?.confidence ?? 0) * 100)}%)`,
    ].join("\n");
  }

  // ---- Helpers ----

  private async flattenDirectoryTree(rootIds: string[]): Promise<string[]> {
    const result: string[] = [];
    const visited = new Set<string>();
    const queue = [...rootIds];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue; // Prevent infinite loops from circular refs
      visited.add(id);
      result.push(id);
      const children = await this.store.getDirectoryChildren(id);
      for (const child of children) {
        if (child.childType === "directory" && !visited.has(child.childId)) {
          queue.push(child.childId);
        }
      }
    }
    return result;
  }

  private computeRelevance(query: string, text: string): number {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);
    if (queryTerms.length === 0) return 0;
    const textLower = text.toLowerCase();
    const matched = queryTerms.filter((t) => textLower.includes(t));
    return matched.length / queryTerms.length;
  }
}
