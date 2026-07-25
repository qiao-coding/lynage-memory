// ---------------------------------------------------------------------------
// SourceVerifier — verifies search candidates against original messages
//
// Flow:
//   Search returns candidates (directory summaries matching keywords)
//   → SourceVerifier opens the original messages for each candidate
//   → Checks if the query terms actually appear in the original text
//   → Reads surrounding context (padding messages before/after)
//   → Assigns confidence score
//   → Filters out false positives below threshold
// ---------------------------------------------------------------------------

import type { LynageStore } from "./store.js";
import type { Message, DirectoryNode } from "./types.js";
import type { SearchCandidate } from "./history-retriever.js";

// ---- Types ----

export interface VerificationResult {
  verified: boolean;
  confidence: number;
  actualContent: string;
  matchesQuery: boolean;
  reason: string;
  relatedCandidates?: string[];
}

export interface VerifiedCandidate extends SearchCandidate {
  verified: boolean;
  confidence: number;
  contextExpanded: boolean;
}

const CONFIDENCE_THRESHOLD = 0.3;

export class SourceVerifier {
  private store: LynageStore;

  constructor(store: LynageStore) {
    this.store = store;
  }

  /**
   * Verify a single search candidate by opening its original messages.
   */
  async verify(
    candidate: SearchCandidate,
    query: string,
  ): Promise<VerificationResult> {
    // Open original source messages
    const messages = await this.store.getMessageRange(
      candidate.sourceRange.from,
      candidate.sourceRange.to,
    );

    if (messages.length === 0) {
      return {
        verified: false,
        confidence: 0,
        actualContent: "(no messages found)",
        matchesQuery: false,
        reason: "Source messages could not be retrieved.",
      };
    }

    // Build full text from original messages
    const fullText = messages.map((m) => m.content).join(" ");

    // Check query term presence
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);
    const matchedTerms = queryTerms.filter((t) => fullText.toLowerCase().includes(t));

    const termRatio = queryTerms.length > 0 ? matchedTerms.length / queryTerms.length : 0;

    // Also check if the candidate's summary keyword overlaps
    const summaryLower = candidate.summary.toLowerCase();
    const summaryMatch = queryTerms.some((t) => summaryLower.includes(t));

    // Compute confidence
    const confidence = termRatio * 0.6 + (summaryMatch ? 0.4 : 0);

    const verified = confidence >= CONFIDENCE_THRESHOLD;

    return {
      verified,
      confidence: Math.round(confidence * 100) / 100,
      actualContent: fullText.slice(0, 300) + (fullText.length > 300 ? "..." : ""),
      matchesQuery: termRatio > 0,
      reason: verified
        ? `Matched ${matchedTerms.length}/${queryTerms.length} query terms in original messages.`
        : `Only ${matchedTerms.length}/${queryTerms.length} query terms found. Below confidence threshold.`,
    };
  }

  /**
   * Verify a batch of candidates, returning only verified ones sorted by confidence.
   */
  async verifyBatch(
    candidates: SearchCandidate[],
    query: string,
  ): Promise<VerifiedCandidate[]> {
    const verified: VerifiedCandidate[] = [];

    for (const c of candidates) {
      const result = await this.verify(c, query);
      if (result.verified) {
        verified.push({
          ...c,
          verified: true,
          confidence: result.confidence,
          contextExpanded: false,
        });
      }
    }

    // Sort by confidence descending
    verified.sort((a, b) => b.confidence - a.confidence);

    return verified;
  }

  /**
   * Expand context around a candidate by reading padding messages
   * before and after the source range to reconstruct relationship chains.
   */
  async expandContext(
    candidate: SearchCandidate,
    padding = 3,
  ): Promise<{ messages: Message[]; relatedChunkIds: string[] }> {
    const messages = await this.store.getMessageRange(
      candidate.sourceRange.from,
      candidate.sourceRange.to,
    );

    if (messages.length === 0) return { messages: [], relatedChunkIds: [] };

    // Get all messages for the session to find padding
    const sessionId = messages[0]!.sessionId;
    const allRecent = await this.store.getRecent({ sessionId });

    // Find position of our range in the full message stream
    const fromIdx = allRecent.findIndex((m) => m.id === candidate.sourceRange.from);
    const toIdx = allRecent.findIndex((m) => m.id === candidate.sourceRange.to);

    if (fromIdx === -1) return { messages, relatedChunkIds: [] };

    // Include padding messages
    const startIdx = Math.max(0, fromIdx - padding);
    const endIdx = Math.min(allRecent.length - 1, (toIdx >= 0 ? toIdx : fromIdx) + padding);

    const expanded = allRecent.slice(startIdx, endIdx + 1);

    // Find related chunks that overlap with the expanded range
    const chunks = await this.store.listChunks(sessionId);
    const relatedChunkIds = chunks
      .filter(
        (ch) =>
          ch.id !== candidate.contextId &&
          ch.timeRangeStart <= (expanded[expanded.length - 1]?.createdAt ?? Infinity) &&
          ch.timeRangeEnd >= (expanded[0]?.createdAt ?? 0),
      )
      .map((ch) => ch.id);

    return { messages: expanded, relatedChunkIds };
  }

  /**
   * Deep verify: expand context, find related chunks, and rebuild the
   * information evolution chain (satisfies architecture.md §11).
   */
  async deepVerify(
    candidates: SearchCandidate[],
    query: string,
  ): Promise<{
    verified: VerifiedCandidate[];
    evolutionChain: string[];
    finalConfidence: number;
  }> {
    // Step 1: basic verify
    const verified = await this.verifyBatch(candidates, query);

    // Step 2: expand context for top candidates
    const expanded: VerifiedCandidate[] = [];
    const allRelatedIds = new Set<string>();

    for (const vc of verified.slice(0, 3)) {
      const ctx = await this.expandContext(vc);
      allRelatedIds.add(vc.contextId);
      ctx.relatedChunkIds.forEach((id) => allRelatedIds.add(id));

      expanded.push({
        ...vc,
        contextExpanded: true,
        confidence: Math.min(1, vc.confidence + 0.1), // boost for expanded context
      });
    }

    // Step 3: build evolution chain from related chunks
    const chain: string[] = [];
    for (const id of allRelatedIds) {
      const chunk = await this.store.getChunk(id);
      if (chunk) {
        chain.push(`[${new Date(chunk.timeRangeStart).toLocaleDateString()}] ${chunk.summary}`);
      }
    }

    // Sort by time
    chain.sort();

    const finalConfidence =
      expanded.length > 0 ? expanded.reduce((s, c) => s + c.confidence, 0) / expanded.length : 0;

    return { verified: expanded, evolutionChain: chain, finalConfidence };
  }
}
