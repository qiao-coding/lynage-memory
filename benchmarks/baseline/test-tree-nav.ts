// Validate FTS tree navigation: searchDirectories + drillDown speed + correctness
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { LynageSdkModel } from "@lynage/ai-sdk";
import path from "node:path";
import fs from "node:fs";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

async function main(){
  const dbPath=path.resolve(process.cwd(),"data","forget.db");
  const mem=createLynageMemory({model:new LynageSdkModel(m, undefined, { useToolChoice: false }),dbPath:dbPath,config:{archiveThreshold:16000,retainTokens:8000,directoryCapacity:10}});
  const store=mem.store;

  // 1. searchDirectories correctness
  for(const q of ["数据库","状态管理","构建工具"]){
    const t0=performance.now();
    const dirs=await store.searchDirectories(q,"s1");
    console.log(`searchDirectories("${q}"): ${(performance.now()-t0).toFixed(1)}ms → ${dirs.length} dirs`);
    for(const id of dirs.slice(0,2)){
      const d=await store.getDirectory(id);
      console.log(`   [${id.slice(0,8)}] gen=${d?.generation} "${d?.overallContent.slice(0,50)}"`);
    }
  }

  // 2. Full search timing — a query that flat FTS may miss → tree fallback
  //    (use a vague phrasing; measure total search time)
  for(const q of ["关于数据库的事，我们当时是怎么定的？","状态管理的决策过程"]){
    const t0=performance.now();
    const sr=await mem.search({query:q,sessionId:"s1"});
    console.log(`\nsearch("${q}"): ${(performance.now()-t0).toFixed(0)}ms, ${sr.candidates.length} cands, dirsScanned=${sr.searchedDirectories}, chunksChecked=${sr.totalChunksChecked}`);
  }
}
main().catch(e=>{console.error("FAIL",e);process.exit(1);});
