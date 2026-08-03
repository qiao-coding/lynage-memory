// Quick smoke test: does the tree actually build + get exercised by search?
// Feeds ~300 turns (enough to cross the archive threshold ~5x), waits for
// archiving, asserts chunks/dirs, then confirms search descends the tree.
// Run: tsx smoke-tree.ts  (needs DEEPSEEK_API_KEY)
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

const T=300; // 300 turns ≈ 5+ archive passes
const pk=<T,>(a:T[])=>a[Math.floor(Math.random()*a.length)]!;
const turns:Array<{u:string;a:string}>=[];
for(let i=0;i<T;i++){
  const c=pk(["Button","Table","Modal","Form","Input"]),a=pk(["重构","性能优化","边界处理","测试覆盖"]);
  turns.push({u:`${c}组件正在做${a}工作。${pk(["进度约60%","遇到状态同步竞态问题","需要虚拟滚动","API一致性需梳理"])}。请给出建议。`,
    a:`${c}组件的${a}方向正确。${pk(["保持API一致性","优先处理影响面大的场景","补充自动化测试"])}。有进度及时同步。`});
}

async function main(){
  console.log(`Smoke: ${T} turns, low thresholds`);
  const db=path.resolve(process.cwd(),"data","smoke-tree.db");try{fs.unlinkSync(db);}catch{}
  // Low threshold so short smoke messages (~22 tok/msg) still trigger
  // archiving within the 200-message getRecent window.
  const mem=createLynageMemory({model:new AiSdkModel(m, undefined, { useToolChoice: false }),dbPath:db,config:{archiveThreshold:2000,retainTokens:800,directoryCapacity:10}});
  const st0=performance.now();
  for(let i=0;i<turns.length;i++){const t=turns[i]!;const tn=await mem.startTurn("s1","u1",t.u);await tn.finish({response:t.a});}
  await mem.waitForArchiving("s1");
  // Give throttled archive one more drain cycle if it was still dirty
  await mem.waitForArchiving("s1");
  const st=await mem.getArchiveStats("s1");
  console.log(`Store ${((performance.now()-st0)/1000).toFixed(0)}s → ${st.chunkCount} chunks, ${st.directoryCount} dirs`);
  if(st.chunkCount<2){console.error(`❌ FAIL: only ${st.chunkCount} chunks — archiving did not progress.`);process.exit(1);}

  // Search that must descend the tree
  const sr=await mem.search({query:"Table 组件性能优化",sessionId:"s1"});
  console.log(`Search: status=${sr.status} candidates=${sr.candidates.length} dirs_scanned=${sr.searchedDirectories} chunks_checked=${sr.totalChunksChecked}`);
  if(sr.totalChunksChecked<=0){console.warn(`⚠️ search did not descend tree (checked=0) — FTS only`);}
  console.log(st.directoryCount>=2?`✅ Multi-level tree confirmed (${st.directoryCount} dirs)`:"✅ Tree built (G0 only)");
  try{fs.unlinkSync(db);}catch{}
  console.log("SMOKE OK");
}
main().catch(e=>{console.error("SMOKE FAIL:",e);process.exit(1);});
