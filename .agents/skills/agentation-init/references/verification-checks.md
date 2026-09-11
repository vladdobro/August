# Verification checklist

1. Start Agentation HTTP server:
```bash
./scripts/run_agentation_server.sh
```

2. Validate HTTP endpoints:
```bash
curl http://127.0.0.1:4747/health
curl http://127.0.0.1:4747/status
```

3. Start frontend dev server and verify env:
```bash
VITE_AGENTATION_ENDPOINT=http://127.0.0.1:4747
```

4. Confirm Agentation controls appear in the browser UI.

5. Confirm MCP wiring in `.codex/config.toml`:
```toml
[mcp_servers.agentation]
command = "bash"
args = ["/absolute/path/to/project/scripts/run_agentation_mcp_stdio.sh"]
```

6. In the annotation client, run:
- list active sessions
- watch annotations and process one annotation end-to-end

# Common issues

- MCP tools load but no annotation data: verify `AGENTATION_HTTP_URL` points to live Agentation HTTP server.
- Browser controls missing: ensure `Agentation` component is mounted and frontend restarted.
- Port conflict on `4747`: set `AGENTATION_PORT` and keep `VITE_AGENTATION_ENDPOINT` plus `AGENTATION_HTTP_URL` aligned.
