// ---------------------------------------------------------------------------
// Shared LLM-as-judge for benchmark evaluation
// Used by both LongMemEval and LoCoMo runners.
// ---------------------------------------------------------------------------

import type { LanguageModelV1 } from "ai";
import { generateText } from "ai";

export interface JudgeResult {
  accurate: boolean;
  hallucination: boolean;
  reasoning: string;
}

/**
 * Strict factual judge: compare student answer against ground truth.
 * Returns accurate=true only when key facts match; hallucination=true
 * when the answer invents claims not in the ground truth.
 */
export async function judgeAnswer(
  model: LanguageModelV1,
  question: string,
  expected: string,
  actual: string,
): Promise<JudgeResult> {
  const prompt = `You are a strict fact checker evaluating a memory system's answer.

Question: "${question}"

Ground truth (correct answer): "${expected}"

System's answer: "${actual}"

Evaluate:
- accurate: Does the system's answer convey the SAME KEY FACTS as the ground truth?
  Minor wording differences are OK, but missing or wrong key facts are NOT.
  If the system says "I don't know" or "not mentioned", that is INACCURATE (unless the ground truth is also "not mentioned").
- hallucination: Does the system's answer INVENT facts that contradict or are absent from the ground truth?

Reply with ONLY a JSON object (no markdown, no backticks):
{"accurate": true/false, "hallucination": true/false, "reasoning": "one sentence explaining your judgment"}`;

  const result = await generateText({ model, prompt, maxTokens: 200 });

  try {
    // Extract JSON from response (handle possible markdown wrapping)
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        accurate: !!parsed.accurate,
        hallucination: !!parsed.hallucination,
        reasoning: parsed.reasoning || "",
      };
    }
  } catch {
    // Fallback: simple string matching
  }

  // Fallback heuristic
  const actualLower = actual.toLowerCase();
  const hasAnswer = expected.toLowerCase().split(" ").filter(w => w.length > 3).every(w =>
    actualLower.includes(w.toLowerCase())
  );
  return {
    accurate: hasAnswer,
    hallucination: false,
    reasoning: "fallback keyword match",
  };
}

/**
 * Batch judge with concurrency limit.
 */
export async function judgeBatch(
  model: LanguageModelV1,
  items: Array<{ question: string; expected: string; actual: string }>,
  concurrency = 4,
): Promise<JudgeResult[]> {
  const results: JudgeResult[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(item => judgeAnswer(model, item.question, item.expected, item.actual))
    );
    results.push(...batchResults);
  }
  return results;
}
