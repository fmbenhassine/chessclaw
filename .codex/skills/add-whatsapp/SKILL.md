---
name: add-whatsapp
description: Replace the current messaging transport with WhatsApp as the single messaging channel for ChessClaw. Use when the user wants WhatsApp to be the only communication channel in the current single-channel architecture.
---

# Replace Current Transport With WhatsApp

This skill updates ChessClaw so that WhatsApp is the only live messaging transport.

It is intended for the current single-channel architecture. Use it when the user wants to:

- keep the existing WhatsApp runtime and set it up cleanly
- switch a fork back from Telegram or another transport to WhatsApp
- make WhatsApp the only assistant channel

Do not preserve any old multi-channel or multi-chat design. The target architecture is:

- one direct WhatsApp chat as the assistant channel
- one assistant workspace
- one persistent session
- no parallel Telegram or secondary transport runtime

## What This Skill Should Do

When executed, this skill should transform or confirm the codebase so that:

1. WhatsApp is the only live messaging transport
2. The single-channel runtime stays intact
3. The assistant still uses:
   - `assistant/AGENTS.md`
   - `assistant/`
   - `data/session/.codex/`
   - `data/ipc/`
4. The request lifecycle remains:
   - transport ingest
   - SQLite persistence
   - single message queue
   - Apple container
   - Codex thread
   - transport reply

Do not reintroduce:

- group registration
- `registered_groups`
- per-chat folders
- per-chat sessions
- per-chat queueing
- chat privilege models

## Questions To Ask

Before editing code, ask the user:

1. Should the assistant use the authenticated WhatsApp self-chat, or one explicit direct 1:1 chat JID?
2. If not the self-chat, what exact WhatsApp JID should be used?

## Prerequisites

### 1. Install WhatsApp Dependencies

If the repo does not already include the WhatsApp transport dependencies, install them:

```bash
npm install @whiskeysockets/baileys qrcode-terminal
npm install -D @types/qrcode-terminal
```

If the current fork already has these dependencies, do not duplicate or replace them.

### 2. Authenticate With WhatsApp

Tell the user:

> I need you to authenticate ChessClaw with WhatsApp.
>
> 1. Run `npm run auth`
> 2. Open WhatsApp on your phone
> 3. Go to Settings -> Linked Devices -> Link a Device
> 4. Scan the QR code shown in the terminal

Wait for successful authentication before continuing.

### 3. Identify Assistant Chat

Tell the user:

> Send a message in the direct WhatsApp chat you want ChessClaw to use.
>
> If `ASSISTANT_CHAT_JID` is not set, ChessClaw can fall back to your authenticated self-chat.
> If you want a specific direct chat, we should set `ASSISTANT_CHAT_JID` explicitly.

## Target Code Changes

Apply changes only to support the single-channel WhatsApp architecture.

### Step 1: Update Root Dependencies

Ensure the root app depends on WhatsApp transport packages and does not keep an unused alternative transport:

```bash
npm install @whiskeysockets/baileys qrcode-terminal
npm install -D @types/qrcode-terminal
```

If Telegram or another transport was previously added, remove the no-longer-used transport dependency from the root app.

Keep SQLite, cron, pino, and the rest of the single-channel runtime intact.

### Step 2: Update Configuration

Modify `src/config.ts` so transport configuration is WhatsApp-specific.

Ensure it includes:

```typescript
export const ASSISTANT_CHAT_JID = process.env.ASSISTANT_CHAT_JID || '';
```

Keep:

- container/session/path settings

Do not add trigger-word configuration or multiple active transport settings.

### Step 3: Keep The Existing Single-Channel Database Model

Use the existing single-channel message storage model in `src/db.ts`.

Do not add:

- transport-specific chat registration tables
- per-chat session tables
- per-channel queue state

If a previous transport introduced a helper like `storeMessageDirect`, it is acceptable to keep it only if it still fits the same single-channel schema.

### Step 4: Ensure A WhatsApp Transport Module Exists

The WhatsApp transport should be responsible for:

- connecting through Baileys
- receiving incoming messages
- storing assistant-chat messages in SQLite
- sending outgoing WhatsApp messages
- reconnecting when appropriate
- shutting down cleanly

If the repo already has this logic in `src/index.ts`, it is acceptable to keep it there.

If a previous transport refactor extracted transport code into a separate module, it is acceptable to reintroduce a dedicated WhatsApp module such as `src/whatsapp.ts`, but only if that keeps the single-channel runtime clear.

