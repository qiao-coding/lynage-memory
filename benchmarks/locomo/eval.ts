// ---------------------------------------------------------------------------
// LoCoMo + Lynage Evaluation
//
// Evaluates Lynage on LoCoMo's 10 multi-session conversations.
// For each conversation: search → openSource → answer → judge.
//
// Usage:
//   pnpm tsx benchmarks/locomo/setup.ts     # one-time pre-ingest
//   pnpm tsx benchmarks/locomo/eval.ts       # run evaluation
//   LIMIT=50 pnpm tsx .../eval.ts            # only first 50 questions
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { LynageSdkModel } from "@lynage/ai-sdk";
import { judgeAnswer, type JudgeResult } from "../shared/judge.js";
import { saveResults, loadEnv, calcCost, estimateTokens } from "../shared/runner-utils.js";
import type { BenchmarkResult } from "../shared/runner-utils.js";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..", "..");
const RESULTS_DIR = path.resolve(import.meta.dirname || __dirname, "results");
const STATE_PATH = path.join(RESULTS_DIR, ".locomo-setup-state.json");

loadEnv(PROJECT_ROOT);

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("❌ DEEPSEEK_API_KEY not set.");
  process.exit(1);
}

interface ConvState {
  dbPath: string;
  sessionId: string;
  userId: string;
  stats: { messages: number; chunks: number; dirs: number; depth: number };
  qa: Array<{ question: string; answer: string; category: string; evidence: string[] }>;
  speakerA: string;
  speakerB: string;
}

async function evalConversation(
  state: ConvState,
  model: any,
  judgeModel: any,
  label: string,
): Promise<{
  details: BenchmarkResult["details"];
  inputTokens: number;
  outputTokens: number;
  searchTotalMs: number;
}> {
  console.log(`\n📋 Evaluating ${label} (${state.qa.length} questions)...`);

  const memory = createLynageMemory({
    model: new LynageSdkModel(model, undefined, { useToolChoice: false }),
    dbPath: state.dbPath,
  });

  const details: BenchmarkResult["details"] = [];
  let inputTokens = 0, outputTokens = 0, searchTotalMs = 0;

  const LIMIT = Number(process.env.LIMIT) || state.qa.length;
  const questions = state.qa.slice(0, LIMIT);

  for (let i = 0; i < questions.length; i++) {
    const qa = questions[i]!;
    const searchStart = performance.now();

    // Search
    const searchResult = await memory.search({ query: qa.question, sessionId: state.sessionId });
    searchTotalMs += performance.now() - searchStart;

    // Open top candidates
    const contextParts: string[] = [];
    for (const cand of searchResult.candidates.slice(0, 4)) {
      const openResult = await memory.openSource(cand.contextId);
      if (openResult) {
        contextParts.push(
          openResult.messages.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join("\n")
        );
      }
    }
    const retrievedContext = contextParts.join("\n\n---\n\n");

    // Generate answer
    const systemPrompt = retrievedContext
      ? `Answer based ONLY on the conversation history below. If not found, say "Not found in conversation history." Do NOT guess.\n\n--- History ---\n${retrievedContext}`
      : "You have no conversation history. Say you don't have enough information.";

    const result = await generateText({ model, prompt: qa.question, system: systemPrompt, maxTokens: 200 });
    const usage = await result.usage;
    const pi = usage?.promptTokens ?? estimateTokens(systemPrompt + qa.question);
    const po = usage?.completionTokens ?? estimateTokens(result.text);
    inputTokens += pi;
    outputTokens += po;

    // Judge
    const judge = await judgeAnswer(judgeModel, qa.question, qa.answer, result.text);

    details.push({
      questionId: `${label}-q${i}`,
      question: qa.question,
      expected: qa.answer,
      actual: result.text,
      correct: judge.accurate,
      category: qa.category,
      searchMs: Math.round(searchResult.candidates.length > 0 ? (performance.now() - searchStart) : 0),
      tokensUsed: { input: pi, output: po },
    });

    if ((i + 1) % 20 === 0) {
      const acc = details.filter(d => d.correct).length;
      console.log(`  ${i + 1}/${questions.length} | acc: ${acc}/${i + 1} (${(acc/(i+1)*100).toFixed(0)}%)`);
    }
  }

  return { details, inputTokens, outputTokens, searchTotalMs };
}

async function main() {
  console.log("🧪 LoCoMo × Lynage Evaluation\n");

  if (!fs.existsSync(STATE_PATH)) {
    console.error("❌ Setup state not found. Run: pnpm tsx benchmarks/locomo/setup.ts");
    process.exit(1);
  }
  const states: ConvState[] = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));

  const deepseek = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" });
  const model = deepseek("deepseek-v4-flash");
  const judgeModel = deepseek("deepseek-v4-flash");

  const allDetails: BenchmarkResult["details"] = [];
  let totalInput = 0, totalOutput = 0, totalSearchMs = 0;
  const storeStart = performance.now();

  for (const state of states) {
    const label = state.sessionId; // "locomo-conv_1", etc.
    const r = await evalConversation(state, model, judgeModel, label);
    allDetails.push(...r.details);
    totalInput += r.inputTokens;
    totalOutput += r.outputTokens;
    totalSearchMs += r.searchTotalMs;
  }

  const storeTimeS = (performance.now() - storeStart) / 1000;

  // Category breakdown
  const byCategory: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const d of allDetails) {
    if (!byCategory[d.category]) byCategory[d.category] = { total: 0, correct: 0, accuracy: 0 };
    byCategory[d.category]!.total++;
    if (d.correct) byCategory[d.category]!.correct++;
  }
  for (const v of Object.values(byCategory)) {
    v.accuracy = v.total > 0 ? v.correct / v.total : 0;
  }

  const correct = allDetails.filter(d => d.correct).length;
  const cost = calcCost(totalInput, totalOutput);

  const result: BenchmarkResult = {
    benchmark: "LoCoMo",
    timestamp: new Date().toISOString(),
    model: "deepseek-v4-flash (via Lynage Memory)",
    config: { archiveThreshold: 600, retainTokens: 250, directoryCapacity: 5 },
    summary: {
      totalQuestions: allDetails.length,
      correct,
      accuracy: allDetails.length > 0 ? correct / allDetails.length : 0,
      hallucination: 0,
      byCategory,
    },
    details: allDetails,
    system: {
      chunks: states.reduce((s, st) => s + st.stats.chunks, 0),
      dirs: states.reduce((s, st) => s + st.stats.dirs, 0),
      treeDepth: Math.max(...states.map(st => st.stats.depth)),
      storeTimeS,
      answerTimeS: 0,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      costEstimates: cost,
    },
  };

  const outputPath = saveResults(RESULTS_DIR, "locomo", result);
  console.log(`\n📄 Results: ${outputPath}`);

  console.log("\n📊 Category Breakdown:");
  for (const [cat, v] of Object.entries(byCategory)) {
    console.log(`   ${cat}: ${v.correct}/${v.total} (${(v.accuracy * 100).toFixed(1)}%)`);
  }
  console.log(`\n   Overall: ${correct}/${allDetails.length} (${(result.summary.accuracy * 100).toFixed(1)}%)`);
  console.log(`   Tokens: ${totalInput}i + ${totalOutput}o | Cost: ¥${cost.total.toFixed(3)}`);
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
