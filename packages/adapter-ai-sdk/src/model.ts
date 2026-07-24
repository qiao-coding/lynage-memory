// ---------------------------------------------------------------------------
// AiSdkModel — LynageModel implementation using Vercel AI SDK
// Uses generateObject + Zod schemas for structured model output.
// ---------------------------------------------------------------------------

import { generateObject, type LanguageModelV1 } from "ai";
import type {
  LynageModel,
  ChunkSummaryInput,
  ChunkSummary,
  DirectorySummaryInput,
  DirectorySummary,
  SearchBatchInput,
  SearchBatchResult,
} from "@lynage/core";
import {
  ChunkSummarySchema,
  DirectorySummarySchema,
  SearchBatchResultSchema,
} from "@lynage/core";

const MAX_RETRIES = 3;

export class AiSdkModel implements LynageModel {
  private model: LanguageModelV1;
  private systemPrompt: string;

  constructor(model: LanguageModelV1, systemPrompt?: string) {
    this.model = model;
    this.systemPrompt = systemPrompt ?? "";
  }

  async summarizeChunk(input: ChunkSummaryInput): Promise<ChunkSummary> {
    const content = formatMessagesForSummary(input.messages, input.recentMemory);

    const result = await retryWithValidation(
      () =>
        generateObject({
          model: this.model,
          schema: ChunkSummarySchema,
          system:
            this.systemPrompt +
            "\nYou are a precise conversation archivist. Summarize the given conversation segment accurately.",
          prompt: `Summarize the following conversation segment.

Focus on:
- What was discussed and decided
- How the work progressed (not just topics, but the flow of decisions)
- Key terms and concepts mentioned

${content}`,
        }),
      MAX_RETRIES,
    );

    return result.object as ChunkSummary;
  }

  async summarizeDirectory(
    input: DirectorySummaryInput,
  ): Promise<DirectorySummary> {
    const childList = input.childDescriptions
      .map(
        (c: DirectorySummaryInput["childDescriptions"][number], i: number) =>
          `[${i + 1}] Type: ${c.type}\n    Summary: ${c.summary}\n    Progress: ${c.progress}\n    Conclusions: ${c.conclusions.join("; ")}`,
      )
      .join("\n\n");

    const result = await retryWithValidation(
      () =>
        generateObject({
          model: this.model,
          schema: DirectorySummarySchema,
          system:
            this.systemPrompt +
            "\nYou are a project historian. Synthesize multiple conversation segments into a coherent progress narrative.",
          prompt: `Create a directory summary that synthesizes the following conversation segments.

Time range: ${new Date(input.timeRangeStart).toISOString()} to ${new Date(input.timeRangeEnd).toISOString()}

Child segments:
${childList}

Produce:
- overallContent: A narrative summary of what happened across all these segments (NOT just "discussed X, Y, Z" — explain how the work progressed)
- progress: How the project/task advanced during this period
- mainConclusions: Key decisions or conclusions reached
- importantChanges: Changes in direction, abandoned approaches, or significant corrections`,
        }),
      MAX_RETRIES,
    );

    return result.object as DirectorySummary;
  }

  async analyzeSearchBatch(
    input: SearchBatchInput,
  ): Promise<SearchBatchResult> {
    const candidateList = input.candidatesToCheck
      .map(
        (c: SearchBatchInput["candidatesToCheck"][number], i: number) =>
          `[${i + 1}] ID: ${c.directoryId}\n    Summary: ${c.summary}\n    Conclusions: ${c.conclusions.join("; ")}`,
      )
      .join("\n\n");

    const result = await retryWithValidation(
      () =>
        generateObject({
          model: this.model,
          schema: SearchBatchResultSchema,
          system:
            this.systemPrompt +
            "\nYou are a precise search analyst. Match queries against directory summaries.",
          prompt: `A user is searching for: "${input.query}"

Current understanding of what they're looking for: ${input.currentUnderstanding || "Unknown — this is a vague query."}

Candidate directories to check:
${candidateList}

Determine:
- relevantIds: Which directory IDs are relevant to the query?
- reasoning: Why those are relevant (or why none match)
- shouldContinue: Should we check more directories?
- refinedUnderstanding: (optional) Has the search clarified what the user is really looking for?`,
        }),
      MAX_RETRIES,
    );

    return result.object as SearchBatchResult;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMessagesForSummary(
  messages: ChunkSummaryInput["messages"],
  recentMemory?: string,
): string {
  const lines: string[] = [];

  if (recentMemory) {
    lines.push(`## Working Memory Context\n${recentMemory}\n`);
  }

  lines.push("## Conversation\n");

  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    let line = `[${role}]`;
    if (msg.toolName) line += ` (tool: ${msg.toolName})`;
    if (msg.toolCallId) line += ` (callId: ${msg.toolCallId})`;
    line += `\n${msg.content}`;
    lines.push(line);
  }

  return lines.join("\n\n");
}

async function retryWithValidation<T>(
  fn: () => Promise<{ object: T }>,
  maxRetries: number,
): Promise<{ object: T }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        // Brief wait before retry (exponential backoff)
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError;
}
