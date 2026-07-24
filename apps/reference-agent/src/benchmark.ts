// ---------------------------------------------------------------------------
// M0 Baseline Benchmark
// Runs N turns and outputs baseline metrics (latency, tokens, messages).
// Usage: pnpm bench
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { runAgent, type RunAgentResult } from "./agent.js";
import { createDatabase, SqliteStore } from "@lynage/storage-sqlite";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.resolve(process.cwd(), "data");
const RESULTS_PATH = path.join(DATA_DIR, "benchmark-m0.json");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY not set.");
  process.exit(1);
}

// Benchmark prompts covering different interaction patterns
const PROMPTS = [
  "Hello! What can you help me with?",
  "What time is it right now?",
  "Calculate (15 * 23) + (47 / 3)",
  "Read the file config.json and tell me what's in it.",
  "What is 2 + 2? Just give me the number.",
  "Calculate the square root of 144.",
  "What time is it? Also, calculate 100 / 7.",
  "Read the files package.json and tsconfig.json.",
  "Thanks for your help! Summarize what we did.",
  "Goodbye!",
];

interface BenchmarkResult {
  timestamp: string;
  version: string;
  turns: number;
  prompts: string[];
  results: Array<{
    turn: number;
    prompt: string;
    elapsedMs: number;
    textLength: number;
    toolCalls: number;
    messageCount: number;
  }>;
  summary: {
    totalElapsedMs: number;
    avgElapsedMs: number;
    totalToolCalls: number;
    finalMessageCount: number;
    avgTextLength: number;
  };
}

async function runBenchmark() {
  console.log("🏃 Lynage M0 Baseline Benchmark\n");

  const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
  const model = openai("gpt-4o-mini");
  const sessionId = `bench-${Date.now()}`;

  const turnResults: BenchmarkResult["results"] = [];
  let totalElapsed = 0;
  let totalToolCalls = 0;

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i]!;
    process.stdout.write(`[${i + 1}/${PROMPTS.length}] ${prompt.slice(0, 50)}... `);

    const startTime = performance.now();
    const result = await runAgent({ model, prompt, sessionId });
    const elapsed = performance.now() - startTime;

    turnResults.push({
      turn: i + 1,
      prompt,
      elapsedMs: Math.round(elapsed),
      textLength: result.text.length,
      toolCalls: result.toolCalls,
      messageCount: result.messageCount,
    });

    totalElapsed += elapsed;
    totalToolCalls += result.toolCalls;

    console.log(`${Math.round(elapsed)}ms`);
  }

  const summary = {
    totalElapsedMs: Math.round(totalElapsed),
    avgElapsedMs: Math.round(totalElapsed / PROMPTS.length),
    totalToolCalls,
    finalMessageCount: turnResults[turnResults.length - 1]?.messageCount ?? 0,
    avgTextLength: Math.round(
      turnResults.reduce((sum, r) => sum + r.textLength, 0) / turnResults.length,
    ),
  };

  const benchmarkResult: BenchmarkResult = {
    timestamp: new Date().toISOString(),
    version: "M0",
    turns: PROMPTS.length,
    prompts: PROMPTS,
    results: turnResults,
    summary,
  };

  // Ensure data dir exists
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(benchmarkResult, null, 2));

  console.log("\n📊 Summary:");
  console.log(`   Total time:     ${summary.totalElapsedMs}ms`);
  console.log(`   Avg per turn:   ${summary.avgElapsedMs}ms`);
  console.log(`   Tool calls:     ${summary.totalToolCalls}`);
  console.log(`   Total messages: ${summary.finalMessageCount}`);
  console.log(`   Avg text len:   ${summary.avgTextLength} chars`);
  console.log(`\n📄 Results saved to: ${RESULTS_PATH}`);
}

runBenchmark().catch(console.error);
