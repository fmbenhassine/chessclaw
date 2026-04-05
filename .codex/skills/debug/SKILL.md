---
name: debug
description: "Debug ChessClaw Codex container issues: auth, mounts, session resumption, runtime failures, and service health."
---

# ChessClaw Debug (Codex Runtime)

## Architecture Snapshot

```
Host (macOS)                           Container (Linux VM)
───────────────────────────────────────────────────────────
src/container-runner.ts                container/agent-runner/
    │                                      │
    │ spawns Apple Container runtime       │ runs Codex SDK
    │                                      │
    ├── assistant/  ─────────────────> /workspace/assistant
    ├── data/ipc/  ──────────────────> /workspace/ipc
    ├── data/session/.codex/  ───────> /home/node/.codex/
    └── data/env/env  ───────────────> /workspace/env-dir/env
```

## Key Logs

- Host logs: `logs/chessclaw.log`
- Host error logs: `logs/chessclaw.error.log`
- Per-run container logs: `assistant/logs/container-*.log`
- Persistent Codex session/auth state: `data/session/.codex/`

## Fast Health Check

```bash
launchctl list | grep chessclaw
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep chessclaw
grep -E 'ERROR|WARN|timeout|failed' logs/chessclaw.log | tail -30
```

## Common Failures

### 1) "Codex process exited with code 1"

Check latest container log first:

```bash
ls -lt assistant/logs/container-*.log | head -5
cat assistant/logs/container-<timestamp>.log
```

Likely causes:
- Missing auth (`codex login` not done, no API key in `.env`)
- Runtime missing (`container` unavailable)
- Session mount mismatch

### 2) Auth Not Available in Container

Supported auth paths:
- Host Codex login copied into `data/session/.codex/auth.json`
- API keys from `.env` allowlist (`OPENAI_API_KEY`, `CODEX_API_KEY`, plus optional OpenAI overrides)

Checks:

```bash
ls -la data/session/.codex/
grep -E '^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID)=' .env
```

Validate mounted env inside container:

```bash
echo '{}' | container run -i \
  --mount type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly \
  --entrypoint /bin/bash chessclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); env | grep -E "^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID)="'
```

### 3) Session Not Resuming

Ensure mount target is `.codex` and session IDs are persisted:

```bash
grep -n '/home/node/.codex' src/container-runner.ts
sqlite3 store/messages.db "SELECT key, session_id FROM sessions ORDER BY key;"
ls -la data/session/.codex/sessions 2>/dev/null
```

### 4) Telegram Not Responding

```bash
grep -E 'Connected to Telegram|Telegram polling started|Telegram bot error' logs/chessclaw.log | tail -20
grep -E 'New messages|Processing messages|Spawning container|Agent error' logs/chessclaw.log | tail -40
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 10;"
```

Expect the configured assistant chat to be a direct Telegram chat with the bot. Do not debug group-chat routing as the intended setup anymore.

## Manual Runtime Test

```bash
mkdir -p data/env data/ipc/{messages,tasks,input,results} assistant
cp .env data/env/env

echo '{"prompt":"Say hello","chatJid":"tg:123456789"}' | \
  container run -i \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  -v $(pwd)/assistant:/workspace/assistant \
  -v $(pwd)/data/ipc:/workspace/ipc \
  -v $(pwd)/data/session/.codex:/home/node/.codex \
  chessclaw-agent:latest
```

## Rebuild and Restart

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/dev.chessclaw
```

## If Still Broken

Collect and share:
- Last 100 lines of `logs/chessclaw.log`
- Latest `assistant/logs/container-*.log`
- `sqlite3 store/messages.db "SELECT * FROM sessions;"`
