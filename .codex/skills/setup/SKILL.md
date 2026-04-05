---
name: setup
description: Run initial ChessClaw setup for Codex. Use for first-time install, Telegram bot setup, assistant chat configuration, and launchd service start.
---

# ChessClaw Setup (Codex)

Run commands directly. Pause only when user action is required (Telegram bot setup, chat discovery, runtime install, auth choice).

## 1. Install Dependencies

```bash
npm install
```

## 2. Confirm Apple Container Runtime

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
```

If the platform is not macOS, stop and tell the user this base setup flow targets Apple Container on macOS.

If Apple Container is missing, ask user to install from:
- https://github.com/apple/container/releases

Then verify:

```bash
container system start
container --version
```

## 3. Configure Codex Authentication

Ask user which path they want:

1. Codex login/subscription (recommended)
2. API key in `.env`

### Option A: Codex login/subscription

Tell user to run in another terminal:

```bash
codex login
```

Then proceed. ChessClaw will copy host `~/.codex/auth.json` into the assistant session directory automatically.

### Option B: API key

Create `.env` with one of:

```bash
echo 'OPENAI_API_KEY=' > .env
# or
echo 'CODEX_API_KEY=' > .env
```

Optional overrides (only if needed):

```bash
cat >> .env << 'EOF_ENV'
OPENAI_BASE_URL=
OPENAI_ORG_ID=
OPENAI_PROJECT_ID=
EOF_ENV
```

Validate:

```bash
grep -E '^(OPENAI_API_KEY|CODEX_API_KEY)=' .env || echo "No key configured"
```

## 4. Build Container Image

```bash
./container/build.sh
```

Smoke test:

```bash
echo '{}' | container run -i --entrypoint /bin/echo chessclaw-agent:latest "Container OK"
```

## 5. Create Telegram Bot

Tell the user:

> I need a Telegram bot token for ChessClaw.
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot`
> 3. Choose a bot name
> 4. Choose a bot username ending in `bot`
> 5. Copy the bot token

Wait for the token before continuing.

## 6. Configure Assistant Chat

- ChessClaw uses exactly one Telegram chat as the assistant channel.
- The expected setup is a direct private chat between the user and the bot.

Write Telegram config to `.env`:

```bash
cat >> .env << 'EOF_ENV'
TELEGRAM_BOT_TOKEN=
ASSISTANT_CHAT_ID=
EOF_ENV
```

Tell the user to message the bot in the target Telegram chat.

Build and run ChessClaw so `/chatid` is available:

```bash
npm run build
npm run dev
```

Then tell the user:

> In Telegram, send `/chatid` to the bot in the chat you want ChessClaw to use.
> Copy the returned `tg:<id>` value into `ASSISTANT_CHAT_ID`.

Notes:

- `ASSISTANT_CHAT_ID` should use the exact `tg:<id>` value returned by `/chatid`.
- The assistant is expected to operate only in its direct chat with the user.

If assistant name or behavior instructions changed, update:
- `assistant/AGENTS.md`

Do not create `CLAUDE.md` compatibility files.

## 7. Configure launchd Service (macOS)

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

mkdir -p ~/Library/LaunchAgents
sed \
  -e "s|{{NODE_PATH}}|${NODE_PATH}|g" \
  -e "s|{{PROJECT_ROOT}}|${PROJECT_PATH}|g" \
  -e "s|{{HOME}}|${HOME_PATH}|g" \
  launchd/dev.chessclaw.plist > ~/Library/LaunchAgents/dev.chessclaw.plist

npm run build
mkdir -p logs
launchctl unload ~/Library/LaunchAgents/dev.chessclaw.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/dev.chessclaw.plist
launchctl list | grep chessclaw
```

## 8. Test

Tell user to send:

- Assistant private chat: `hello`

Watch logs:

```bash
tail -f logs/chessclaw.log
```

## 9. Initialize Chess Database (FYI)

After the assistant runtime is working, tell the user that the chess database should be initialized on the host.

Run:

```bash
python3 backend/setup-database.py
```

This is a host-side setup step. It creates the SQLite database if needed and loads the bundled opening data. Do not ask the user to run any game analysis during setup.

## 10. Optionally Download Games

Ask the user whether they want to download games now from:

1. Lichess.org
2. Chess.com

For each platform the user wants:

- ask for the username
- store it in `.env` for runtime enforcement:
  - `CHESSCLAW_LICHESS_USERNAME=<username>`
  - `CHESSCLAW_CHESSCOM_USERNAME=<username>`
- run the matching first-time import flow so games are downloaded and ingested into the database

Examples:

```bash
python3 backend/download-games.py <username> --platform lichess --mode init
python3 backend/download-games.py <username> --platform chesscom --mode init
```

Then ingest the downloaded PGN files into the database.

Typical flow:

```bash
python3 backend/download-games.py <username> --platform lichess --mode init
python3 backend/ingest-games.py data/games/lichess-<username>-games/lichess-<username>.pgn
```

```bash
python3 backend/download-games.py <username> --platform chesscom --mode init
python3 backend/ingest-games.py
```

After ingesting, tell the user where the downloaded PGN files were written.

Do not run `analyze-games.py` during setup.

## Troubleshooting

- Service not starting: `logs/chessclaw.error.log`
- Runtime failures: `assistant/logs/container-*.log`
- Auth problems: run `codex login` or add `OPENAI_API_KEY`/`CODEX_API_KEY` in `.env`
- Telegram issues: verify `TELEGRAM_BOT_TOKEN`, confirm the bot is running, then restart service:

```bash
launchctl kickstart -k gui/$(id -u)/dev.chessclaw
```
