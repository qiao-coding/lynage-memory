// ---------------------------------------------------------------------------
// LynageModel — AI model abstraction interface
// Core never calls AI SDK directly; it depends on this interface.
// ---------------------------------------------------------------------------

import type { Message } from "./types.js";

/** Input for chunk summary generation */
export interface ChunkSummaryInput {
  messages: Message[];
  recentMemory?: string;
}

/** AI-generated chunk summary */
export interface ChunkSummary {
  summary: string;
  progress: string;
  keywords: string[];
}

/** Input for directory summary generation */
export interface DirectorySummaryInput {
  directoryId: string;
  timeRangeStart: number;
  timeRangeEnd: number;
  childDescriptions: Array<{
    id: string;
    type: "chunk" | "directory";
    summary: string;
    progress: string;
    conclusions: string[];
    importantChanges?: string[];
    keywords?: string[];
  }>;
}

/** AI-generated directory summary */
export interface DirectorySummary {
  overallContent: string;
  progress: string;
  mainConclusions: string[];
  importantChanges: string[];
}

/** Input for batch search analysis */
export interface SearchBatchInput {
  query: string;
  currentUnderstanding: string;
  candidatesToCheck: Array<{
    directoryId: string;
    summary: string;
    conclusions: string[];
  }>;
}

/** AI-analyzed search batch result */
export interface SearchBatchResult {
  relevantIds: string[];
  reasoning: string;
  shouldContinue: boolean;
  refinedUnderstanding?: string;
}

/** Query understanding — LLM turns a vague question into a search intent */
export interface QueryUnderstanding {
  /** Search intent */
  intent: "fact_lookup" | "process_recall" | "decision";
  /** Semantic description of what the user is looking for */
  description: string;
  /** Auxiliary retrieval keywords (fallback, not primary) */
  keywords: string[];
  /** Optional time range hint */
  timeRange?: { start: number; end: number };
}

/** Input for directory relevance judgment (semantic tree navigation) */
export interface DirectoryRelevanceInput {
  /** Directory summary — the parent context that guides navigation */
  directorySummary: string;
  /** User's original question */
  question: string;
  /** Query understanding intent */
  intent: string;
}

/** Model interface that Core depends on */
export interface LynageModel {
  summarizeChunk(input: ChunkSummaryInput): Promise<ChunkSummary>;
  summarizeDirectory(input: DirectorySummaryInput): Promise<DirectorySummary>;
  analyzeSearchBatch(input: SearchBatchInput): Promise<SearchBatchResult>;
  /** Vague question → search intent (semantic, not keyword extraction) */
  analyzeSearchQuery(question: string): Promise<QueryUnderstanding>;
  /** Does this directory's summary semantically relate to the question? */
  isDirectoryRelevant(input: DirectoryRelevanceInput): Promise<boolean>;
}
