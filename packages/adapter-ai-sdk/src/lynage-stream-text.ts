// ---------------------------------------------------------------------------
// lynageStreamText — Vercel AI SDK wrapper with Lynage Memory lifecycle
// M3+: Injects history search tools into the Agent automatically.
// ---------------------------------------------------------------------------

import { streamText, tool, type LanguageModelV1 } from "ai";
import type { CoreTool } from "ai";
import { z } from "zod";
import type { LynageMemory } from "@lynage/core";

export interface LynageStreamTextOptions {
  memory: LynageMemory;
  userId: string;
  threadId: string;
  model: LanguageModelV1;
  prompt: string;
  tools?: Record<string, CoreTool>;
  system?: string;
}

// ---- Lynage History Tools (injected into every Agent) ----

function createLynageTools(memory: LynageMemory, threadId: string) {
  const lynageSearch = tool({
    description:
      "Search conversation history for relevant past discussions. Use this when the user asks about something that was discussed before.",
    parameters: z.object({
      query: z.string().describe("Search query to find relevant past conversations"),
    }),
    execute: async ({ query }) => {
      const result = await memory.search({ query, sessionId: threadId });
      // Verify candidates against original messages before returning
      if (result.candidates.length > 0) {
        const verified = await memory.verifySearch(result.candidates, query);
        // Only return verified results
        const verifiedResult = { ...result, candidates: verified };
        return memory.compileRetrievedContext(verifiedResult);
      }
      return memory.compileRetrievedContext(result);
    },
  });

  const lynageOpenSource = tool({
    description:
      "Read the original conversation messages from a specific context chunk. Use the contextId from lynage_search results.",
    parameters: z.object({
      contextId: z.string().describe("Context chunk ID from search results"),
    }),
    execute: async ({ contextId }) => {
      const messages = await memory.openSource(contextId);
      if (!messages || messages.length === 0) {
        return "No messages found for this context ID.";
      }
      return messages
        .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
        .join("\n\n");
    },
  });

  const lynageListDirectories = tool({
    description:
      "List the directory tree of archived conversation history. Use this to understand what past topics are available.",
    parameters: z.object({}),
    execute: async () => {
      const tree = await memory.getDirectoryTree(threadId);
      if (tree.length === 0) {
        return "No archived conversation directories yet.";
      }
      return formatDirectoryTree(tree);
    },
  });

  const lynageContinueSearch = tool({
    description:
      "Continue a previously started fuzzy search task. Use when the initial search was too vague and needs further investigation. Returns the next batch of results.",
    parameters: z.object({
      taskId: z.string().describe("Search task ID to continue"),
      batchSize: z.number().optional().describe("Number of directories to check (default 3)"),
    }),
    execute: async ({ taskId, batchSize }) => {
      const batch = await memory.continueSearch(taskId, batchSize ?? 3);
      if (batch.status === "completed" || batch.status === "not_found") {
        const analysis = await memory.analyzeSearch(taskId);
        return analysis.summary + "\n\n" + analysis.suggestion;
      }
      return (
        batch.progress +
        "\nCandidates: " +
        batch.newCandidates.map((c) => `- ${c.summary}`).join("\n")
      );
    },
  });

  const lynageParallelSearch = tool({
    description:
      "Run a parallel search across multiple directory trees for a specific question. " +
      "Workers concurrently read different directories and return evidence positions. " +
      "Use for broad, important questions that need thorough historical investigation.",
    parameters: z.object({
      question: z.string().describe("The question to investigate across all history"),
      projectGoal: z.string().optional().describe("Current project context/goal"),
      knownDecisions: z.array(z.string()).optional().describe("Known decisions to include in the snapshot"),
      searchGoal: z.string().optional().describe("What specifically to look for in the results"),
    }),
    execute: async ({ question, projectGoal, knownDecisions, searchGoal }) => {
      const snapshot = {
        snapshotId: `snap-${Date.now()}`,
        projectGoal: projectGoal ?? "Investigate historical context",
        currentProgress: "Parallel search in progress",
        knownDecisions: knownDecisions ?? [],
        question,
        searchGoal: searchGoal ?? question,
      };
      const result = await memory.parallelSearch(threadId, snapshot);
      return [
        result.summary,
        result.evolutionChain.length > 0
          ? "\nInformation Evolution Chain:\n" + result.evolutionChain.join("\n")
          : "",
        `\nWorkers: ${result.totalWorkers} | Directories: ${result.totalDirectoriesSearched} | Confidence: ${Math.round(result.finalConfidence * 100)}%`,
      ].join("\n");
    },
  });

  return { lynageSearch, lynageOpenSource, lynageListDirectories, lynageContinueSearch, lynageParallelSearch };
}

/**
 * Stream a model response with full Lynage Memory lifecycle.
 * Automatically injects lynage_search, lynage_open_source, and
 * lynage_list_directories tools for history retrieval.
 */
export async function lynageStreamText(options: LynageStreamTextOptions) {
  const { memory, userId, threadId, model, prompt, tools: userTools, system } = options;

  // 1. Start turn: save user message, get compiled context
  const turn = await memory.startTurn(threadId, userId, prompt);

  // Merge user tools with Lynage history tools
  const lynageTools = createLynageTools(memory, threadId);
  const allTools = { ...lynageTools, ...userTools };

  const collectedCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }> = [];
  const collectedResults: Array<{
    toolCallId: string;
    toolName: string;
    result: unknown;
  }> = [];
  let responseText = "";

  // 2. Stream the model response (with error handling to prevent orphaned turns)
  let result;
  try {
    result = streamText({
      model,
      prompt,
      tools: allTools as Record<string, CoreTool>,
      system,
      onFinish: (event) => {
        responseText = event.text ?? "";
        for (const step of event.steps ?? []) {
          const s = step as {
            toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>;
            toolResults?: Array<{ toolCallId: string; toolName: string; result: unknown }>;
          };
          for (const tc of s.toolCalls ?? []) {
            collectedCalls.push(tc);
          }
          for (const tr of s.toolResults ?? []) {
            collectedResults.push(tr);
          }
        }
      },
    });

    // 3. Wait for stream completion
    const final = await result;
    const finalText = await final.text;

    // 4. Finish turn
    await turn.finish({
      response: responseText || finalText || "(no text response)",
      toolCalls: collectedCalls.length > 0 ? collectedCalls : undefined,
      toolResults: collectedResults.length > 0 ? collectedResults : undefined,
    });
  } catch (err) {
    // Ensure turn is always finished — even on model failure.
    // This prevents orphaned user messages in the store.
    const errorMessage = err instanceof Error ? err.message : String(err);
    await turn.finish({
      response: `[Error: ${errorMessage}]`,
    });
    throw err;
  }

  return result!;
}

// ---- Helpers ----

function formatDirectoryTree(
  nodes: Array<{ generation: number; summary: string; children: unknown[]; chunkCount: number }>,
  indent = "",
): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const prefix = indent ? "├── " : "";
    lines.push(
      `${indent}${prefix}[G${node.generation}] ${node.summary.slice(0, 80)} (${node.chunkCount} chunks)`,
    );
    if (node.children.length > 0) {
      lines.push(
        formatDirectoryTree(
          node.children as typeof nodes,
          indent + "    ",
        ),
      );
    }
  }
  return lines.join("\n");
}
