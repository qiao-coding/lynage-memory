// ---------------------------------------------------------------------------
// Context Compiler — compiles storage data into model-readable text
//
// Takes raw data from store (messages, working memory, directory summaries)
// and produces a formatted prompt suitable for model consumption.
//
// Truncation policy: newer messages prioritized; directories summarized at
// top level; working memory injected as system context.
// ---------------------------------------------------------------------------

import type { Message, WorkingMemory, DirectoryNode, ContextChunk } from "./types.js";

export interface CompileOptions {
  /** Working memory for the current session */
  workingMemory?: WorkingMemory | null;
  /** Recent messages (already trimmed by archive manager) */
  recentMessages: Message[];
  /** Top-level directory summaries to include */
  directories?: DirectoryNode[];
  /** Optional chunk summaries for more context */
  chunkSummaries?: ContextChunk[];
  /** Max tokens for the compiled output (soft limit) */
  maxTokens?: number;
}

export interface CompiledContext {
  /** System prompt text (working memory + directory summaries) */
  systemPrompt: string;
  /** Messages for the model */
  messages: Array<{ role: string; content: string }>;
  /** Estimated token count */
  estimatedTokens: number;
}

/**
 * Compile storage data into model-ready context.
 */
export function compileContext(options: CompileOptions): CompiledContext {
  const parts: string[] = [];

  // 1. Working Memory section
  if (options.workingMemory) {
    parts.push(formatWorkingMemory(options.workingMemory));
  }

  // 2. Directory summaries
  if (options.directories && options.directories.length > 0) {
    parts.push("# Project History\n");
    for (const dir of options.directories) {
      parts.push(formatDirectorySummary(dir));
    }
  }

  // 3. Chunk summaries (if provided)
  if (options.chunkSummaries && options.chunkSummaries.length > 0) {
    parts.push("\n# Recent Archives\n");
    for (const chunk of options.chunkSummaries) {
      parts.push(
        `- [${new Date(chunk.timeRangeStart).toLocaleDateString()}] ${chunk.summary}`,
      );
    }
  }

  const systemPrompt = parts.join("\n");

  // 4. Messages for the model
  const messages = options.recentMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 5. Estimate tokens
  const estimatedTokens =
    systemPrompt.length / 4 +
    messages.reduce((sum, m) => sum + m.content.length / 4, 0);

  return {
    systemPrompt,
    messages,
    estimatedTokens: Math.ceil(estimatedTokens),
  };
}

// ---- Formatters ----

function formatWorkingMemory(wm: WorkingMemory): string {
  const lines: string[] = ["# Working Memory"];

  if (wm.currentTask) {
    lines.push(`\n## Current Task\n${wm.currentTask}`);
  }

  if (wm.confirmed.length > 0) {
    lines.push(
      `\n## Confirmed Decisions\n${wm.confirmed.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  if (wm.progress.length > 0) {
    lines.push(
      `\n## Progress\n${wm.progress.map((p) => `- ${p}`).join("\n")}`,
    );
  }

  if (wm.unresolved.length > 0) {
    lines.push(
      `\n## Unresolved\n${wm.unresolved.map((u) => `- ${u}`).join("\n")}`,
    );
  }

  return lines.join("\n");
}

function formatDirectorySummary(dir: DirectoryNode): string {
  const lines: string[] = [
    `## ${new Date(dir.timeRangeStart).toLocaleDateString()} — ${new Date(dir.timeRangeEnd).toLocaleDateString()}`,
    "",
    dir.overallContent,
    "",
  ];

  if (dir.mainConclusions.length > 0) {
    lines.push(
      `Key conclusions: ${dir.mainConclusions.join("; ")}`,
    );
  }

  if (dir.importantChanges.length > 0) {
    lines.push(
      `Important changes: ${dir.importantChanges.join("; ")}`,
    );
  }

  lines.push(`Progress: ${dir.progress}`);
  lines.push("");

  return lines.join("\n");
}
