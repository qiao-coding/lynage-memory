// ---------------------------------------------------------------------------
// Real API benchmark: Lynage vs Summary vs NoMemory
//
// Feeds a 60-turn simulated conversation through 3 strategies,
// then tests 5 fact-based questions against each.
//
// Usage:
//   set DEEPSEEK_API_KEY=...
//   pnpm bench-real (from benchmarks/baseline/)
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { generateSimulation } from "./simulate.js";
import { computeReport, printReport, type GroupResult, type TurnMetrics } from "./metrics.js";
import fs from "node:fs";
import path from "node:path";

// ---- Load .env ----
const envPath = path.resolve(process.cwd(), "..", "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx < 0) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error("❌ DEEPSEEK_API_KEY not set. Fill it in .env first.");
  process.exit(1);
}

const MODEL_NAME = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

// ---- Setup ----
const deepseek = createOpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
const model = deepseek(MODEL_NAME);

// Common config
const ARCHIVE_THRESHOLD = 600; // tokens before archiving (low to trigger with simulated short turns)
const SUMMARY_THRESHOLD = 800; // chars before re-summarizing

// Token counter
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
function recordUsage(prompt: number, completion: number) {
  totalPromptTokens += prompt;
  totalCompletionTokens += completion;
}

// ---- LLM helpers ----

async function askLLM(prompt: string, system?: string): Promise<{ text: string; usage: { prompt: number; completion: number } }> {
  const result = await generateText({
    model,
    prompt,
    system,
    maxTokens: 300,
  });
  return {
    text: result.text,
    usage: {
      prompt: result.usage?.promptTokens ?? result.usage?.inputTokens ?? 0,
      completion: result.usage?.completionTokens ?? result.usage?.outputTokens ?? 0,
    },
  };
}

function estimateTokens(text: string): number {
  // CJK ~1 token/char, Latin ~0.25 token/char
  let cjk = 0, latin = 0;
  for (const c of text) {
    if (/[一-鿿　-〿＀-￯]/.test(c)) cjk++;
    else latin++;
  }
  return Math.ceil(cjk + latin * 0.25);
}

// ---- Evaluation ----

async function evaluateAnswer(question: string, expected: string, actual: string): Promise<boolean> {
  const prompt = `You are a strict evaluator. Compare the student's answer to the expected answer.

Question: "${question}"

Expected answer: "${expected}"

Student's answer: "${actual}"

Does the student's answer convey the same key facts as the expected answer?
Reply with ONLY "CORRECT" or "INCORRECT".`;

  const result = await askLLM(prompt);
  return result.text.trim().toUpperCase().startsWith("CORRECT");
}

// =========================================================================
// Strategy A: Lynage Memory (real)
// =========================================================================

