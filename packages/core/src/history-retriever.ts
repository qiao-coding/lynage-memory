// ---------------------------------------------------------------------------
// HistoryRetriever — hybrid history search: FTS + directory drill-down
//
// Flow:
//   1. FTS5 search on messages.content for keyword candidates
//   2. Drill down: Root → Directories → Chunks → Source Messages
//   3. Merge results, rank by relevance
//   4. openSource: recover original messages from a chunk
// ---------------------------------------------------------------------------

import type { Message } from "./types.js";
import type { LynageStore } from "./store.js";
import { estimateTokenCount } from "./token-counter.js";

// ---- Types ----

export interface SearchParams {
  query: string;
  sessionId: string;
  limit?: number;
}

export interface DirectoryContext {
  directoryId: string; generation: number;
  overallContent: string; progress: string;
  mainConclusions: string[]; importantChanges: string[];
}
export interface SearchCandidate {
  contextId: string; summary: string; progress: string; keywords: string[];
  sourceRange: { from: string; to: string };
  timeRange: { start: number; end: number };
  relevance: number;
  directoryContext?: DirectoryContext;
}
export interface OpenSourceOptions {
  /** Max total tokens for returned messages (default: unlimited) */
  maxTokens?: number;
}
export interface OpenSourceResult {
  messages: Message[];
  directoryContext: DirectoryContext | null;
}

export interface SearchResult {
  status: "found" | "not_found" | "partial";
  candidates: SearchCandidate[];
  searchedDirectories: number;
  totalChunksChecked: number;
  /** Suggested next step if status is "partial" */
  suggestion?: string;
}

export interface DirectoryTreeNode {
  id: string;
  generation: number;
  summary: string;
  children: DirectoryTreeNode[];
  chunkCount: number;
}

// ---------------------------------------------------------------------------
// HistoryRetriever
// ---------------------------------------------------------------------------

export class HistoryRetriever {
  private store: LynageStore;

  constructor(store: LynageStore) {
    this.store = store;
  }

  /**
   * Hybrid search: FTS keyword match + directory drill-down.
   */
  async search(params: SearchParams): Promise<SearchResult> {
    const { query, sessionId, limit = 5 } = params;
    const candidates: SearchCandidate[] = [];
    let searchedDirectories = 0;
    let totalChunksChecked = 0;

    // ---- Step 1: FTS keyword search on messages ----
    const ftsMessages = await this.store.searchMessages(query, sessionId);
    const matchedChunkIds = new Set<string>();

    // Find which chunks contain these messages
    if (ftsMessages.length > 0) {
      const chunks = await this.store.listChunks(sessionId);
      for (const chunk of chunks) {
        if (
          ftsMessages.some(
            (m) =>
              m.createdAt >= chunk.timeRangeStart &&
              m.createdAt <= chunk.timeRangeEnd,
          )
        ) {
          matchedChunkIds.add(chunk.id);
        }
      }
      totalChunksChecked += chunks.length;
    }

    // ---- Step 2: Directory drill-down ----
    const rootDirs = await this.store.getRootDirectories(sessionId);
    searchedDirectories = rootDirs.length;

    for (const dir of rootDirs) {
      const dirResults = await this.drillDown(dir.id, query);
      searchedDirectories += dirResults.searched;
      totalChunksChecked += dirResults.checked;

      for (const candidate of dirResults.candidates) {
        matchedChunkIds.add(candidate.contextId);
      }
    }

    // ---- Step 3: Build candidate list from matched chunks ----
    for (const chunkId of matchedChunkIds) {
      const chunk = await this.store.getChunk(chunkId);
      if (!chunk) continue;

      // Compute relevance score
      const relevance = computeRelevance(query, chunk.summary, chunk.keywords);

      candidates.push({
        contextId: chunk.id,
        summary: chunk.summary,
        progress: chunk.progress,
        keywords: chunk.keywords,
        sourceRange: {
          from: chunk.sourceFromId,
          to: chunk.sourceToId,
        },
        timeRange: {
          start: chunk.timeRangeStart,
          end: chunk.timeRangeEnd,
        },
        relevance,
      });
    }

    // Sort by relevance descending
    candidates.sort((a, b) => b.relevance - a.relevance);

    // Determine status
    const top = candidates.slice(0, limit);
    const status: SearchResult["status"] =
      top.length > 0
        ? candidates.length > limit
          ? "partial"
          : "found"
        : "not_found";

    return {
      status,
      candidates: top,
      searchedDirectories,
      totalChunksChecked,
      suggestion:
        status === "not_found"
          ? "No matching conversation found. Try broader keywords or a different time range."
          : status === "partial"
            ? `${candidates.length - limit} more results available. Refine query or use openSource to read specific chunks.`
            : undefined,
    };
  }

