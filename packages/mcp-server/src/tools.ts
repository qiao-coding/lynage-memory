// ---------------------------------------------------------------------------
// MCP Tool definitions for Lynage Memory
// ---------------------------------------------------------------------------

import type { LynageMemory } from "@lynage/core";
import { z } from "zod";

export function createLynageMcpTools(memory: LynageMemory) {
  return {
    lynage_memory_read: {
      description:
        "Read the current working memory for a session. Returns current task, confirmed decisions, progress, and unresolved items.",
      inputSchema: {
        sessionId: z.string().describe("Session/thread ID"),
      },
      handler: async (args: { sessionId: string }) => {
        const wm = await memory.getWorkingMemory(args.sessionId);
        if (!wm) return { content: [{ type: "text", text: "No working memory found for this session." }] };
        return {
          content: [
            {
              type: "text",
              text: [
                `# Working Memory (${args.sessionId})`,
                wm.currentTask ? `\n## Current Task\n${wm.currentTask}` : "",
                wm.confirmed.length > 0
                  ? `\n## Confirmed\n${wm.confirmed.map((c) => `- ${c}`).join("\n")}`
                  : "",
                wm.progress.length > 0
                  ? `\n## Progress\n${wm.progress.map((p) => `- ${p}`).join("\n")}`
                  : "",
                wm.unresolved.length > 0
                  ? `\n## Unresolved\n${wm.unresolved.map((u) => `- ${u}`).join("\n")}`
                  : "",
              ].join("\n"),
            },
          ],
        };
      },
    },

    lynage_memory_search: {
      description:
        "Search conversation history. Returns matching context chunks with summaries and source ranges.",
      inputSchema: {
        query: z.string().describe("Search query"),
        sessionId: z.string().describe("Session/thread ID"),
      },
      handler: async (args: { query: string; sessionId: string }) => {
        const result = await memory.search(args);
        const text = memory.compileRetrievedContext(result);
        return { content: [{ type: "text", text }] };
      },
    },

    lynage_memory_open_source: {
      description:
        "Read the original conversation messages from a specific context chunk. Use contextId from search results.",
      inputSchema: {
        contextId: z.string().describe("Context chunk ID from search results"),
      },
      handler: async (args: { contextId: string }) => {
        const messages = await memory.openSource(args.contextId);
        if (!messages || messages.length === 0) {
          return { content: [{ type: "text", text: "No messages found for this context ID." }] };
        }
        const text = messages
          .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
          .join("\n\n---\n\n");
        return { content: [{ type: "text", text }] };
      },
    },

    lynage_memory_commit: {
      description:
        "Write back to working memory. Use 'append' to add a new item, 'remove' to delete one.",
      inputSchema: {
        section: z.string().describe("Section to update: currentTask, confirmed, progress, unresolved"),
        value: z.string().describe("Value to add or remove"),
        operation: z.enum(["append", "remove"]).describe("append or remove"),
        sessionId: z.string().optional().describe("Session ID (defaults to 'default')"),
      },
      handler: async (args: {
        section: string;
        value: string;
        operation: "append" | "remove";
        sessionId?: string;
      }) => {
        await memory.commit(
          [
            {
              target: "workingMemory",
              operation: args.operation,
              section: args.section,
              value: args.value,
            },
          ],
          args.sessionId ?? "default",
        );
        return { content: [{ type: "text", text: `Memory updated: ${args.operation} "${args.value}" to ${args.section}` }] };
      },
    },

    lynage_memory_stats: {
      description: "Get archive statistics for a session.",
      inputSchema: {
        sessionId: z.string().describe("Session/thread ID"),
      },
      handler: async (args: { sessionId: string }) => {
        const stats = await memory.getArchiveStats(args.sessionId);
        return {
          content: [
            {
              type: "text",
              text: [
                `# Archive Stats (${args.sessionId})`,
                `- Messages: ${stats.messageCount}`,
                `- Context Chunks: ${stats.chunkCount}`,
                `- Directories: ${stats.directoryCount}`,
              ].join("\n"),
            },
          ],
        };
      },
    },
  };
}
