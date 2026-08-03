// ---------------------------------------------------------------------------
// Zod schemas for validating AI model output
// These are the gate between untrusted model output and trusted storage.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Validates a chunk summary from the AI model */
export const ChunkSummarySchema = z.object({
  summary: z.string().min(1, "Summary must not be empty"),
  progress: z.string().min(1, "Progress must not be empty"),
  keywords: z.array(z.string()).min(1, "At least one keyword required"),
  conclusions: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
});

/** Validates a directory summary from the AI model */
export const DirectorySummarySchema = z.object({
  overallContent: z.string().min(1, "Overall content must not be empty"),
  progress: z.string().min(1, "Progress must not be empty"),
  mainConclusions: z.array(z.string()),
  importantChanges: z.array(z.string()),
  goals: z.array(z.string()).default([]),
});

/** Validates a search batch result from the AI model */
export const SearchBatchResultSchema = z.object({
  relevantIds: z.array(z.string()),
  reasoning: z.string(),
  shouldContinue: z.boolean(),
  refinedUnderstanding: z.string().optional(),
});

/** Validates a navigateDirectory result (TOC-style child selection) */
export const NavigateDirectoryResultSchema = z.object({
  relevantChildIds: z.array(z.string()),
  reasoning: z.string(),
});

/** Validates a rerankCandidates result (semantic filtering of FTS candidates) */
export const RerankResultSchema = z.object({
  relevantIds: z.array(z.string()),
  reasoning: z.string(),
});

// ---------------------------------------------------------------------------
// Memory action — model-proposed write-back (validated before execution)
// ---------------------------------------------------------------------------

export type MemoryActionTarget = "workingMemory" | "userMemory";

export type MemoryActionOperation = "append" | "remove";

export const MemoryActionSchema = z.object({
  target: z.enum(["workingMemory", "userMemory"]),
  operation: z.enum(["append", "remove"]),
  section: z.string().min(1),
  value: z.string().min(1),
});

export type MemoryAction = z.infer<typeof MemoryActionSchema>;

/** Multiple actions in one reply */
export const MemoryActionsSchema = z.array(MemoryActionSchema);

// ---------------------------------------------------------------------------
// Helper: parse + validate model output
// ---------------------------------------------------------------------------

export function validateChunkSummary(data: unknown) {
  return ChunkSummarySchema.parse(data);
}

export function validateDirectorySummary(data: unknown) {
  return DirectorySummarySchema.parse(data);
}

export function validateSearchBatchResult(data: unknown) {
  return SearchBatchResultSchema.parse(data);
}

export function validateMemoryActions(data: unknown): MemoryAction[] {
  return MemoryActionsSchema.parse(data);
}
