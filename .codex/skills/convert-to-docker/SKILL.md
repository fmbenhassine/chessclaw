---
name: convert-to-docker
description: Convert ChessClaw from Apple Container to Docker for cross-platform support. Use when the user wants Linux support, Docker, cross-platform deployment, or to replace Apple Container while preserving the current single-channel direct-chat architecture.
---

# Convert to Docker

This skill migrates ChessClaw from Apple Container to Docker.

The target architecture must stay the same:
- one assistant workspace
- one configured assistant chat
- one persistent Codex session
- one message queue
- one host-mounted SQLite database file
- no multi-channel or multi-chat redesign

What changes:
- runtime command: `container` -> `docker`
- startup health checks: Apple Container -> Docker
- image build command: `container build` -> `docker build`
- run/test commands: `container run` -> `docker run`

What must stay intact:
- the current single-channel direct-chat model
- the host DB mount exposed through `CHESSCLAW_DATABASE_PATH`
- the in-container chess tooling copied into the image
- the assistant/runtime/session/IPC flow

## Prerequisites

Verify Docker is installed and running:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker ready" || echo "Install Docker first"
```

If Docker is not installed:
- macOS: install Docker Desktop from https://docker.com/products/docker-desktop
- Linux: install Docker Engine and start the daemon

## 1. Update Runtime Commands

Edit `src/container-runner.ts` so container execution uses Docker.

Required changes:
- replace `spawn('container', ...)` with `spawn('docker', ...)`
- replace `container stop ...` with `docker stop ...`
- keep `--rm`
- keep container naming
- preserve the current `CHESSCLAW_DATABASE_PATH` env wiring

When converting mount syntax:
- writable bind mounts become `-v host:container`
- readonly mounts become `-v host:container:ro`

Do not remove the host DB file mount. The Docker version must still mount the host database file directly into the container and keep `CHESSCLAW_DATABASE_PATH` pointing at that mounted file.

## 2. Update Startup Checks

Edit `src/index.ts`:
- replace Apple Container startup checks with `docker info`
- replace Apple Container-specific fatal messages with Docker-specific ones
- replace orphan cleanup commands from `container ls` / `container stop` to Docker equivalents such as `docker ps` / `docker stop`

The cleanup behavior should remain:
- detect stale ChessClaw containers from previous runs
- stop them on startup

## 3. Update Build Script

Edit `container/build.sh`:
- replace `container build` with `docker build`
- keep using the repo root as build context
- preserve `-f container/Dockerfile .`

The build should still work from the repo root because the image needs:
- `backend/`
- `assets/`
- `data/sql`
- `data/chess-openings`

Update the smoke-test example to use:

```bash
echo '{}' | docker run -i chessclaw-agent:latest
```

or:

```bash
echo '{}' | docker run -i --entrypoint /bin/echo chessclaw-agent:latest "Container OK"
```

## 4. Preserve Current Dockerfile Behavior

Do not simplify the current Dockerfile into a Node-only image.

The Docker version must preserve the current behavior:
- install Node dependencies for the agent runner
- install Python and pip
- install `sqlite3`
- install `stockfish`
- copy `backend/`, `assets/`, and required `data/` resources into the image
- keep the entrypoint exporting `CHESSCLAW_DATABASE_PATH`

If the Dockerfile already matches this model, keep it and only make the runtime use Docker.

## 5. Update Documentation

Update docs so they no longer describe Apple Container as the active runtime.

Expected targets:
- `README.md`
- `AGENTS.md`
- `docs/REQUIREMENTS.md`
- `docs/SPEC.md`
- `docs/HOW_IT_WORKS.md`
- `.codex/skills/setup/SKILL.md`
- `.codex/skills/debug/SKILL.md`

Key conventions to preserve:
- project name is `ChessClaw`
- image name is `chessclaw-agent`
- launchd/macOS-specific service docs may remain only where relevant to macOS host setup
- the assistant uses one direct chat with the bot, not group-chat routing

## 6. Update Skills

### Setup skill

The setup skill should switch from Apple Container install/verification to Docker install/verification.

It should:
- check `docker --version`
- check `docker info`
- build with the Docker-based `container/build.sh`
- verify the `chessclaw-agent` image

### Debug skill

The debug skill should switch runtime diagnostics from Apple Container commands to Docker equivalents.

It should:
- use `docker ps`, `docker info`, `docker logs`, `docker stop`
- keep current ChessClaw naming
- keep direct-chat assumptions

## 7. Verification

After the conversion, verify:

```bash
npm run build
./container/build.sh
docker images | grep chessclaw-agent
echo '{}' | docker run -i --entrypoint /bin/echo chessclaw-agent:latest "Container OK"
```

Also verify:
- the host DB file is still mounted into the container
- `CHESSCLAW_DATABASE_PATH` is still set correctly inside the container
- the chess scripts inside the image can still read and write the host database

## 8. Integration Test

Run the app and verify:
- the bot connects normally
- a direct message in the configured assistant chat is processed
- the response comes back correctly
- session continuity still works
- scheduled tasks still run

## Important Constraint

This skill must preserve the current architecture while swapping runtimes.

Do not:
- reintroduce multi-channel routing
- reintroduce group registration or `registered_groups`
- reintroduce trigger-word assumptions as a default setup convention
- remove the host database mount model
- remove the in-container chess tooling
