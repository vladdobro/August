---
name: agentation-init
description: Configure Agentation for a web frontend project with complete server, MCP, and UI wiring. Use when the user asks to set up Agentation, enable browser annotation buttons, or replicate this repository's Agentation configuration in another project.
---

# Goal
Set up Agentation in any web frontend repository so browser annotations flow into annotation MCP tools and can be processed in watch mode.

# Instructions
1. Inspect the target repository before editing.
- Confirm frontend framework and entry component.
- Confirm package manager from lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).
- Confirm `.codex/config.toml` exists or create it.

2. Add frontend Agentation dependency.
- Install `agentation` in the frontend package.
- Keep the existing package manager and workspace conventions.
- Do not add unrelated dependencies.

3. Add runtime configuration for the frontend endpoint.
- Ensure frontend reads an endpoint env var named `VITE_AGENTATION_ENDPOINT`.
- Default endpoint to `http://127.0.0.1:4747` when env var is missing.
- Update `.env.example` with `VITE_AGENTATION_ENDPOINT=http://127.0.0.1:4747`.

4. Mount Agentation UI in the root app component.
- Import `Agentation` from `agentation`.
- Render `<Agentation endpoint={agentationEndpoint} />` near root providers so it is visible across routes.
- Gate mounting behind development mode unless user explicitly requests production enablement.
- Follow the React Vite pattern from `references/frontend-react-vite.md`.

5. Add Agentation server scripts in `scripts/`.
- Add `resolve_agentation_cli.sh` to discover the `agentation-mcp` CLI.
- Add `run_agentation_server.sh` to run HTTP annotations server (default port `4747`).
- Add `run_agentation_mcp_stdio.sh` to run MCP stdio bridge against `AGENTATION_HTTP_URL`.
- Use the shell templates in `references/script-templates.md`.

6. Wire the annotation MCP server.
- Add MCP config to `.codex/config.toml`:
  - section `[mcp_servers.agentation]`
  - `command = "bash"`
  - `args = ["<absolute-or-workspace script path>/scripts/run_agentation_mcp_stdio.sh"]`
- Keep existing MCP servers unchanged.

7. Document operational flow.
- Add or update a setup doc that includes startup order:
  1) Agentation HTTP server
  2) frontend dev server
  3) client session with MCP config loaded
- Include verification commands and common failure modes using `references/verification-checks.md`.

8. Validate end-to-end behavior.
- Run `curl http://127.0.0.1:4747/health` after starting the server.
- Confirm frontend shows Agentation controls in dev mode.
- In the annotation client, list sessions and watch annotations.
- If annotations appear in browser but not MCP, verify `AGENTATION_HTTP_URL`.

9. Keep project context updated.
- Update relevant files under `project-context/` when architecture or setup behavior changes.

# Examples
User request: "Set up agentation in this React Vite app so I can annotate screens and fix bugs from the annotation client."
Agent action: install `agentation`, mount `<Agentation ... />` in root app, add Agentation scripts, wire `.codex/config.toml`, update `.env.example`, and add setup documentation.

User request: "Copy the same agentation setup from this repo into another frontend project."
Agent action: apply files from `references/script-templates.md`, `references/frontend-react-vite.md`, and `references/verification-checks.md`, then adapt paths and package manager.

# Constraints
- Do not remove or modify unrelated MCP server entries.
- Do not enable Agentation UI in production unless explicitly requested.
- Do not hardcode private hosts or secrets.
- Always include explicit error handling in shell scripts (`set -euo pipefail`).
- Always preserve existing architecture boundaries and coding style.
- Always update `.env.example` for newly required environment variables.