Required behavior:

- incoming messages for the configured assistant chat are stored in SQLite
- only one assistant chat is active
- the runtime can use explicit `ASSISTANT_CHAT_JID`
- self-chat fallback may remain if the user wants that behavior
- the supported shape is direct chat, not group chat
- non-text messages should be stored using placeholders

### Step 5: Update `src/index.ts`

Refactor the transport layer only. Preserve the single-channel request pipeline.

#### Replace Alternate Transport Code

Remove any no-longer-used Telegram or alternate transport code such as:

- bot startup logic
- alternate transport auth handling
- alternate transport outgoing message code
- alternate chat ID translation logic

Restore or preserve WhatsApp equivalents using Baileys.

#### Preserve The Single-Channel Flow

Keep:

- SQLite-backed polling
- `processChannelMessages`
- `MessageQueue`
- `runAgent`
- scheduler startup
- IPC watcher
- recovery logic

The transport layer should only:

- write incoming messages into SQLite
- send responses back out

#### Assistant Channel Initialization

Ensure assistant channel initialization is WhatsApp-specific:

- the assistant channel comes from `ASSISTANT_CHAT_JID`, if configured
- otherwise the runtime may fall back to the authenticated self-chat
- there is still only one assistant channel

Do not add support for multiple WhatsApp chats at once.
Do not add group-chat-only behaviors.

### Step 6: Update Setup Flow

Update `.codex/skills/setup/SKILL.md` so setup is WhatsApp-native.

It should:

- keep `npm run auth`
- keep QR-based WhatsApp authentication
- collect `ASSISTANT_CHAT_JID` only when needed
- explain self-chat fallback vs explicit direct-chat selection
- test WhatsApp connectivity after auth

The setup flow should not mention Telegram or any alternate live transport unless the user is explicitly converting away from it.

### Step 7: Update Documentation

When the actual skill is executed, it should update docs so they match WhatsApp as the only messaging channel.

Targets include:

- `README.md`
- `AGENTS.md`
- `docs/REQUIREMENTS.md`
- `docs/SECURITY.md`
- `docs/SPEC.md`
- `docs/HOW_IT_WORKS.md`

Replace alternate transport descriptions with WhatsApp-specific ones, while preserving the same single-channel architecture.

### Step 8: Remove Alternate Transport Runtime Code

When applying the transformation, remove now-unused alternate transport code paths such as:

- transport modules like `src/telegram.ts`
- alternate transport imports/usages in `src/index.ts`
- alternate transport env vars from `src/config.ts`
- alternate transport dependencies from root `package.json`

Do this only when the user actually runs the skill. This skill file should instruct that transformation; it should not perform it by itself.

## Behavior Requirements

### Triggering

The current convention is direct-chat operation without a trigger word.

Do not preserve `ASSISTANT_NAME`-style mention triggers when converting to WhatsApp unless the user explicitly asks for that behavior.

### Chat ID Format

Use one stable assistant chat identifier format based on WhatsApp JIDs, for example:

- self-chat: `<phone>@s.whatsapp.net`
- direct chat: `<phone>@s.whatsapp.net`

The assistant state should store exactly one active assistant chat ID.

### Non-Text Messages

Store placeholders such as:

- `[Image]`
- `[Video]`
- `[Voice message]`
- `[Document: filename]`

This keeps the request pipeline consistent without requiring full media ingestion.

## Testing Checklist

When the skill is executed later, it should instruct verification of:

1. WhatsApp authentication succeeds
2. the runtime connects through Baileys
3. incoming WhatsApp messages appear in SQLite
4. the single-channel polling loop picks them up
5. responses are sent back to WhatsApp
6. scheduled tasks still run and message the same WhatsApp chat
7. assistant session continuity still works across turns

## Removal Instructions

If the user later wants to remove WhatsApp support after applying this skill:

1. delete any dedicated WhatsApp transport module if one was introduced
2. remove WhatsApp transport imports from `src/index.ts`
3. remove `ASSISTANT_CHAT_JID` and any WhatsApp-only config from `src/config.ts`
4. remove Baileys and QR dependencies from `package.json`
5. update docs and setup flow again

## Important Constraint

This skill must transform the current architecture, not the old one.

If you find instructions in this file or elsewhere that assume:

- registered groups
- `registerGroup()`
- `registered_groups`
- per-chat folders
- multiple channels at once
- group-specific privilege models

you must replace them with the current single-channel direct-chat model instead of preserving them.
