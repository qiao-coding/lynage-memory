#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI entry point for @lynage/mcp
//
// Usage:
//   npx lynage-memory mcp --db ./data/lynage.db --provider deepseek --model deepseek-v4-flash
//   npx lynage-memory serve --db ./data/lynage.db --port 4318 --provider openai --model gpt-4o-mini
//
// Claude Code MCP config:
//   {
//     "mcpServers": {
//       "lynage": {
//         "command": "npx",
//         "args": ["lynage-memory", "mcp", "--db", "./lynage.db", "--provider", "deepseek", "--model", "deepseek-v4-flash"]
//       }
//     }
//   }
// ---------------------------------------------------------------------------

import { createLynageMcpServer } from "./index.js";
import { AiSdkModel } from "@lynage/ai-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LanguageModelV1 } from "ai";

// ---------------------------------------------------------------------------
// CLI argument parsing (zero-dependency)
// ---------------------------------------------------------------------------

interface CliArgs {
  command: "mcp" | "serve";
  db: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  port: number;
}

function parseArgs(raw: string[]): CliArgs {
  const args = raw.slice(2); // strip node + script path
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = "true";
      }
    } else if (arg.startsWith("-")) {
      flags[arg.slice(1)] = "true";
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] as "mcp" | "serve" | undefined;
  if (!command || !["mcp", "serve"].includes(command)) {
    usage();
    process.exit(1);
  }

  const db = flags["db"];
  if (!db) {
    console.error("Error: --db <path> is required");
    usage();
    process.exit(1);
  }

  const provider = flags["provider"];
  if (!provider) {
    console.error("Error: --provider <name> is required (openai | deepseek | anthropic)");
    usage();
    process.exit(1);
  }

  const modelName = flags["model"];
  if (!modelName) {
    console.error("Error: --model <name> is required");
    usage();
    process.exit(1);
  }

  return {
    command,
    db,
    provider,
    model: modelName,
    baseUrl: flags["base-url"],
    apiKey: flags["api-key"],
    port: parseInt(flags["port"] ?? "4318", 10),
  };
}

function usage() {
  console.log(`
lynage-memory — MCP Server for Lynage Memory

Usage:
  lynage-memory mcp   [--db <path>] [--provider <name>] [--model <name>] [--base-url <url>] [--api-key <key>]
  lynage-memory serve [--db <path>] [--port <num>] [--provider <name>] [--model <name>] [--base-url <url>] [--api-key <key>]

Commands:
  mcp     Start in stdio mode (for Claude Code / MCP clients)
  serve   Start in HTTP mode (for remote clients)

Options:
  --db <path>         SQLite database path (default: ./data/lynage.db)
  --provider <name>   LLM provider: openai | deepseek | anthropic
  --model <name>      Model name (e.g. deepseek-v4-flash, gpt-4o-mini, claude-haiku-4-5-20251001)
  --base-url <url>    Custom API base URL (overrides provider default)
  --api-key <key>     API key (overrides env var)
  --port <num>        HTTP port for serve command (default: 4318)

Environment variables:
  DEEPSEEK_API_KEY    DeepSeek API key
  OPENAI_API_KEY      OpenAI API key
  ANTHROPIC_API_KEY   Anthropic API key

Claude Code config example (~/.claude/claude.json or .claude/settings.json):
  {
    "mcpServers": {
      "lynage": {
        "command": "npx",
        "args": ["lynage-memory", "mcp", "--db", "./lynage.db", "--provider", "deepseek", "--model", "deepseek-v4-flash"]
      }
    }
  }
`);
}

// ---------------------------------------------------------------------------
// Model factory — dynamically imports the right AI SDK provider
// ---------------------------------------------------------------------------

const PROVIDER_IMPORTS: Record<string, () => Promise<any>> = {
  openai: () => import("@ai-sdk/openai"),
  deepseek: () => import("@ai-sdk/deepseek"),
  anthropic: () => import("@ai-sdk/anthropic"),
};

const API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

