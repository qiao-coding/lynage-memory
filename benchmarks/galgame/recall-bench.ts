// Galgame recall@prompt — plot-detail fidelity benchmark
//
// Measures how often specific plot details (exact dialogue lines, timeline
// events, foreshadows, character memories) survive into the context handed to
// a story generator. This is the metric that matters for narrative memory
// (Protocol Zero design), unlike fact-retrieval benchmarks.
//
// Two context modes are compared:
//   A. summary-only  → memory.compileRetrievedContext(sr)  (AI summaries)
//   B. summary+source → summary + every candidate's RAW messages (openSource)
//
// If a detail is only in the raw messages, mode A misses it — exposing the
// "summaries drop narrative detail" gap that the message-level index + source
// opening is designed to close.
//
// Usage (cwd = benchmarks/galgame):
//   pnpm tsx recall-bench.ts
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import { TransformersEmbedder } from "@lynage/core";
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), "..", "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i < 0) continue;
    if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
const deepseek = createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" });
const model = deepseek("deepseek-v4-flash");

// ---------------------------------------------------------------------------
// Synthetic Chinese Galgame plot with embedded details
// ---------------------------------------------------------------------------
interface Detail {
  type: "台词" | "时间线" | "伏笔" | "角色记忆";
  question: string;
  keyPhrase: string;   // core phrase that MUST appear for recall
  chapter: number;
}

interface Turn { u: string; a: string }

