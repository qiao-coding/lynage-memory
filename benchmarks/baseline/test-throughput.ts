// Measure archive throughput with new config (fetchLimit 2000, retainTokens 8000)
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { LynageSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

const T=Number(process.env.TURNS)||1000; // turns ≈ 2*T messages
const turns:Array<{u:string;a:string}>=[];
const pk=<T,>(a:T[])=>a[Math.floor(Math.random()*a.length)]!;
for(let i=0;i<T;i++){const c=pk(["Button","Table","Modal","Form","Input"]);const a=pk(["重构","性能优化","国际化","暗色模式","响应式"]);
  turns.push({u:`${c}组件正在做${a}工作。这次改动涉及组件的基础样式、交互逻辑和对外暴露的API接口。请给出优化建议。`,
    a:`${c}组件的${a}方向正确。建议参考Table组件的状态管理方案：1)保持API一致性；2)补充自动化测试。`});}

async function main(){
  const db=path.resolve(process.cwd(),"data","throughput.db");try{fs.unlinkSync(db);}catch{}
  const mem=createLynageMemory({model:new LynageSdkModel(m, undefined, { useToolChoice: false }),dbPath:db,config:{archiveThreshold:16000,retainTokens:8000,directoryCapacity:10,archiveFetchLimit:2000}});
  const t0=performance.now();
  for(const t of turns){const tn=await mem.startTurn("s1","u1",t.u);await tn.finish({response:t.a});}
  const t1=performance.now();
  await mem.waitForArchiving("s1");
  const st=await mem.getArchiveStats("s1");
  const t2=performance.now();
  console.log(`TURNS=${T}: store loop=${((t1-t0)/1000).toFixed(0)}s drain=${((t2-t1)/1000).toFixed(0)}s TOTAL=${((t2-t0)/1000).toFixed(0)}s → ${st.chunkCount} chunks`);
  try{fs.unlinkSync(db);}catch{}
}
main().catch(e=>{console.error("FAIL",e);process.exit(1);});
