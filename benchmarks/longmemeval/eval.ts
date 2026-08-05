// ---------------------------------------------------------------------------
// LongMemEval + Promptfoo Evaluation
//
// Uses Promptfoo's Node.js API with an inline Lynage provider.
// Requires setup.ts to have been run first.
//
// Usage:
//   pnpm tsx benchmarks/longmemeval/setup.ts    # one-time pre-ingest
//   pnpm tsx benchmarks/longmemeval/eval.ts      # run evaluation
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { TrigramEmbedder } from "@lynage/core";
import promptfoo from "promptfoo";
import fs from "node:fs";
import path from "node:path";

// ---- Config ----
const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..", "..");
const DATA_DIR = path.resolve(import.meta.dirname || __dirname, "..", "data");
const RESULTS_DIR = path.resolve(import.meta.dirname || __dirname, "results");
const DATASET_PATH = path.join(DATA_DIR, "longmemeval_s_cleaned.json");
const STATE_PATH = path.join(RESULTS_DIR, ".lynage-setup-state.json");

// ---- Load env ----
const envPath = path.resolve(PROJECT_ROOT, ".env");
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

// ---- Types ----
interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: SessionTurn[][];
  answer_session_ids: string[];
}

interface SetupState {
  dbPath: string;
  sessionId: string;
  userId: string;
}

// ---- Token counter ----
let totalPromptTokens = 0;
let totalCompletionTokens = 0;

function estimateTokens(text: string): number {
  let cjk = 0, latin = 0;
  for (const c of text) {
    if (/[一-鿿　-〿＀-￯]/.test(c)) cjk++;
    else latin++;
  }
  return Math.ceil(cjk + latin * 0.25);
}

