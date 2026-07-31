// ---------------------------------------------------------------------------
// M1 Reference Agent — uses LynageMemory + lynageStreamText lifecycle
// ---------------------------------------------------------------------------

import type { LanguageModelV1 } from "ai";
import { createDatabase, ensureTables, SqliteStore } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { LynageMemory } from "@lynage/core";
import { lynageStreamText } from "@lynage/ai-sdk";
import { tools } from "./tools.js";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "lynage.db");

let memory: LynageMemory | null = null;

function getMemory(model: LanguageModelV1): LynageMemory {
  if (!memory) {
    const { db, raw } = createDatabase(DB_PATH);
    ensureTables(raw);
    const store = new SqliteStore(db, raw);
    const aiModel = new AiSdkModel(model);
    memory = new LynageMemory({ store, model: aiModel });
  }
  return memory;
}

export interface RunAgentOptions {
  model: LanguageModelV1;
  prompt: string;
  sessionId?: string;
  userId?: string;
}

export interface RunAgentResult {
  text: string;
  toolCalls: number;
  messageCount: number;
}

/**
 * Run a single agent turn using the Lynage Memory lifecycle (M1).
 */
export async function runAgent(
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const m = getMemory(options.model);
  const sessionId = options.sessionId ?? "default";
  const userId = options.userId ?? "user-001";

  const result = await lynageStreamText({
    memory: m,
    userId,
    threadId: sessionId,
    model: options.model,
    prompt: options.prompt,
    tools,
  });

  const msgCount = await m.store.getMessageCount(sessionId);

  return { text: result.text, toolCalls: 0, messageCount: msgCount };
}
