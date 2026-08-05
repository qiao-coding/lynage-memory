// ---------------------------------------------------------------------------
// Generate Promptfoo test cases from LongMemEval dataset
//
// Usage: pnpm tsx benchmarks/longmemeval/generate-tests.ts [--limit N]
// Output: benchmarks/longmemeval/tests-generated.json
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname || __dirname, "..", "data");
const OUTPUT_DIR = path.resolve(import.meta.dirname || __dirname);
const DATASET_PATH = path.join(DATA_DIR, "longmemeval_s.json");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "tests-generated.json");

interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: SessionTurn[][];
  answer_session_ids: string[];
}

interface PromptfooTestCase {
  vars: Record<string, string>;
  assert: Array<{ type: string; value: string }>;
  meta: Record<string, string>;
}

function main() {
  const limit = Number(process.env.LIMIT) || Infinity;

  if (!fs.existsSync(DATASET_PATH)) {
    console.error(`❌ Dataset not found: ${DATASET_PATH}`);
    console.error("   Run: npx tsx benchmarks/data/fetch-datasets.ts");
    process.exit(1);
  }

  const raw = fs.readFileSync(DATASET_PATH, "utf-8");
  const dataset: LongMemEvalInstance[] = JSON.parse(raw);

  const tests: PromptfooTestCase[] = [];
  const count = Math.min(limit, dataset.length);

  for (let i = 0; i < count; i++) {
    const inst = dataset[i]!;
    const isAbstention = inst.question_id.endsWith("_abs");

    tests.push({
      vars: {
        question_id: inst.question_id,
        query: inst.question,
        expected: inst.answer,
        category: inst.question_type,
        is_abstention: String(isAbstention),
      },
      assert: [
        {
          type: "llm-rubric",
          value: isAbstention
            ? `这是一个弃权问题（答案应为"不知道"或"对话历史中没有相关信息"）。评估回答是否正确表示不知道。如果回答尝试给出具体答案但不存在 → 不通过。如果回答正确表示不知道 → 通过。`
            : `评估回答是否与参考答案一致。参考答案: "${inst.answer}"。回答应包含相同的关键事实。如果回答称不知道但答案明确存在于对话历史中 → 不通过。不能编造不存在的事实。`,
        },
      ],
      meta: {
        question_id: inst.question_id,
        category: inst.question_type,
        answer_session_ids: inst.answer_session_ids.join(","),
        is_abstention: String(isAbstention),
      },
    });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(tests, null, 2));
  console.log(`✅ Generated ${tests.length} test cases → ${OUTPUT_PATH}`);

  // Category breakdown
  const cats: Record<string, number> = {};
  for (const t of tests) {
    const cat = t.meta.category;
    cats[cat] = (cats[cat] || 0) + 1;
  }
  console.log("\n📊 Category distribution:");
  for (const [cat, n] of Object.entries(cats)) {
    console.log(`   ${cat}: ${n}`);
  }
}

main();
