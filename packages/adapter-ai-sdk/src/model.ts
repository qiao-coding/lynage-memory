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
  ChunkRelevanceInput,
  NavigateDirectoryInput,
  NavigateDirectoryResult,
  RerankInput,
  RerankResult,
} from "@lynage/core";
import {
  ChunkSummarySchema,
  DirectorySummarySchema,
  SearchBatchResultSchema,
  NavigateDirectoryResultSchema,
  RerankResultSchema,
} from "@lynage/core";

export interface AiSdkModelOptions {
  /**
   * Use generateObject (tool_choice structured output) for model calls.
   * Set false for thinking/reasoning models (e.g. deepseek-v4-flash) where
   * tool_choice is unsupported — they fail EVERY call, then waste 3 retries
   * before falling back. Default true.
   */
  useToolChoice?: boolean;
}

export class AiSdkModel implements LynageModel {
  private model: LanguageModelV1;
  private systemPrompt: string;
  private useToolChoice: boolean;

  constructor(model: LanguageModelV1, systemPrompt?: string, options?: AiSdkModelOptions) {
    this.model = model;
    this.systemPrompt = systemPrompt ?? "";
    this.useToolChoice = options?.useToolChoice ?? true;
  }

  /**
   * Structured output: generateObject (if enabled) → generateText + JSON parse.
   * ONE generateObject attempt only — no retry storm. If both paths fail,
   * throws; callers fall back to their keyword logic.
   */
  private async structured<S extends z.ZodType>(
    schema: S,
    prompt: string,
    system: string,
    jsonHint: string,
  ): Promise<z.output<S>> {
    if (this.useToolChoice) {
      try {
        const r = await generateObject({ model: this.model, schema, system, prompt });
        return r.object as z.output<S>;
      } catch {
        // Fall through to generateText + JSON parse (works for thinking models)
      }
    }
    const text = await generateText({ model: this.model, system, prompt: prompt + jsonHint });
    const jsonMatch = text.text.match(/\{[\s\S]*?\}/); // non-greedy, first JSON object
    if (jsonMatch) {
      try {
        return schema.parse(JSON.parse(jsonMatch[0])) as z.output<S>;
      } catch {
        // parse or schema validation failed
      }
    }
    throw new Error("structured output failed");
  }

