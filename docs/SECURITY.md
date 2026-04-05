# ChessClaw Security Model

ChessClaw is a single-channel chess assistant. The security model is built around isolating the agent from the host while keeping the runtime simple enough to audit.

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Configured assistant chat | Trusted user input | Personal control channel |
| Telegram transport | External input surface | Messages still need defensive handling |
| Host process | Trusted | Owns routing, persistence, host chess tooling, and container lifecycle |
| Container agent | Sandboxed | Can only use mounted files and host-backed tools exposed to it |

## Primary Security Boundary

### Container Isolation

Agents run in Apple Container, not directly on the host.

This gives:

- process isolation
- filesystem isolation through explicit mounts
- non-root execution inside the container
- disposable container lifecycle per run

## Mounted Paths

The agent sees only these host-backed paths:

- `/workspace/assistant`
- `/workspace/ipc`
- `/home/node/.codex`
- `/workspace/env-dir`
- `/app/src`

The live chess database is not mounted into the container.

## Session And Memory Isolation

There is one persistent Codex session for the assistant, stored in:

- SQLite `sessions` table
- `data/session/.codex/`

There is one persistent workspace for assistant files:

- `assistant/`

There are no group contexts and no multi-tenant memory boundaries to manage.

## IPC Boundary

The container communicates with the host through `data/ipc/`.

The host remains responsible for:

- sending Telegram messages and images
- staging uploaded media
- managing scheduled tasks
- running trusted chess scripts under `backend/`
- executing host-backed chess actions

The container never talks to Telegram or the host database directly.

## Credentials

### Exposed To The Container

- copied Codex auth and config in `data/session/.codex/`
- filtered API-related values from `.env`

### Not Exposed To The Container

- the Telegram bot token
- the live chess database file
- arbitrary host secrets outside mounted paths

### Filtered Environment Variables

Only these values are copied out of `.env` for container use:

- `OPENAI_API_KEY`
- `CODEX_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_ORG_ID`
- `OPENAI_PROJECT_ID`

## Runtime Limits

- web search is disabled in the container
- general network browsing is disabled in the container
- chess news fetches and other trusted external access happen through host-backed tools

## Remaining Risks

- anything mounted into the container should be treated as visible to the agent
- the assistant chat is trusted by design; anyone who can post there can steer the agent
- host-backed chess actions are powerful because they intentionally modify the chess database and generate artifacts
- Codex auth and session files are visible inside the container because that is how session continuity works

## Practical Guidance

- keep the assistant chat private
- review `assistant/` periodically
- review what capabilities are exposed through the chess MCP surface
- avoid broad new host mounts
- prefer new host-backed chess tools over giving the container direct host access