async function runLynage(
  turns: Array<{ user: string; assistant: string; toolCalls?: Array<{ name: string; args: string; result: string }> }>,
  testQuestions: Array<{ question: string; expectedAnswer: string }>,
): Promise<GroupResult> {
  console.log("\n🔷 Strategy A: Lynage Memory");
  const metrics: TurnMetrics[] = [];

  // Fresh DB per run
  const DB_PATH = path.resolve(process.cwd(), "data", `bench-lynage-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const memory = createLynageMemory({
    model: new AiSdkModel(model),
    dbPath: DB_PATH,
    config: { archiveThreshold: ARCHIVE_THRESHOLD, retainTokens: 250, directoryCapacity: 5 },
  });

  const SESSION = "bench-session";
  const USER = "bench-user";

  // Process all turns
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const startTime = performance.now();

    const turnHandle = await memory.startTurn(SESSION, USER, turn.user);
    await turnHandle.finish({
      response: turn.assistant,
      ...(turn.toolCalls?.length
        ? { toolCalls: turn.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })), toolResults: turn.toolCalls.map((tc) => ({ result: tc.result })) }
        : {}),
    });

    const elapsed = performance.now() - startTime;
    const promptTokens = estimateTokens(turn.user);
    const completionTokens = estimateTokens(turn.assistant);

    metrics.push({ turn: i + 1, promptTokens, completionTokens, elapsedMs: Math.round(elapsed), messageCount: (i + 1) * 2 });

    if ((i + 1) % 15 === 0) {
      const stats = await memory.getArchiveStats(SESSION);
      console.log(`  Turn ${i + 1}/60 | chunks: ${stats.chunkCount} | dirs: ${stats.directoryCount}`);
    }
  }

  // Stats
  const stats = await memory.getArchiveStats(SESSION);
  console.log(`  Done | messages: ${stats.messageCount} | chunks: ${stats.chunkCount} | dirs: ${stats.directoryCount}`);

  // Answer test questions
  const testAnswers: GroupResult["testAnswers"] = [];
  for (const q of testQuestions) {
    const searchResult = await memory.search({ query: q.question, sessionId: SESSION });
    let context = "";

    if (searchResult.candidates.length > 0) {
      const top = searchResult.candidates[0]!;
      const openResult = await memory.openSource(top.contextId);
      if (openResult) {
        context = openResult.messages.map((m) => `[${m.role.toUpperCase()}] ${m.content}`).join("\n");
      }
    }

    const prompt = context
      ? `Based on the following conversation history, answer the question.\n\n--- History ---\n${context}\n--- End History ---\n\nQuestion: ${q.question}`
      : `Question: ${q.question}`;

    const answer = await askLLM(prompt);
    recordUsage(answer.usage.prompt, answer.usage.completion);

    const correct = await evaluateAnswer(q.question, q.expectedAnswer, answer.text);
    testAnswers.push({ question: q.question, expected: q.expectedAnswer, actual: answer.text, correct });
    console.log(`  Q: ${q.question.slice(0, 50)}... → ${correct ? "✅" : "❌"}`);
  }

  // Cleanup
  try { fs.unlinkSync(DB_PATH); } catch {}

  return { name: "Lynage", turns: metrics, testAnswers };
}

// =========================================================================
// Strategy B: Summary Compression (real LLM summarization)
// =========================================================================

async function runSummary(
  turns: Array<{ user: string; assistant: string }>,
  testQuestions: Array<{ question: string; expectedAnswer: string }>,
): Promise<GroupResult> {
  console.log("\n🔶 Strategy B: Summary Compression");
  const metrics: TurnMetrics[] = [];

  let summary = "";
  const recent: Array<{ role: string; content: string }> = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const startTime = performance.now();

    recent.push({ role: "user", content: turn.user });
    recent.push({ role: "assistant", content: turn.assistant });

    // When recent messages exceed threshold, summarize oldest half
    const recentChars = recent.reduce((s, m) => s + m.content.length, 0);
    if (recentChars > SUMMARY_THRESHOLD) {
      const mid = Math.floor(recent.length / 2);
      const toSummarize = recent.slice(0, mid);
      const text = toSummarize.map((m) => `[${m.role.toUpperCase()}] ${m.content.slice(0, 120)}`).join("\n");

      const result = await askLLM(
        `Summarize this conversation segment. Keep key decisions, facts, and reasoning. Be concise but complete.\n\n${summary ? `Previous summary: ${summary}\n\n` : ""}New messages:\n${text}`,
      );
      recordUsage(result.usage.prompt, result.usage.completion);
      summary = result.text;
      recent.splice(0, mid);
    }

    const elapsed = performance.now() - startTime;
    metrics.push({
      turn: i + 1,
      promptTokens: estimateTokens(turn.user),
      completionTokens: estimateTokens(turn.assistant),
      elapsedMs: Math.round(elapsed),
      messageCount: recent.length + (summary ? 1 : 0),
    });

    if ((i + 1) % 20 === 0) {
      console.log(`  Turn ${i + 1}/60 | summary len: ${summary.length} | recent: ${recent.length} msgs`);
    }
  }

  console.log(`  Done | final summary: ${summary.length} chars | recent: ${recent.length} msgs`);

  // Answer test questions using only summary + recent
  const testAnswers: GroupResult["testAnswers"] = [];
  for (const q of testQuestions) {
    const context = summary
      ? `Summary of previous conversation:\n${summary}\n\n---\nRecent messages:\n${recent.map((m) => `[${m.role.toUpperCase()}] ${m.content}`).join("\n")}`
      : recent.map((m) => `[${m.role.toUpperCase()}] ${m.content}`).join("\n");

    const prompt = `Based on the following, answer the question.\n\n${context}\n\nQuestion: ${q.question}`;
    const answer = await askLLM(prompt);
    recordUsage(answer.usage.prompt, answer.usage.completion);

    const correct = await evaluateAnswer(q.question, q.expectedAnswer, answer.text);
    testAnswers.push({ question: q.question, expected: q.expectedAnswer, actual: answer.text, correct });
    console.log(`  Q: ${q.question.slice(0, 50)}... → ${correct ? "✅" : "❌"}`);
  }

  return { name: "Summary", turns: metrics, testAnswers };
}

// =========================================================================
// Strategy C: No Memory
// =========================================================================

async function runNoMemory(
  turns: Array<{ user: string; assistant: string }>,
  testQuestions: Array<{ question: string; expectedAnswer: string }>,
): Promise<GroupResult> {
  console.log("\n🔻 Strategy C: No Memory");
  const metrics: TurnMetrics[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    metrics.push({
      turn: i + 1,
      promptTokens: estimateTokens(turn.user),
      completionTokens: estimateTokens(turn.assistant),
      elapsedMs: 0,
      messageCount: 2,
    });
  }

  const testAnswers: GroupResult["testAnswers"] = [];
  for (const q of testQuestions) {
    const prompt = `Question: ${q.question}\n\n(You have no conversation history. Answer based on your general knowledge. If you don't know, say so.)`;
    const answer = await askLLM(prompt);
    recordUsage(answer.usage.prompt, answer.usage.completion);

    const correct = await evaluateAnswer(q.question, q.expectedAnswer, answer.text);
    testAnswers.push({ question: q.question, expected: q.expectedAnswer, actual: answer.text, correct });
    console.log(`  Q: ${q.question.slice(0, 50)}... → ${correct ? "✅" : "❌"}`);
  }

  return { name: "NoMemory", turns: metrics, testAnswers };
}

// =========================================================================
// Main
// =========================================================================

async function main() {
  console.log("🏃 Lynage Memory — Real API Benchmark\n");
  console.log(`Model: ${MODEL_NAME} | Base URL: ${BASE_URL}`);
  console.log(`Archive threshold: ${ARCHIVE_THRESHOLD} chars | Summary threshold: ${SUMMARY_THRESHOLD} chars\n`);

  const sim = generateSimulation();
  const flatTurns = sim.turns.map((t) => ({ user: t.user, assistant: t.assistant, toolCalls: t.toolCalls }));
  const testQuestions = sim.testQuestions.map((q) => ({ question: q.question, expectedAnswer: q.expectedAnswer }));

  console.log(`Generated ${flatTurns.length} turns, ${testQuestions.length} test questions`);
  console.log("─".repeat(50));

  // Run all 3 strategies
  const lynageGroup = await runLynage(flatTurns, testQuestions);
  const summaryGroup = await runSummary(flatTurns, testQuestions);
  const noMemoryGroup = await runNoMemory(flatTurns, testQuestions);

  // Report
  const groups = [lynageGroup, summaryGroup, noMemoryGroup];
  const report = computeReport(groups);

  console.log("\n" + printReport(report));

  // Show answers
  console.log("─".repeat(70));
  console.log("  Answer Details");
  console.log("─".repeat(70));
  for (let i = 0; i < testQuestions.length; i++) {
    const q = testQuestions[i]!;
    console.log(`\nQ${i + 1}: ${q.question}`);
    console.log(`  Expected: ${q.expectedAnswer}`);
    for (const g of groups) {
      const a = g.testAnswers[i]!;
      console.log(`  [${g.name}] ${a.correct ? "✅" : "❌"} ${a.actual.slice(0, 120)}`);
    }
  }

  console.log(`\nTotal API tokens used: prompt=${totalPromptTokens} completion=${totalCompletionTokens}`);
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err);
  process.exit(1);
});
