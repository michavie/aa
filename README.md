# BoN Agent Arena

10-agent orchestrator for the Battle of Nodes Red Light / Green Light challenge. Agents send transactions when GREEN, stop on RED. Commands are interpreted semantically via Gemini, and the runner pauses immediately on every new admin command until semantic classification completes.

## Setup

```bash
cp .env.example .env   # fill in GL_PRIVATE_KEY_HEX + GOOGLE_GENERATIVE_AI_API_KEY
npm install
```

## Challenge day

```bash
# As early as possible — generates wallets, waits for GL funding, funds agents
npm start

# Once ADMIN_WALLET_ADDRESS + TARGET_WALLET_ADDRESS are announced (~15:00 UTC):
# → add them to .env

# Build a manifest if you have manifest.config.json
npm run build:manifest

# Register agents on BON (before 15:45 UTC)
npm run register

# Start agents (before round 1 at 16:00 UTC) — Ctrl+C after round 2 ends
npm start
```

`npm start` is idempotent — reuses existing wallets and skips already-funded agents.
Tuning (agents, batch size, gas, etc.) is in `src/config.ts`.

## Safety rails

- The runner stops sending outside the configured UTC round windows.
- The runner stops sending when the configured agent fee budget is exhausted.
- Every new admin message pauses senders first, then the LLM decides whether to resume.

Relevant `.env` knobs:

```bash
ROUND1_START_UTC=2026-03-27T16:00:00Z
ROUND1_END_UTC=2026-03-27T16:30:00Z
ROUND2_START_UTC=2026-03-27T17:00:00Z
ROUND2_END_UTC=2026-03-27T17:30:00Z
MAX_AGENT_FEE_BUDGET_ATTO=500000000000000000000
ENFORCE_SCHEDULE=1
AGENT_BASE_URI=https://agent.molt.bot
```

## Local verification

Use the local runner if you want to exercise the bot against a funded simulated admin wallet on BON without waiting for a full guild-leader setup:

```bash
npm run arena:local
```

## Testing

```bash
npm test                   # unit tests — nonce, interpreter, sender logic
npm run type-check         # TypeScript compile check

npm run simulate           # terminal 1: sends adversarial green/red commands as admin
npm run arena:local        # terminal 2: agents react to simulator commands

npm run validate           # validate Gemini accuracy on 108 adversarial cases (needs GOOGLE_GENERATIVE_AI_API_KEY)
```

## Registration note

This repo now supports:

- `manifest.config.json` -> `manifest.json` via `npm run build:manifest`
- `agent.config.json` input for `manifestUri`, metadata, and services during `npm run register`

It still does not pin manifests to IPFS for you. For challenge-day registration, populate `agent.config.json` with a real `manifestUri` before running `npm run register`.
