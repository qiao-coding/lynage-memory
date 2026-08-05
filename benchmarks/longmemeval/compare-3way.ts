// 3-way retrieval recall comparison: FTS-only (Noop) vs FTS+Trigram vs FTS+BGE.
//
// Key optimization: the embedder ONLY matters at search time — archiving is
// embedder-agnostic. So we build ONE DB per question, then search it 3 times
// with memory.setEmbedder(...). This cuts ingest cost 3× vs per-embedder DBs.
//
// Recall = answer terms present in the returned candidate messages (>=50% of
// answer terms appear in ANY candidate's source messages).
//
// Usage:
//   pnpm tsx benchmarks/longmemeval/compare-3way.ts          # 10 questions
//   COUNT=6 pnpm tsx benchmarks/longmemeval/compare-3way.ts  # 6 questions
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { TrigramEmbedder, NoopEmbedder, TransformersEmbedder } from "@lynage/core";
import fs from "node:fs";

const dataset = JSON.parse(fs.readFileSync("benchmarks/data/longmemeval_s_cleaned.json", "utf-8"));
const envPath = "D:/coding/lynage-memory/.env";
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("="); if (idx < 0) continue;
    if (!process.env[t.slice(0, idx).trim()]) process.env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
}
const deepseek = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" });
const model = deepseek("deepseek-v4-flash");

/** Pool recall = answer terms in ANY candidate; Top3 recall = in the top-3. */
async function recallFromCandidates(memory: any, sr: { candidates: { contextId: string }[] }, answerTerms: string[]): Promise<{ pool: boolean; top3: boolean }> {
  const hit = (c: { contextId: string }) => {
    return (async () => {
      const open = await memory.openSource(c.contextId);
      if (!open) return false;
      const all = open.messages.map(m => m.content.toLowerCase()).join(" ");
      return answerTerms.length > 0 && answerTerms.filter(t => all.includes(t)).length / answerTerms.length >= 0.5;
    })();
  };
  let pool = false;
  for (const c of sr.candidates) {
    if (await hit(c)) { pool = true; break; }
  }
  let top3 = false;
  for (const c of sr.candidates.slice(0, 3)) {
    if (await hit(c)) { top3 = true; break; }
  }
  return { pool, top3 };
}

async function main() {
  const COUNT = Number(process.env.COUNT) || 10;
  console.log(`Compare retrieval recall: FTS-only | FTS+Trigram | FTS+BGE (${COUNT} Q, 1 DB each)\n`);

  // Instantiate once — TransformersEmbedder loads the ~30MB model on first
  // embed (~17s); recreating per question would reload it every time.
  const embedders = [
    { name: "noop",  inst: new NoopEmbedder() },
    { name: "trig",  inst: new TrigramEmbedder() },
    { name: "bge",   inst: new TransformersEmbedder() },
  ];

  console.log("Q# | FTS-only    | FTS+Trigram | FTS+BGE     | Q");
  console.log("--- | ----------- | ----------- | ----------- | ---");
  const counts = [0, 0, 0];
  const rows: { recalled: { pool: boolean; top3: boolean }[]; cands: number[]; question: string }[] = [];

  for (let qi = 0; qi < COUNT; qi++) {
    const inst = dataset[qi];
    const dbPath = `benchmarks/data/cmp3way-${qi}.db`;
    try { fs.unlinkSync(dbPath); } catch {}

    // Build ONE DB with noop embedder (archiving is embedder-agnostic)
    const memory = createLynageMemory({
      model: new AiSdkModel(model, undefined, { useToolChoice: false }),
      dbPath,
      config: { archiveThreshold: 12000, retainTokens: 12000, directoryCapacity: 10 },
      embedder: new NoopEmbedder(),
    });
    const SID = "eval";
    for (const turns of inst.haystack_sessions) {
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        if (t.role === "user") {
          const h = await memory.startTurn(SID, "u", t.content);
          const next = turns[i + 1];
          if (next && next.role === "assistant") { await h.finish({ response: next.content }); i++; }
          else await h.finish({ response: "(none)" });
        }
      }
    }
    await memory.waitForArchiving(SID);

    // >= 2 (not > 3): numeric answers like "$800" are 3 chars and must not be
    // filtered out — otherwise the recall metric can never see the answer.
    const answerTerms = inst.answer.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);

    // Search with all 3 embedders on the SAME DB
    const recalled: { pool: boolean; top3: boolean }[] = [];
    const cands: number[] = [];
    for (const e of embedders) {
      memory.setEmbedder(e.inst);
      const sr = await memory.search({ query: inst.question, sessionId: SID });
      cands.push(sr.candidates.length);
      recalled.push(await recallFromCandidates(memory, sr, answerTerms));
    }

    try { fs.unlinkSync(dbPath); } catch {}

    recalled.forEach((r, i) => { if (r.pool) counts[i]!++; });
    rows.push({ recalled, cands, question: inst.question });
    console.log(`${String(qi).padStart(2)} | ${recalled[0].pool ? "✅" : "❌"} (${String(cands[0]).padStart(2)}c)   | ${recalled[1].pool ? "✅" : "❌"} (${String(cands[1]).padStart(2)}c)   | ${recalled[2].pool ? "✅" : "❌"} (${String(cands[2]).padStart(2)}c)   | ${inst.question.slice(0, 30)}`);
  }

  console.log(`\n== Candidate-pool recall (answer chunk in ANY candidate) ==`);
  console.log(`FTS-only recall:   ${counts[0]}/${COUNT} (${(counts[0] / COUNT * 100).toFixed(0)}%)`);
  console.log(`FTS+Trigram:       ${counts[1]}/${COUNT} (${(counts[1] / COUNT * 100).toFixed(0)}%)`);
  console.log(`FTS+BGE:           ${counts[2]}/${COUNT} (${(counts[2] / COUNT * 100).toFixed(0)}%)`);
  const t3 = [0, 0, 0];
  rows.forEach(r => r.recalled.forEach((v, i) => { if (v.top3) t3[i]!++; }));
  console.log(`\n== Recall@top3 (answer chunk in top-3 — predicts reaching the LLM) ==`);
  console.log(`FTS-only top3:   ${t3[0]}/${COUNT} (${(t3[0] / COUNT * 100).toFixed(0)}%)`);
  console.log(`FTS+Trigram top3: ${t3[1]}/${COUNT} (${(t3[1] / COUNT * 100).toFixed(0)}%)`);
  console.log(`FTS+BGE top3:     ${t3[2]}/${COUNT} (${(t3[2] / COUNT * 100).toFixed(0)}%)`);
  console.log(`BGE gain vs Trigram: +${counts[2] - counts[1]} questions`);
  fs.writeFileSync("benchmarks/data/compare-3way-result.json", JSON.stringify({
    poolRecall: counts, top3Recall: t3, count: COUNT, rows,
  }, null, 2));
}
main().catch(e => { console.error("❌", e); process.exit(1); });
