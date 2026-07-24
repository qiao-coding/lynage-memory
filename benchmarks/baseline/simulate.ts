// ---------------------------------------------------------------------------
// Conversation Simulator — generates realistic long-running project dialogue
// ---------------------------------------------------------------------------

export interface SimulatedMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
}

export interface SimulationScript {
  turns: Array<{
    user: string;
    assistant: string;
    toolCalls?: Array<{
      name: string;
      args: string;
      result: string;
    }>;
  }>;
  /** Ground-truth facts established during the conversation */
  facts: Array<{
    turn: number;
    description: string;
    context: string;
  }>;
  /** Questions to ask after the conversation, with expected answers */
  testQuestions: Array<{
    question: string;
    expectedAnswer: string;
    /** Which fact(s) this question targets */
    factIndices: number[];
  }>;
}

/**
 * Generate a simulated conversation about a software project
 * with design decisions, pivots, and abandoned approaches.
 */
export function generateSimulation(): SimulationScript {
  const turns: SimulationScript["turns"] = [];
  const facts: SimulationScript["facts"] = [];
  const testQuestions: SimulationScript["testQuestions"] = [];

  // Phase 1: Initial setup (turns 1-20)
  for (let i = 1; i <= 20; i++) {
    if (i === 1) {
      turns.push({
        user: "Let's build a new component library. What tech stack should we use?",
        assistant: "We should consider React + TypeScript. For styling, we have options: CSS Modules, Tailwind, or styled-components. What's your preference?",
      });
    } else if (i === 3) {
      turns.push({
        user: "I'm leaning towards CSS Modules. Keep it simple.",
        assistant: "Good choice. CSS Modules gives us scoped styles without runtime overhead. We'll need PostCSS for processing.",
      });
      facts.push({
        turn: 3,
        description: "Initial choice: CSS Modules for styling",
        context: "CSS Modules chosen over Tailwind and styled-components for simplicity and zero runtime cost.",
      });
    } else if (i === 8) {
      turns.push({
        user: "Actually, CSS Modules is getting unwieldy. Can we switch to Tailwind?",
        assistant: "That's a significant change. Tailwind would give us utility-first development, but we'd need to refactor all existing components. It'll take about 3-4 days.",
      });
      facts.push({
        turn: 8,
        description: "Pivot: considering switching from CSS Modules to Tailwind",
        context: "CSS Modules found unwieldy; evaluating Tailwind as replacement.",
      });
    } else if (i === 12) {
      turns.push({
        user: "Let's do the Tailwind migration. Better to do it early.",
        assistant: "OK, I'll start the migration. We'll convert Component A first as a test, then roll out to the rest.",
      });
      facts.push({
        turn: 12,
        description: "Decision: migrated to Tailwind CSS",
        context: "Full migration from CSS Modules to Tailwind approved and started.",
      });
    } else if (i === 18) {
      turns.push({
        user: "How's the Tailwind migration going?",
        assistant: "Going well. 80% of components converted. The utility classes are much faster to work with once you get used to the syntax.",
      });
    } else {
      turns.push({
        user: `Development update for milestone ${Math.ceil(i / 5)}: what's the status?`,
        assistant: `Working on component set ${Math.ceil(i / 5)}. Fixed ${i * 3} bugs. Added ${i} new components. Documentation at ${Math.round(i * 0.8)}% coverage.`,
        toolCalls:
          i % 4 === 0
            ? [{ name: "get_status", args: JSON.stringify({ milestone: Math.ceil(i / 5) }), result: JSON.stringify({ components: i * 2, bugs: i * 3 }) }]
            : undefined,
      });
    }
  }

  // Phase 2: Architecture pivot (turns 21-40)
  for (let i = 21; i <= 40; i++) {
    if (i === 21) {
      turns.push({
        user: "The team is growing. Should we split this into a monorepo?",
        assistant: "That's an interesting idea. We could use Turborepo to manage multiple packages. But it adds complexity to the build pipeline.",
      });
    } else if (i === 25) {
      turns.push({
        user: "Let's NOT do the monorepo split. It's premature optimization.",
        assistant: "Agreed. Premature optimization is the root of all evil. We'll revisit when we have 5+ distinct packages.",
      });
      facts.push({
        turn: 25,
        description: "Decision: rejected monorepo split as premature optimization",
        context: "Monorepo split considered but rejected. Will revisit at 5+ packages.",
      });
    } else if (i === 30) {
      turns.push({
        user: "We need to add a CLI tool. How should we structure it?",
        assistant: "Options: 1) Separate package in current repo, 2) New repo, 3) Monorepo with workspaces. Given our earlier decision, option 1 keeps it simple.",
      });
    } else if (i === 35) {
      turns.push({
        user: "The CLI is getting big. Remember that monorepo discussion? Let's reconsider.",
        assistant: "Good point. Since turn 25 we've added 3 packages. We're now at the threshold where monorepo makes sense. Let's plan the migration.",
      });
      facts.push({
        turn: 35,
        description: "Reversal: monorepo decision revisited, now approved",
        context: "Previously rejected monorepo (turn 25) now approved due to team growth (3+ packages).",
      });
    } else {
      turns.push({
        user: `Update on package ${String.fromCharCode(65 + ((i - 21) % 5))}: ready yet?`,
        assistant: `Package ${String.fromCharCode(65 + ((i - 21) % 5))} is at ${(i - 20) * 5}% completion. ${i % 3 === 0 ? "Found a bug in the build config." : "On track."}`,
        toolCalls:
          i % 5 === 0
            ? [{ name: "check_build", args: JSON.stringify({ package: String.fromCharCode(65 + ((i - 21) % 5)) }), result: "BUILD OK" }]
            : undefined,
      });
    }
  }

  // Phase 3: Design system debate (turns 41-60)
  for (let i = 41; i <= 60; i++) {
    if (i === 41) {
      turns.push({
        user: "We should create a design system. What approach?",
        assistant: "We could build our own from scratch, or adapt an existing one like Radix UI or shadcn/ui. Building from scratch gives full control but takes months.",
      });
    } else if (i === 45) {
      turns.push({
        user: "Let's go with shadcn/ui. It's customizable enough.",
        assistant: "Great choice. shadcn/ui gives us accessible primitives that we can style with our Tailwind setup. Much faster than building from scratch.",
      });
      facts.push({
        turn: 45,
        description: "Decision: adopted shadcn/ui for design system",
        context: "Chose shadcn/ui over Radix UI and custom build. Leverages existing Tailwind setup.",
      });
    } else {
      turns.push({
        user: `Design system progress update for component ${i - 40}?`,
        assistant: `Component ${i - 40} integrated. Following shadcn/ui patterns. Consistent with our Tailwind theme configuration.`,
      });
    }
  }

  // Generate test questions
  testQuestions.push(
    {
      question: "What styling approach did we initially choose and why did we change it?",
      expectedAnswer: "Initially chose CSS Modules, then switched to Tailwind because CSS Modules became unwieldy.",
      factIndices: [0, 1, 2],
    },
    {
      question: "Did we decide to use a monorepo? What was the reasoning?",
      expectedAnswer: "Initially rejected monorepo as premature optimization (turn 25), then later adopted it when the team grew to 3+ packages (turn 35).",
      factIndices: [3, 4],
    },
    {
      question: "What design system did we choose and why?",
      expectedAnswer: "Chose shadcn/ui because it's customizable and works with our existing Tailwind setup.",
      factIndices: [5],
    },
    {
      question: "What was the first approach we considered for styling?",
      expectedAnswer: "CSS Modules was the first approach, chosen for simplicity and zero runtime overhead.",
      factIndices: [0],
    },
    {
      question: "Why did we abandon the monorepo idea initially?",
      expectedAnswer: "Because it was premature optimization — the team wasn't big enough yet.",
      factIndices: [3],
    },
  );

  return { turns, facts, testQuestions };
}
