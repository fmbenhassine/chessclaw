# ChessClaw Debug Checklist

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep chessclaw

# 2. Any running containers?
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep chessclaw

# 3. Recent warnings/errors
grep -E 'ERROR|WARN|timeout|failed' logs/chessclaw.log | tail -30

# 4. Telegram connection state
grep -E 'Connected to Telegram|Telegram polling started|Telegram bot error' logs/chessclaw.log | tail -10

# 5. Assistant channel state
sqlite3 store/messages.db "SELECT chat_jid, requires_trigger, container_timeout FROM assistant_state;"
```

## Session Checks

```bash
# Single persistent Codex session/auth state
ls -la data/session/.codex/

# Confirm the saved session ID
sqlite3 store/messages.db "SELECT key, session_id FROM sessions;"

# Inspect recent Codex session metadata files
find data/session/.codex/sessions -type f 2>/dev/null | head -20
```

## Container Log Checks

```bash
# Timeouts in host logs
grep -E 'Container timeout|timed out' logs/chessclaw.log | tail -20

# Recent assistant container logs
ls -lt assistant/logs/container-*.log | head -10

# Open the latest container log
cat assistant/logs/container-<timestamp>.log
```

## Message Routing Checks

```bash
# New messages seen by router
grep 'New messages' logs/chessclaw.log | tail -20

# Assistant processing lifecycle
grep -E 'Processing messages|Spawning container|Container completed|Agent error' logs/chessclaw.log | tail -40

# Message table sanity
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) AS latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 10;"
```

## Host Chess Action Checks

```bash
# Recent host chess bridge actions
grep -E 'chess_|macOS bridge action failed|macOS bridge action completed' logs/chessclaw.log | tail -40

# Recent image sends
grep -E 'Image sent|image_message' logs/chessclaw.log | tail -20
```

## Task Checks

```bash
# List tasks
sqlite3 store/messages.db "SELECT id, schedule_type, schedule_value, status, next_run FROM scheduled_tasks ORDER BY created_at DESC;"

# Recent task runs
sqlite3 store/messages.db "SELECT task_id, run_at, status, duration_ms FROM task_run_logs ORDER BY run_at DESC LIMIT 20;"
```

## Credential Checks

```bash
# API key present in .env
[ -f .env ] && grep -Eq '^(OPENAI_API_KEY|CODEX_API_KEY)=' .env && echo "API key present" || echo "No API key in .env"

# Copied Codex auth available for container runs
[ -f data/session/.codex/auth.json ] && echo "Codex auth present" || echo "No copied Codex auth"
```

## IPC Checks

```bash
# Pending IPC files
find data/ipc -maxdepth 2 -type f | sort

# Current task snapshot visible to the container
cat data/ipc/current_tasks.json
```

## Service Control

```bash
# Restart service
launchctl kickstart -k gui/$(id -u)/dev.chessclaw

# Live logs
tail -f logs/chessclaw.log

# Stop service
launchctl bootout gui/$(id -u)/dev.chessclaw

# Start service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.chessclaw.plist
```
