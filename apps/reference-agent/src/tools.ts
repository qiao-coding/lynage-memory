// ---------------------------------------------------------------------------
// Test tools for the Reference Agent
// Simple tools to exercise tool calling in the baseline.
// ---------------------------------------------------------------------------

import { tool } from "ai";
import { z } from "zod";

export const getCurrentTime = tool({
  description: "Get the current date and time in ISO 8601 format.",
  parameters: z.object({}),
  execute: async () => new Date().toISOString(),
});

export const calculate = tool({
  description:
    "Evaluate a simple arithmetic expression. Supports +, -, *, /, and parentheses.",
  parameters: z.object({
    expression: z
      .string()
      .describe("Arithmetic expression, e.g. '2 + 3 * 4'"),
  }),
  execute: async ({ expression }) => {
    const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
    if (sanitized !== expression.replace(/\s/g, "")) {
      return "Error: expression contains invalid characters.";
    }
    try {
      return String(Function(`"use strict"; return (${sanitized})`)());
    } catch {
      return "Error: could not evaluate expression.";
    }
  },
});

export const readFile = tool({
  description: "Simulate reading a file. Returns placeholder content.",
  parameters: z.object({
    path: z.string().describe("File path to read"),
  }),
  execute: async ({ path }) => {
    const filename = path.split("/").pop() ?? path;
    return `[Simulated content of ${filename}] This is placeholder data.`;
  },
});

export const tools = { getCurrentTime, calculate, readFile };
