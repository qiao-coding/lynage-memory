// ---------------------------------------------------------------------------
// Reference Agent CLI (M0)
// Usage: pnpm dev "your prompt here"
// ---------------------------------------------------------------------------

import { createOpenAI } from "@ai-sdk/openai";
import { runAgent } from "./agent.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY environment variable is not set.");
  console.error("Copy .env.example to .env and fill in your key.");
  process.exit(1);
}

const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
const model = openai("gpt-4o-mini");

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: pnpm dev <prompt>");
    console.log("  e.g. pnpm dev \"What is the capital of France?\"");
    console.log("  e.g. pnpm dev \"Calculate 15 * 23 + 7\"");
    console.log("  e.g. pnpm dev \"Read the file config.json\"");
    process.exit(0);
  }

  const prompt = args.join(" ");
  const sessionId = process.env.LYNAGE_SESSION ?? "m0-baseline";

  console.log(`\n🤖 Lynage Reference Agent (M0 Baseline)`);
  console.log(`Session: ${sessionId}`);
  console.log(`Prompt: ${prompt}`);
  console.log("-".repeat(50));

  const startTime = performance.now();
  const result = await runAgent({
    model,
    prompt,
    sessionId,
  });
  const elapsed = (performance.now() - startTime).toFixed(0);

  console.log(`\n📝 Response:\n${result.text}`);
  console.log("-".repeat(50));
  console.log(
    `⏱️ ${elapsed}ms | 🔧 ${result.toolCalls} tool calls | 💬 ${result.messageCount} total messages`,
  );
}

main().catch(console.error);
