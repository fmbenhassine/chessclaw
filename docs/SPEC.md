# ChessClaw Specification

ChessClaw is a single-channel Telegram chess assistant powered by Codex. The host process owns routing, persistence, and trusted chess actions. The containerized agent owns conversation flow and tool use.

## Architecture

```text
Telegram
  -> SQLite state
  -> host message loop
  -> single queue
  -> container runner
  -> Codex session
  -> host-backed chess MCP tools
  -> response back to Telegram
```

### Host Responsibilities

- receive Telegram messages and photos
- receive Telegram messages
- store chats, messages, tasks, and session state in SQLite
- decide when to start or reuse a container
- execute trusted chess tooling on the host
- send outbound text and images
- manage scheduled tasks
- manage IPC and container lifecycle

### Container Responsibilities

- run the Codex agent
- read and write the assistant workspace
- resume the persistent session
- call the injected chess MCP tools
- communicate with the host through file-based IPC

## Folder Structure

```text
chessclaw/
├── README.md
├── assistant/
│   ├── AGENTS.md
│   ├── conversations/
│   └── logs/
├── backend/
│   ├── missed-mates.py
│   ├── engine.py
│   ├── paths.py
│   ├── setup-database.py
│   ├── download-games.py
│   ├── ingest-games.py
│   ├── sync-games.py
│   ├── find-missed-mates.py
│   ├── render-png.py
│   └── render-rating-plot.py
├── container/
│   ├── build.sh
│   └── agent-runner/
├── data/
│   ├── chess-openings/
│   ├── games/
│   ├── ipc/
│   ├── session/
│   └── sql/
├── docs/
├── logs/
├── src/
└── store/
```

## Configuration

Main runtime values live in [src/config.ts](/Users/mbh/projects/chessclaw/src/config.ts).

Important settings:

- `TELEGRAM_BOT_TOKEN`
- `ASSISTANT_CHAT_ID`
- `CONTAINER_IMAGE`
- `CONTAINER_TIMEOUT`
- `IDLE_TIMEOUT`
- `POLL_INTERVAL`
- `SCHEDULER_POLL_INTERVAL`

### Chat Selection

- `ASSISTANT_CHAT_ID` pins the one Telegram chat the assistant should serve
- it uses the internal `tg:<id>` format
- `/chatid` returns the exact value needed for setup

## Memory And Session Model

### Workspace Memory

- instructions: `assistant/AGENTS.md`
- persistent assistant files: `assistant/`
- conversation archive: `assistant/conversations/`
- container logs: `assistant/logs/`

### Persistent Session

ChessClaw keeps one persistent Codex session for the assistant.

It is stored in:

- the SQLite `sessions` table
- `data/session/.codex/`

## Container Mounts

The assistant container gets these mounts:

- `assistant/` -> `/workspace/assistant`
- `data/ipc/` -> `/workspace/ipc`
- `data/session/.codex/` -> `/home/node/.codex`
- filtered environment file copy -> `/workspace/env-dir`
- `container/agent-runner/src/` -> `/app/src`

The host chess database is not mounted into the container. Database access happens through host-backed MCP tools.

## SQLite Model

Key tables:

- `chats`
- `messages`
- `scheduled_tasks`
- `task_run_logs`
- `router_state`
- `assistant_state`
- `sessions`

Notable state values:

- `router_state.last_timestamp`
- `router_state.last_agent_timestamp`
- `assistant_state.chat_jid`
- `assistant_state.container_timeout`
- `sessions.session_id`

## Message Flow

### Incoming Chat Message

1. grammY receives a Telegram message or photo
2. the host stores chat metadata and the full message in SQLite
3. the polling loop reads new assistant-chat messages
4. if a container is already active, the message batch is piped into it via IPC
5. otherwise the queue starts a new container run
6. streamed assistant output is forwarded back to Telegram

### Follow-Up Messages During A Run

- the active run watches `/workspace/ipc/input`
- new messages are buffered and used as the next prompt when the current turn completes
- `_close` tells the container loop to shut down cleanly

## Scheduled Tasks

Scheduled tasks are stored in SQLite and executed by the host scheduler.

Supported schedule types:

- `cron`
- `interval`
- `once`

Task behavior:

- tasks run in the same workspace as the main assistant
- tasks reuse the same persistent session
- tasks can send results through `send_message`
- task runs are logged in `task_run_logs`
- scheduled-task containers exit after one completed turn

## MCP Tools

The injected `chessclaw` MCP server exposes:

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

These tools are chess-focused and host-backed. The container does not directly run the real database workflows itself.

## Deployment

### Local Service

ChessClaw is intended to run as a local `launchd` service on macOS under the label `dev.chessclaw`.

### Runtime Dependencies

- Node.js 20+
- Telegram bot token
- Apple Container
- Codex auth or API credentials
- Python and `uv` for host chess tooling
- Stockfish on the host for analysis

## Security Notes

- only one configured Telegram chat is treated as assistant input
- the container does not get a direct mount of `data/db.sqlite`
- the container has no general web search or general network browsing enabled
- trusted chess actions run on the host through MCP
