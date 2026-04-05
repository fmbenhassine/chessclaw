# ChessClaw

Personal Codex assistant. See [README.md](README.md) for setup and usage. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Telegram, routes messages to Codex SDK running in Apple Container (Linux VMs). One configured chat talks to one assistant workspace.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: Telegram connection, single-channel routing, IPC |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/telegram.ts` | Telegram transport and message delivery |
| `assistant/AGENTS.md` | Assistant memory and behavior instructions |

## Operating Notes

- Prefer `assistant/AGENTS.md` for runtime instructions and memory.
- Run commands directly when asked; do not hand off command execution.

## Slash Commands

Treat these commands as aliases:

- `/setup` -> execute `.codex/skills/setup/SKILL.md`
- `/customize` -> execute `.codex/skills/customize/SKILL.md`
- `/debug` -> execute `.codex/skills/debug/SKILL.md`

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

```bash
launchctl load ~/Library/LaunchAgents/dev.chessclaw.plist
launchctl unload ~/Library/LaunchAgents/dev.chessclaw.plist
```

## Container Build Cache

Apple Container's build cache can retain stale COPY layers. For a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Verify rebuilt source was copied:

```bash
container run -i --rm --entrypoint wc chessclaw-agent:latest -l /app/src/index.ts
```
