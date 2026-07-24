// ---------------------------------------------------------------------------
// Token counting utility
// Simple char-based estimator. Can be swapped for tiktoken later.
// ---------------------------------------------------------------------------

import type { Message } from "./types.js";

/**
 * Rough token estimation: ~4 characters per token for English text.
 * This is intentionally simple for M0-M2; replace with tiktoken or
 * gpt-tokenizer for production accuracy.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // 4 chars ≈ 1 token is a common rule of thumb
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessagesTokenCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    // If the message already has a recorded tokenCount, use it
    if (msg.tokenCount) {
      total += msg.tokenCount;
    } else {
      total += estimateTokenCount(msg.content);
    }
  }
  return total;
}

/**
 * Format a token count for display.
 */
export function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return String(count);
}
