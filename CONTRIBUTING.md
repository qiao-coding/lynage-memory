# Contributing to Lynage Memory

Thanks for your interest in contributing! Lynage is a memory infrastructure layer for AI agents — immutable storage, tree navigation, high-fidelity recall.

## Getting Started

```bash
git clone https://github.com/qiao-coding/lynage-memory.git
cd lynage-memory
pnpm install
pnpm test        # 56 tests, must all pass
pnpm typecheck   # 6 packages, must be clean
```

## Project Structure

| Directory | Purpose |
|---|---|
| `packages/core/` | Core logic — memory, search, archiving, compaction, verification |
| `packages/storage-sqlite/` | SQLite + FTS5 storage layer |
| `packages/adapter-ai-sdk/` | Vercel AI SDK adapter |
| `packages/mcp-server/` | MCP Server for cross-framework access |
| `apps/test-runner/` | E2E test pipeline |
| `benchmarks/` | Forget, 10k, Galgame recall benchmarks |
| `docs/` | Architecture and integration guides |

## Development Workflow

1. **Fork & branch** — create a feature branch from `main`
2. **Code** — follow existing patterns (TypeScript strict, no `any`, no unnecessary abstractions)
3. **Test** — `pnpm test` must pass; add tests for new behavior
4. **Typecheck** — `pnpm typecheck` must pass across all packages
5. **PR** — describe what changed and why; keep changes focused

## Commit Style

```
<type>: <short description>

- Bullet points for details if needed
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`

## Running Benchmarks

```bash
# Forget-style stress test (requires DEEPSEEK_API_KEY in .env)
cd benchmarks/baseline
TURNS=2000 pnpm tsx bench-forget.ts

# Galgame narrative fidelity
cd benchmarks/galgame
pnpm tsx recall-bench.ts
```

## Design Principles

- **Messages are immutable** — append-only, never UPDATE/DELETE
- **Summaries are navigation, not storage** — open source messages to verify
- **Tree grows automatically** — chunks → directories → generations (G0→G1→G2)
- **Fast path first** — FTS before embedding before LLM rerank
- **Errors are non-fatal** — a transient model failure must never kill an archive

## Questions?

Open an issue on GitHub.
