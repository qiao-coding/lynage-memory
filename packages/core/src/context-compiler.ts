// ---------------------------------------------------------------------------
// Context Compiler — compiles storage data into model-readable text
//
// Supports 6 views (per architecture.md §13):
//   normal-chat        — default: UserMemory + WorkingMemory + Recent
//   project-work       — normal-chat + directories + unresolved issues
//   history-search     — search result candidates + source positions
//   worker-search      — shared snapshot + single subdirectory (M8 ready)
//   source-verification — candidate full text + query comparison
//   archive-indexing   — chunk messages → summary prompt
// ---------------------------------------------------------------------------

import type { Message, WorkingMemory, DirectoryNode, ContextChunk, UserMemory } from "./types.js";
import type { VerifiedCandidate } from "./source-verifier.js";

// ---- View type ----

export type CompileView =
  | "normal-chat"
  | "project-work"
  | "history-search"
  | "worker-search"
  | "source-verification"
  | "archive-indexing";

// ---- Options ----

export interface CompileOptions {
  view?: CompileView;
  workingMemory?: WorkingMemory | null;
  userMemory?: UserMemory | null;
  recentMessages: Message[];
  directories?: DirectoryNode[];
  chunkSummaries?: ContextChunk[];
  /** Verified search candidates (history-search / source-verification views) */
  verifiedCandidates?: VerifiedCandidate[];
  /** Original query (source-verification view) */
  searchQuery?: string;
  /** Worker snapshot (worker-search view, M8) */
  workerSnapshot?: { snapshotId: string; question: string; directoryId: string };
  maxTokens?: number;
}

export interface CompiledContext {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  estimatedTokens: number;
}

/**
 * Compile storage data into model-ready context.
 * Behavior controlled by `view` parameter.
 */
export function compileContext(options: CompileOptions): CompiledContext {
  const view = options.view ?? "normal-chat";

  switch (view) {
    case "normal-chat":
      return compileNormalChat(options);
    case "project-work":
      return compileProjectWork(options);
    case "history-search":
      return compileHistorySearch(options);
    case "worker-search":
      return compileWorkerSearch(options);
    case "source-verification":
      return compileSourceVerification(options);
    case "archive-indexing":
      return compileArchiveIndexing(options);
  }
}

// ---- View compilers ----

function compileNormalChat(options: CompileOptions): CompiledContext {
  const parts: string[] = [];

  if (options.userMemory) {
    parts.push(formatUserMemoryCompact(options.userMemory));
  }
  if (options.workingMemory) {
    parts.push(formatWorkingMemory(options.workingMemory));
  }

  return buildResult(parts, options.recentMessages);
}

function compileProjectWork(options: CompileOptions): CompiledContext {
  const parts: string[] = [];

  // User memory + working memory
  if (options.userMemory) {
    parts.push(formatUserMemoryCompact(options.userMemory));
  }
  if (options.workingMemory) {
    parts.push(formatWorkingMemory(options.workingMemory));
  }

  // Directory summaries for project context
  if (options.directories && options.directories.length > 0) {
    parts.push("# Project History\n");
    for (const dir of options.directories) {
      parts.push(formatDirectorySummary(dir));
    }
  }

  // Unresolved issues highlighted
  if (options.workingMemory?.unresolved.length) {
    parts.push("\n## ⚠️ Unresolved Issues");
    for (const u of options.workingMemory.unresolved) {
      parts.push(`- [ ] ${u}`);
    }
  }

  return buildResult(parts, options.recentMessages);
}

function compileHistorySearch(options: CompileOptions): CompiledContext {
  const parts: string[] = [];

  if (!options.verifiedCandidates || options.verifiedCandidates.length === 0) {
    parts.push("[No verified history results found.]");
    return buildResult(parts, options.recentMessages);
  }

  parts.push(`# History Search Results (${options.verifiedCandidates.length} verified)\n`);

  for (let i = 0; i < options.verifiedCandidates.length; i++) {
    const c = options.verifiedCandidates[i]!;
    parts.push(
      `## Result ${i + 1} — Confidence: ${Math.round(c.confidence * 100)}%`,
      `- **Summary**: ${c.summary}`,
      `- **Progress**: ${c.progress}`,
      `- **Time**: ${new Date(c.timeRange.start).toLocaleDateString()}`,
      `- **Source**: \`${c.sourceRange.from}\` → \`${c.sourceRange.to}\``,
      `- **Keywords**: ${c.keywords.join(", ")}`,
      `- **Verified**: ${c.verified ? "✅" : "❌"} (context expanded: ${c.contextExpanded ? "✅" : "❌"})`,
      "",
    );
  }

  parts.push("> Use lynage_open_source with the contextId to read full original messages.");

  return buildResult(parts, options.recentMessages);
}

