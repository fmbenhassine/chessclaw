# Container Lifecycle

When you run ChessClaw, containers are started on demand. The app does not keep one permanent assistant container running forever. Instead, it spawns a container when work begins, keeps it alive while that work is active, reuses it briefly for follow-up input, and lets it exit when it becomes idle or fails.

## High-Level Flow

1. On startup, the host process checks that Apple Container is running.
2. It also stops orphaned old ChessClaw containers left behind by earlier runs.
3. When a user message or scheduled task needs processing, the host queue starts container-backed work.
4. The host spawns a fresh container with the ChessClaw agent image.
5. The host sends a JSON payload to the container over stdin.
6. Inside the container, the agent runner creates or resumes a Codex session and starts the turn.
7. While that container is still alive, new input can be sent through IPC instead of spawning another container immediately.
8. If no more input arrives, the host signals the container to close after the idle timeout.
9. The container exits, and because it is started with `--rm`, it is removed automatically.

## What Gets Mounted

Before the container starts, the host prepares bind mounts for:

- `assistant/` as `/workspace/assistant`
- session state as `/home/node/.codex`
- IPC as `/workspace/ipc`
- a filtered env directory when allowed API keys are present
- the container runner source as `/app/src`

The host chess database is not mounted into the container.

## How Input Reaches the Container

At spawn time, the host writes a single JSON payload to the container’s stdin. That payload contains:

- the prompt
- the chat id
- an optional session id
- an optional container timeout
- a flag for scheduled-task runs when applicable

While a container remains alive, follow-up input is delivered through `/workspace/ipc/input`.

## Reuse While Active

Once a container is running, ChessClaw can keep using that same container for follow-up messages instead of spawning a new one immediately.

This is why the runtime behaves like “one active assistant container with piped follow-ups” rather than “one brand-new container per individual message.”

## Idle Shutdown

The host maintains an idle timer while the agent is active. If no more meaningful output arrives before `IDLE_TIMEOUT`, the host writes a `_close` sentinel into IPC.

Inside the container, the runner watches for that sentinel and exits its processing loop when it appears.

## Reuse Window and Idle Time

The reuse window is defined by `IDLE_TIMEOUT`.

By default, `IDLE_TIMEOUT` is `1800000` milliseconds, which is 30 minutes.

So in practice:

1. A container starts handling a prompt.
2. It may stay alive after the turn completes.
3. If follow-up input arrives within `IDLE_TIMEOUT`, the same container can be reused.
4. If no follow-up arrives within that window, the host tells it to shut down.

## Idle Timeout vs Hard Runtime Timeout

There are two different timing controls in the system:

- `IDLE_TIMEOUT`: how long to keep a healthy container alive for reuse after activity
- `CONTAINER_TIMEOUT` or `assistant.containerTimeout`: the hard limit for how long a single container run is allowed to execute before the host force-stops it

These timers serve different purposes. `IDLE_TIMEOUT` controls reuse. `CONTAINER_TIMEOUT` controls safety.

## Session Continuity Across Containers

Container lifetime and conversation lifetime are separate.

When the agent produces a `newSessionId`, the host stores it and passes it back into the next container run. That lets a later container resume the same Codex session even though the previous container has already exited.

## Scheduled Task Behavior

Scheduled tasks use the same queue and the same container machinery as chat runs, but their containers now exit after one completed turn instead of waiting for the normal reuse loop.

This avoids task starvation and ensures `next_run` advances reliably.

## Concurrency Model

The queue allows only one active container-backed unit of work at a time. User messages and scheduled tasks are serialized through the same queue.

That means the normal runtime model is:

- one active assistant container at a time
- queued follow-up work behind it
- brief reuse of the active container through IPC
- automatic shutdown on idle, timeout, or error
