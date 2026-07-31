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
  // Chinese/CJK characters ≈ 1 token each, Latin ≈ 4 chars per token
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      tokens += 1; // CJK Unified + Extension A: ~1 token per char
    } else if (ch === " " || code < 128) {
      tokens += 0.25; // ASCII: ~4 chars per token
    } else {
      tokens += 0.5; // Other (CJK punctuation etc): ~2 chars per token
    }
  }
  return Math.ceil(tokens);
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessagesTokenCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    // If the message already has a recorded tokenCount, use it
    if (msg.tokenCount != null) {
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
