// Time each search() component to find the 5s culprit
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

async function main(){
  const db=path.resolve(process.cwd(),"data","time-search.db");try{fs.unlinkSync(db);}catch{}
  const mem=createLynageMemory({model:new AiSdkModel(m, undefined, { useToolChoice: false }),dbPath:db,config:{archiveThreshold:2000,retainTokens:800,directoryCapacity:10}});
  // Populate 2000 turns (fast messages, low threshold)
  const pk=<T,>(a:T[])=>a[Math.floor(Math.random()*a.length)]!;
  const factTurns=new Set([400,800,1200,1600]);
  for(let i=1;i<=2000;i++){
    let u,a;
    if(factTurns.has(i)){u="关于样式方案需要做技术决策。候选有CSS Modules和Tailwind CSS。综合评估推荐选哪个？请给出完整理由。";a="推荐CSS Modules。这是关于样式方案的重要决策。";}
    else{const c=pk(["Button","Table","Modal","Form","Input"]);u=`${c}组件正在做性能优化。这次改动涉及组件的基础样式、交互逻辑和对外暴露的API接口。请给出优化建议。`;a=`${c}组件的性能优化方向正确。建议保持API一致性。`;}
    const tn=await mem.startTurn("s1","u1",u);await tn.finish({response:a});
  }
  await mem.waitForArchiving("s1"); await mem.waitForArchiving("s1");
  const st=await mem.getArchiveStats("s1");
  console.log(`${st.chunkCount} chunks, ${st.messageCount} messages`);

  const store=mem.store;
  const queries=["样式方案","数据库","Button","Table"];
  for(const q of queries){
    let t0=performance.now();
    const cids=await store.searchChunks(q,"s1");
    const t1=performance.now();
    const msgs=await store.searchMessages(q,"s1");
    const t2=performance.now();
    const all=await store.listChunks("s1");
    const t3=performance.now();
    const byIds=await store.getChunksByIds(cids.slice(0,5));
    const t4=performance.now();
    console.log(`"${q}": searchChunks=${(t1-t0).toFixed(1)}ms(${cids.length}) searchMessages=${(t2-t1).toFixed(1)}ms(${msgs.length}) listChunks=${(t3-t2).toFixed(1)}ms(${all.length}) getChunksByIds=${(t4-t3).toFixed(1)}ms`);
  }
  // Full search timing
  for(const q of ["样式方案","Button"]){
    const t0=performance.now();
    const sr=await mem.search({query:q,sessionId:"s1"});
    console.log(`FULL search "${q}": ${(performance.now()-t0).toFixed(0)}ms status=${sr.status}`);
  }
  try{fs.unlinkSync(db);}catch{}
}
main().catch(e=>{console.error("FAIL",e);process.exit(1);});
