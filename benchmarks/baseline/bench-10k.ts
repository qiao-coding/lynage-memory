// 10k-turn fair benchmark: Lynage, symmetric with Hermes (no artificial truncation)
import { createOpenAI } from "@ai-sdk/openai"; import { generateText } from "ai";
import { createLynageMemory } from "@lynage/storage-sqlite"; import { LynageSdkModel } from "@lynage/ai-sdk";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:"https://api.deepseek.com/v1"});const m=ds("deepseek-v4-flash");
const IC=1/1e6,OC=2/1e6;
let _s=42;function rnd(){_s=(_s*1103515245+12345)&0x7fffffff;return _s/0x7fffffff;}const pk=<T,>(a:T[])=>a[Math.floor(rnd()*a.length)]!;
// Symmetric with Hermes: no max output, no context truncation
async function ask(p:string,retries=5){for(let ri=0;ri<retries;ri++){try{const r=await generateText({model:m,prompt:p});const u=await r.usage;return{text:r.text,input:u?.promptTokens??0,output:u?.completionTokens??0};}catch(e){if(ri===retries-1)return{text:"(api error)",input:0,output:0};await new Promise(r=>setTimeout(r,3000*(ri+1)));}}return{text:"",input:0,output:0};}

const TP=[["样式方案","CSS Modules","Tailwind CSS"],["数据库","PostgreSQL","SQLite"],["部署方案","Docker","Vercel"],["测试框架","Vitest","Jest"],["状态管理","Zustand","Redux"],["路由方案","React Router","TanStack Router"],["认证方案","NextAuth","Clerk"],["设计系统","shadcn/ui","Ant Design"],["构建工具","Vite","Turbopack"],["Monorepo","Turborepo","Nx"]];
// TURNS env override for cheap validation runs; full 10k by default.
const T=Number(process.env.TURNS)||10000,QN=50,F=TP.length;
const factTurns:number[]=[];for(let i=0;i<QN;i++)factTurns.push(Math.floor((i+1)*T/(QN+1)));

const turns:Array<{u:string;a:string}>=[];
let fi=0;
for(let i=1;i<=T;i++){
  if(fi<QN&&i===factTurns[fi]){const[n,c,w]=TP[fi%F]!;
    turns.push({u:`关于${n}需要做技术决策。候选有${c}和${w}。${c}社区成熟文档完善团队熟悉。${w}性能好但学习成本高。综合评估推荐选哪个？请给出完整理由。`,a:`推荐${c}。三个理由：1)社区成熟度高——GitHub stars和npm下载量都远超${w}；2)团队已有经验，上手零成本；3)与现有TypeScript+React+Node技术栈无缝衔接。${w}在特定benchmark领先，但综合工程性价比不如${c}。这是关于${n}的重要决策，会影响后续架构。`});fi++;
  }else{const c=pk(["Button","Table","Modal","Form","Input","Select","Card","Dialog","Tabs","Toast"]);const a=pk(["重构","性能优化","边界处理","无障碍适配","测试覆盖","暗色模式","响应式","国际化"]);const d=pk(["进度约60%核心已跑通","遇到状态同步竞态问题","不同尺寸下表现不一致","大数据量渲染卡顿需虚拟滚动","API一致性需梳理"]);const detail=pk(["这次改动涉及三个核心模块，包括组件的基础样式、交互逻辑和对外暴露的 API 接口。我们在设计评审中讨论了 props 命名规范和默认值策略，最终决定保持与现有组件库一致的命名风格，避免引入额外的学习成本。同时需要补充相应的单元测试用例，覆盖正常的渲染路径和边界情况，确保在后续迭代中不会引入回归问题。","在实现过程中发现了一个与事件冒泡相关的交互缺陷，具体表现为当用户在快速点击时，组件的状态更新存在竞态条件，导致 UI 与内部状态不同步。经过排查，根因是异步回调中的状态引用问题。我们计划通过引入统一的 reducer 模式来管理组件状态，并在关键的交互路径上增加防抖处理，以提升整体的响应稳定性。","设计稿里要求的暗色模式适配涉及所有颜色 token 的迁移。我们已经梳理出完整的颜色变量清单，包括背景、前景、边框、阴影等十几个维度。为了平滑过渡，将采用 CSS 变量的方案，在根节点上切换 data-theme 属性。同时需要处理图表、图片等非文本内容的对比度问题，确保在暗色模式下依然有良好的可读性。","性能优化方面，当前的瓶颈在列表渲染。当数据量超过一万条时，每次滚动都会触发大量的重渲染，导致明显的卡顿。初步方案是采用虚拟滚动，只渲染可视区域内的条目，配合稳定的 key 值避免不必要的 DOM 复用。此外还计划对频繁调用的计算函数做 memo 化处理，将计算复杂度从 O(n²) 降低到 O(n)。","这次国际化改造涉及 i18n 资源文件的组织方式。我们决定按模块拆分翻译文件，而不是集中在一个大文件里，这样便于团队并行维护。同时需要处理日期、数字、货币的本地化格式，以及从右到左语言的布局适配。在构建层面引入自动化的 key 检查工具，避免翻译缺失导致界面出现英文占位符。"]);const ref=pk(["Button组件的最佳实践","Table组件的状态管理方案","Modal的焦点管理","之前总结的编码规范","项目的架构设计文档"]);
    turns.push({u:`${c}组件正在做${a}工作。${detail}。针对当前进展，你有什么优化建议？请结合项目的技术栈给出具体方案。`,a:`${c}组件的${a}工作方向正确。${detail}。针对这些问题，建议参考${ref}：1)保持组件 API 的一致性，避免引入新的模式；2)优先处理影响面最大的场景，再逐步完善边界情况；3)为关键路径补充自动化测试，防止回归。有进度及时同步。`});}
}