function generateChapters(): { turns: Turn[]; details: Detail[] } {
  // 5 chapters × 30 turns of Chinese Galgame dialogue.
  // Details are embedded verbatim in specific turns.
  // Details live in CHAPTERS 1-4 (already past). Chapter 5 is the "generate
  // now" target: the generator must RECALL early-chapter detail from memory,
  // not find it in the recent window (where compression already wins). This is
  // the scene Lynage exists for.
  const details: Detail[] = [
    // 台词 (exact lines a character said)
    { type: "台词", question: "零说过关于海的话吗？她的原话是什么？", keyPhrase: "陪你去海边看日落", chapter: 1 },
    { type: "台词", question: "男主在桥上说过什么特别的话？", keyPhrase: "桥上的风很温柔", chapter: 3 },
    { type: "台词", question: "零提起过她的母亲吗？说了什么？", keyPhrase: "妈妈在雨里走丢了", chapter: 4 },
    // 时间线 (when an event happened)
    { type: "时间线", question: "我们是什么时候决定去海边的？", keyPhrase: "第二天清晨出发", chapter: 1 },
    { type: "时间线", question: "零是什么时候说她不坐车的？", keyPhrase: "过了安检之后", chapter: 3 },
    { type: "时间线", question: "那场雨是什么时候下的？", keyPhrase: "离开车站的那个傍晚", chapter: 4 },
    // 伏笔 (foreshadows planted early)
    { type: "伏笔", question: "零口袋里一直带着什么？她提过吗？", keyPhrase: "一把旧钥匙", chapter: 2 },
    { type: "伏笔", question: "关于零的笔记本，透露过什么？", keyPhrase: "夹着一张褪色的照片", chapter: 4 },
    { type: "伏笔", question: "零害怕的东西是什么？", keyPhrase: "怕打雷", chapter: 2 },
    // 角色记忆 (what one character told another)
    { type: "角色记忆", question: "男主对零说过他小时候的事吗？", keyPhrase: "小时候养过一只猫", chapter: 2 },
    { type: "角色记忆", question: "零对男主讲过她的生日吗？", keyPhrase: "生日是十一月", chapter: 3 },
    { type: "角色记忆", question: "男主说过他为什么怕水吗？", keyPhrase: "掉进过池塘", chapter: 4 },
  ];

  // Chapter themes: 1初遇 2相处 3出行 4回忆 5离别
  const chapterTheme: string[] = [
    "第一章：在旧车站初次相遇", "第二章：一起逛过的小镇", "第三章：说好一起去看海",
    "第四章：雨夜里的往事", "第五章：最后一班列车",
  ];
  // Filler dialogue pools (non-plot chatter, ~100 chars/line, so ~200 rounds
  // ≈ 25k tokens → archiving fires into several chunks across the 5 chapters)
  const fillerU = [
    "今天天气不错，云很淡。沿着这条旧路一直走，远处能看见车站的轮廓，我们以前好像也走过这里。",
    "你饿了吗？前面转角有家小店，门口挂着褪色的布帘，老板是个总是笑眯眯的老人家。",
    "走了这么久，腿有点酸了。前面有张长椅，树荫正好，我们歇一会儿再走好不好？",
    "你在想什么？一路都没怎么说话。是想起以前的事了吗，还是单纯在发呆？",
    "那边草丛里好像有什么动静，沙沙的响，我有点好奇，要不要过去看看是什么。",
    "起风了，天色也开始暗下来。天气预报说今晚可能会变天，要不要趁早找个地方避一避？",
    "这条路我总觉得走过，路边的灯柱上还留着去年贴的海报，边角都卷起来了。",
    "天快黑了，街灯一盏一盏亮起来，昏黄的光落在石板路上，影子被拉得很长很长。",
    "你平时一个人的时候都喜欢做什么？除了等我，总该有自己的生活吧。",
    "要一起喝点什么吗？前面有家茶馆，靠窗的位子能看到整条街，老板还会讲当地的故事。",
  ];
  const fillerA = [
    "嗯，天气确实很好。云淡风轻的日子总是让人想起很多以前的事，包括那些以为已经忘了的细节。",
    "我不太饿，不过陪你去看看也行。那家店我路过很多次，老板娘的手艺据说不错，值得一试。",
    "好，那就坐一会儿吧。长椅被太阳晒得温温的，靠着椅背，整个人都放松下来了。",
    "没什么，只是在看远处那些山。一年四季，山的样子都不一样，像在慢慢变老。",
    "可能是只野猫吧，这一带的小动物不少，晚上还常能听见它们的声音，习惯了就好。",
    "我把外套借你吧，风一吹确实凉了。出门前没想到会降温，早知道该多带一件。",
    "嗯，是走过。这条路上的每个转角我都记得，包括那棵歪脖子的树，去年还开着花。",
    "天黑前回去也来得及。不过难得出来一趟，多待一会儿也不错，我其实挺喜欢这样的傍晚。",
    "平时也就是看看书，整理一下房间，偶尔写点东西。生活很简单，没什么特别的。",
    "好，我请客。那家的茶不错，上次路过闻着特别香，正好一起尝尝看。",
  ];

  const turns: Turn[] = [];
  const detailByChapter = new Map<number, Detail[]>();
  for (const d of details) {
    if (!detailByChapter.has(d.chapter)) detailByChapter.set(d.chapter, []);
    detailByChapter.get(d.chapter)!.push(d);
  }

  // ~40 rounds/chapter → ~200 rounds → ~35k tokens → archiving fires (needs
  // to exceed retainTokens=16000 to produce chunks, not just raw messages).
  for (let ch = 0; ch < 5; ch++) {
    const chDetails = detailByChapter.get(ch + 1) ?? [];
    turns.push({ u: `【${chapterTheme[ch]}】`, a: "（剧情开始）" });
    for (let i = 0; i < 40; i++) {
      const u = fillerU[(ch * 40 + i) % fillerU.length]!;
      const a = fillerA[(ch * 40 + i) % fillerA.length]!;
      turns.push({ u, a });
      // Embed a detail at a specific round within the chapter
      const detailIdx = Math.floor(i / 12);
      if (i % 12 === 9 && chDetails[detailIdx]) {
        const d = chDetails[detailIdx]!;
        // weave the detail into the assistant's reply naturally
        turns[turns.length - 1] = { u, a: `${a} ${d.keyPhrase}。这是我记得最清楚的部分。` };
      }
    }
  }
  return { turns, details };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { turns, details } = generateChapters();
  console.log(`Galgame recall@prompt: ${turns.length} turns, ${details.length} details (${turns.length / 2} rounds)\n`);

  const dbPath = path.resolve(process.cwd(), "data", "galgame-recall.db");
  try { fs.unlinkSync(dbPath); } catch {}
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const memory = createLynageMemory({
    model: new AiSdkModel(model, undefined, { useToolChoice: false }),
    dbPath,
    // Lower retainTokens so the ~25k-token story archives into several chunks
    // (one per chapter-ish), exercising cross-chunk retrieval.
    config: { archiveThreshold: 4000, retainTokens: 3000, directoryCapacity: 10 },
    embedder: new TransformersEmbedder({ model: "Xenova/bge-small-zh-v1.5" }),
  });

  // 1. Ingest (real turn path — archiving triggers automatically)
  console.log("Ingesting story...");
  const SID = "story";
  const st0 = performance.now();
  for (const t of turns) {
    const h = await memory.startTurn(SID, "u1", t.u);
    await h.finish({ response: t.a });
  }
  await memory.waitForArchiving(SID);
  const ingestS = ((performance.now() - st0) / 1000).toFixed(0);
  const stats = await memory.getArchiveStats(SID);
  console.log(`Ingested ${turns.length} turns in ${ingestS}s → ${stats.chunkCount} chunks, ${stats.directoryCount} dirs`);

  // 2. Language check on one chunk summary (verifies Chinese-drift fix)
  const tree = await memory.getDirectoryTree(SID);
  const sampleSummary = tree[0]?.summary ?? "(no tree)";
  const hasHan = /[一-鿿]/.test(sampleSummary);
  const hasLatinWords = /[a-zA-Z]{4,}/.test(sampleSummary);
  console.log(`Summary language: ${hasHan && !hasLatinWords ? "中文 ✅" : hasHan ? "混合 ⚠️" : "英文 ❌"} | "${sampleSummary.slice(0, 60)}"`);

  // 2b. Compression baseline: hand the generator the most recent W messages
  // (the "last N rounds" window a context-compression system would keep).
  // Details planted in chapters 1-4 should be OUTSIDE this window — showing
  // compression can't recall the past, which is exactly Lynage's job.
  const WINDOW = 40;
  const recent = await memory.store.getRecent({ sessionId: SID });
  const windowText = recent.slice(0, WINDOW).map((m) => m.content).join("\n");
  const compHits = details.filter((d) => windowText.includes(d.keyPhrase)).length;
  console.log(`Compression baseline (last ${WINDOW} msgs): ${compHits}/${details.length} (${(compHits / details.length * 100).toFixed(0)}%)`);

  // 3. Recall@prompt
  const byType: Record<string, { hit: number; total: number }> = {};
  for (const d of details) {
    if (!byType[d.type]) byType[d.type] = { hit: 0, total: 0 };
    byType[d.type]!.total++;
  }
  let hitSumA = 0, hitSumB = 0;
  const rows: Array<{ type: string; question: string; sumOnly: boolean; full: boolean }> = [];

  for (const d of details) {
    const sr = await memory.search({ query: d.question, sessionId: SID });
    // A. summary-only context
    const ctxA = memory.compileRetrievedContext(sr);
    const hitA = ctxA.includes(d.keyPhrase);
    // B. summary + raw messages of top-3 candidates
    let fullText = ctxA;
    for (const c of sr.candidates.slice(0, 3)) {
      const open = await memory.openSource(c.contextId);
      if (open) fullText += "\n" + open.messages.map((m) => m.content).join("\n");
    }
    const hitB = fullText.includes(d.keyPhrase);
    if (hitA) hitSumA++;
    if (hitB) hitSumB++;
    for (const b of [byType[d.type]!]) if (hitB) b.hit++;
    rows.push({ type: d.type, question: d.question, sumOnly: hitA, full: hitB });
    console.log(`${hitB ? "✅" : "❌"} [${d.type}] ${d.question} → 摘要${hitA ? "✅" : "❌"} 原文${hitB ? "✅" : "❌"}`);
  }

  const total = details.length;
  console.log(`\n${"=".repeat(55)}`);
  console.log(`Galgame recall@prompt results`);
  console.log(`Turn count: ${turns.length}  Chunks: ${stats.chunkCount}`);
  console.log(`Compression baseline (last ${WINDOW} msgs): ${compHits}/${total} (${(compHits / total * 100).toFixed(0)}%)`);
  console.log(`A. Summary-only context: ${hitSumA}/${total} (${(hitSumA / total * 100).toFixed(0)}%)`);
  console.log(`B. Summary + raw messages: ${hitSumB}/${total} (${(hitSumB / total * 100).toFixed(0)}%)`);
  console.log(`\nBy type (full context):`);
  for (const [type, v] of Object.entries(byType)) {
    console.log(`   ${type}: ${v.hit}/${v.total} (${(v.hit / v.total * 100).toFixed(0)}%)`);
  }
  console.log(`\nInsight: B beats the compression baseline when early-chapter detail`);
  console.log(`(outside the recent window) is recalled — that is Lynage's reason to exist.`);

  fs.writeFileSync(path.resolve(process.cwd(), "data", "galgame-recall.json"),
    JSON.stringify({ turns: turns.length, chunks: stats.chunkCount, total, compression: compHits, sumOnly: hitSumA, full: hitSumB, byType, rows }, null, 2));
  try { fs.unlinkSync(dbPath); } catch {}
}
main().catch((e) => { console.error("❌", e); process.exit(1); });
