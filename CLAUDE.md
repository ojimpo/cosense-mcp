# CLAUDE.md

MCP server for Cosense (Scrapbox). Also works as a CLI.

## Commands

```bash
npm run build        # TypeScript → JavaScript (uses tsconfig.build.json)
npm run watch        # Auto-rebuild during development
npm run test         # Run Jest tests
npm run lint         # ESLint (console.log triggers warning)
npm run inspector    # Debug with MCP Inspector
```

## Architecture

### Tools (8)

| Tool | Description | Auth |
|---|---|---|
| `get_page` | Retrieve page content, metadata, and links | - |
| `list_pages` | List pages with sorting and pagination (max 1000) | - |
| `search_pages` | Keyword search (API limit: 100 results) | - |
| `create_page` | Create new page. Rejects if page already exists | SID |
| `get_page_url` | Generate URL from page title | - |
| `insert_lines` | Insert text after a target line (exact match). Appends to end if not found | SID |
| `edit_lines` | Replace a target line (exact match). Errors if not found. `matchAll` replaces every occurrence | SID |
| `get_smart_context` | Get page + linked pages (1-hop/2-hop) in AI-optimized format | SID |

### CLI

All tools are also available as CLI subcommands (`get`, `list`, `search`, `create`, `url`, `insert`, `edit`, `context`). Run `scrapbox-cosense-mcp <command> --help` for usage. Key flags:

- `--compact` — Token-efficient output (85% smaller for list)
- `--json` — JSON output
- `--project=NAME` — Override project name

### Skill (SKILL.md)

`skills/scrapbox/SKILL.md` defines a Claude Code skill that wraps the CLI. When users invoke `/cosense`, Claude Code reads SKILL.md and executes CLI commands via Bash. Keep SKILL.md concise — details should be discoverable via `--help`.

### Claude Code Plugin

`.claude-plugin/` (plugin.json + marketplace.json) enables installation via `/plugin marketplace add worldnine/scrapbox-cosense-mcp`. The marketplace resolves the plugin from the **npm package**, so `.claude-plugin/`, `.mcp.json`, and `skills/` must be listed in package.json `files` — a plugin fix only takes effect after the next npm release.

### Desktop Extensions (.mcpb)

`manifest.json` + `.mcpbignore` enable Claude Desktop Extensions packaging. The `.mcpb` file is auto-built and attached to GitHub Releases by `release-mcpb.yml`. To build locally: `npm install --omit=dev && npx @anthropic-ai/mcpb pack`.

### Directory Structure

- `src/cosense.ts` — Scrapbox REST API client
- `src/routes/handlers/` — One handler module per tool
- `src/utils/format.ts` — Response formatting, `stringifyError`, `formatError`
- `src/utils/sort.ts` — Sorting with pinned page filtering
- `src/utils/markdown-converter.ts` — Markdown → Scrapbox conversion (uses `md2sb`)
- `src/types/` — API response and MCP request/response type definitions
- `src/cli.ts` — CLI entry point (args → CLI mode, no args → MCP server)
- `src/index.ts` — Server entry point

### Design Decisions

- **WebSocket API (`@cosense/std`)** is used for `create_page` / `insert_lines` / `edit_lines` because the REST API has no page creation/editing endpoints
- **`create_page` rejects existing pages** (`persistent === true`). Without this check, `patch()` silently replaces all content since it's a diff-update API
- **`insert_lines` uses exact match**. Partial match risks inserting at unintended lines
- **`edit_lines` defaults to `matchAll: false`**. Repeated lines (bullet markers, blank lines) are common, so replacing every occurrence by default would exceed what the caller asked for
- **`insert_lines` and `edit_lines` differ when the target is missing**, deliberately. `insert_lines` appends to the end, since "add this text" still has a sensible landing spot. `edit_lines` errors and leaves the page untouched, since "replace this line" has no fallback — appending would silently produce a page nobody asked for
- **`patch()` returns `Result<string, PushError>`**, not throw. Must check `result.ok`
- **Default sort is `updated`**. Aligned across API, display, and user expectations

### Environment Variables

See README.md. Key variables:

- `COSENSE_PROJECT_NAME` — Target project (required)
- `COSENSE_SID` — Session ID for private projects and write operations
- `COSENSE_TOOL_SUFFIX` — Tool name suffix for multiple server instances
- `COSENSE_CONVERT_NUMBERED_LISTS` — Convert numbered lists to bullet lists

## CI/CD & Release

### GitHub Actions

- **pr.yml** — Quality check on PRs (lint → test → build)
- **security-scan.yml** — Security scan
- **auto-release.yml** — `release/v*` PR merge → auto-create tag + GitHub Release
- **publish-npm.yml** — `v*` tag push → auto-publish to npm
- **release-mcpb.yml** — GitHub Release → auto-build and attach .mcpb

### Release Process

1. Create `release/vX.Y.Z` branch, bump version in `package.json` + `manifest.json` + `.claude-plugin/plugin.json`
2. Create PR → CI passes → merge
3. Everything after merge is automatic (tag → npm → GitHub Release → .mcpb)

## TypeScript

- **Strict mode**: includes `exactOptionalPropertyTypes: true`
- **Path aliases**: `@/` → `src/` (configured in both TypeScript and Jest; runtime uses relative paths)
- **ESM**: imports use `.js` extensions
- **Dual config**: `tsconfig.json` (dev) and `tsconfig.build.json` (prod, excludes tests)