  async summarizeChunk(input: ChunkSummaryInput): Promise<ChunkSummary> {
    const content = formatMessagesForSummary(input.messages, input.recentMemory);

    const prompt = `Summarize the following conversation segment into a STRUCTURED memory entry.

Extract:
- summary: What was discussed (overview)
- progress: How work advanced
- keywords: Key terms
- conclusions: CONCRETE decisions/outcomes reached (e.g. "chose MongoDB over PostgreSQL", "abandoned CSS Modules"). Empty if none.
- goals: What this segment aimed to accomplish

This structured output is used for semantic navigation — a reader scans conclusions/goals like a book's table of contents to decide whether to open this window.

${content}`;

    // Structured output: generateObject (if enabled) → generateText + JSON.
    // Single generateObject attempt — a transient/thinking-mode failure
    // immediately falls to generateText, never a 3× retry storm.
    try {
      return await this.structured(
        ChunkSummarySchema,
        prompt,
        this.systemPrompt + "\nYou are a precise conversation archivist. Summarize the given conversation segment accurately.",
        '\n\nReturn ONLY a JSON object with fields: {"summary": "...", "progress": "...", "keywords": [...], "conclusions": [...], "goals": [...]}',
      );
    } catch {
      // Both structured paths failed — derive a keyword fallback from the messages
      // so a transient API error NEVER kills the archive task.
      const raw = input.messages.map((m) => m.content).join(" ").slice(0, 300);
      const kw = raw.split(/[，。；、,.;\s]+/).filter((w) => w.length >= 2).slice(0, 10);
      return { summary: raw.slice(0, 200), progress: "Unknown", keywords: kw, conclusions: [], goals: [] };
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

    const prompt = `Create a directory summary that synthesizes the following conversation segments. This is the PARENT CONTEXT for semantic navigation — like a book's table of contents, it must let a reader decide which child to open.

Time range: ${new Date(input.timeRangeStart).toISOString()} to ${new Date(input.timeRangeEnd).toISOString()}

Child segments:
${childList}

Produce:
- overallContent: A narrative summary of what happened
- progress: How the project advanced
- mainConclusions: Key decisions reached
- importantChanges: Changes in direction or abandoned approaches
- goals: Aggregated goals across the child windows`;

    try {
      return await this.structured(
        DirectorySummarySchema,
        prompt,
        this.systemPrompt,
        '\n\nReturn ONLY JSON: {"overallContent":"...","progress":"...","mainConclusions":[...],"importantChanges":[...],"goals":[...]}',
      );
    } catch {
      // Both structured paths failed — aggregate keywords/conclusions from children.
      const allKeywords = [...new Set(input.childDescriptions.flatMap((c) => c.keywords ?? []))];
      const allConclusions = [...new Set(input.childDescriptions.flatMap((c) => c.conclusions))];
      return {
        overallContent: "Phases covered: " + allKeywords.slice(0, 30).join(", "),
        progress: `Archived ${input.childDescriptions.length} windows`,
        mainConclusions: allConclusions.slice(0, 20),
        importantChanges: [],
        goals: [],
      };
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

    return this.structured(
      SearchBatchResultSchema,
      `A user is searching for: "${input.query}"

Current understanding of what they're looking for: ${input.currentUnderstanding || "Unknown — this is a vague query."}

Candidate directories to check:
${candidateList}

Determine:
- relevantIds: Which directory IDs are relevant to the query?
- reasoning: Why those are relevant (or why none match)
- shouldContinue: Should we check more directories?
- refinedUnderstanding: (optional) Has the search clarified what the user is really looking for?`,
      this.systemPrompt + "\nYou are a precise search analyst. Match queries against directory summaries.",
      '\n\nReturn ONLY JSON: {"relevantIds":[...],"reasoning":"...","shouldContinue":true/false,"refinedUnderstanding":"..."}',
    );
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
      return await this.structured(
        schema,
        prompt,
        this.systemPrompt,
        '\n\nReturn ONLY JSON: {"intent":"fact_lookup"|"process_recall"|"decision","description":"...","keywords":[...]}',
      );
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
    const prompt = `You are navigating a memory directory tree. Like a book's table of contents, decide whether this directory's content relates to the user's question.

User question: "${input.question}"
What the user is looking for: intent=${input.intent}

Directory overview: "${input.overallContent}"
Directory conclusions: ${input.mainConclusions.join("; ")}
Directory goals: ${input.goals.join("; ")}
Important changes: ${input.importantChanges.join("; ")}

Does this directory contain information relevant to the user's question? Answer with a single word: YES or NO.
- YES if the directory's conclusions/goals/content relate to what the user asks about (semantic match, exact words may differ)
- NO if it's clearly unrelated`;

    try {
      const text = await generateText({ model: this.model, system: this.systemPrompt, prompt, maxTokens: 10 });
      const t = text.text.trim().toUpperCase();
      return t.startsWith("YES");
    } catch {
      // Fallback: token overlap across all structured fields
      const terms: string[] = input.question.replace(/[^\w\s一-鿿]/g, " ").split(/\s+/).filter((k) => k.length > 1);
      const summary = input.overallContent + " " + input.mainConclusions.join(" ") + " " + input.goals.join(" ") + " " + input.importantChanges.join(" ");
      return terms.some((t: string) => summary.includes(t));
    }
  }

  /**
   * Summary-first matching: does this chunk's summary semantically match
   * the question? Used inside drillDown instead of keyword-only computeRelevance.
   */
  async isChunkRelevant(input: ChunkRelevanceInput): Promise<boolean> {
    const prompt = `You are matching a memory window against a user question.

User question: "${input.question}"
What the user is looking for: intent=${input.intent}

Window overview: "${input.chunkSummary}"
Window conclusions: ${input.chunkConclusions.join("; ")}
Window goals: ${input.chunkGoals.join("; ")}
Window keywords: ${input.chunkKeywords.join(", ")}

Like a book chapter — decide if this window contains what the user asks about. Answer with a single word: YES or NO.
- YES if the window's conclusions/goals/topic match the user's question (semantic match, exact words may differ)
- NO if clearly unrelated`;

    try {
      const text = await generateText({ model: this.model, system: this.systemPrompt, prompt, maxTokens: 10 });
      const t = text.text.trim().toUpperCase();
      return t.startsWith("YES");
    } catch {
      // Fallback: token overlap with conclusions + goals + summary
      const terms: string[] = input.question.replace(/[^\w\s一-鿿]/g, " ").split(/\s+/).filter((k: string) => k.length > 1);
      const text = input.chunkSummary + " " + input.chunkConclusions.join(" ") + " " + input.chunkGoals.join(" ") + " " + input.chunkKeywords.join(" ");
      return terms.some((t: string) => text.includes(t));
    }
  }

  /**
   * TOC-style navigation: scan all children of a directory at once
   * and select which ones are relevant — like scanning a book's table of contents.
   */
  async navigateDirectory(input: NavigateDirectoryInput): Promise<NavigateDirectoryResult> {
    const childrenList = input.children
      .map(
        (c, i) =>
          `[${i + 1}] Type: ${c.childType === "chunk" ? "window" : "phase"} | ID: ${c.childId}\n    Summary: "${c.summary}"\n    Conclusions: ${c.conclusions.join("; ")}\n    Goals: ${c.goals.join("; ")}` +
          (c.keywords?.length ? `\n    Keywords: ${c.keywords.join(", ")}` : ""),
      )
      .join("\n\n");

    const parentBreadcrumb = input.parentContext
      ? `Parent context (this directory is inside):
  Overview: "${input.parentContext.overallContent}"
  Conclusions: ${input.parentContext.mainConclusions.join("; ")}
  Goals: ${input.parentContext.goals.join("; ")}

`
      : "";

    const prompt = `You are scanning a memory directory like a book's table of contents. The user has a question — find which chapters (children) are relevant.

${parentBreadcrumb}Directory context (section overview):
  Overview: "${input.overallContent}"
  Conclusions: ${input.mainConclusions.join("; ")}
  Goals: ${input.goals.join("; ")}

User question: "${input.question}"
Intent: ${input.intent}

Children (chapters in this section):
${childrenList}

Determine:
- relevantChildIds: Which child IDs are relevant to the question? Include ALL that match, not just the best one.
- reasoning: Brief explanation of why those were selected (or why none match)`;

    try {
      return await this.structured(
        NavigateDirectoryResultSchema,
        prompt,
        this.systemPrompt + "\nYou are a precise TOC navigator. Select all relevant children.",
        '\n\nReturn ONLY JSON: {"relevantChildIds":["..."],"reasoning":"..."}',
      );
    } catch {
      // Fallback: keyword overlap on children summaries/conclusions/goals
      const terms: string[] = input.question.replace(/[^\w\s一-鿿]/g, " ").split(/\s+/).filter((k: string) => k.length > 1);
      const relevantChildIds = input.children
        .filter((c) => {
          const text = c.summary + " " + c.conclusions.join(" ") + " " + c.goals.join(" ") + " " + (c.keywords ?? []).join(" ");
          return terms.some((t: string) => text.includes(t));
        })
        .map((c) => c.childId);
      return { relevantChildIds, reasoning: "Keyword fallback" };
    }
  }

  /**
   * Semantic rerank of FTS candidates: filters incidental mentions.
   * FTS matches by keyword frequency — a topic word in passing ("Table组件
   * 的状态管理方案") outranks the real decision ("关于状态管理的决策过程").
   * The LLM distinguishes genuine relevance from noise in ONE bounded call.
   */
  async rerankCandidates(input: RerankInput): Promise<RerankResult> {
    const candidatesList = input.candidates
      .map(
        (c, i) =>
          `[${i + 1}] ID: ${c.contextId}\n    Summary: "${c.summary}"\n    Matching message: "${c.messageSnippet ?? c.summary}"\n    Conclusions: ${c.conclusions.join("; ")}\n    Goals: ${c.goals.join("; ")}` +
          (c.keywords?.length ? `\n    Keywords: ${c.keywords.join(", ")}` : ""),
      )
      .join("\n\n");

    const prompt = `You are a precise memory search reranker. A user question matched some conversation-window candidates by keyword — but keyword matches include INCIDENTAL mentions (a topic mentioned in passing) alongside the REAL answer.

User question: "${input.query}"
Intent: ${input.intent}

Candidates (from keyword search). The "Matching message" is the actual conversation text that matched — use it to judge REAL relevance:
${candidatesList}

Select ONLY the candidate(s) genuinely about the user's question — the decision/process/content the question asks about. EXCLUDE candidates that merely mention the topic in passing (e.g. a message like "Table组件的状态管理方案" when asking about the state-management DECISION process; the real decision messages say things like "关于状态管理...最后决定用Redux Toolkit").

- relevantIds: IDs genuinely relevant to the question. Empty if none are.
- reasoning: Brief explanation.`;

    try {
      return await this.structured(
        RerankResultSchema,
        prompt,
        this.systemPrompt + "\nYou are a precise relevance judge for a memory system.",
        '\n\nReturn ONLY JSON: {"relevantIds":["..."],"reasoning":"..."}',
      );
    } catch {
      // Fallback: keep candidates whose summary/conclusions contain any query topic term.
      const terms: string[] = input.query.replace(/[^\w\s一-鿿]/g, " ").split(/\s+/).filter((k: string) => k.length >= 2);
      const relevantIds = input.candidates
        .filter((c) => {
          const text = c.summary + " " + c.conclusions.join(" ") + " " + c.goals.join(" ") + " " + (c.keywords ?? []).join(" ");
          return terms.some((t: string) => text.includes(t));
        })
        .map((c) => c.contextId);
      return { relevantIds, reasoning: "Keyword fallback" };
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