function compileWorkerSearch(options: CompileOptions): CompiledContext {
  const parts: string[] = [];

  if (options.workerSnapshot) {
    parts.push(
      `# Worker Search Task`,
      `- Snapshot: ${options.workerSnapshot.snapshotId}`,
      `- Question: ${options.workerSnapshot.question}`,
      `- Directory: ${options.workerSnapshot.directoryId}`,
      "",
      "Read the assigned directory and return evidence locations. Do NOT modify working memory.",
      "",
    );
  } else {
    parts.push("# Worker Search\n[No snapshot assigned.]");
  }

  return buildResult(parts, options.recentMessages);
}

function compileSourceVerification(options: CompileOptions): CompiledContext {
  const parts: string[] = [];

  if (!options.verifiedCandidates || options.verifiedCandidates.length === 0) {
    parts.push("[No candidates to verify.]");
    return buildResult(parts, options.recentMessages);
  }

  parts.push("# Source Verification\n");

  if (options.searchQuery) {
    parts.push(`**Query**: "${options.searchQuery}"\n`);
  }

  for (let i = 0; i < options.verifiedCandidates.length; i++) {
    const c = options.verifiedCandidates[i]!;
    parts.push(
      `## Candidate ${i + 1} [Confidence: ${Math.round(c.confidence * 100)}%]`,
      `- Summary: ${c.summary}`,
      `- Source: ${c.sourceRange.from} → ${c.sourceRange.to}`,
      `- Verified: ${c.verified ? "YES" : "NO"}`,
      "",
    );
  }

  return buildResult(parts, options.recentMessages);
}

function compileArchiveIndexing(options: CompileOptions): CompiledContext {
  const parts: string[] = [];

  parts.push(
    "# Archive Indexing Task",
    "",
    "Summarize the following conversation segment for archive navigation.",
    "Focus on: what was discussed, decisions made, progress, and key terms.",
    "",
  );

  return buildResult(parts, options.recentMessages);
}

// ---- Shared result builder ----

function buildResult(
  parts: string[],
  messages: Message[],
): CompiledContext {
  const systemPrompt = parts.join("\n");

  const modelMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const estimatedTokens =
    Math.ceil(systemPrompt.length / 4) +
    modelMessages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

  return { systemPrompt, messages: modelMessages, estimatedTokens };
}

// ---- Formatters ----

function formatUserMemoryCompact(um: UserMemory): string {
  const lines: string[] = ["# User Preferences"];
  if (um.preferences.length > 0) {
    lines.push(um.preferences.map((p) => `- ${p}`).join("\n"));
  }
  if (um.constraints.length > 0) {
    lines.push(`\nConstraints: ${um.constraints.join("; ")}`);
  }
  return lines.join("\n");
}

function formatWorkingMemory(wm: WorkingMemory): string {
  const lines: string[] = ["# Working Memory"];

  if (wm.currentTask) {
    lines.push(`\n## Current Task\n${wm.currentTask}`);
  }
  if (wm.confirmed.length > 0) {
    lines.push(`\n## Confirmed Decisions\n${wm.confirmed.map((c) => `- ${c}`).join("\n")}`);
  }
  if (wm.progress.length > 0) {
    lines.push(`\n## Progress\n${wm.progress.map((p) => `- ${p}`).join("\n")}`);
  }
  if (wm.unresolved.length > 0) {
    lines.push(`\n## Unresolved\n${wm.unresolved.map((u) => `- ${u}`).join("\n")}`);
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
    lines.push(`Key conclusions: ${dir.mainConclusions.join("; ")}`);
  }
  if (dir.importantChanges.length > 0) {
    lines.push(`Important changes: ${dir.importantChanges.join("; ")}`);
  }
  lines.push(`Progress: ${dir.progress}`);
  lines.push("");

  return lines.join("\n");
}
