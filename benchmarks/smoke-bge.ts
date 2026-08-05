// BGE smoke test — verify TransformersEmbedder runs on this machine.
import { TransformersEmbedder, TrigramEmbedder } from "../packages/core/src/embedder.ts";

async function main() {
  const trig = new TrigramEmbedder();
  trig.fit(["deployment platform is v2", "TypeScript chosen", "database decision"]);
  const a = await trig.embed("deployment platform");
  const b = await trig.embed("deployment strategy");
  console.log("Trigram sim(deployment platform, deployment strategy):", trig.similarity(a, b).toFixed(3));

  console.log("Loading TransformersEmbedder (downloads bge-small-en ~30MB on first run)...");
  const t0 = Date.now();
  const bge = new TransformersEmbedder();
  const v1 = await bge.embed("the user prefers TypeScript for the project");
  const v2 = await bge.embed("deployment platform strategy");
  const v3 = await bge.embed("the user chose TypeScript");
  const v4 = await bge.embed("summer vibes playlist");
  console.log(`Loaded + embedded 4 texts in ${((Date.now() - t0) / 1000).toFixed(1)}s, dim=${v1.length}`);
  console.log("bge sim(user prefers TS, user chose TS):", bge.similarity(v1, v3).toFixed(3));
  console.log("bge sim(TS, deployment):", bge.similarity(v1, v2).toFixed(3));
  console.log("bge sim(TS, summer vibes):", bge.similarity(v1, v4).toFixed(3));
  // sanity: same-language related should beat unrelated by a wide margin
  if (bge.similarity(v1, v3) <= bge.similarity(v1, v4)) {
    console.error("SANITY FAIL: bge similarity ordering is wrong");
    process.exit(1);
  }
  console.log("✅ BGE works on this machine");
}

main().catch(e => { console.error("❌ FAILED:", e.message); console.error(e.stack?.slice(0, 800)); process.exit(1); });
