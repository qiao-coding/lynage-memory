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

/** AI-generated chunk summary — structured for semantic navigation */
export interface ChunkSummary {
  summary: string;
  progress: string;
  keywords: string[];
  /** Concrete conclusions reached in this window (decisions, outcomes) */
  conclusions: string[];
  /** Goals / what this window aimed to accomplish */
  goals: string[];
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

/** AI-generated directory summary — the parent context that guides navigation */
export interface DirectorySummary {
  overallContent: string;
  progress: string;
  mainConclusions: string[];
  importantChanges: string[];
  /** Aggregated goals across child windows */
  goals: string[];
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
  /** Directory overview — what this phase covers */
  overallContent: string;
  /** Key conclusions reached in this directory's windows */
  mainConclusions: string[];
  /** Important changes in direction or abandoned approaches */
  importantChanges: string[];
  /** Aggregated goals across child windows */
  goals: string[];
  /** User's original question */
  question: string;
  /** Query understanding intent */
  intent: string;
}

/** Input for chunk relevance judgment (summary-first matching) */
export interface ChunkRelevanceInput {
  /** AI-generated chunk summary — the window's content description */
  chunkSummary: string;
  /** Chunk keywords */
  chunkKeywords: string[];
  /** Concrete conclusions reached in this window */
  chunkConclusions: string[];
  /** Goals of this window */
  chunkGoals: string[];
  /** User's original question */
  question: string;
  /** Query understanding intent */
  intent: string;
}

/** Input for batch child selection (TOC-style navigation) */
export interface NavigateDirectoryInput {
  /** Directory ID being navigated (use "__root__" for virtual root) */
  directoryId: string;
  /** Directory overview */
  overallContent: string;
  /** Key conclusions from this directory's windows */
  mainConclusions: string[];
  /** Aggregated goals */
  goals: string[];
  /** Parent directory breadcrumb — guides recursive navigation (null at root) */
  parentContext?: {
    overallContent: string;
    mainConclusions: string[];
    goals: string[];
  };
  /** User's original question */
  question: string;
  /** Query understanding intent */
  intent: string;
  /** All children — like a book's table of contents */
  children: Array<{
    childId: string;
    childType: "chunk" | "directory";
    summary: string;
    conclusions: string[];
    goals: string[];
    keywords?: string[];
  }>;
}

/** Result of TOC-style navigation */
export interface NavigateDirectoryResult {
  /** Which child IDs are relevant */
  relevantChildIds: string[];
  /** Why those were selected */
  reasoning: string;
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
  /** Does this chunk's summary semantically match the question? */
  isChunkRelevant(input: ChunkRelevanceInput): Promise<boolean>;
  /** Batch-select relevant children from a directory (TOC-style, one LLM call) */
  navigateDirectory?(input: NavigateDirectoryInput): Promise<NavigateDirectoryResult>;
}
