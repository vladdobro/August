# Shell script templates

Create these files under `scripts/` with executable permissions.

`scripts/resolve_agentation_cli.sh`
```bash
set -euo pipefail

if [[ -n "${AGENTATION_MCP_CLI:-}" && -f "${AGENTATION_MCP_CLI}" ]]; then
  printf '%s\n' "${AGENTATION_MCP_CLI}"
  exit 0
fi

if command -v agentation-mcp >/dev/null 2>&1; then
  command -v agentation-mcp
  exit 0
fi

if [[ -d "${HOME}/.npm/_npx" ]]; then
  while IFS= read -r -d '' p; do
    printf '%s\n' "${p}"
    exit 0
  done < <(
    find "${HOME}/.npm/_npx" -path '*/node_modules/agentation-mcp/dist/cli.js' -type f -print0 \
      2>/dev/null | sort -z
  )
fi

echo "Unable to find agentation-mcp CLI. Install with: npm i -g agentation-mcp" >&2
exit 1
```

`scripts/run_agentation_server.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PATH="$("${ROOT_DIR}/scripts/resolve_agentation_cli.sh")"
PORT="${AGENTATION_PORT:-4747}"

exec node "${CLI_PATH}" server --port "${PORT}"
```

`scripts/run_agentation_mcp_stdio.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PATH="$("${ROOT_DIR}/scripts/resolve_agentation_cli.sh")"
HTTP_URL="${AGENTATION_HTTP_URL:-http://127.0.0.1:4747}"

exec node "${CLI_PATH}" server --mcp-only --http-url "${HTTP_URL}"
```

After creating scripts:
```bash
chmod +x scripts/resolve_agentation_cli.sh
chmod +x scripts/run_agentation_server.sh
chmod +x scripts/run_agentation_mcp_stdio.sh
```
