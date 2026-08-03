// Measure: what actually dominates archiving time?
// 1. Single AI call latency (generateObject structured output)
// 2. Then extrapolate: 10k turns → N chunks → total archive time
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { ChunkSummarySchema } from "@lynage/core";
import fs from "node:fs"; import path from "node:path";
const ep=path.resolve(process.cwd(),"..","..",".env");
if(fs.existsSync(ep))for(const l of fs.readFileSync(ep,"utf-8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;if(!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const ds=createOpenAI({apiKey:process.env.DEEPSEEK_API_KEY!,baseURL:(process.env.DEEPSEEK_BASE_URL||"https://api.deepseek.com/v1")});const m=ds(process.env.DEEPSEEK_MODEL||"deepseek-v4-flash");

const schema=ChunkSummarySchema;
// ~8000-token input (mirrors a real archive batch)
const batch = Array.from({length:30},(_,i)=>`[${i%2===0?"user":"assistant"}] Button组件正在做性能优化。${"这次改动涉及三个核心模块，包括组件的基础样式、交互逻辑和对外暴露的 API 接口。我们在设计评审中讨论了 props 命名规范和默认值策略，最终决定保持与现有组件库一致的命名风格。".repeat(3)}`).join("\n");

async function timeOnce(tag:string,fn:()=>Promise<unknown>){const t0=performance.now();await fn();console.log(`${tag}: ${(performance.now()-t0).toFixed(0)}ms`);}

async function main(){
  // generateObject (structured, what archiving uses)
  await timeOnce("generateObject (8000-tok input)",()=>generateObject({model:m,schema,prompt:`Summarize:\n${batch}`}));
  // generateText (plain)
  await timeOnce("generateText  (8000-tok input)",()=>generateText({model:m,prompt:`Summarize:\n${batch}`}));
  // 4-way parallel generateObject (archiving concurrency)
  const t0=performance.now();
  await Promise.all(Array.from({length:4},()=>generateObject({model:m,schema,prompt:`Summarize:\n${batch}`})));
  console.log(`4× parallel generateObject: ${(performance.now()-t0).toFixed(0)}ms`);
}
main().catch(e=>{console.error("ERR",e);process.exit(1);});
