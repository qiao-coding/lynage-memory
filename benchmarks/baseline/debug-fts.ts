// Debug: does FTS over chunk summaries find the decision chunk?
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

// ~40 turns: 20 generic + interleaved style/DB decisions
const turns:Array<{u:string;a:string}>=[];
turns.push({u:"关于样式方案需要做技术决策。候选有CSS Modules和Tailwind CSS。CSS Modules社区成熟文档完善团队熟悉。Tailwind CSS性能好但学习成本高。综合评估推荐选哪个？请给出完整理由。",a:"推荐CSS Modules。三个理由：1)社区成熟度高；2)团队已有经验；3)与现有技术栈无缝衔接。这是关于样式方案的重要决策，会影响后续架构。"});
turns.push({u:"关于数据库需要做技术决策。候选有PostgreSQL和SQLite。PostgreSQL社区成熟文档完善团队熟悉。SQLite性能好但学习成本高。综合评估推荐选哪个？",a:"推荐PostgreSQL。三个理由：1)社区成熟度高；2)团队已有经验；3)与现有技术栈无缝衔接。这是关于数据库的重要决策。"});
for(let i=0;i<38;i++){const c=["Button","Table","Modal","Form","Input"][i%5]!;turns.push({u:`${c}组件正在做性能优化。这次改动涉及组件的基础样式、交互逻辑和对外暴露的API接口。请给出优化建议。`,a:`${c}组件的性能优化方向正确。建议参考：1)保持组件API一致性；2)优先处理影响面大的场景；3)补充自动化测试。`});}

async function main(){
  const db=path.resolve(process.cwd(),"data","debug-fts.db");try{fs.unlinkSync(db);}catch{}
  const mem=createLynageMemory({model:new AiSdkModel(m, undefined, { useToolChoice: false }),dbPath:db,config:{archiveThreshold:2000,retainTokens:800,directoryCapacity:10}});
  for(const t of turns){const tn=await mem.startTurn("s1","u1",t.u);await tn.finish({response:t.a});}
  await mem.waitForArchiving("s1"); await mem.waitForArchiving("s1");
  const chunks = await mem.store.listChunks("s1");
  console.log(`\n${chunks.length} chunks:`);
  for(const c of chunks){console.log(`  [${c.id}] ${c.summary.slice(0,60)} | kw=${c.keywords.slice(0,3).join(",")} | conc=${(c.conclusions??[]).slice(0,2).join(";").slice(0,50)}`);}
  for(const q of ["样式方案","数据库","Button"]){
    const sr = await mem.search({query:q,sessionId:"s1"});
    console.log(`\n=== search "${q}" → status=${sr.status} candidates=${sr.candidates.length} ===`);
    for(const cand of sr.candidates.slice(0,4)){console.log(`  ${cand.contextId}: "${cand.summary.slice(0,50)}" rel=${cand.relevance.toFixed(2)}`);}
  }
  try{fs.unlinkSync(db);}catch{}
}
main().catch(e=>{console.error("FAIL",e);process.exit(1);});
