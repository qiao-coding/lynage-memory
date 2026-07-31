// ---------------------------------------------------------------------------
// TurnManager unit tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { TurnManager } from "./turn.js";
import type {
  LynageStore,
  Message,
  MessageInput,
  WorkingMemory,
} from "./index.js";

// ---- In-memory mock store ----

class MockStore implements LynageStore {
  messages: Message[] = [];
  chunks: Map<string, unknown> = new Map();
  directories: Map<string, unknown> = new Map();
  children: unknown[] = [];
  wm: Map<string, WorkingMemory> = new Map();

  async appendMessage(input: MessageInput): Promise<Message> {
    const msg: Message = {
      id: `msg-${this.messages.length + 1}`,
      sessionId: input.sessionId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      tokenCount: input.tokenCount,
      createdAt: Date.now(),
    };
    this.messages.push(msg);
    return msg;
  }

  async getRecent(scope: { sessionId: string }): Promise<Message[]> {
    return this.messages.filter((m) => m.sessionId === scope.sessionId);
  }

  async getWorkingMemory(sessionId: string): Promise<WorkingMemory | null> {
    return this.wm.get(sessionId) ?? null;
  }
  async getUserMemory() { return null; }
  async upsertUserMemory() { return {} as never; }

  // ---- Unused stubs ----
  async getMessage() { return null; }
  async getMessageRange() { return []; }
  async getMessageCount() { return this.messages.length; }
  async createChunk() { return {} as never; }
  async getChunk() { return null; }
  async getChunksByIds() { return []; }
  async getChunksByDirectory() { return []; }
  async listChunks() { return []; }
  async updateChunkDirectory() {}
  async createDirectory() { return {} as never; }
  async getDirectory() { return null; }
  async updateDirectory() { return {} as never; }
  async getRootDirectories() { return []; }
  async getChildDirectories() { return []; }
  async addChildToDirectory() {}
  async removeChildFromDirectory() {}
  async getDirectoryChildren() { return []; }
  async upsertWorkingMemory(input: { sessionId: string; currentTask?: string; confirmed?: string[]; progress?: string[]; unresolved?: string[] }) {
    const wm: WorkingMemory = {
      id: "wm-1",
      sessionId: input.sessionId,
      confirmed: input.confirmed ?? [],
      progress: input.progress ?? [],
      unresolved: input.unresolved ?? [],
      recentChanges: [],
      updatedAt: Date.now(),
      currentTask: input.currentTask,
    };
    this.wm.set(input.sessionId, wm);
    return wm;
  }
  async createSearchTask() { return {} as never; }
  async updateSearchTask() { return {} as never; }
  async getSearchTask() { return null; }
  async searchMessages() { return []; }
  async getEstimatedTokenCount() { return 0; }
}

describe("TurnManager", () => {
  let store: MockStore;
  let tm: TurnManager;

  beforeEach(() => {
    store = new MockStore();
    tm = new TurnManager(store);
  });

  it("startTurn creates a user message", async () => {
    const handle = await tm.startTurn("session-1", "user-1", "Hello");
    expect(handle.turnId).toBeDefined();
    expect(store.messages.length).toBe(1);
    expect(store.messages[0]?.role).toBe("user");
    expect(store.messages[0]?.content).toBe("Hello");
  });

  it("startTurn returns recent messages in context", async () => {
    // Add some prior messages
    await store.appendMessage({
      sessionId: "session-1",
      role: "user",
      content: "Previous question",
    });
    await store.appendMessage({
      sessionId: "session-1",
      role: "assistant",
      content: "Previous answer",
    });

    const handle = await tm.startTurn("session-1", "user-1", "New question");
    // Should include prior messages + new user message
    expect(handle.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("startTurn includes working memory as system context", async () => {
    await store.upsertWorkingMemory({
      sessionId: "s1",
      currentTask: "Testing Lynage",
      confirmed: ["Decision A"],
      progress: ["Working on it"],
      unresolved: ["Edge case X"],
    });

    const handle = await tm.startTurn("s1", "u1", "Hello");
    const systemMsg = handle.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain("Testing Lynage");
    expect(systemMsg?.content).toContain("Decision A");
  });

  it("finishTurn saves assistant message", async () => {
    const handle = await tm.startTurn("s1", "u1", "Hello");
    const result = await handle.finish({
      response: "Hi there!",
    });

    expect(result.assistantMessage.role).toBe("assistant");
    expect(result.assistantMessage.content).toBe("Hi there!");
    expect(store.messages.length).toBe(2); // user + assistant
  });

  it("finishTurn saves tool calls and results", async () => {
    const handle = await tm.startTurn("s1", "u1", "Calculate 2+2");

    const result = await handle.finish({
      response: "The answer is 4.",
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "calculate",
          args: { expression: "2+2" },
        },
      ],
      toolResults: [
        {
          toolCallId: "call-1",
          toolName: "calculate",
          result: "4",
        },
      ],
    });

    expect(result.toolMessages.length).toBe(2);
    expect(result.toolMessages[0]?.toolName).toBe("calculate");
    expect(result.toolMessages[0]?.toolCallId).toBe("call-1");
  });

  it("finishTurn tracks token usage", async () => {
    const handle = await tm.startTurn("s1", "u1", "Hello");
    const result = await handle.finish({
      response: "Hi!",
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("multiple turns maintain message order", async () => {
    const h1 = await tm.startTurn("s1", "u1", "Q1");
    await h1.finish({ response: "A1" });

    const h2 = await tm.startTurn("s1", "u1", "Q2");
    await h2.finish({ response: "A2" });

    const messages = store.messages;
    expect(messages.length).toBe(4); // Q1, A1, Q2, A2
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
