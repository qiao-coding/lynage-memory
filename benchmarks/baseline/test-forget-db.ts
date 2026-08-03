// Reuse the fully-archived forget.db (87 chunks) to test search + rerank
// WITHOUT re-archiving. Loads DB, runs the 10 forget questions, reports
// whether each decision chunk is found + ranked.
import { createOpenAI } from "@ai-sdk/openai";
import { createLynageMemory } from "@lynage/storage-sqlite";
import { AiSdkModel } from "@lynage/ai-sdk";
import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
import fs from "node:fs";
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

// Same FACTS as bench-forget.ts
const FACTS:[string,string,string,string,string,string][]=[
  ["样式方案","CSS Modules","Tailwind CSS","styled-components","CSS Modules 在大型项目里样式碎片化严重","主题通过 ThemeProvider 从根组件注入"],
  ["数据库","PostgreSQL","SQLite","MongoDB","PostgreSQL 的关系型 schema 不合适","部署在 Atlas M10 实例"],
  ["部署方案","Docker","自托管服务器","Vercel","Docker 需要团队自己维护运维","API 用 Functions 而非 Edge Functions"],
  ["状态管理","Zustand","MobX","Redux Toolkit","Zustand 的异步流处理能力弱","用 createSlice 定义 reducer"],
  ["认证方案","NextAuth","Auth0","Supabase Auth","NextAuth 的自定义用户表支持有限","邮箱验证 + JWT"],
  ["Monorepo","Turborepo","Lerna","Nx","Turborepo 的跨包类型检查依赖图不够细","用 affected 命令做增量构建"],
  ["测试框架","Vitest","Jest","Cypress 组件测试","Vitest 主要覆盖单元层","用组件测试而非 e2e"],
  ["路由方案","App Router","React Router","TanStack Router","App Router 的 search params 没有类型安全","search params 类型安全是核心理由"],
  ["构建工具","Vite","Webpack","esbuild","Vite 的打包控制粒度不够细","用自定义 plugin 处理 CSS 提取"],
  ["设计系统","shadcn/ui","自建组件库","Ant Design","shadcn/ui 缺少企业级复杂组件","用 ConfigProvider 定制设计 token"],
];
const questions=FACTS.map(([n,mainstream,tried,chosen])=>({
  q:`关于${n}的事，我记不太清了。我们当时是怎么定的？一开始是不是用了别的方案？中间是不是换了什么？最后定的是哪个？`,
  fact:chosen, wrong:[mainstream,tried],
}));

async function main(){
  const dbPath=path.resolve(process.cwd(),"data","forget.db");
  const mem=createLynageMemory({model:new AiSdkModel(m, undefined, { useToolChoice: false }),dbPath:dbPath,config:{archiveThreshold:8000,retainTokens:2000,directoryCapacity:10}});
  const st=await mem.getArchiveStats("s1");
  console.log(`DB: ${st.chunkCount} chunks, ${st.messageCount} messages`);

  for(let i=0;i<questions.length;i++){
    const q=questions[i]!;
    const t0=performance.now();
    const sr=await mem.search({query:q.q,sessionId:"s1"});
    const ms=Math.round(performance.now()-t0);
    console.log(`\nQ${i+1} [${q.fact}] (${ms}ms, ${sr.candidates.length} cands):`);
    for(const cand of sr.candidates.slice(0,5)){
      const hasFact=cand.summary.includes(q.fact);
      const hasWrong=q.wrong.filter(w=>cand.summary.includes(w)).join(",");
      console.log(`  [${cand.contextId}] rel=${cand.relevance.toFixed(2)} "${cand.summary.slice(0,50)}" ${hasFact?"✅FACT":hasWrong?"⚠️WRONG":"—"}`);
    }
  }
  // count facts found in top-3
  console.log("\n=== summary ===");
  process.exit(0);
}
main().catch(e=>{console.error("FAIL",e);process.exit(1);});
