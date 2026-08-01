// ---------------------------------------------------------------------------
// GenerationCompactor — directory generational compaction
//
// When a directory reaches max capacity, it "graduates" to the next generation:
//   G0 full → create G1 → G0 children become G1's children → G1 is new root
//   G1 full → create G2 → ...
//
// The original directory still exists (as a child of the new parent), and
// all source data is preserved. Only the navigation hierarchy grows deeper.
// ---------------------------------------------------------------------------

import type { LynageStore } from "./store.js";
import type { LynageModel, DirectorySummaryInput } from "./model.js";
import type { DirectoryNode } from "./types.js";

export interface CompactConfig {
  /** Max children before triggering compaction */
  capacity: number;
}

export interface CompactResult {
  compacted: boolean;
  /** ID of the newly created parent directory (if compacted) */
  newParentId?: string;
  /** ID of the directory that was compacted */
  compactedDirectoryId?: string;
}

export class GenerationCompactor {
  private store: LynageStore;
  private model: LynageModel;
  private capacity: number;

  constructor(store: LynageStore, model: LynageModel, capacity: number) {
    this.store = store;
    this.model = model;
    this.capacity = capacity;
  }

  /**
   * Check if a directory needs compaction and execute if so.
   * Recursive: after compacting, checks if the new parent also needs compaction.
   */
  async checkAndCompact(directoryId: string): Promise<CompactResult> {
    const dir = await this.store.getDirectory(directoryId);
    if (!dir) return { compacted: false };

    const children = await this.store.getDirectoryChildren(directoryId);

    if (children.length < this.capacity) {
      return { compacted: false };
    }

    // Compact once, then STOP. Do NOT recurse into the new parent here —
    // moving chunks to it makes it full too, causing infinite recursion.
    // The next archive check will naturally compact it if needed.
    return this.compact(directoryId, dir);
  }

  /**
   * Execute compaction: create parent directory, re-parent children.
   */
  private async compact(
    directoryId: string,
    dir: DirectoryNode,
  ): Promise<CompactResult> {
    const children = await this.store.getDirectoryChildren(directoryId);
    if (children.length === 0) return { compacted: false };

    // 1. Collect child summaries for the new parent directory
    const childDescriptions: Array<DirectorySummaryInput["childDescriptions"][number]> = [];

    for (const child of children) {
      if (child.childType === "chunk") {
        const chunk = await this.store.getChunk(child.childId);
        if (chunk) {
          childDescriptions.push({
            id: chunk.id,
            type: "chunk",
            summary: chunk.summary,
            progress: chunk.progress,
            conclusions: [],
            keywords: chunk.keywords,
          });
        }
      } else {
        const subDir = await this.store.getDirectory(child.childId);
        if (subDir) {
          childDescriptions.push({
            id: subDir.id,
            type: "directory",
            summary: subDir.overallContent,
            progress: subDir.progress,
            conclusions: subDir.mainConclusions,
            importantChanges: subDir.importantChanges,
          });
        }
      }
    }

    // 2. Ask model to generate parent directory summary
    const summary = await this.model.summarizeDirectory({
      directoryId,
      timeRangeStart: dir.timeRangeStart,
      timeRangeEnd: dir.timeRangeEnd,
      childDescriptions,
    });

    // 3. Create the new parent directory (higher generation)
    const newGen = dir.generation + 1;
    const newParent = await this.store.createDirectory({
      sessionId: dir.sessionId,
      generation: newGen,
      timeRangeStart: dir.timeRangeStart,
      timeRangeEnd: dir.timeRangeEnd,
      overallContent: summary.overallContent,
      progress: summary.progress,
      mainConclusions: summary.mainConclusions,
      importantChanges: summary.importantChanges,
    });

    // 4. Move the OLDEST HALF of chunk children to new parent.
    //    Keep the other half in the old directory so it doesn't
    //    immediately re-trigger compaction on the next check.
    const oldChildren = await this.store.getDirectoryChildren(directoryId);
    const chunkChildren = oldChildren.filter((c) => c.childType === "chunk");
    const toMove = chunkChildren.slice(0, Math.ceil(chunkChildren.length / 2));
    if (toMove.length > 0) {
      // Update chunk directoryId to point to new parent
      for (const cc of toMove) {
        await this.store.updateChunkDirectory(cc.childId, newParent.id);
      }
      // Move child entries to new parent
      const newChildren = await this.store.getDirectoryChildren(newParent.id);
      let sort = newChildren.length;
      for (const cc of toMove) {
        await this.store.addChildToDirectory({
          id: "", // Let store auto-generate UUID
          directoryId: newParent.id,
          childType: "chunk",
          childId: cc.childId,
          sortOrder: sort++,
        });
        // Remove stale entry from old directory
        await this.store.removeChildFromDirectory(directoryId, cc.childId);
      }
    }

    // 5. Set the old directory's parent to the new parent
    await this.store.updateDirectory(directoryId, {
      parentId: newParent.id,
    });

    // 6. Add old directory as child of new parent
    const parentChildren = await this.store.getDirectoryChildren(newParent.id);
    await this.store.addChildToDirectory({
      id: "", // Let store auto-generate UUID
      directoryId: newParent.id,
      childType: "directory",
      childId: directoryId,
      sortOrder: parentChildren.length,
    });

    return {
      compacted: true,
      newParentId: newParent.id,
      compactedDirectoryId: directoryId,
    };
  }

  /**
   * Get full directory tree stats for monitoring.
   */
  async getStats(sessionId: string): Promise<{
    directories: number;
    maxGeneration: number;
    totalChunks: number;
  }> {
    const rootDirs = await this.store.getRootDirectories(sessionId);
    const store = this.store;

    let dirCount = 0;
    let maxGen = 0;
    let chunks = 0;

    const walk = async (dirId: string): Promise<void> => {
      const dir = await store.getDirectory(dirId);
      if (dir) {
        dirCount++;
        if (dir.generation > maxGen) maxGen = dir.generation;
      }

      const children = await store.getDirectoryChildren(dirId);
      for (const child of children) {
        if (child.childType === "directory") {
          await walk(child.childId);
        } else {
          chunks++;
        }
      }
    };

    for (const dir of rootDirs) {
      await walk(dir.id);
    }

    return { directories: dirCount, maxGeneration: maxGen, totalChunks: chunks };
  }
}
