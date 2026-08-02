// ---------------------------------------------------------------------------
// AiSdkModel — LynageModel implementation using Vercel AI SDK
// Uses generateObject + Zod schemas for structured model output.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { generateObject, generateText, type LanguageModelV1 } from "ai";
import type {
  LynageModel,
  ChunkSummaryInput,
  ChunkSummary,
  DirectorySummaryInput,
  DirectorySummary,
  SearchBatchInput,
  SearchBatchResult,
  QueryUnderstanding,
  DirectoryRelevanceInput,
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
          `[${i + 1}] Type: ${c.type}\n    Summary: ${c.summary}\n    Progress: ${c.progress}\n    Conclusions: ${c.conclusions.join("; ")}` +
          (c.importantChanges?.length ? `\n    ImportantChanges: ${c.importantChanges.join("; ")}` : "") +
          (c.keywords?.length ? `\n    Keywords: ${c.keywords.join(", ")}` : ""),
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

  /**
   * Vague question → search intent (semantic tree navigation).
   * Extracts what the user is looking for, NOT just keywords.
   */
  async analyzeSearchQuery(question: string): Promise<QueryUnderstanding> {
    const schema = z.object({
      intent: z.enum(["fact_lookup", "process_recall", "decision"]),
      description: z.string(),
      keywords: z.array(z.string()),
    });
    const prompt = `Analyze this user question from a conversation memory system. The user may not remember exact terms — extract what they are LOOKING FOR semantically.

Question: "${question}"

Return:
- intent: "fact_lookup" (looking for a specific fact), "process_recall" (remembering how a decision was reached — what was tried, abandoned, chosen), or "decision" (what was decided)
- description: a semantic description of what memory the user needs (e.g. "the styling approach decision process")
- keywords: 2-4 key terms that would appear in the relevant conversation (topic words like 样式方案, database — NOT filler like 记不清/怎么/定了)`;

    try {
      const result = await retryWithValidation(
        () =>
          generateObject({ model: this.model, schema, system: this.systemPrompt, prompt }),
        MAX_RETRIES,
      );
      return result.object as QueryUnderstanding;
    } catch {
      // Fallback: strip fillers, keep likely topic words
      const keywords = question
        .replace(/[记不清|怎么|定了|最后|哪个|是不是|中间|换了|什么|我们|当时|我|的|方案事]/g, " ")
        .split(/\s+/)
        .filter((k) => k.length > 1)
        .slice(0, 4);
      return {
        intent: question.includes("怎么定") || question.includes("过程") || question.includes("中间") ? "process_recall" : "decision",
        description: `memory about: ${keywords.join(", ")}`,
        keywords: keywords.length > 0 ? keywords : [question.slice(0, 20)],
      };
    }
  }

  /**
   * Semantic tree navigation: does this directory's summary relate to the question?
   * The parent context (directory summary) guides whether to descend.
   */
  async isDirectoryRelevant(input: DirectoryRelevanceInput): Promise<boolean> {
    const prompt = `You are navigating a memory directory tree. Decide whether to descend into this directory.

User question: "${input.question}"
What the user is looking for: intent=${input.intent}

Directory summary (parent context):
"${input.directorySummary}"

Does this directory's content relate to what the user is looking for? Answer with a single word: YES or NO.
- YES if the directory covers the topic/semantics of the question (even if exact words differ)
- NO if it's clearly unrelated`;

    try {
      const text = await generateText({ model: this.model, system: this.systemPrompt, prompt, maxTokens: 10 });
      const t = text.text.trim().toUpperCase();
      return t.startsWith("YES");
    } catch {
      // Fallback: token overlap
      const terms: string[] = input.question.replace(/[^\w\s一-鿿]/g, " ").split(/\s+/).filter((k) => k.length > 1);
      const summary = input.directorySummary;
      return terms.some((t: string) => summary.includes(t));
    }
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
