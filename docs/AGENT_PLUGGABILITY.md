# Agent Pluggability

This document outlines the minimum refactor needed to make the agent layer pluggable without changing current ChessClaw behavior.

## Goal

Keep the current product behavior the same while making it possible to replace Codex with another coding agent later.

The intent is not to redesign the whole system. The intent is to isolate the Codex-specific parts behind a narrow adapter boundary.

## What Should Stay Unchanged

These parts of the system are already generic enough and should remain as they are:

- Telegram integration
- host message routing
- SQLite-backed app state
- scheduled tasks
- container lifecycle management
- assistant workspace layout
- host-backed chess MCP tools

In other words, the host runtime and chess tooling should stay intact. The refactor should focus on the container-side agent execution path.

## Target Shape

The host should talk to a generic agent session contract rather than directly depending on Codex concepts.

That contract should support:

- starting a session
- resuming a session
- running a prompt
- streaming text results
- returning an updated session identifier
- returning an error when the run fails

The current host-side output format can remain unchanged:

- `status`
- `result`
- `newSessionId`
- `error`

That preserves compatibility with the existing host logic.

## Minimum Refactor

### 1. Define a Generic Agent Session Contract

Replace the current implicit "Codex thread" model with a generic session model.

The generic interface should cover operations such as:

- `startSession()`
- `resumeSession(sessionId)`
- `run(prompt, options)`

The generic runner should not know anything about Codex thread types or Codex event names.

### 2. Extract Codex-Specific Logic Into an Adapter

Split the current container-side runner into:

- a generic runner loop
- a Codex-specific adapter

The generic runner should remain responsible for:

- reading stdin
- writing framed output records
- handling IPC follow-up messages
- reacting to the close sentinel
- archiving conversation turns

The Codex adapter should own:

- `@openai/codex-sdk` imports
- Codex client construction
- thread creation and resumption
- streamed event handling
- translation from Codex events into generic streamed results

### 3. Add an `AGENT_PROVIDER` Selector

Introduce an environment/config value such as:

- `AGENT_PROVIDER=codex`

The generic runner should load the selected provider adapter.

Initially there only needs to be one provider implementation:

- `codex`

This keeps current behavior exactly the same while establishing a clean extension point.

### 4. Generalize Session Storage Naming

The current code stores provider state under a Codex-specific directory name:

- `.codex`

That naming should be generalized conceptually to something like:

- `AGENT_STATE_DIR`

For the first step, the underlying on-disk layout can stay unchanged for Codex. The important change is to stop hard-coding the provider name into the architecture model.

### 5. Move Provider-Specific Auth and Config Bootstrapping Behind the Adapter

The current host container setup copies Codex-specific files such as:

- `~/.codex/auth.json`
- `~/.codex/config.toml`

That behavior should be isolated behind provider-specific preparation logic.

For the first pass:

- keep the current Codex behavior
- move it into a provider-specific bootstrap function

This keeps the host runtime generic while preserving the existing authentication flow.

### 6. Make the Container Image Provider-Aware

The current container image installs Codex-specific tooling.

That should be treated as the implementation detail of the `codex` provider, not as a permanent property of the whole architecture.

The minimum refactor does not require building multiple images yet. It only requires making the image and runtime assumptions explicit and provider-scoped.

### 7. Leave MCP and Assistant Instructions Alone

These pieces should stay as they are:

- host-backed chess MCP tools
- assistant instructions in `assistant/AGENTS.md`

They are already sufficiently agent-agnostic for the current architecture.

## Suggested File Split

A minimal file split could look like this:

- `container/agent-runner/src/index.ts`
  - generic runner loop only
- `container/agent-runner/src/agent-provider.ts`
  - shared provider interface and common types
- `container/agent-runner/src/providers/codex.ts`
  - Codex adapter implementation
- host-side provider bootstrap helper
  - provider-specific auth/config/session preparation

This is enough to make the agent boundary explicit without broad code churn.

## Highest-Value First Changes

If the goal is the smallest possible refactor with the best long-term payoff, do these first:

1. Extract all Codex SDK usage from the current container runner into a dedicated adapter.
2. Introduce `AGENT_PROVIDER=codex`.
3. Replace hard-coded `.codex` assumptions with neutral provider-state helpers.

These three steps create a real pluggability boundary while keeping runtime behavior unchanged.

## Expected Outcome

After this refactor:

- the host runtime remains unchanged in behavior
- the current Codex provider still works the same way
- adding another coding agent becomes an adapter implementation task instead of a runtime rewrite

That is the minimum viable path to making ChessClaw's agent layer pluggable.
