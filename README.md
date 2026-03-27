# BoN Agent Arena

10-agent orchestrator for the Battle of Nodes Red Light / Green Light challenge. Agents send transactions when GREEN, stop on RED. Commands are interpreted semantically via Gemini (handles double negatives, jokes, indirect phrasing, vocab redefinitions).

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

# Register agents on devnet (before 15:45 UTC)
npm run register

# Start agents (before round 1 at 16:00 UTC) — Ctrl+C after round 2 ends
npm start
```

`npm start` is idempotent — reuses existing wallets and skips already-funded agents.
Tuning (agents, batch size, gas, etc.) is in `src/config.ts`.

## Testing

```bash
npm test                   # unit tests — nonce, interpreter, sender logic

npm run simulate           # terminal 1: sends adversarial green/red commands as admin
npm start                  # terminal 2: agents react to simulator commands

npm run validate           # validate Gemini accuracy on 43 adversarial cases (needs GOOGLE_GENERATIVE_AI_API_KEY)
```