  /**
   * Drill down into a directory and its descendants.
   * Returns matching chunk candidates.
   */
  async drillDown(
    directoryId: string,
    query: string,
  ): Promise<{
    candidates: Array<{ contextId: string; relevance: number }>;
    searched: number;
    checked: number;
  }> {
    const candidates: Array<{ contextId: string; relevance: number }> = [];
    let searched = 1;
    let checked = 0;

    const dir = await this.store.getDirectory(directoryId);
    if (!dir) return { candidates, searched, checked };

    // Search in directory summary
    const dirRelevance = computeRelevance(
      query,
      dir.overallContent + " " + dir.mainConclusions.join(" ") + " " + dir.importantChanges.join(" "),
      [],
    );

    // Get children
    const children = await this.store.getDirectoryChildren(directoryId);

    for (const child of children) {
      if (child.childType === "chunk") {
        checked++;
        const chunk = await this.store.getChunk(child.childId);
        if (chunk) {
          const rel = computeRelevance(query, chunk.summary, chunk.keywords);
          // Boost relevance if parent directory matched
          const boostedRel = Math.max(rel, dirRelevance > 0.3 ? rel * 1.3 : rel);
          if (boostedRel > 0) {
            candidates.push({ contextId: chunk.id, relevance: boostedRel });
          }
        }
      } else if (child.childType === "directory") {
        const sub = await this.drillDown(child.childId, query);
        searched += sub.searched;
        checked += sub.checked;
        candidates.push(...sub.candidates);
      }
    }

    return { candidates, searched, checked };
  }

  /**
   * Open the original source messages for a context chunk.
   * When maxTokens is set, keeps the most recent messages within budget.
   */
  async openSource(contextId: string, options?: OpenSourceOptions): Promise<OpenSourceResult | null> {
    const chunk = await this.store.getChunk(contextId);
    if (!chunk) return null;
    let messages = await this.store.getMessageRange(chunk.sourceFromId, chunk.sourceToId);
    // Truncate to maxTokens budget (keep most recent — usually most relevant)
    if (options?.maxTokens) {
      let tokens = 0;
      const kept: typeof messages = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const t = messages[i]!.tokenCount ?? estimateTokenCount(messages[i]!.content);
        if (tokens + t <= options.maxTokens) { tokens += t; kept.unshift(messages[i]!); }
      }
      messages = kept;
    }
    let directoryContext: DirectoryContext | null = null;
    if (chunk.directoryId) { const dir = await this.store.getDirectory(chunk.directoryId);
      if (dir) directoryContext = { directoryId:dir.id, generation:dir.generation, overallContent:dir.overallContent, progress:dir.progress, mainConclusions:dir.mainConclusions, importantChanges:dir.importantChanges }; }
    return { messages, directoryContext };
  }

  /**
   * Get the directory tree for a session.
   */
  async getDirectoryTree(sessionId: string): Promise<DirectoryTreeNode[]> {
    const rootDirs = await this.store.getRootDirectories(sessionId);
    const tree: DirectoryTreeNode[] = [];

    for (const dir of rootDirs) {
      tree.push(await this.buildTreeNode(dir.id));
    }

    return tree;
  }

  private async buildTreeNode(directoryId: string): Promise<DirectoryTreeNode> {
    const dir = await this.store.getDirectory(directoryId);
    const children = await this.store.getDirectoryChildren(directoryId);

    const childNodes: DirectoryTreeNode[] = [];
    let chunkCount = 0;

    for (const child of children) {
      if (child.childType === "directory") {
        childNodes.push(await this.buildTreeNode(child.childId));
      } else {
        chunkCount++;
      }
    }

    return {
      id: directoryId,
      generation: dir?.generation ?? 0,
      summary: dir?.overallContent ?? "(empty)",
      children: childNodes,
      chunkCount,
    };
  }

  /**
   * Compile retrieved context into a model-readable text block.
   */
  compileRetrievedContext(result: SearchResult, maxTokens?: number): string {
    if (result.candidates.length === 0) return "[No relevant history found.]";

    const lines: string[] = [
      `# History Search Results (${result.status})`,
      `Found ${result.candidates.length} relevant conversation segments:\n`,
    ];
    let totalEst = estimateTokenCount(lines.join("\n"));

    for (let i = 0; i < result.candidates.length; i++) {
      const c = result.candidates[i]!;
      const date = new Date(c.timeRange.start).toLocaleDateString();
      const block = [
        `## Result ${i + 1} [${date}] (relevance: ${Math.round(c.relevance * 100)}%)`,
        `Context ID: ${c.contextId}`,
        `Summary: ${c.summary}`,
      ];
      // Directory context: adds signal but costs tokens — include only if budget allows
      if (c.directoryContext) {
        block.push(`Phase: ${c.directoryContext.overallContent}`);
        if (c.directoryContext.mainConclusions.length > 0) {
          block.push(`Conclusions: ${c.directoryContext.mainConclusions.join("; ")}`);
        }
      }
      const blockText = block.join("\n") + "\n";
      const blockTokens = estimateTokenCount(blockText);
      // Stop adding candidates when budget exceeded
      if (maxTokens && totalEst + blockTokens > maxTokens) break;
      totalEst += blockTokens;
      lines.push(...block, "");
    }

    return lines.join("\n");
  }
}

// ---- Helpers ----

/**
 * Compute a simple relevance score (0-1) between a query and text + keywords.
 */
function computeRelevance(query: string, text: string, keywords: string[]): number {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/);

  // Check text match
  const textLower = text.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    if (textLower.includes(term)) {
      score += 0.3;
    }
  }

  // Check keyword match
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    for (const term of queryTerms) {
      if (kwLower.includes(term) || term.includes(kwLower)) {
        score += 0.2;
      }
    }
  }

  return Math.min(score, 1.0);
}
