// ---------------------------------------------------------------------------
// lynageStreamText — Vercel AI SDK wrapper with Lynage Memory lifecycle
// M1+: Uses startTurn/finishTurn to auto-save all messages.
// ---------------------------------------------------------------------------

import { streamText, type LanguageModelV1 } from "ai";
import type { CoreTool } from "ai";
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

/**
 * Stream a model response with full Lynage Memory lifecycle.
 */
export async function lynageStreamText(options: LynageStreamTextOptions) {
  const { memory, userId, threadId, model, prompt, tools, system } = options;

  // 1. Start turn: save user message, get compiled context
  const turn = await memory.startTurn(threadId, userId, prompt);

  // We pass the prompt directly (not as messages) since startTurn handles that
  // The model receives the prompt as the user message; tools are passed separately.
  // For advanced context injection, use the system prompt or override in M2+.

  // Accumulate tool calls/results from onFinish callback
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

  // 2. Stream the model response
  const result = streamText({
    model,
    prompt,
    tools,
    system,
    onFinish: (event) => {
      responseText = event.text ?? "";
      // Collect tool calls from steps
      for (const step of event.steps ?? []) {
        for (const tc of (step as { toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> }).toolCalls ?? []) {
          collectedCalls.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          });
        }
        for (const tr of (step as { toolResults?: Array<{ toolCallId: string; toolName: string; result: unknown }> }).toolResults ?? []) {
          collectedResults.push({
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            result: tr.result,
          });
        }
      }
    },
  });

  // 3. Wait for stream completion
  const final = await result;

  const finalText = await final.text;

  // 4. Finish turn: save assistant + tool messages
  await turn.finish({
    response: responseText || finalText || "(no text response)",
    toolCalls: collectedCalls.length > 0 ? collectedCalls : undefined,
    toolResults: collectedResults.length > 0 ? collectedResults : undefined,
  });

  return result;
}
