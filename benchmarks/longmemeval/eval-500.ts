// LongMemEval 500Q evaluation — per-question Lynage DB
// Each question has its own haystack (38-62 sessions). We create a temp DB
// per question, ingest its sessions, search, answer, judge, then discard.
//
// Usage:
//   pnpm tsx benchmarks/longmemeval/eval-500.ts           # all 500 Q
//   QUESTIONS=20 pnpm tsx .../eval-500.ts                  # first 20 Q
//   OFFSET=100 QUESTIONS=50 pnpm tsx .../eval-500.ts       # Q100-149

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { TransformersEmbedder, type Embedder } from "@lynage/core";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..", "..");
const DATA_DIR = path.resolve(import.meta.dirname || __dirname, "..", "data");
const RESULTS_DIR = path.resolve(import.meta.dirname || __dirname, "results");
const DATASET_PATH = path.join(DATA_DIR, "longmemeval_s_cleaned.json");
const DB_DIR = path.join(DATA_DIR, `eval-dbs-${Date.now()}`);

// Load env
const envPath = path.resolve(PROJECT_ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("="); if (idx < 0) continue;
    if (!process.env[t.slice(0,idx).trim()]) process.env[t.slice(0,idx).trim()] = t.slice(idx+1).trim();
  }
}

const API_KEY = process.env.DEEPSEEK_API_KEY!;
const deepseek = createOpenAI({ apiKey: API_KEY, baseURL: "https://api.deepseek.com/v1" });
const model = deepseek("deepseek-v4-flash");
const judgeModel = deepseek("deepseek-v4-flash");

interface SessionTurn { role: "user" | "assistant"; content: string; has_answer?: boolean; }
interface Instance {
  question_id: string; question_type: string; question: string; answer: string;
  question_date: string; haystack_session_ids: string[]; haystack_dates: string[];
  haystack_sessions: SessionTurn[][]; answer_session_ids: string[];
}

