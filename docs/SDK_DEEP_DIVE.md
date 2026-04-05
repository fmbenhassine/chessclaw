# Codex SDK Deep Dive

This project uses `@openai/codex-sdk` inside `container/agent-runner`.

## Runtime Model

- the host process starts a container when the assistant needs to respond
- the container runner starts or resumes one Codex session
- the host persists one session ID in SQLite
- Codex auth and session files are stored in `data/session/.codex/`

## Session Lifecycle

- new conversation state uses `startThread()`
- existing conversation state uses `resumeThread(sessionId)`
- the host updates the saved session ID whenever Codex emits a new one

## Streaming Flow

The runner uses streamed Codex execution and emits results wrapped between:

- `---CHESSCLAW_OUTPUT_START---`
- `---CHESSCLAW_OUTPUT_END---`

The host parses those markers incrementally and forwards user-visible text to Telegram.

## Conversation Continuity

ChessClaw keeps continuity in two places:

- SQLite session ID persistence
- Codex auth and session files under `data/session/.codex/`

The runner also appends a lightweight archive of prompt and response pairs to:

- `assistant/conversations/`

## Instructions

The runner loads assistant instructions from:

- `assistant/AGENTS.md`

The Codex session runs with:

- working directory: `/workspace/assistant`
- network access disabled
- web search disabled
- approval policy: `never`
- sandbox mode: `danger-full-access`

The true isolation boundary is the container, not the internal SDK sandbox.

## MCP Integration

The runner injects one MCP server, `chessclaw`, via stdio.

That MCP server exposes assistant-facing tools such as:

- `send_message`
- `send_image`
- `schedule_task`
- `list_tasks`
- `pause_task`
- `resume_task`
- `cancel_task`
- `query_chess_database`
- `fetch_chess_news`
- `download_games`
- `ingest_games`
- `sync_games`
- `analyze_games`
- `render_puzzle_png`
- `render_rating_plot`

The MCP server itself talks to the host over IPC, and the host executes the trusted chess actions.

## Authentication Sources

Supported authentication sources are:

1. Codex login on the host
   - `~/.codex/auth.json`
   - copied into `data/session/.codex/`
2. API credentials from `.env`
   - filtered before being mounted into the container
