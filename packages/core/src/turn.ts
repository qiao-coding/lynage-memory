// ---------------------------------------------------------------------------
// TurnManager — conversation turn lifecycle
// Handles startTurn (compile context) → finishTurn (save results)
// ---------------------------------------------------------------------------

import type { Message } from "./types.js";
import type { LynageStore } from "./store.js";
import { estimateTokenCount } from "./token-counter.js";
import type { ArchiveManager } from "./archive-manager.js";

// ---- Turn handle returned to the caller ----

export interface TurnHandle {
  /** Turn identifier */
  turnId: string;
  /** Compiled messages for the model (recent context + working memory) */
  messages: Message[];
  /** Call when the model response is complete */
  finish(input: FinishTurnInput): Promise<TurnResult>;
}

export interface FinishTurnInput {
  response: string;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    result: unknown;
  }>;
  /** Total token usage reported by the model (prompt + completion) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface TurnResult {
  userMessage: Message;
  assistantMessage: Message;
  toolMessages: Message[];
  totalTokens: number;
}

export interface TurnManagerConfig {
  /** Session-scoped token threshold hint (used by archive manager later) */
  tokenThreshold?: number;
}

let turnCounter = 0;

export class TurnManager {
  private store: LynageStore;
  private archiveManager?: ArchiveManager;

  constructor(store: LynageStore, archiveManager?: ArchiveManager) {
    this.store = store;
    this.archiveManager = archiveManager;
  }

  /**
   * Start a new turn: save the user message, compile recent context,
   * and return a TurnHandle for the caller to use with their model.
   */
  async startTurn(
    sessionId: string,
    userId: string | undefined,
    input: string,
  ): Promise<TurnHandle> {
    const turnId = `turn-${++turnCounter}-${Date.now()}`;

    // 1. Save user message
    const userMessage = await this.store.appendMessage({
      sessionId,
      userId,
      role: "user",
      content: input,
      tokenCount: estimateTokenCount(input),
    });

    // 2. Get recent context
    const recentMessages = await this.store.getRecent({ sessionId });

    // 3. Get working memory (inject as system context if present)
    const wm = await this.store.getWorkingMemory(sessionId);
    const systemMessages: Message[] = [];

    if (wm) {
      const memoryText = formatWorkingMemory(wm);
      // Create a synthetic system message for working memory context
      const systemMsg: Message = {
        id: `sys-${turnId}`,
        sessionId,
        role: "system",
        content: memoryText,
        createdAt: Date.now(),
      };
      systemMessages.push(systemMsg);
    }

    // 4. Compile messages: system context + recent messages
    const messages = [...systemMessages, ...recentMessages];

    const handle: TurnHandle = {
      turnId,
      messages,
      finish: async (finishInput: FinishTurnInput): Promise<TurnResult> => {
        return this.finishTurn(turnId, sessionId, userId, userMessage, finishInput);
      },
    };

    return handle;
  }

  /**
   * Finish a turn: save assistant response + tool calls/results.
   */
  private async finishTurn(
    turnId: string,
    sessionId: string,
    userId: string | undefined,
    userMessage: Message,
    input: FinishTurnInput,
  ): Promise<TurnResult> {
    const toolMessages: Message[] = [];

    // Compute token estimate for assistant message
    const assistantTokens =
      input.usage?.completionTokens ?? estimateTokenCount(input.response);

    // Save assistant message
    const assistantMessage = await this.store.appendMessage({
      sessionId,
      userId,
      role: "assistant",
      content: input.response,
      tokenCount: assistantTokens,
    });

    // Save tool calls
    if (input.toolCalls) {
      for (const tc of input.toolCalls) {
        const tcContent = JSON.stringify(tc.args);
        const msg = await this.store.appendMessage({
          sessionId,
          role: "tool",
          content: tcContent,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          tokenCount: estimateTokenCount(tcContent),
        });
        toolMessages.push(msg);
      }
    }

    // Save tool results (NO toolName — results are identified by toolCallId only,
    // so boundary-detector can distinguish calls from results)
    if (input.toolResults) {
      for (const tr of input.toolResults) {
        const content =
          typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
        const msg = await this.store.appendMessage({
          sessionId,
          role: "tool",
          content,
          toolCallId: tr.toolCallId,
          tokenCount: estimateTokenCount(content),
        });
        toolMessages.push(msg);
      }
    }

    const totalTokens =
      (userMessage.tokenCount ?? 0) +
      assistantTokens +
      toolMessages.reduce((sum, m) => sum + (m.tokenCount ?? 0), 0);

    // Trigger archiving in background (per-session queue, non-blocking)
    if (this.archiveManager) {
      this.archiveManager.queueArchive(sessionId);
    }

    return {
      userMessage,
      assistantMessage,
      toolMessages,
      totalTokens,
    };
  }
}

// ---- Helpers ----

function formatWorkingMemory(wm: {
  currentTask?: string;
  confirmed: string[];
  progress: string[];
  unresolved: string[];
}): string {
  const lines: string[] = ["# Working Memory"];

  if (wm.currentTask) {
    lines.push(`\n## Current Task\n${wm.currentTask}`);
  }

  if (wm.confirmed.length > 0) {
    lines.push(`\n## Confirmed\n${wm.confirmed.map((c) => `- ${c}`).join("\n")}`);
  }

  if (wm.progress.length > 0) {
    lines.push(`\n## Progress\n${wm.progress.map((p) => `- ${p}`).join("\n")}`);
  }

  if (wm.unresolved.length > 0) {
    lines.push(`\n## Unresolved\n${wm.unresolved.map((u) => `- ${u}`).join("\n")}`);
  }

  return lines.join("\n");
}
