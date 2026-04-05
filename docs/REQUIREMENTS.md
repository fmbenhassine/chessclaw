# ChessClaw Requirements

Current design decisions for the single-channel ChessClaw runtime.

## Why This Exists

ChessClaw is a small personal chess assistant you can understand end to end. It is intentionally narrow: one Telegram chat, one assistant workspace, one persistent session, one Node.js host process, and a trusted host-side chess toolchain.

The goal is not to be a framework. The goal is to provide a secure, inspectable, customizable chess assistant with minimal glue code.

## Core Principles

### Small Enough To Understand

- one Node.js host process
- one SQLite state store
- one assistant workspace
- file-based IPC between host and container

### Real Isolation

- agent execution happens inside Apple Container
- the host process never gives the agent unrestricted host access
- the container only sees explicitly mounted paths
- the live chess database stays on the host

### Single Personal Channel

- one Telegram chat is the assistant channel
- no group registration
- no multi-user routing
- no cross-chat permission matrix

### One Workspace, One Session

- runtime instructions live in `assistant/AGENTS.md`
- persistent assistant files live under `assistant/`
- Codex session state lives under `data/session/.codex/`

### Chess Actions Run On The Host

- game sync, ingest, analysis, puzzle rendering, rating charts, and database queries are host-backed
- the container uses MCP tools instead of directly touching the database
- trusted host scripts under `backend/` are the source of truth for chess workflows

## Runtime Model

### Message Routing

- Telegram messages are received through grammY
- the host stores messages in SQLite
- only the configured assistant chat is treated as conversational input
- text and photo messages both enter the same queue

### Memory Model

- instruction memory: `assistant/AGENTS.md`
- file memory: anything created under `assistant/`
- conversation continuity: one persistent Codex session in SQLite plus `.codex` session files
- conversation archive: `assistant/conversations/`

### Container Mounts

The assistant container gets:

- `assistant/` mounted at `/workspace/assistant`
- `data/session/.codex/` mounted at `/home/node/.codex`
- `data/ipc/` mounted at `/workspace/ipc`
- filtered credentials from `.env` mounted read-only at `/workspace/env-dir`
- `container/agent-runner/src/` mounted read-only at `/app/src`

The container does not get a direct mount of the host chess database.

### Scheduling

- scheduled tasks are stored in SQLite
- tasks run in the same assistant workspace and session context as chat
- tasks can send messages back through the `chessclaw` MCP server
- supported schedules:
  - cron
  - interval
  - once

## Persistence

SQLite stores:

- chat metadata
- message history for the assistant channel
- scheduled tasks
- task run logs
- router state
- assistant configuration
- the single persistent session ID

Filesystem stores:

- assistant workspace files
- assistant conversation archive
- Codex auth and session files
- IPC messages and results
- host and container logs
- chess database and downloaded PGNs under `data/`

## Integration Points

### Telegram

- `grammy`
- bot token configured in `.env`
- incoming text and photo ingest
- outgoing text and image delivery

### Codex SDK

- `@openai/codex-sdk`
- streamed runs via the container agent runner
- session resume through one stored session ID

### Host-Backed MCP

The injected `chessclaw` MCP server provides:

- chat delivery tools
- scheduling tools
- chess database query tooling
- chess news fetch tooling
- host-backed game download, ingest, sync, and analysis
- host-backed puzzle and chart rendering

## Deployment

- local macOS service via `launchd`
- Apple Container runtime
- host Python environment managed with `uv`
- host Stockfish binary for chess analysis

## Non-Goals

- multi-group isolation
- multi-user routing
- generic productivity assistant behavior
- direct container-side writes to the live host chess database
- broad host-application automation outside chess workflows
