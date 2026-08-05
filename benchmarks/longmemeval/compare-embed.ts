// Compare retrieval recall: FTS-only (NoopEmbedder) vs FTS+TrigramEmbedder.
// For each question, build two DBs, search each, check if the answer chunk
// is in the candidate pool. This isolates what the embedding channel adds.
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { TrigramEmbedder, NoopEmbedder } from "@lynage/core";
import fs from "node:fs";

const dataset = JSON.parse(fs.readFileSync("benchmarks/data/longmemeval_s_cleaned.json", "utf-8"));
const envPath = "D:/coding/lynage-memory/.env";
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("="); if (idx < 0) continue;
    if (!process.env[t.slice(0,idx).trim()]) process.env[t.slice(0,idx).trim()] = t.slice(idx+1).trim();
  }
}
const deepseek = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" });
const model = deepseek("deepseek-v4-flash");

async function buildAndRecall(idx: number, embedder: any, label: string): Promise<{recalled: boolean; cands: number}> {
  const inst = dataset[idx];
  const dbPath = `benchmarks/data/cmp-${label}-${idx}.db`;
  try { fs.unlinkSync(dbPath); } catch {}
  const memory = createLynageMemory({
    model: new AiSdkModel(model, undefined, { useToolChoice: false }),
    dbPath,
    config: { archiveThreshold: 12000, retainTokens: 12000, directoryCapacity: 10 },
    embedder,
  });
  const SID = "eval";
  for (const turns of inst.haystack_sessions) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t.role === "user") {
        const h = await memory.startTurn(SID, "u", t.content);
        const next = turns[i+1];
        if (next && next.role === "assistant") { await h.finish({response:next.content}); i++; }
        else await h.finish({response:"(none)"});
      }
    }
  }
  await memory.waitForArchiving(SID);
  const sr = await memory.search({ query: inst.question, sessionId: SID });
  const terms = inst.answer.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  let recalled = false;
  for (const c of sr.candidates) {
    const open = await memory.openSource(c.contextId);
    if (!open) continue;
    const all = open.messages.map(m => m.content.toLowerCase()).join(" ");
    if (terms.length > 0 && terms.filter(t => all.includes(t)).length / terms.length >= 0.5) {
      recalled = true; break;
    }
  }
  try { fs.unlinkSync(dbPath); } catch {}
  return { recalled, cands: sr.candidates.length };
}

async function main() {
  const COUNT = Number(process.env.COUNT) || 10;
  const LIMIT = Number(process.env.LIMIT) || 12;
  console.log(`Compare retrieval recall: FTS-only vs FTS+TrigramEmbedder (${COUNT} Q)\n`);
  console.log("Q# | FTS-only          | FTS+Trigram       | Q");
  console.log("--- | ----------------- | ----------------- | ---");
  let noop = 0, trig = 0;
  for (let i = 0; i < COUNT; i++) {
    const noopR = await buildAndRecall(i, new NoopEmbedder(), "noop");
    const trigR = await buildAndRecall(i, new TrigramEmbedder(), "trig");
    if (noopR.recalled) noop++;
    if (trigR.recalled) trig++;
    console.log(`${i.toString().padStart(2)} | ${noopR.recalled ? "✅" : "❌"} (${String(noopR.cands).padStart(2)}c)    | ${trigR.recalled ? "✅" : "❌"} (${String(trigR.cands).padStart(2)}c)    | ${dataset[i].question.slice(0,35)}`);
  }
  console.log(`\nFTS-only recall: ${noop}/${COUNT} (${(noop/COUNT*100).toFixed(0)}%)`);
  console.log(`FTS+Trigram recall: ${trig}/${COUNT} (${(trig/COUNT*100).toFixed(0)}%)`);
  console.log(`Embedding gain: +${trig - noop} questions`);
}
main().catch(e => { console.error(e); process.exit(1); });