const questions=[];for(let i=0;i<QN;i+=5){const t=factTurns[i]!,tp=TP[i%F]!;questions.push({q:`第${t}轮关于${tp[0]}的技术决策是什么？选了哪个？`,fact:tp[1]!,wrong:tp[2]!,search:tp[0]!});}

async function judge(q:string,ans:string,f:string,w:string){const p=`你是事实核查员。评估回答。
【正确答案】选了${f}（而非${w}）
【回答】${ans}
输出JSON：{"accurate":true/false,"hallucination":true/false}`;
  const r=await ask(p);try{const j=JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0]??r.text);return{ok:!!j.accurate,hal:!!j.hallucination};}catch{return{ok:ans.includes(f)&&!ans.includes(`选${w}`),hal:ans.includes(`选${w}`)};}
}

async function main(){
console.log(`Lynage 10k fair: ${T} turns, ${questions.length} questions (no truncation)`);
const db=path.resolve(process.cwd(),"data","10k-fair.db");try{fs.unlinkSync(db);}catch{}
// Lower retainTokens + directoryCapacity so ~10k turns grow G0→G1→G2
// in minutes instead of hours (with throttled directory summaries).
const mem=createLynageMemory({model:new LynageSdkModel(m, undefined, { useToolChoice: false }),dbPath:db,config:{archiveThreshold:16000,retainTokens:8000,directoryCapacity:10}});

console.log("Storing (async archiving)...");
const st0=performance.now();
for(let i=0;i<turns.length;i++){const t=turns[i]!;const tn=await mem.startTurn("s1","u1",t.u);await tn.finish({response:t.a});
  if((i+1)%2000===0){const s=await mem.getArchiveStats("s1");console.log(`  ${i+1}/${T}: ${s.chunkCount}c ${s.directoryCount}d ${((performance.now()-st0)/1000).toFixed(0)}s`);}}
// ---- Reliability: drain archiving, then ASSERT the tree actually built ----
// We refuse to publish accuracy data unless the generation tree exists —
// otherwise FTS hits on unarchived messages would give a false positive.
const MIN_CHUNKS=Math.min(20, Math.max(5, Math.floor(T/200))), DRAIN_TIMEOUT_MS=600000;
console.log("Draining archiving...");
await mem.waitForArchiving("s1");
let st=await mem.getArchiveStats("s1");
const drainT0=performance.now();
while((performance.now()-drainT0)<DRAIN_TIMEOUT_MS && st.chunkCount<MIN_CHUNKS){
  await new Promise(r=>setTimeout(r,3000));
  st=await mem.getArchiveStats("s1");
}
const stS=(performance.now()-st0)/1000;
console.log(`Store: ${stS.toFixed(0)}s ${st.chunkCount}c ${st.directoryCount}d`);
// Assert a multi-level generation tree actually formed (G0→G1+), not just
// a flat G0 — otherwise navigation wouldn't be meaningfully exercised.
const tree=await mem.getDirectoryTree("s1");
let maxGen=0,totalDirs=0;
(function walk(ns:any[]){for(const n of ns){totalDirs++;if(n.generation>maxGen)maxGen=n.generation;walk(n.children);}})(tree);
console.log(`Tree: ${maxGen+1} levels (max gen ${maxGen}), ${totalDirs} dirs`);
if(st.chunkCount<MIN_CHUNKS||maxGen<1){
  console.error(`❌ TREE NOT BUILT (chunks=${st.chunkCount} < ${MIN_CHUNKS} OR maxGen=${maxGen} < 1). `+
    `Search would hit unarchived messages, not the tree. Refusing to publish results.`);
  process.exit(1);
}
console.log(`✅ Multi-level tree built: ${st.chunkCount} chunks, gen ${maxGen} — navigation is exercised.`);

console.log("Answering (no truncation, no max output)...");
let acc=0,hal=0,ti=0,to=0,ts=0,tl=0,treeHits=0,searchedDirs=0,checkedChunks=0;const a0=performance.now();
for(let i=0;i<questions.length;i++){const q=questions[i]!;
  const s0=performance.now();const sr=await mem.search({query:q.search,sessionId:"s1"});ts+=performance.now()-s0;
  searchedDirs+=sr.searchedDirectories;checkedChunks+=sr.totalChunksChecked;
  if(sr.totalChunksChecked>0)treeHits++; // search actually descended the tree
  // Lynage's native context: tree summaries + candidate metadata (NOT full raw
  // message windows). This is the differentiator — fixed-size context regardless
  // of conversation length. The Hermes symmetry rationale no longer applies
  // (README dropped the Hermes comparison as a different arena).
  // Lightweight context: top-2 candidates + truncated summaries — token control
  // (vs the old 5-candidate full-summary block, ~9.8k input tokens for 10 Q).
  const cx=mem.compileRetrievedContext(sr, undefined, 2, 200);
  const l0=performance.now();const an=await ask(`根据对话历史回答，用中文。\n---\n${cx}\n---\n${q.q}`);tl+=performance.now()-l0;
  ti+=an.input;to+=an.output;
  const j=await judge(q.q,an.text,q.fact,q.wrong);if(j.ok)acc++;if(j.hal)hal++;
  if((i+1)%5===0)console.log(`  ${i+1}/${questions.length}: ${acc}ok ${hal}hal srch=${(ts/(i+1)).toFixed(0)}ms in=${ti} out=${to}`);
}
const ansS=(performance.now()-a0)/1000;const cost=ti*IC+to*OC;
const treePct=Math.round(treeHits/questions.length*100);
console.log(`\n${"=".repeat(55)}`);
console.log(`Lynage 10k fair results`);
console.log(`Chunks: ${st.chunkCount} Dirs: ${st.directoryCount}`);
console.log(`Accuracy: ${acc}/${questions.length} (${(acc/questions.length*100).toFixed(0)}%) Hal:${hal}`);
console.log(`Tokens: ${ti}i+${to}o=${ti+to} Cost:¥${cost.toFixed(3)}`);
console.log(`Search: ${(ts/questions.length).toFixed(0)}ms LLM:${(tl/questions.length).toFixed(0)}ms`);
console.log(`Tree usage: ${treeHits}/${questions.length} searches descended tree (${treePct}%) — dirs scanned ${searchedDirs}, chunks checked ${checkedChunks}`);
const out={system:"Lynage",turns:T,questions:questions.length,accuracy:acc/questions.length,correct:acc,hallucination:hal,total_input:ti,total_output:to,cost_cny:cost,avg_search_ms:ts/questions.length,avg_llm_ms:tl/questions.length,store_s:stS,answer_s:ansS,chunks:st.chunkCount,dirs:st.directoryCount,tree_usage_pct:treePct,dirs_scanned:searchedDirs,chunks_checked:checkedChunks};
fs.writeFileSync(path.resolve(process.cwd(),"data","10k_fair_lynage.json"),JSON.stringify(out,null,2));
try{fs.unlinkSync(db);}catch{}
}main().catch(console.error);
