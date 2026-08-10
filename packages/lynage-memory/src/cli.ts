#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// lynage-memory CLI — delegates to @lynage/mcp's CLI
//
// Usage:
//   npx lynage-memory mcp   --db ./lynage.db --provider deepseek --model deepseek-v4-flash
//   npx lynage-memory serve --db ./lynage.db --port 4318 --provider openai --model gpt-4o-mini
// ---------------------------------------------------------------------------

import "@lynage/mcp/cli";
