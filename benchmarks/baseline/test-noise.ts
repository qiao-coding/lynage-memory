// Fast validation: monotonic timestamps + noise + rerank
// Builds a conversation where the topic word appears 20x in noise, archives,
// searches, checks the DECISION chunk surfaces via rerank.
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { LynageSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

const turns:Array<{u:string;a:string}>=[];
// The DECISION process (状态管理)
turns.push({u:"关于状态管理，我们一开始按主流做法选了Zustand。你帮我看看这个方案对我们的场景合适吗？",a:"Zustand 是通用选择，但我们要先试用评估。先按Zustand搭一版看看效果。"});
turns.push({u:"Zustand 用下来有问题。我听说MobX可能更合适，要不要试试？",a:"MobX 的问题也很明显：MobX并不完全匹配。Zustand和MobX都淘汰了，我们重新评估。"});
turns.push({u:"那两个都不行。你觉得Redux Toolkit这个方案怎么样？",a:"经过评估，Redux Toolkit最合适。用createSlice定义reducer，RTK Query管理异步状态。最终决定用Redux Toolkit，不用Zustand也不用MobX。"});
// NOISE: generic turns repeatedly mentioning "状态管理方案" incidentally
for(let i=0;i<80;i++){const c=["Button","Table","Modal","Form","Input"][i%5]!;const a=["重构","性能优化","国际化","暗色模式","响应式"][i%5]!;
  const ref=pk(["Button组件的最佳实践","Table组件的状态管理方案","Modal的焦点管理","之前总结的编码规范"]);
  turns.push({u:`${c}组件正在做${a}工作。这次改动涉及组件的基础样式、交互逻辑和对外暴露的API接口。请给出建议。`,a:`${c}组件的${a}方向正确。建议参考${ref}：1)保持API一致性；2)补充自动化测试。`});}

async function main(){
  const db=path.resolve(process.cwd(),"data","test-noise.db");try{fs.unlinkSync(db);}catch{}
  const mem=createLynageMemory({model:new LynageSdkModel(m, undefined, { useToolChoice: false }),dbPath:db,config:{archiveThreshold:2000,retainTokens:800,directoryCapacity:10}});
  for(const t of turns){const tn=await mem.startTurn("s1","u1",t.u);await tn.finish({response:t.a});}
  await mem.waitForArchiving("s1");
  const st=await mem.getArchiveStats("s1");
  console.log(`Archived: ${st.chunkCount} chunks, ${st.messageCount} msgs`);
  // Find the decision chunk
  const chunks=await mem.store.listChunks("s1");
  const decision=chunks.find(c=>(c.summary+c.conclusions.join("")).includes("Redux")||(c.summary+c.conclusions.join("")).includes("状态管理"));
  console.log(`Decision chunk: ${decision?decision.id:"NOT FOUND"} | "${decision?.summary.slice(0,60)}"`);

  const sr=await mem.search({query:"关于状态管理的事，我记不太清了。我们当时是怎么定的？",sessionId:"s1"});
  console.log(`Search: ${sr.candidates.length} candidates`);
  for(const cand of sr.candidates.slice(0,4)){
    const isD=decision && cand.contextId===decision.id;
    console.log(`  [${cand.contextId}] rel=${cand.relevance.toFixed(2)} "${cand.summary.slice(0,50)}" ${isD?"←DECISION":""}`);
  }
  try{fs.unlinkSync(db);}catch{}
}
function pk<T>(a:T[]){return a[Math.floor(Math.random()*a.length)]!;}
main().catch(e=>{console.error("FAIL",e);process.exit(1);});