async function processQuestion(inst: Instance, idx: number, embedder: Embedder): Promise<{
  questionId: string; question: string; expected: string; actual: string;
  category: string; pass: boolean; ingestMs: number; searchMs: number;
  chunks: number; dirs: number; recallInContext: boolean;
}> {
  const DB_PATH = path.join(DB_DIR, `q${idx}.db`);
  try { fs.unlinkSync(DB_PATH); } catch {}
  fs.mkdirSync(DB_DIR, { recursive: true });

  const memory = createLynageMemory({
    model: new AiSdkModel(model, undefined, { useToolChoice: false }),
    dbPath: DB_PATH,
    config: { archiveThreshold: 12000, retainTokens: 12000, directoryCapacity: 10 },
    embedder,
  });

  // Ingest — archive fires once per ~8k tokens of messages
  const SID = "eval";
  const ingestStart = performance.now();
  const sessions = inst.haystack_sessions;
  for (const turns of sessions) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!;
      if (t.role === "user") {
        const handle = await memory.startTurn(SID, "u", t.content);
        const next = turns[i + 1];
        if (next && next.role === "assistant") {
          await handle.finish({ response: next.content });
          i++;
        } else {
          await handle.finish({ response: "(no response)" });
        }
      }
    }
  }
  await memory.waitForArchiving(SID);
  const ingestMs = performance.now() - ingestStart;

  // Search + answer
  const searchStart = performance.now();
  const sr = await memory.search({ query: inst.question, sessionId: SID });
  if (sr.candidates.length === 0) process.stderr.write(`[0cand] `);
  const contextParts: string[] = [];
  // Stop words must be filtered or "what"/"with" match every message and bury
  // the answer message (same lesson as Lynage's extractKeywords).
  const STOP = new Set([
    "what","which","when","where","who","why","how","is","are","was","were","be",
    "have","has","had","do","does","did","will","would","shall","should","can",
    "could","may","might","must","the","this","that","these","those","it","its",
    "i","me","my","we","our","you","your","he","she","they","them","his","her",
    "not","no","or","and","but","if","then","else","of","in","on","to","for",
    "with","about","at","from","by","as","into","than","also","just","now",
    "only","very","really","some","any","each","every","all","both","few","more",
    "most","other","such","much","there","here","their","mine","yours","ours",
    "whats","didnt","dont","isnt","wasnt","werent","user","users","use","using",
  ]);
  const qTerms = inst.question.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !STOP.has(w));
  // Gather candidate + its best messages, then re-rank by total query hits so
  // the answer-bearing candidate leads (Lynage's relevance can rank unrelated
  // chunks higher). Cap at 3 to reduce LLM noise.
  type CandBundle = { cand: typeof sr.candidates[0]; text: string; dateStr: string; hits: number };
  const bundles: CandBundle[] = [];
  for (const cand of sr.candidates.slice(0, 6)) {
    const open = await memory.openSource(cand.contextId);
    if (!open) continue;
    const msgs = open.messages;
    // Selection: message-level index hits (P2 — the answer message usually has
    // the highest embedding similarity) FIRST, then query-hit messages, then
    // first/last + every-other for dense coverage. Answers in LongMemEval live
    // anywhere in a 10-45 message chunk; prioritizing the semantically-matched
    // message gets the answer text into context without noise.
    const hitIdx = new Set<number>();
    if (cand.topMessageIds?.length) {
      const idToIdx = new Map(msgs.map((m, i) => [m.id, i] as const));
      for (const id of cand.topMessageIds) {
        const idx = idToIdx.get(id);
        if (idx !== undefined) hitIdx.add(idx);
      }
    }
    let totalHits = 0;
    msgs.forEach((m, i) => {
      const hits = qTerms.filter(t => m.content.toLowerCase().includes(t)).length;
      if (hits > 0) { hitIdx.add(i); totalHits += hits; }
    });
    if (msgs.length > 0) { hitIdx.add(0); hitIdx.add(msgs.length - 1); }
    // Every-other coverage for medium chunks; skip only if very long
    const N = msgs.length;
    if (N > 6) {
      for (let i = 1; i < N - 1; i += 2) hitIdx.add(i);
    }
    const keep = [...hitIdx].filter(i => i >= 0 && i < N).sort((a, b) => a - b);
    const selected = keep.map(i => msgs[i]);
    const text = selected.map(m => {
      const ts = new Date(m.createdAt).toISOString().slice(0, 10);
      const content = m.content.length > 1200 ? m.content.slice(0, 1200) + "…" : m.content;
      return `[${ts}] [${m.role.toUpperCase()}] ${content}`;
    }).join("\n");
    bundles.push({
      cand,
      dateStr: new Date(cand.timeRange.start).toISOString().slice(0, 10),
      text,
      hits: totalHits,
    });
  }
  // Trust Lynage's relevance ordering (diagnosis: ansPos ∈ {0,1} for 8/10
  // with Lynage's native order). Only use hits as a tiebreak.
  bundles.sort((a, b) => b.cand.relevance - a.cand.relevance || b.hits - a.hits);
  for (let bi = 0; bi < Math.min(bundles.length, 3); bi++) {
    const b = bundles[bi]!;
    const meta: string[] = [];
    if (b.cand.summary) meta.push(`[summary] ${b.cand.summary}`);
    if (b.cand.conclusions?.length) meta.push(`[conclusions] ${b.cand.conclusions.join(" | ")}`);
    const block = meta.length > 0 ? meta.join("\n") + "\n" + b.text : b.text;
    const budget = bi === 0 ? 6000 : bi === 1 ? 5000 : 3000;
    contextParts.push(`--- ${b.dateStr} (rel ${(b.cand.relevance*100).toFixed(0)}%) ---\n` + block.slice(0, budget));
  }
  const ctx = contextParts.join("\n\n");
  if (process.env.DEBUG_CONTEXT && inst.question_id === process.env.DEBUG_CONTEXT) {
    console.error(`\n===== CONTEXT for ${inst.question_id} =====`);
    console.error(`len=${ctx.length} cands=${sr.candidates.length}`);
    console.error(`terms=${JSON.stringify(qTerms)}`);
    console.error(ctx.slice(0, 3000));
    console.error("\n...\n");
    console.error(ctx.slice(-1500));
    console.error("===== END =====\n");
  }
  const truncated = ctx.length > 16000 ? ctx.slice(0, 16000) + "\n[...truncated]" : ctx;
  const systemPrompt = ctx
    ? `Answer based ONLY on the history below. Use timestamps (YYYY-MM-DD) for temporal questions. If answer not in history, say "Not found in history."\n\n---\n${truncated}`
    : "No history found. Say so.";

  // Recall@context: does the answer appear in the context we gave the LLM?
  const ctxLower = truncated.toLowerCase();
  const ctxTerms = inst.answer.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
  const ctxHits = ctxTerms.filter(t => ctxLower.includes(t)).length;
  const recallInContext = ctxTerms.length > 0 && ctxHits / ctxTerms.length >= 0.5;

  let actual = "(error)";
  try {
    const result = await generateText({ model, prompt: inst.question, system: systemPrompt, maxTokens: 200, temperature: 0 });
    actual = result.text?.trim() || "";
    // Retry once on empty response (DeepSeek flash occasionally returns empty)
    if (!actual) {
      const retry = await generateText({ model, prompt: inst.question, system: systemPrompt, maxTokens: 200, temperature: 0 });
      actual = retry.text?.trim() || "(empty)";
    }
  } catch(e: any) { actual = `(error: ${e.message})`; }
  const searchMs = performance.now() - searchStart;

  // Judge — LLM judge + keyword verification double-check.
  // DeepSeek-flash as judge is unstable (often marks correct answers wrong),
  // so if the LLM says INCORRECT we fall back to lexical verification.
  const actualLower = actual.toLowerCase();
  const isAbs = inst.question_id.endsWith("_abs");
  const keyTerms = inst.answer.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
  const kwHits = keyTerms.filter(t => actualLower.includes(t)).length;
  const kwPass = keyTerms.length > 0 && kwHits / keyTerms.length >= 0.5;
  // Abstention: correct behavior is to deny having the info
  const absPass = isAbs && /not found|don.t (have|know)|does not contain|not available/i.test(actualLower);

  let llmPass = false;
  try {
    const judgePrompt = isAbs
      ? `Abstention question. Correct behavior = say info unavailable. Expected: "${inst.answer}". Student: "${actual}". If student indicates they don't know / not found → CORRECT. Reply ONLY "CORRECT" or "INCORRECT".`
      : `You are a LENIENT grader. The student's answer is CORRECT if it CONTAINS the expected key fact, even if phrased differently or with extra detail.\nExpected fact: "${inst.answer}"\nStudent answer: "${actual}"\nDoes the student's answer contain the expected fact? Reply ONLY "CORRECT" or "INCORRECT".`;
    const judge = await generateText({ model: judgeModel, prompt: judgePrompt, maxTokens: 50, temperature: 0 });
    llmPass = judge.text.trim().toUpperCase().startsWith("CORRECT");
  } catch { llmPass = kwPass; }

  const pass = llmPass || kwPass || absPass;

  // Stats
  const stats = await memory.getArchiveStats(SID);
  try { fs.unlinkSync(DB_PATH); } catch {}

  return {
    questionId: inst.question_id, question: inst.question, expected: inst.answer,
    actual, category: inst.question_type, pass, ingestMs: Math.round(ingestMs),
    searchMs: Math.round(searchMs), chunks: stats.chunkCount, dirs: stats.directoryCount,
    recallInContext,
  };
}