async function createModel(args: CliArgs): Promise<LanguageModelV1> {
  const importer = PROVIDER_IMPORTS[args.provider];
  if (!importer) {
    console.error(`Unknown provider: ${args.provider}. Supported: ${Object.keys(PROVIDER_IMPORTS).join(", ")}`);
    process.exit(1);
  }

  let mod: any;
  try {
    mod = await importer();
  } catch {
    console.error(
      `Provider "${args.provider}" requires @ai-sdk/${args.provider}. Install it with:\n` +
        `  pnpm add @ai-sdk/${args.provider}`,
    );
    process.exit(1);
  }

  const apiKey = args.apiKey ?? process.env[API_KEY_ENV[args.provider]!];
  if (!apiKey) {
    console.error(
      `No API key found for ${args.provider}. Set ${API_KEY_ENV[args.provider]} environment variable or pass --api-key.`,
    );
    process.exit(1);
  }

  // Each @ai-sdk/* package exports a factory function named after the provider
  // e.g. @ai-sdk/deepseek → createDeepSeek, @ai-sdk/openai → createOpenAI
  const factoryName = `create${args.provider.charAt(0).toUpperCase() + args.provider.slice(1)}`;
  const factory = mod[factoryName];
  if (!factory) {
    console.error(`Could not find ${factoryName} in @ai-sdk/${args.provider}. Check the package exports.`);
    process.exit(1);
  }

  const client = factory({
    apiKey,
    ...(args.baseUrl ? { baseURL: args.baseUrl } : {}),
  });

  return client(args.model);
}

// ---------------------------------------------------------------------------
// Register tools on an McpServer instance
// ---------------------------------------------------------------------------

function registerTools(server: McpServer, tools: ReturnType<typeof createLynageMcpServer>["tools"]) {
  for (const [name, def] of Object.entries(tools)) {
    // Use the 4-arg form: (name, description, paramsSchema, handler)
    // Cast through any because the tools map erases precise Zod literal types
    (server as any).tool(name, def.description, def.inputSchema, def.handler);
  }
}

// ---------------------------------------------------------------------------
// Stdio mode — for Claude Code / MCP clients
// ---------------------------------------------------------------------------

async function runStdio(args: CliArgs) {
  const model = await createModel(args);
  const aiSdkModel = new AiSdkModel(model);

  const { tools } = createLynageMcpServer({
    dbPath: args.db,
    model: aiSdkModel,
  });

  const server = new McpServer({
    name: "lynage-memory",
    version: "0.0.1",
  });

  registerTools(server, tools);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with stdio protocol
  console.error(`Lynage Memory MCP server running (stdio, provider=${args.provider}, model=${args.model}, db=${args.db})`);
}

// ---------------------------------------------------------------------------
// HTTP serve mode — for remote clients
// ---------------------------------------------------------------------------

async function runServe(args: CliArgs) {
  // Dynamic import to avoid requiring express when using stdio mode
  let StreamableHTTPServerTransport: any;
  try {
    const sdk = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    StreamableHTTPServerTransport = sdk.StreamableHTTPServerTransport;
  } catch {
    console.error(
      "HTTP serve mode requires @modelcontextprotocol/sdk >= 1.12.0.\n" +
        "Make sure your SDK version supports StreamableHTTPServerTransport.",
    );
    process.exit(1);
  }

  const model = await createModel(args);
  const aiSdkModel = new AiSdkModel(model);

  const { tools } = createLynageMcpServer({
    dbPath: args.db,
    model: aiSdkModel,
  });

  const server = new McpServer({
    name: "lynage-memory",
    version: "0.0.1",
  });

  registerTools(server, tools);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // use default
  });

  await server.connect(transport);

  // Use Node.js built-in HTTP server (no express dependency)
  const http = await import("node:http");
  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for browser-based clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Error handling request:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  });

  httpServer.listen(args.port, () => {
    console.error(
      `Lynage Memory MCP server listening on http://localhost:${args.port} (provider=${args.provider}, model=${args.model}, db=${args.db})`,
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "mcp") {
    await runStdio(args);
  } else {
    await runServe(args);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
