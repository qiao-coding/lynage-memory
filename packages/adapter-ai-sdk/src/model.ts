// ---------------------------------------------------------------------------
// AiSdkModel — LynageModel implementation using Vercel AI SDK
// Uses generateObject + Zod schemas for structured model output.
// ---------------------------------------------------------------------------

import { generateObject, generateText, type LanguageModelV1 } from "ai";
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

    const prompt = `Summarize the following conversation segment.

Focus on:
- What was discussed and decided
- How the work progressed (not just topics, but the flow of decisions)
- Key terms and concepts mentioned

${content}`;

    // Try generateObject first (structured output via tool_choice)
    try {
      const result = await retryWithValidation(
        () =>
          generateObject({
            model: this.model,
            schema: ChunkSummarySchema,
            system:
              this.systemPrompt +
              "\nYou are a precise conversation archivist. Summarize the given conversation segment accurately.",
            prompt,
          }),
        MAX_RETRIES,
      );
      return result.object as ChunkSummary;
    } catch {
      // Fallback: generateText + JSON parse (compatible with thinking models)
      const text = await generateText({
        model: this.model,
        system: this.systemPrompt,
        prompt: prompt + '\n\nReturn ONLY a JSON object with fields: {"summary": "...", "progress": "...", "keywords": [...]}',
      });
      const jsonMatch = text.text.match(/\{[\s\S]*?\}/); // non-greedy, first JSON object only
      if (jsonMatch) {
        try {
          const parsed = ChunkSummarySchema.parse(JSON.parse(jsonMatch[0]));
          return parsed;
        } catch {
          // JSON parse or schema validation failed, use raw text
        }
      }
      return { summary: text.text.slice(0, 200), progress: "Unknown", keywords: [] };
    }
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

    const prompt = `Create a directory summary that synthesizes the following conversation segments.

Time range: ${new Date(input.timeRangeStart).toISOString()} to ${new Date(input.timeRangeEnd).toISOString()}

Child segments:
${childList}

Produce:
- overallContent: A narrative summary of what happened
- progress: How the project advanced
- mainConclusions: Key decisions reached
- importantChanges: Changes in direction or abandoned approaches`;

    try {
      const result = await retryWithValidation(
        () =>
          generateObject({
            model: this.model,
            schema: DirectorySummarySchema,
            system: this.systemPrompt,
            prompt,
          }),
        MAX_RETRIES,
      );
      return result.object as DirectorySummary;
    } catch {
      const text = await generateText({
        model: this.model,
        prompt: prompt + '\n\nReturn ONLY JSON: {"overallContent":"...","progress":"...","mainConclusions":[...],"importantChanges":[...]}',
      });
      const jsonMatch = text.text.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          return DirectorySummarySchema.parse(JSON.parse(jsonMatch[0]));
        } catch {
          // parse failed, use raw text
        }
      }
      return { overallContent: text.text.slice(0, 200), progress: "Unknown", mainConclusions: [], importantChanges: [] };
    }
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
