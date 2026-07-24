// ---------------------------------------------------------------------------
// SearchTaskManager — persistent fuzzy search with cursor-based batching
//
// For extremely vague queries ("之前那个设计为什么不用了？"):
//   1. Create a persistent SearchTask
//   2. Check directories in batches (e.g., 3 at a time)
//   3. Save cursor/checked list after each batch
//   4. Agent can continue across turns without repeating work
// ---------------------------------------------------------------------------

import type { LynageStore } from "./store.js";
import type { SearchTask, SearchStatus } from "./types.js";

// ---- Types ----

export interface StartSearchInput {
  sessionId: string;
  query: string;
  understanding?: string;
  strategy?: string;
}

export interface SearchBatch {
  taskId: string;
  checkedDirectories: string[];
  newCandidates: Array<{
    directoryId: string;
    summary: string;
    reason: string;
  }>;
  shouldContinue: boolean;
  status: SearchStatus;
  /** Next batch starting position (cursor) */
  cursor?: string;
  /** Progress summary */
  progress: string;
}

export interface SearchAnalysis {
  status: SearchStatus;
  summary: string;
  candidates: Array<{
    directoryId: string;
    summary: string;
    reason: string;
  }>;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// SearchTaskManager
// ---------------------------------------------------------------------------

export class SearchTaskManager {
  private store: LynageStore;

  constructor(store: LynageStore) {
    this.store = store;
  }

  /**
   * Create a new search task for a vague query.
   * Auto-generates an initial search strategy.
   */
  async startSearch(input: StartSearchInput): Promise<SearchTask> {
    const strategy =
      input.strategy ??
      "Start from most recent directories. Check each directory's summary " +
        "for design decisions, abandoned approaches, or significant changes. " +
        "Prioritize directories that mention changes in direction.";

    const understanding =
      input.understanding ??
      "User is asking about a previous design or decision that was apparently " +
        "abandoned or changed. The query is vague — need to search broadly first.";

    return this.store.createSearchTask({
      sessionId: input.sessionId,
      query: input.query,
      understanding,
      strategy,
    });
  }

  /**
   * Process the next batch of directories.
   * Returns candidates found and updates the cursor.
   */
  async nextBatch(taskId: string, batchSize = 3): Promise<SearchBatch> {
    const task = await this.store.getSearchTask(taskId);
    if (!task) throw new Error(`Search task ${taskId} not found`);

    // Get all root directories
    const rootDirs = await this.store.getRootDirectories(task.sessionId);

    // Flatten the directory tree into a list, excluding already-checked
    const allDirIds = await this.flattenDirectoryTree(rootDirs.map((d) => d.id));
    const remaining = allDirIds.filter(
      (id) => !task.checkedDirectories.includes(id),
    );

    // Process a batch
    const batch = remaining.slice(0, batchSize);
    const newCandidates: SearchBatch["newCandidates"] = [];

    for (const dirId of batch) {
      const dir = await this.store.getDirectory(dirId);
      if (!dir) continue;

      // Simple keyword relevance check against directory summary
      const relevance = this.checkRelevance(task.query, dir);

      if (relevance.matches) {
        newCandidates.push({
          directoryId: dirId,
          summary: dir.overallContent,
          reason: relevance.reason,
        });
      }
    }

    // Build progress description
    const progress =
      batch.length > 0
        ? `Checked ${batch.length} directories. ${newCandidates.length} potential matches found. ${remaining.length - batch.length} directories remaining.`
        : "All directories have been checked.";

    // Update task state
    const newChecked = [...task.checkedDirectories, ...batch];
    const newCandidatesList = [
      ...task.candidates,
      ...newCandidates.map((c) => c.directoryId),
    ];
    const shouldContinue = remaining.length > batch.length;
    const newStatus: SearchStatus =
      !shouldContinue && newCandidatesList.length === 0
        ? "not_found"
        : !shouldContinue
          ? "completed"
          : "in_progress";

    const cursor = remaining[batch.length] ?? undefined;

    await this.store.updateSearchTask(taskId, {
      checkedDirectories: newChecked,
      candidates: newCandidatesList,
      nextBatch: cursor,
      status: newStatus,
    });

    return {
      taskId,
      checkedDirectories: batch,
      newCandidates,
      shouldContinue,
      status: newStatus,
      cursor,
      progress,
    };
  }

  /**
   * Analyze completed search results and produce a summary.
   */
  async analyzeResults(taskId: string): Promise<SearchAnalysis> {
    const task = await this.store.getSearchTask(taskId);
    if (!task) throw new Error(`Search task ${taskId} not found`);

    const candidates: SearchAnalysis["candidates"] = [];

    for (const dirId of task.candidates) {
      const dir = await this.store.getDirectory(dirId);
      if (dir) {
        candidates.push({
          directoryId: dirId,
          summary: dir.overallContent,
          reason: "Matched by search criteria",
        });
      }
    }

    let suggestion = "";
    if (candidates.length === 0) {
      suggestion =
        "No matching conversations found. The query may be too vague, " +
        "or the relevant discussion may have happened in a different session.";
    } else if (candidates.length === 1) {
      suggestion = `Found 1 potential match. Use openSource to read the full context.`;
    } else {
      suggestion =
        `Found ${candidates.length} candidates. ` +
        "Ask the user to clarify which one they meant, or use openSource to explore each.";
    }

    return {
      status: task.status,
      summary: `Search "${task.query}": ${task.checkedDirectories.length} directories checked, ${candidates.length} candidates found.`,
      candidates,
      suggestion,
    };
  }

  /**
   * Get search task progress for display.
   */
  async getProgress(taskId: string): Promise<string> {
    const task = await this.store.getSearchTask(taskId);
    if (!task) return "Search task not found.";

    const parts = [
      `Query: "${task.query}"`,
      `Status: ${task.status}`,
      `Directories checked: ${task.checkedDirectories.length}`,
      `Candidates: ${task.candidates.length}`,
    ];

    if (task.nextBatch) {
      parts.push(`Next batch starting from: ${task.nextBatch}`);
    }

    return parts.join("\n");
  }

  // ---- Helpers ----

  /**
   * Flatten directory tree into a flat list of IDs (BFS).
   */
  private async flattenDirectoryTree(rootIds: string[]): Promise<string[]> {
    const result: string[] = [];
    const queue = [...rootIds];

    while (queue.length > 0) {
      const id = queue.shift()!;
      result.push(id);
      const children = await this.store.getDirectoryChildren(id);
      for (const child of children) {
        if (child.childType === "directory") {
          queue.push(child.childId);
        }
      }
    }

    return result;
  }

  /**
   * Simple keyword-based relevance check against a directory.
   */
  private checkRelevance(
    query: string,
    dir: { overallContent: string; mainConclusions: string[]; importantChanges: string[] },
  ): { matches: boolean; reason: string } {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

    // Check summary
    const contentLower = dir.overallContent.toLowerCase();
    const matchedTerms = queryTerms.filter((t) => contentLower.includes(t));

    // Check conclusions
    const conclusionsLower = dir.mainConclusions.join(" ").toLowerCase();
    const conclusionMatches = queryTerms.filter((t) => conclusionsLower.includes(t));

    // Check changes
    const changesLower = dir.importantChanges.join(" ").toLowerCase();
    const changeMatches = queryTerms.filter((t) => changesLower.includes(t));

    const allMatches = new Set([...matchedTerms, ...conclusionMatches, ...changeMatches]);

    return {
      matches: allMatches.size > 0,
      reason:
        allMatches.size > 0
          ? `Matched terms: ${[...allMatches].join(", ")}`
          : "No keyword match",
    };
  }
}
