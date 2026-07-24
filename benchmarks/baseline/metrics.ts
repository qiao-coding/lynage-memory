// ---------------------------------------------------------------------------
// Benchmark metrics calculation
// ---------------------------------------------------------------------------

export interface TurnMetrics {
  turn: number;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
  messageCount: number;
}

export interface GroupResult {
  name: string;
  turns: TurnMetrics[];
  testAnswers: Array<{
    question: string;
    expected: string;
    actual: string;
    correct: boolean;
  }>;
}

export interface ComparisonReport {
  timestamp: string;
  simulationTurns: number;
  testQuestions: number;
  groups: Array<{
    name: string;
    avgPromptTokens: number;
    avgCompletionTokens: number;
    avgElapsedMs: number;
    totalTokens: number;
    accuracy: number; // 0-1
    finalMessageCount: number;
  }>;
  winner: string;
}

/**
 * Compute a comparison report from group results.
 */
export function computeReport(groups: GroupResult[]): ComparisonReport {
  const groupSummaries = groups.map((g) => {
    const avgPrompt = avg(g.turns.map((t) => t.promptTokens));
    const avgCompletion = avg(g.turns.map((t) => t.completionTokens));
    const avgElapsed = avg(g.turns.map((t) => t.elapsedMs));
    const totalTokens = sum(g.turns.map((t) => t.promptTokens + t.completionTokens));
    const accuracy = g.testAnswers.filter((a) => a.correct).length / Math.max(g.testAnswers.length, 1);
    const finalMsg = g.turns[g.turns.length - 1]?.messageCount ?? 0;

    return {
      name: g.name,
      avgPromptTokens: Math.round(avgPrompt),
      avgCompletionTokens: Math.round(avgCompletion),
      avgElapsedMs: Math.round(avgElapsed),
      totalTokens,
      accuracy: Math.round(accuracy * 100) / 100,
      finalMessageCount: finalMsg,
    };
  });

  // Winner: best accuracy; tiebreaker = lowest token count
  const winner = groupSummaries.reduce((best, g) => {
    if (g.accuracy > best.accuracy) return g;
    if (g.accuracy === best.accuracy && g.totalTokens < best.totalTokens) return g;
    return best;
  }, groupSummaries[0]!);

  return {
    timestamp: new Date().toISOString(),
    simulationTurns: groups[0]?.turns.length ?? 0,
    testQuestions: groups[0]?.testAnswers.length ?? 0,
    groups: groupSummaries,
    winner: winner.name,
  };
}

/**
 * Print a formatted comparison table.
 */
export function printReport(report: ComparisonReport): string {
  const lines: string[] = [
    "=".repeat(70),
    `  Lynage Memory Benchmark Report — ${report.simulationTurns} turns, ${report.testQuestions} questions`,
    "=".repeat(70),
    "",
    "┌──────────────────┬──────────┬──────────┬──────────┐",
    "│ Metric           │" +
      report.groups.map((g) => ` ${g.name.padEnd(10)}`).join("│") +
      "│",
    "├──────────────────┼──────────┼──────────┼──────────┤",
  ];

  const metrics: Array<[string, (g: typeof report.groups[0]) => string]> = [
    ["Accuracy", (g) => `${(g.accuracy * 100).toFixed(0)}%`.padEnd(10)],
    ["Avg Prompt Tok", (g) => g.avgPromptTokens.toString().padEnd(10)],
    ["Avg Compl Tok", (g) => g.avgCompletionTokens.toString().padEnd(10)],
    ["Total Tokens", (g) => g.totalTokens.toString().padEnd(10)],
    ["Avg Latency ms", (g) => g.avgElapsedMs.toString().padEnd(10)],
  ];

  for (const [label, fn] of metrics) {
    lines.push(
      `│ ${label.padEnd(16)} │` + report.groups.map((g) => ` ${fn(g)}`).join("│") + "│",
    );
  }

  lines.push("└──────────────────┴──────────┴──────────┴──────────┘");
  lines.push("");
  lines.push(`  🏆 Winner: ${report.winner}`);
  lines.push("");

  return lines.join("\n");
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
