// Diagnose forget Q4(状态管理)/Q6(Monorepo) failures: what does FTS find?
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

// One fact: 状态管理 (Zustand→MobX→Redux Toolkit). Plus generic noise.
const turns:Array<{u:string;a:string}>=[];
turns.push({u:"关于状态管理，我们一开始按主流做法选了Zustand。你帮我看看这个方案对我们的场景合适吗？",a:"Zustand 是通用选择，但我们要先试用评估。先按Zustand搭一版看看效果。"});
turns.push({u:"Zustand 用下来有问题。我听说MobX可能更合适，要不要试试？",a:"MobX 的问题也很明显：MobX并不完全匹配。Zustand和MobX都淘汰了，我们重新评估。"});
turns.push({u:"那两个都不行。你觉得Redux Toolkit这个方案怎么样？",a:"经过评估，Redux Toolkit最合适。用createSlice定义reducer，RTK Query管理异步状态。最终决定用Redux Toolkit，不用Zustand也不用MobX。"});
for(let i=0;i<60;i++){const c=["Button","Table","Modal","Form","Input"][i%5]!;const a=["重构","性能优化","边界处理","测试覆盖"][i%4]!;turns.push({u:`${c}组件正在做${a}工作。这次改动涉及组件的基础样式、交互逻辑。请给出建议。`,a:`${c}组件的${a}方向正确。建议保持API一致性。`});}

async function main(){
  const db=path.resolve(process.cwd(),"data","debug-forget.db");try{fs.unlinkSync(db);}catch{}
  const mem=createLynageMemory({model:new AiSdkModel(m, undefined, { useToolChoice: false }),dbPath:db,config:{archiveThreshold:2000,retainTokens:800,directoryCapacity:10}});
  for(const t of turns){const tn=await mem.startTurn("s1","u1",t.u);await tn.finish({response:t.a});}
  await mem.waitForArchiving("s1"); await mem.waitForArchiving("s1");
  const chunks=await mem.store.listChunks("s1");
  console.log(`\n${chunks.length} chunks:`);
  for(const c of chunks){console.log(`  [${c.id}] "${c.summary.slice(0,70)}"`);}
  // Find the decision chunk
  const decision = chunks.find(c => (c.summary + (c.conclusions??[]).join(" ")).includes("Redux"));
  console.log(`\nDecision chunk: ${decision ? decision.id : "NOT FOUND"}`);
  for(const q of ["关于状态管理的事，我记不太清了。我们当时是怎么定的？","Monorepo"]){
    const sr=await mem.search({query:q,sessionId:"s1"});
    console.log(`\n=== search "${q.slice(0,20)}" → ${sr.candidates.length} candidates ===`);
    for(const cand of sr.candidates.slice(0,5)){console.log(`  [${cand.contextId}] rel=${cand.relevance.toFixed(2)} "${cand.summary.slice(0,55)}" ${decision && cand.contextId===decision.id?"←DECISION":""}`);}
  }
  try{fs.unlinkSync(db);}catch{}
}
main().catch(e=>{console.error("FAIL",e);process.exit(1);});
