// ---------------------------------------------------------------------------
// Context Compiler tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { compileContext } from "./context-compiler.js";
import type { Message, WorkingMemory, DirectoryNode } from "./types.js";

function makeMsg(role: Message["role"], content: string): Message {
  return {
    id: "m1",
    sessionId: "s1",
    role,
    content,
    createdAt: Date.now(),
  };
}

describe("compileContext", () => {
  it("compiles working memory + recent messages", () => {
    const wm: WorkingMemory = {
      id: "wm-1",
      sessionId: "s1",
      currentTask: "Testing",
      confirmed: ["Decision A"],
      progress: ["Step 1 done"],
      unresolved: ["Edge case X"],
      recentChanges: [],
      updatedAt: Date.now(),
    };

    const recent = [
      makeMsg("user", "Hello"),
      makeMsg("assistant", "Hi there!"),
    ];

    const result = compileContext({ workingMemory: wm, recentMessages: recent });

    expect(result.systemPrompt).toContain("Testing");
    expect(result.systemPrompt).toContain("Decision A");
    expect(result.systemPrompt).toContain("Edge case X");
    expect(result.messages.length).toBe(2);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("includes directory summaries when present", () => {
    const dir: DirectoryNode = {
      id: "d1",
      sessionId: "s1",
      generation: 0,
      timeRangeStart: Date.now() - 86400000,
      timeRangeEnd: Date.now(),
      overallContent: "Discussed architecture and made key decisions.",
      progress: "Architecture phase complete.",
      mainConclusions: ["Use SQLite", "Use Drizzle ORM"],
      importantChanges: ["Abandoned semantic classification"],
      createdAt: Date.now(),
    };

    const result = compileContext({
      recentMessages: [makeMsg("user", "Continue please")],
      directories: [dir],
    });

    expect(result.systemPrompt).toContain("SQLite");
    expect(result.systemPrompt).toContain("Drizzle ORM");
    expect(result.systemPrompt).toContain("Abandoned semantic classification");
  });

  it("handles empty state gracefully", () => {
    const result = compileContext({ recentMessages: [] });
    expect(result.systemPrompt).toBe("");
    expect(result.messages.length).toBe(0);
    expect(result.estimatedTokens).toBe(0);
  });
});
