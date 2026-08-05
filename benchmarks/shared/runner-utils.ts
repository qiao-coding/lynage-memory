// ---------------------------------------------------------------------------
// Shared utilities for benchmark runners
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import type { LanguageModelV1 } from "ai";

// ---- Types ----

export interface BenchmarkConfig {
  archiveThreshold: number;
  retainTokens: number;
  directoryCapacity: number;
  archiveFetchLimit?: number;
}

export interface BenchmarkResult {
  benchmark: string;
  timestamp: string;
  model: string;
  config: BenchmarkConfig;
  summary: {
    totalQuestions: number;
    correct: number;
    accuracy: number;
    hallucination: number;
    byCategory: Record<string, { total: number; correct: number; accuracy: number }>;
    recall?: { sessionLevel: number; turnLevel: number };
  };
  details: Array<{
    questionId: string;
    question: string;
    expected: string;
    actual: string;
    correct: boolean;
    category: string;
    searchMs: number;
    tokensUsed: { input: number; output: number };
  }>;
  system: {
    chunks: number;
    dirs: number;
    treeDepth: number;
    storeTimeS: number;
    answerTimeS: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    costEstimates?: { inputCost: number; outputCost: number; total: number };
  };
}

// ---- DB / Memory ----

export function createMemory(
  model: LanguageModelV1,
  dbPath: string,
  config?: Partial<BenchmarkConfig>,
) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return createLynageMemory({
    model: new AiSdkModel(model, undefined, { useToolChoice: false }),
    dbPath,
    config: {
      archiveThreshold: config?.archiveThreshold ?? 600,
      retainTokens: config?.retainTokens ?? 250,
      directoryCapacity: config?.directoryCapacity ?? 5,
      archiveFetchLimit: config?.archiveFetchLimit,
    },
  });
}

// ---- Token estimation ----

export function estimateTokens(text: string): number {
  let cjk = 0, latin = 0;
  for (const c of text) {
    if (/[一-鿿　-〿＀-￯]/.test(c)) cjk++;
    else latin++;
  }
  return Math.ceil(cjk + latin * 0.25);
}

// ---- Tree depth helper ----

export function calcTreeDepth(tree: any[]): number {
  let maxDepth = 0;
  (function walk(nodes: any[], depth: number) {
    for (const n of nodes) {
      if (depth > maxDepth) maxDepth = depth;
      if (n.children?.length) walk(n.children, depth + 1);
    }
  })(tree, 0);
  return maxDepth;
}

// ---- Results persistence ----

export function saveResults(dir: string, name: string, result: BenchmarkResult): string {
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const filePath = path.join(dir, `${name}-${ts}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

// ---- Env loading ----

export function loadEnv(projectRoot: string) {
  const envPath = path.resolve(projectRoot, ".env");
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
}

// ---- Price constants (DeepSeek) ----

export const PRICE_INPUT_PER_1M = 1;   // ¥1 / 1M tokens
export const PRICE_OUTPUT_PER_1M = 2;  // ¥2 / 1M tokens

export function calcCost(inputTokens: number, outputTokens: number) {
  return {
    inputCost: (inputTokens / 1_000_000) * PRICE_INPUT_PER_1M,
    outputCost: (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_1M,
    total: (inputTokens / 1_000_000) * PRICE_INPUT_PER_1M + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_1M,
  };
}
