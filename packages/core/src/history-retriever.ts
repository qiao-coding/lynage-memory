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
import type { LynageModel, QueryUnderstanding } from "./model.js";
import type { Embedder } from "./embedder.js";
import { NoopEmbedder, TrigramEmbedder } from "./embedder.js";
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
  goals: string[];
}
export interface SearchCandidate {
  contextId: string; summary: string; progress: string; keywords: string[];
  conclusions: string[]; goals: string[];
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
  private model: LynageModel;
  private embedder: Embedder;
  private _embeddingCache: Map<string, Float32Array> = new Map();

  constructor(store: LynageStore, model?: LynageModel, embedder?: Embedder) {
    this.store = store;
    this.model = model ?? ({} as LynageModel);
    this.embedder = embedder ?? new NoopEmbedder();
  }

  /**
   * Swap the semantic embedder at runtime. Used by benchmarks to compare
   * embedders against the SAME archived DB (archiving is embedder-agnostic,
   * so rebuilding per-embedder would triple the ingest cost for nothing).
   * Clears the embedding cache — vectors from a different embedder are
   * incompatible.
   */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
    this._embeddingCache.clear();
  }

  /**
   * Hybrid search: FTS keyword match + directory drill-down.
   */
  async search(params: SearchParams): Promise<SearchResult> {
    const { query, sessionId, limit = 5 } = params;
    const candidates: SearchCandidate[] = [];
    let searchedDirectories = 0;
    let totalChunksChecked = 0;

    let matchedChunkIds = new Set<string>();

    // ---- Step 1 (PRIMARY, ~6ms): FTS over structured summaries + messages ----
    // Cheap keyword extraction (no LLM) → FTS. Trigram matches topic words
    // inside conclusions/goals, so keyword AND semi-vague queries resolve here
    // without any LLM call. LLM tree navigation is reserved for queries FTS
    // cannot match at all.
    // First clean topic term only — queries usually lead with "关于X", so the
    // first extracted term is the topic. AND-ing multiple fragment terms kills
    // recall; a single precise term matches the decision chunk's messages.
    const keywords = extractKeywords(query);
    // Fallback: if all words were stop words, pick the longest word from the
    // original query (avoids feeding "what"/"the" into FTS).
    const ftsQuery = keywords[0]
      || query.split(/\s+/).sort((a, b) => b.length - a.length)[0]
      || query;

    // 1a. FTS on chunk structured summaries → relevant chunk ids (bm25 order)
    const ftsChunkIds = await this.store.searchChunks(ftsQuery, sessionId);
    for (const id of ftsChunkIds) matchedChunkIds.add(id);

    // 1a-bis. When the primary keyword is too common (matches > 40% of chunks),
    // the result set is noisy. Try a narrower query with the second keyword.
    // E.g. "deployment" alone matches 3+ chunks; "deployment AND vercel" pinpoints
    // the decision chunk. This avoids the "AND-ing kills recall" problem by only
    // using it as a refinement when the first pass is clearly over-matching.
    const allChunks = await this.store.listChunks(sessionId);
    if (ftsChunkIds.length > allChunks.length * 0.4 && keywords.length >= 2) {
      const secondFts = keywords[1];
      if (secondFts) {
        const refinedIds = await this.store.searchChunks(secondFts, sessionId);
        // Intersection: chunks that match BOTH keywords
        const refinedSet = new Set(refinedIds);
        const before = matchedChunkIds.size;
        matchedChunkIds = new Set([...matchedChunkIds].filter(id => refinedSet.has(id)));
        // If intersection empties the set, keep the original (better recall than nothing)
        if (matchedChunkIds.size === 0) {
          // Restore original but limit to top half by BM25 rank (first keyword)
          matchedChunkIds = new Set(ftsChunkIds.slice(0, Math.ceil(ftsChunkIds.length / 2)));
        }
      }
    }

    // 1b. FTS on raw messages → recall supplement (chunks containing hits +
    //     unarchived recent messages as direct candidates)
    // Raw messages are GROUND TRUTH — AI summaries drift (e.g. to English),
    // so a chunk matched by its source messages ranks by message relevance.
    const msgRelevanceByChunk = new Map<string, number>();
    const bestMsgByChunk = new Map<string, string>();
    const ftsMessages = await this.store.searchMessages(ftsQuery, sessionId);
    if (ftsMessages.length > 0) {
      for (const chunk of allChunks) {
        const hits = ftsMessages.filter(
          (m) => m.createdAt >= chunk.timeRangeStart && m.createdAt <= chunk.timeRangeEnd,
        );
        if (hits.length > 0) {
          matchedChunkIds.add(chunk.id);
          let best = 0;
          let bestText = "";
          for (const m of hits) {
            const rel = computeRelevance(query, m.content, []);
            if (rel > best) { best = rel; bestText = m.content; }
          }
          if (best > (msgRelevanceByChunk.get(chunk.id) ?? 0)) {
            msgRelevanceByChunk.set(chunk.id, best);
            bestMsgByChunk.set(chunk.id, bestText);
          }
        }
      }

      const unarchived = ftsMessages.filter(
        (m) => !allChunks.some((c) => m.createdAt >= c.timeRangeStart && m.createdAt <= c.timeRangeEnd),
      );
      for (const msg of unarchived.slice(-10)) {
        const relevance = computeRelevance(query, msg.content, []);
        if (relevance > 0) {
          candidates.push({
            contextId: msg.id,
            summary: msg.content.slice(0, 100),
            progress: "",
            keywords: [],
            conclusions: [],
            goals: [],
            sourceRange: { from: msg.id, to: msg.id },
            timeRange: { start: msg.createdAt, end: msg.createdAt },
            relevance,
          });
        }
      }
    }

    // ---- Step 2 (FALLBACK, ~20ms): FTS tree navigation ----
    // Only when flat FTS found NOTHING. Traverses the directory tree by cheap
    // FTS pruning (directory + chunk summaries) instead of per-level LLM calls.
    // No analyzeSearchQuery — extractKeywords already gives the FTS term.
    if (matchedChunkIds.size === 0 && candidates.length === 0) {
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
    }

    // ---- Step 2 (SEMANTIC): embedding search — parallel channel to FTS ----
    // Lexical FTS misses when query wording ≠ chunk wording (e.g.
    // "deployment platform" vs "deployment strategy"). Embedding cosine
    // similarity bridges this gap (~0.5ms local with TrigramEmbedder, zero LLM).
    const embedScores = new Map<string, number>();
    if (!(this.embedder instanceof NoopEmbedder)) {
      try {
        // Auto-fit TrigramEmbedder on current chunks (idempotent, ~1ms)
        if (this.embedder instanceof TrigramEmbedder) {
          (this.embedder as TrigramEmbedder).fit(allChunks.map(c =>
            c.summary + " " + (c.keywords ?? []).join(" ")));
        }
        const qEmb = await this.embedder.embed(query);
        for (const chunk of allChunks) {
          if (!this._embeddingCache.has(chunk.id)) {
            // Embed BOTH the AI summary AND raw message evidence. Summary-only
            // embedding is why proper-noun answers ("Summer Vibes") were
            // missed: a multi-topic window's summary drops the answer topic.
            // Messages are ground truth — the answer text appears verbatim.
            // bge-small context = 512 tokens, so budget via head+tail: topics
            // at either end of a long window still get represented.
            const summary = chunk.summary + " " + (chunk.keywords ?? []).join(" ");
            let msgText = "";
            try {
              const msgs = await this.store.getMessageRange(chunk.sourceFromId, chunk.sourceToId);
              msgText = msgs.map(m => m.content).join(" ");
            } catch { /* message fetch is non-fatal */ }
            const EMBED_BUDGET = 2000;
            const half = Math.floor(EMBED_BUDGET / 2);
            const text = summary + " " + msgText;
            const trimmed = text.length > EMBED_BUDGET
              ? text.slice(0, half) + " " + text.slice(-half)
              : text;
            this._embeddingCache.set(chunk.id, await this.embedder.embed(trimmed));
          }
          const sim = this.embedder.similarity(qEmb, this._embeddingCache.get(chunk.id)!);
          if (sim > 0.15) { matchedChunkIds.add(chunk.id); embedScores.set(chunk.id, sim); }
        }
      } catch { /* non-fatal */ }
    }

    // ---- Step 2.5 (SEMANTIC RERANK): filter noisy FTS candidates ----
    // FTS matches by keyword frequency; incidental mentions ("Table组件的
    // 状态管理方案") can outrank the real decision ("关于状态管理的决策过程").
    // One bounded LLM call distinguishes genuine relevance from noise.
    // IMPORTANT: the pool includes ALL matched chunks — a keyword score CANNOT
    // rank the decision above noise (both tie at 0.25), so pre-filtering by
    // score would exclude the answer before the LLM ever sees it. Each
    // candidate carries its BEST MATCHING MESSAGE (ground truth — summaries
    // drift to English). Pool capped at 40 to bound the prompt.
    if (matchedChunkIds.size > 1 && this.model.rerankCandidates) {
      try {
        const allMatched = await this.store.getChunksByIds([...matchedChunkIds]);
        // Pool must cover ALL matched chunks — at extreme noise a topic word can
        // appear in 98% of chunks, and the decision chunk is one of them. A
        // keyword score can't rank it higher, so a small cap excludes the answer.
        const pool = allMatched.slice(0, 100);
        // Send ONLY the matching message snippet (ground truth) — the drifted
        // English summary + conclusions/goals bloat the prompt. This keeps the
        // LLM's signal identical while cutting the rerank call size dramatically.
        const rerankResult = await this.model.rerankCandidates({
          query,
          intent: "unknown",
          candidates: pool.map((chunk) => {
            const snippet = (bestMsgByChunk.get(chunk.id) ?? chunk.summary).slice(0, 120);
            return {
              contextId: chunk.id,
              summary: snippet,
              conclusions: [],
              goals: [],
              keywords: [],
              messageSnippet: snippet,
            };
          }),
        });
        if (rerankResult.relevantIds.length > 0) {
          matchedChunkIds = new Set(rerankResult.relevantIds);
        }
        // Safety net: LLM rerank can return empty or miss the best chunk
        // (e.g. when query terms don't appear in chunk summaries). Fall back
        // to computeRelevance ranking — fast, deterministic, keyword-based.
        if (rerankResult.relevantIds.length <= 1 && allMatched.length > 1) {
          // Find the top computeRelevance chunk as backstop
          let bestId = allMatched[0]!.id;
          let bestScore = -1;
          for (const chunk of allMatched) {
            const s = Math.max(
              computeRelevance(query, chunk.summary, chunk.keywords, chunk.conclusions, chunk.goals),
              msgRelevanceByChunk.get(chunk.id) ?? 0,
            );
            if (s > bestScore) { bestScore = s; bestId = chunk.id; }
          }
          if (rerankResult.relevantIds.length === 0) {
            // Rerank returned NOTHING — but that can mean the LLM's evidence
            // (FTS message snippets) was wrong, not that history lacks the
            // answer. Distinguish the two via the embedding channel's strongest
            // match: a genuinely strong similarity means rerank likely missed a
            // real chunk (keep the top-N by blended relevance instead of
            // collapsing to one — collapsing buried proper-noun answers like
            // "Summer Vibes"). A weak max similarity means nothing relevant
            // exists — collapse to the single best keyword candidate to avoid
            // flooding the LLM with noise (and hallucinating from it).
            const maxEmb = embedScores.size > 0 ? Math.max(...embedScores.values()) : 0;
            if (maxEmb >= this.embedder.confidenceThreshold) {
              const scored = allMatched.map(chunk => ({
                id: chunk.id,
                s: Math.max(
                  computeRelevance(query, chunk.summary, chunk.keywords, chunk.conclusions, chunk.goals),
                  msgRelevanceByChunk.get(chunk.id) ?? 0,
                  (embedScores.get(chunk.id) ?? 0) * 0.8,
                ),
              })).sort((a, b) => b.s - a.s);
              matchedChunkIds = new Set(scored.slice(0, 6).map(x => x.id));
            } else {
              // No genuine semantic match — trust computeRelevance ranking
              matchedChunkIds = new Set([bestId]);
            }
          } else if (bestScore > 0) {
            // Rerank found 1 — add computeRelevance best as backup
            matchedChunkIds.add(bestId);
          }
        }
      } catch {
        // Keep original candidates on rerank failure
      }
    }

    // ---- Step 3: Build candidate list from matched chunks (batch fetch) ----
    const matchedChunks = await this.store.getChunksByIds([...matchedChunkIds]);
    for (const chunk of matchedChunks) {

      // Compute relevance: blend FTS (lexical) + embedding (semantic) + message match.
      // FTS: precise keyword hits (0-1), Embedding: semantic similarity (0-1),
      // Message: ground-truth raw message match (0-1). Take best of all three;
      // FTS+embedding combo often catches what neither catches alone.
      const summaryRel = computeRelevance(query, chunk.summary, chunk.keywords, chunk.conclusions, chunk.goals);
      const msgRel = msgRelevanceByChunk.get(chunk.id) ?? 0;
      const embedRel = embedScores.get(chunk.id) ?? 0;
      const relevance = Math.max(summaryRel, msgRel, embedRel * 0.8);
      // Scale embedding down 0.8× — semantic similarity is softer signal than
      // exact keyword match (0.25 per term), so a 0.5 cosine → 0.4 composite.

      candidates.push({
        contextId: chunk.id,
        summary: chunk.summary,
        progress: chunk.progress,
        keywords: chunk.keywords,
        conclusions: chunk.conclusions ?? [],
        goals: chunk.goals ?? [],
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
   * Drill down into a directory and its descendants using CHEAP FTS pruning.
   * Directory summaries + chunk summaries are matched by trigram FTS (~ms/level)
   * — no LLM call per level. navigateDirectory remains a deep fallback only
   * when FTS pruning finds nothing.
   */
  async drillDown(
    directoryId: string,
    query: string,
    understanding?: QueryUnderstanding,
    parentContext?: { overallContent: string; mainConclusions: string[]; goals: string[] },
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

    const children = await this.store.getDirectoryChildren(directoryId);
    const chunkChildren = children.filter((c) => c.childType === "chunk");
    const dirChildren = children.filter((c) => c.childType === "directory");

    const chunkIds = chunkChildren.map((c) => c.childId);
    const chunks = chunkIds.length > 0 ? await this.store.getChunksByIds(chunkIds) : [];

    const subDirs = await Promise.all(
      dirChildren.map(async (c) => {
        const d = await this.store.getDirectory(c.childId);
        return d ? { childId: c.childId, dir: d } : null;
      }),
    ).then((results) => results.filter((r): r is NonNullable<typeof r> => r !== null));

    checked = chunkChildren.length + dirChildren.length;

    // ---- CHEAP FTS TREE PRUNING (primary, ~ms/level) ----
    // Match this directory's sub-directory summaries and chunk summaries by
    // FTS trigram. Descend only into matching subtrees — O(relevant branches).
    const ftsQuery = extractKeywords(query)[0] || query;
    const matchingDirs = new Set(await this.store.searchDirectories(ftsQuery, dir.sessionId));
    const matchingChunks = new Set(await this.store.searchChunks(ftsQuery, dir.sessionId));

    const myContext = {
      overallContent: dir.overallContent,
      mainConclusions: dir.mainConclusions,
      goals: dir.goals ?? [],
    };

    // Recurse into matching sub-directories
    for (const { childId } of subDirs) {
      if (matchingDirs.has(childId)) {
        searched++;
        const sub = await this.drillDown(childId, query, understanding, myContext);
        searched += sub.searched - 1;
        checked += sub.checked;
        candidates.push(...sub.candidates);
      }
    }

    // Add matching chunks
    for (const chunk of chunks) {
      if (matchingChunks.has(chunk.id)) {
        candidates.push({ contextId: chunk.id, relevance: 0.8 });
      }
    }

    // ---- LLM deep fallback: only when FTS pruning found nothing ----
    // navigateDirectory can still disambiguate a fully abstract query that no
    // trigram matches. Bounded: only if this subtree yielded no candidates.
    if (candidates.length === 0 && this.model.navigateDirectory && understanding) {
      try {
        const question = understanding.description || query;
        const childEntries: Array<{
          childId: string;
          childType: "chunk" | "directory";
          summary: string;
          conclusions: string[];
          goals: string[];
          keywords?: string[];
        }> = [];
        for (const chunk of chunks) {
          childEntries.push({
            childId: chunk.id,
            childType: "chunk",
            summary: chunk.summary,
            conclusions: chunk.conclusions ?? [],
            goals: chunk.goals ?? [],
            keywords: chunk.keywords,
          });
        }
        for (const { childId, dir: subDir } of subDirs) {
          childEntries.push({
            childId,
            childType: "directory",
            summary: subDir.overallContent,
            conclusions: subDir.mainConclusions,
            goals: subDir.goals ?? [],
          });
        }
        const navResult = await this.model.navigateDirectory({
          directoryId,
          overallContent: dir.overallContent,
          mainConclusions: dir.mainConclusions,
          goals: dir.goals ?? [],
          parentContext,
          question,
          intent: understanding.intent,
          children: childEntries,
        });
        const relevantSet = new Set(navResult.relevantChildIds);
        for (const chunk of chunks) {
          if (relevantSet.has(chunk.id)) candidates.push({ contextId: chunk.id, relevance: 0.8 });
        }
        for (const { childId } of subDirs) {
          if (relevantSet.has(childId)) {
            searched++;
            const sub = await this.drillDown(childId, query, understanding, myContext);
            searched += sub.searched - 1;
            checked += sub.checked;
            candidates.push(...sub.candidates);
          }
        }
      } catch {
        // Keep whatever FTS found (possibly nothing)
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
    let messages: Message[];
    let chunkRef: { directoryId?: string } | null = chunk;
    if (chunk) {
      messages = await this.store.getMessageRange(chunk.sourceFromId, chunk.sourceToId);
    } else {
      // Raw message ID (from unarchived recent search) — return surrounding context
      // so the model sees both the question AND the assistant's decision.
      messages = await this.store.getMessagesAround(contextId, 5);
      if (messages.length === 0) return null;
      chunkRef = null;
    }
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
    if (chunkRef?.directoryId) { const dir = await this.store.getDirectory(chunkRef.directoryId);
      if (dir) directoryContext = { directoryId:dir.id, generation:dir.generation, overallContent:dir.overallContent, progress:dir.progress, mainConclusions:dir.mainConclusions, importantChanges:dir.importantChanges, goals: dir.goals ?? [] }; }
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

// English stop words — shared between extractKeywords and computeRelevance.
// Without this, "What is the user's favorite language?" → ["What","is","the"]
// before it ever reaches a content word.
const ENGLISH_STOP = new Set([
  "what","which","when","where","who","whom","why","how",
  "is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","shall","should","can","could",
  "may","might","must","the","a","an","this","that","these","those",
  "it","its","i","me","my","we","our","you","your","he","she","they",
  "him","her","us","them","his","hers","mine","yours","ours","theirs",
  "not","no","nor","or","and","but","if","then","else","of","in","on",
  "to","for","with","about","at","from","by","as","into","than",
  "also","just","now","only","very","really","some","any","each","every",
  "all","both","few","more","most","other","such","much",
  "did","does","doing","done","get","got","getting",
  "s","t","don","doesn","isn","aren","wasn","weren",
  // Query verbs & generic nouns — high semantic value for humans but near-zero
  // discriminative power for chunk matching. Filtered from FTS + computeRelevance
  // so they don't add noise; the LLM rerank still receives the full query.
  "user","users",
  "choose","chose","chosen","choosing",
  "decide","decided","deciding","decision",
  "ultimately","finally","eventually",
]);

/**
 * Cheap CJK/Latin keyword extraction — NO LLM. Strips query fillers and
 * keeps topic words (≥2 chars) for the FTS fast path. Mirrors the
 * analyzeSearchQuery LLM fallback, but runs in ~0ms.
 */
function extractKeywords(query: string): string[] {

  // Strip fillers + particles + sentence fragments aggressively, but NEVER
  // content words like 方案/决定 (part of compound topics "样式方案").
  // Goal: leave clean 2-6 char topic terms — "关于数据库的事...怎么定的"
  // → "数据库", NOT fragments like "数据库的事" or "的一开始".
  const cleaned = query
    .replace(/[记不清|怎么|定了|最后|哪个|是不是|中间|换了|什么|我们|你们|他们|当时|关于|现在|记得|帮我|看看|以前|之前|后来|然后|已经|到底|结果|回事|真的|应该|可能|觉得|认为|时候|的话|还是|还有|或者|但是|可是|所以|因为|如果|虽然|而且|一开始|一个|一下|一次|这个|那个|这些|那些|别的|用了|的事|的东西|的事情]/g, " ")
    .replace(/[^\w\s一-鿿぀-ゟ]/g, " ");
  const terms = cleaned.split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 6)
    .filter((t) => !ENGLISH_STOP.has(t.toLowerCase()));
  // Keep unique, up to 3 terms. Prefer longer words — they carry
  // more signal (e.g. "programming" > "user" > "what").
  const unique = [...new Set(terms)];
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, 3);
}

/**
 * Compute a simple relevance score (0-1) between a query and text + keywords.
 */
function computeRelevance(query: string, text: string, keywords: string[], conclusions?: string[], goals?: string[]): number {
  const queryLower = query.toLowerCase();

  // Combine all searchable text
  const searchTexts = [text.toLowerCase()];
  if (conclusions) searchTexts.push(conclusions.join(" ").toLowerCase());
  if (goals) searchTexts.push(goals.join(" ").toLowerCase());
  const combined = searchTexts.join(" ");

  // Latin terms: split by space (word boundaries preserved).
  // Filter English stop words — same as extractKeywords, so "the"/"and"
  // don't match unrelated chunks and inflate relevance scores.
  const latinTerms = queryLower.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !ENGLISH_STOP.has(w));
  let score = 0;
  let matched = 0;

  for (const term of latinTerms) {
    // Word-boundary match: "language" should match "programming language"
    // but not "metalanguage". Falls back to includes() for short/edge cases.
    try {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("\\b" + escaped + "\\b", "i").test(combined)) {
        score += 0.25;
        matched++;
      }
    } catch {
      // Degenerate regex (unlikely) — fall back to simple includes
      if (combined.includes(term)) { score += 0.25; matched++; }
    }
  }

  // CJK: Chinese has no spaces — a full question is ONE token.
  // Match by sliding windows (2-4 chars) so "关于样式方案的事我们当时怎么定的..."
  // can match "样式方案" appearing in summaries.
  const cjkChars = queryLower.replace(/[^一-鿿㐀-䶿]/g, "");
  if (cjkChars.length >= 2) {
    // Try longest window first; one hit per window length
    const maxWin = Math.min(4, cjkChars.length);
    for (let win = maxWin; win >= 2; win--) {
      let hit = false;
      for (let i = 0; i + win <= cjkChars.length; i++) {
        const sub = cjkChars.slice(i, i + win);
        if (combined.includes(sub)) {
          score += 0.25;
          matched++;
          hit = true;
          break;
        }
      }
      if (hit) break; // one window-length match is enough signal
    }
  }

  // Keyword match
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    if (latinTerms.some((t) => kwLower.includes(t)) || (cjkChars.length >= 2 && [...cjkChars].some((_, i) => kwLower.includes(cjkChars.slice(i, i + 2))))) {
      score += 0.15;
    }
  }

  // Normalize
  const maxScore = Math.max(matched, 1) * 0.25 + keywords.length * 0.15;
  if (maxScore <= 0) return 0;
  return Math.min(score / Math.max(maxScore, 1), 1.0);
}
