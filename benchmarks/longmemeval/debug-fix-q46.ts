// Decisive test: does message-embedding (Fix A) and/or smaller chunks (Fix B)
// recover Q4 (playlist "Summer Vibes") and Q6 (yoga "Serenity Yoga")?
// Uses BGE embedder. Tests retainTokens=12000 vs 3000.
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { TransformersEmbedder } from "@lynage/core";
import fs from "node:fs";

const dataset = JSON.parse(fs.readFileSync("benchmarks/data/longmemeval_s_cleaned.json", "utf-8"));
const envPath = "D:/coding/lynage-memory/.env";
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const idx = t.indexOf("="); if (idx < 0) continue;
  if (!process.env[t.slice(0, idx).trim()]) process.env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
}
const deepseek = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" });
const model = deepseek("deepseek-v4-flash");

async function test(inst: any, retainTokens: number, label: string): Promise<void> {
  const dbPath = `benchmarks/data/fix-${retainTokens}-${inst.question_id}.db`;
  try { fs.unlinkSync(dbPath); } catch {}
  const memory = createLynageMemory({
    model: new AiSdkModel(model, undefined, { useToolChoice: false }),
    dbPath,
    config: { archiveThreshold: 12000, retainTokens, directoryCapacity: 10 },
    embedder: new TransformersEmbedder(),
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
  const stats = await memory.getArchiveStats(SID);

  const sr = await memory.search({ query: inst.question, sessionId: SID });
  const answerTerms = inst.answer.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
  let recalled = false, top3 = false;
  const open0 = await memory.openSource(sr.candidates[0]?.contextId);
  for (let i = 0; i < sr.candidates.length; i++) {
    const open = await memory.openSource(sr.candidates[i]!.contextId);
    if (!open) continue;
    const all = open.messages.map(m => m.content.toLowerCase()).join(" ");
    const pass = answerTerms.length > 0 && answerTerms.filter(t => all.includes(t)).length / answerTerms.length >= 0.5;
    if (pass) { recalled = true; if (i < 3) top3 = true; }
  }
  console.log(`${label}: ${recalled ? "✅" : "❌"} pool=${recalled} top3=${top3} cands=${sr.candidates.length} chunks=${stats.chunkCount} dirs=${stats.directoryCount}`);
  try { fs.unlinkSync(dbPath); } catch {}
}

async function main() {
  for (const qi of [4, 6]) {
    const inst = dataset[qi];
    console.log(`\n== Q${qi}: ${inst.question} | answer: "${inst.answer}" ==`);
    await test(inst, 12000, "  [FixA retain=12000] ");
    await test(inst, 3000, "  [FixA+B retain=3000] ");
  }
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
