// ---------------------------------------------------------------------------
// Natural boundary detection for conversation archiving
//
// We cannot cut within:
//   - A user→assistant Q&A pair
//   - A tool call and its corresponding tool result
//   - An incomplete decision process
//
// A natural boundary exists at a point where all pending tool calls
// have been resolved AND we are between turns (after assistant responded,
// before next user message).
// ---------------------------------------------------------------------------

import type { Message } from "./types.js";

/**
 * Find the nearest natural boundary at or before the target index.
 *
 * Returns the index (exclusive) of the oldest message to KEEP in recent context.
 * Messages before this index should be archived. Returns 0 if no valid
 * boundary found (archive nothing).
 *
 * @param messages - All messages sorted chronologically (oldest first)
 * @param targetIndex - Desired split point (index to archive up to)
 */
export function findNaturalBoundary(
  messages: Message[],
  targetIndex: number,
): number {
  if (messages.length === 0) return 0;
  if (targetIndex <= 0) return 0;
  if (targetIndex >= messages.length) targetIndex = messages.length - 1;

  // Scan from targetIndex backwards to find a valid boundary
  for (let i = targetIndex; i >= 0; i--) {
    if (isNaturalBoundary(messages, i)) {
      return i;
    }
  }

  // No boundary found — return 0 (archive nothing)
  return 0;
}

/**
 * Check if position `i` is a natural boundary.
 * `i` is the index of the LAST message to archive.
 * The boundary is between `i` and `i+1`.
 *
 * Valid boundaries:
 *   - After the last message in a complete turn (user→assistant→[tool calls→results])
 *   - Before a user message (turn boundary)
 */
function isNaturalBoundary(messages: Message[], i: number): boolean {
  // If i is the last message, it's always a valid boundary
  if (i >= messages.length - 1) return true;
  if (i < 0) return true;

  const thisMsg = messages[i]!;
  const nextMsg = messages[i + 1]!;

  // Cannot cut between a tool call and any subsequent tool message
  // (tool calls/results form an atomic unit)
  if (thisMsg.role === "tool") {
    // Check if the next message is also a tool message from the same turn
    if (nextMsg.role === "tool") {
      // Both are tool messages — only cut if this is the last tool result
      // (no more pending tool calls)
      if (hasUnresolvedToolCalls(messages, i)) {
        return false;
      }
    }
  }

  // Cannot cut between user message and what follows
  // (user→assistant pair must stay together)
  if (thisMsg.role === "user") {
    return false;
  }

  // Cannot cut between assistant message and its tool calls
  if (thisMsg.role === "assistant" && nextMsg.role === "tool") {
    // Only valid if all tool calls from this assistant have been resolved
    // Check if this assistant started tool calls that are unresolved
    if (hasUnresolvedToolCalls(messages, i)) {
      return false;
    }
  }

  // If the next message is a user message, this is a good boundary
  if (nextMsg.role === "user") {
    return true;
  }

  // If this is the last message, it's a valid boundary
  if (i === messages.length - 1) {
    return true;
  }

  // Default: cannot safely cut here
  return false;
}

/**
 * Check if there are unresolved tool calls after position `i`.
 * Scans forward to see if any tool call lacks a matching result.
 */
function hasUnresolvedToolCalls(messages: Message[], i: number): boolean {
  const pendingCalls = new Set<string>();

  // Scan all messages from start to ensure correctness
  for (let idx = 0; idx <= i; idx++) {
    const msg = messages[idx]!;
    if (msg.role === "tool" && msg.toolCallId && !msg.toolName) {
      // This is a tool result (has toolCallId but toolName is often empty)
      // Actually, we need a better way to distinguish tool calls from results
      // For now: assume tool messages without content are calls, with content are results
    }
    // Track based on whether it's a call or result
  }

  // Simpler approach: just check if the last assistant before position i
  // has tool calls that haven't been resolved
  // Tool call = role "tool" with toolName set (the invocation)
  // Tool result = role "tool" with toolCallId matching a prior call

  const calls = new Map<string, number>(); // toolCallId → count
  const results = new Map<string, number>(); // toolCallId → count

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]!;
    if (msg.role !== "tool") continue;

    if (msg.toolName && msg.toolCallId) {
      // This is a tool call (has both toolName and toolCallId)
      calls.set(msg.toolCallId, (calls.get(msg.toolCallId) ?? 0) + 1);
    } else if (msg.toolCallId) {
      // This is a tool result (has toolCallId but results don't carry toolName)
      results.set(msg.toolCallId, (results.get(msg.toolCallId) ?? 0) + 1);
    }
  }

  // Check if any call is unmatched up to position i
  let callCount = 0;
  let resultCount = 0;
  for (let idx = 0; idx <= i; idx++) {
    const msg = messages[idx]!;
    if (msg.role !== "tool") continue;
    if (msg.toolName && msg.toolCallId) callCount++;
    else if (msg.toolCallId) resultCount++;
  }

  return callCount > resultCount;
}