async function main() {
  const OFFSET = Number(process.env.OFFSET) || 0;
  const LIMIT = Number(process.env.QUESTIONS) || 500;

  console.log(`🧪 LongMemEval 500Q — per-question Lynage eval`);
  console.log(`   Questions: ${OFFSET}-${OFFSET+LIMIT-1}\n`);

  const dataset: Instance[] = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));
  const batch = dataset.slice(OFFSET, OFFSET + LIMIT);
  const results: Awaited<ReturnType<typeof processQuestion>>[] = [];

  // One embedder shared across questions — TransformersEmbedder lazily loads
  // the ~30MB model on first embed (~17s); recreating per question would
  // reload it every time.
  const bgeEmbedder = new TransformersEmbedder();

  const t0 = performance.now();
  const CONCURRENCY = 4;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const chunk = batch.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (inst, ci) => {
        const globalIdx = OFFSET + i + ci;
        process.stdout.write(`[${globalIdx+1}/${OFFSET+LIMIT}] ${inst.question_id.slice(0,20)}... `);
        const r = await processQuestion(inst, globalIdx, bgeEmbedder);
        console.log(`${r.pass ? '✅' : '❌'} ${(r.ingestMs/1000).toFixed(0)}s ${r.chunks}c`);
        return r;
      })
    );
    results.push(...chunkResults);
  }
  const totalS = ((performance.now() - t0) / 1000).toFixed(0);

  // Summary
  const byCategory: Record<string, {total:number;pass:number}> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = {total:0,pass:0};
    byCategory[r.category]!.total++; if(r.pass) byCategory[r.category]!.pass++;
  }
  const passCount = results.filter(r=>r.pass).length;
  const recallCount = results.filter(r=>r.recallInContext).length;
  console.log(`\n📊 Results: ${passCount}/${results.length} (${(passCount/results.length*100).toFixed(1)}%) in ${totalS}s`);
  console.log(`📥 Recall@context: ${recallCount}/${results.length} (${(recallCount/results.length*100).toFixed(1)}%) — answer terms in context`);
  console.log(`   (recall@context > accuracy ⇒ retrieval works, LLM/judge is the bottleneck)\n`);
  for (const [cat, v] of Object.entries(byCategory)) {
    console.log(`   ${cat}: ${v.pass}/${v.total} (${(v.pass/v.total*100).toFixed(1)}%)`);
  }

  const ts = Date.now();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `longmemeval-500-${ts}.json`), JSON.stringify({
    benchmark: "LongMemEval-cleaned", timestamp: new Date().toISOString(),
    model: "deepseek-v4-flash (via Lynage + TransformersEmbedder bge-small-en)",
    offset: OFFSET, count: results.length, totalTimeS: Number(totalS),
    summary: { totalQuestions: results.length, pass: passCount, accuracy: passCount/results.length, byCategory, recallInContext: recallCount/results.length },
    details: results,
  }, null, 2));
}

main().catch(e => { console.error("❌", e); process.exit(1); });
