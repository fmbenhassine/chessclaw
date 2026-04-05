# How It Works

ChessClaw processes a request in six main stages.

## 1. Telegram Ingest

A message arrives through the Telegram bot in [src/index.ts](/Users/mbh/projects/chessclaw/src/index.ts) and [src/telegram.ts](/Users/mbh/projects/chessclaw/src/telegram.ts).

The app:

- normalizes the chat JID
- stores chat metadata
- stores the full message in SQLite for the configured assistant chat
- downloads photo attachments into the assistant workspace when needed

## 2. Host Polling And Routing

The message loop in [src/index.ts](/Users/mbh/projects/chessclaw/src/index.ts) polls SQLite for new messages in the configured assistant chat.

It then:

- gathers all pending messages since the last assistant turn
- formats them into the prompt block
- either pipes them into an already-running container or enqueues a new run through [src/message-queue.ts](/Users/mbh/projects/chessclaw/src/message-queue.ts)

## 3. Container Startup

When a run is needed, [src/container-runner.ts](/Users/mbh/projects/chessclaw/src/container-runner.ts) starts an Apple container.

It mounts:

- `assistant/` as `/workspace/assistant`
- `data/ipc/` as `/workspace/ipc`
- `data/session/.codex/` as `/home/node/.codex`
- filtered API credentials as `/workspace/env-dir`
- the agent-runner source as `/app/src`

The host chess database is not mounted into the container.

## 4. Agent Execution Inside The Container

Inside the container, [container/agent-runner/src/index.ts](/Users/mbh/projects/chessclaw/container/agent-runner/src/index.ts):

- loads [assistant/AGENTS.md](/Users/mbh/projects/chessclaw/assistant/AGENTS.md)
- starts or resumes the single persistent Codex session
- runs the prompt
- streams framed output back to the host

If more user messages arrive during execution, it reads them from `/workspace/ipc/input` and uses them as the next prompt turn.

## 5. Host-Backed Chess Actions

When the assistant needs chess data or chess side effects, it uses MCP tools exposed through [container/agent-runner/src/ipc-mcp-stdio.ts](/Users/mbh/projects/chessclaw/container/agent-runner/src/ipc-mcp-stdio.ts).

Those tools call back into host actions in [src/index.ts](/Users/mbh/projects/chessclaw/src/index.ts), which run the trusted Python tooling under [backend](/Users/mbh/projects/chessclaw/backend).

This is how ChessClaw handles:

- SQL queries against the chess database
- game download, ingest, and sync
- missed-mate analysis
- puzzle rendering
- rating chart rendering
- chess news fetches

## 6. Response Delivery

The host parses streamed container output in [src/container-runner.ts](/Users/mbh/projects/chessclaw/src/container-runner.ts).

Then [src/index.ts](/Users/mbh/projects/chessclaw/src/index.ts):

- strips `<internal>` content
- sends the visible reply back to Telegram
- sends image media when requested
- persists the updated session ID
- advances the last-processed cursors in SQLite

## Supporting Paths

- scheduled tasks enter the same pipeline from [src/task-scheduler.ts](/Users/mbh/projects/chessclaw/src/task-scheduler.ts)
- container-to-host tool calls use file IPC through [container/agent-runner/src/ipc-mcp-stdio.ts](/Users/mbh/projects/chessclaw/container/agent-runner/src/ipc-mcp-stdio.ts)
- persistent runtime state lives primarily in [src/db.ts](/Users/mbh/projects/chessclaw/src/db.ts)

## Summary

The core flow is:

`Telegram -> SQLite -> single queue -> container agent -> host-backed chess tools -> Telegram`