// ---- Main ----
async function main() {
  console.log("🧪 LongMemEval × Lynage × Promptfoo Evaluation\n");

  // Check setup state
  if (!fs.existsSync(STATE_PATH)) {
    console.error("❌ Setup state not found. Run: pnpm tsx benchmarks/longmemeval/setup.ts");
    process.exit(1);
  }
  const state: SetupState = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));

  // Check dataset
  if (!fs.existsSync(DATASET_PATH)) {
    console.error(`❌ Dataset not found: ${DATASET_PATH}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(DATASET_PATH, "utf-8");
  const dataset: LongMemEvalInstance[] = JSON.parse(raw);
  console.log(`📄 ${dataset.length} instances loaded\n`);

  // Create model + memory with semantic embedding (Phase 2)
  const API_KEY = process.env.DEEPSEEK_API_KEY!;
  const deepseek = createOpenAI({ apiKey: API_KEY, baseURL: "https://api.deepseek.com/v1" });
  const model = deepseek("deepseek-v4-flash");
  const embedder = new TrigramEmbedder();
  const memory = createLynageMemory({
    model: new AiSdkModel(model, undefined, { useToolChoice: false }),
    dbPath: state.dbPath,
    embedder,
  });

  // ---- Build test cases ----
  // Limit questions via env var for quick validation
  const QUESTION_LIMIT = Number(process.env.QUESTIONS) || dataset.length;

  const testCases: Array<{
    vars: Record<string, string>;
    assert: Array<{ type: string; value: string }>;
    meta: Record<string, string>;
  }> = [];

  for (let i = 0; i < Math.min(QUESTION_LIMIT, dataset.length); i++) {
    const inst = dataset[i]!;
    testCases.push({
      vars: {
        question_id: inst.question_id,
        query: inst.question,
        expected: inst.answer,
        category: inst.question_type,
      },
      assert: [
        {
          type: "llm-rubric",
          value: `评估回答是否包含正确答案的核心事实。参考答案: "${inst.answer}"。只要回答包含了核心事实（例如: "Vercel" 匹配 "Vercel (originally considered Docker...)")，即使省略了背景细节，也应判定为正确。如果回答编造了不存在的事实，则判错。如果回答称不知道但答案存在于对话历史中，则判错。`,
          provider: "openai:chat:deepseek-v4-flash",
        },
      ],
      meta: {
        question_id: inst.question_id,
        category: inst.question_type,
        answer_session_ids: inst.answer_session_ids.join(","),
        has_abstention: inst.question_id.endsWith("_abs") ? "true" : "false",
      },
    });

    if ((i + 1) % 100 === 0) {
      console.log(`  Built ${i + 1}/${Math.min(QUESTION_LIMIT, dataset.length)} test cases...`);
    }
  }
  console.log(`✅ ${testCases.length} test cases ready\n`);

  // ---- Lynage Provider (inline function) ----
  const lynageProvider = async (prompt: string, context: { vars: Record<string, string> }) => {
    const query = context.vars.query;
    if (!query) return { output: "(no query)" };

    // 1. Search Lynage
    const searchResult = await memory.search({
      query,
      sessionId: state.sessionId,
    });

    // Diagnostic: log search quality
    if (searchResult.candidates.length === 0) {
      console.error(`  ⚠️ Zero candidates for: "${query.slice(0, 80)}"`);
    }

    // 2. Open top candidates and build context (with timestamps)
    const contextParts: string[] = [];
    const topCandidates = searchResult.candidates.slice(0, 5);
    for (const cand of topCandidates) {
      const openResult = await memory.openSource(cand.contextId);
      if (openResult) {
        const dateStr = new Date(cand.timeRange.start).toISOString().slice(0, 10);
        const header = `--- ${dateStr} (relevance: ${(cand.relevance * 100).toFixed(0)}%) ---`;
        const msgs = openResult.messages
          .map((m) => {
            const ts = new Date(m.createdAt).toISOString().slice(0, 10);
            return `[${ts}] [${m.role.toUpperCase()}] ${m.content}`;
          })
          .join("\n");
        contextParts.push(header + "\n" + msgs);
      }
    }
    const retrievedContext = contextParts.join("\n\n---\n\n");

    // 3. Generate answer
    // Always provide some context — even if search returned nothing,
    // give the LLM a clear baseline to prevent empty outputs
    // Truncate context to ~3000 chars to avoid empty LLM responses
    const truncatedContext = retrievedContext.length > 4000
      ? retrievedContext.slice(0, 4000) + "\n[... context truncated ...]"
      : retrievedContext;
    const systemPrompt = retrievedContext
      ? `Answer based ONLY on the conversation history below. Messages include timestamps (YYYY-MM-DD) — use them for temporal questions like "which was decided first". If the answer is not in the history, respond: "The conversation history does not contain this information."\n\n--- History ---\n${truncatedContext}`
      : "No relevant conversation history was found for this query. Respond: \"The conversation history does not contain this information.\"";

    try {
      const result = await generateText({
        model,
        prompt: query,
        system: systemPrompt,
        maxTokens: 200,
      });

      const text = result.text?.trim() || "(empty response)";

      const usage = await result.usage;
      totalPromptTokens += usage?.promptTokens ?? estimateTokens(systemPrompt + query);
      totalCompletionTokens += usage?.completionTokens ?? estimateTokens(text);

      return {
        output: text,
        tokenUsage: {
          total: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
          prompt: usage?.promptTokens ?? 0,
          completion: usage?.completionTokens ?? 0,
        },
      };
    } catch (err: any) {
      console.error(`  ⚠️ Provider error for query "${query.slice(0, 50)}": ${err.message}`);
      return { output: `Unable to answer due to a technical error. Please try again.` };
    }
  };

  // ---- Run Promptfoo Eval ----
  console.log("🚀 Running Promptfoo evaluation...\n");

  const results = await promptfoo.evaluate({
    prompts: [
      `你是一个能访问对话历史的助手。基于提供的对话历史回答问题。如果历史中没有答案，诚实地说不知道。

问题：{{query}}`,
    ],
    providers: [lynageProvider],
    tests: testCases,
    env: {
      OPENAI_API_KEY: API_KEY,
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      DEEPSEEK_API_KEY: API_KEY,
    },
  });

  // ---- Summarize ----
  const summary = await results.toEvaluateSummary();

  const passCount = summary.stats?.successes ?? details.filter(d => d.pass).length;
  const failCount = summary.stats?.failures ?? details.filter(d => !d.pass).length;
  const totalCount = summary.results?.length ?? details.length;

  // Build details from results
  const details: Array<{
    questionId: string;
    question: string;
    expected: string;
    actual: string;
    category: string;
    pass: boolean;
    score: number;
  }> = [];

  const byCategory: Record<string, { total: number; pass: number }> = {};

  for (const r of summary.results) {
    const result = r as any;
    const vars = result.vars || {};
    const actual = result.response?.output ?? "(no output)";
    const detail = {
      questionId: (vars.question_id as string) || "",
      question: (vars.query as string) || "",
      expected: (vars.expected as string) || "",
      actual,
      category: (vars.category as string) || "unknown",
      pass: result.success ?? false,
      score: result.score ?? 0,
    };
    details.push(detail);

    if (!byCategory[detail.category]) byCategory[detail.category] = { total: 0, pass: 0 };
    byCategory[detail.category]!.total++;
    if (detail.pass) byCategory[detail.category]!.pass++;
  }

  console.log("\n📊 Results Summary:");
  console.log(`   Total: ${totalCount} questions`);
  console.log(`   Pass: ${passCount} (${(passCount / Math.max(totalCount, 1) * 100).toFixed(1)}%)`);
  console.log(`   Fail: ${failCount}`);
  console.log(`   Token usage: prompt=${totalPromptTokens} completion=${totalCompletionTokens}`);

  const ts = Date.now();
  const resultPath = path.join(RESULTS_DIR, `longmemeval-${ts}.json`);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const output = {
    benchmark: "LongMemEval",
    model: "deepseek-v4-flash (via Lynage Memory)",
    timestamp: new Date().toISOString(),
    summary: {
      totalQuestions: details.length,
      pass: details.filter((d) => d.pass).length,
      accuracy: (details.filter((d) => d.pass).length / Math.max(details.length, 1)),
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([cat, v]) => [
          cat,
          { ...v, accuracy: (v.pass / v.total) },
        ]),
      ),
    },
    details,
    system: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      costEstimates: {
        inputCost: (totalPromptTokens / 1_000_000) * 1,
        outputCost: (totalCompletionTokens / 1_000_000) * 2,
        total: (totalPromptTokens / 1_000_000) * 1 + (totalCompletionTokens / 1_000_000) * 2,
      },
    },
  };

  fs.writeFileSync(resultPath, JSON.stringify(output, null, 2));
  console.log(`\n📄 Results saved: ${resultPath}`);

  // Print category breakdown
  console.log("\n📊 Category Breakdown:");
  for (const [cat, v] of Object.entries(byCategory)) {
    const pct = (v.pass / v.total * 100).toFixed(1);
    console.log(`   ${cat}: ${v.pass}/${v.total} (${pct}%)`);
  }
}

main().catch((err) => {
  console.error("❌ Eval failed:", err);
  process.exit(1);
});
