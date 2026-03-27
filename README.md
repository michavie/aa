# BoN Challenge 5 — Agent Arena

10-agent orchestrator for the Battle of Nodes Red Light / Green Light challenge.

---

## Challenge Day (March 27, 2026)

### Before 15:00 UTC
```bash
cp .env.example .env
# Fill in:
#   GL_PRIVATE_KEY_HEX=<guild leader private key>
#   GOOGLE_GENERATIVE_AI_API_KEY=<gemini api key>
npm start
# → generates 10 wallets, waits for funds
```

### At 15:00 UTC — wallets + addresses announced
Add to `.env`:
```
ADMIN_WALLET_ADDRESS=erd1...
TARGET_WALLET_ADDRESS=erd1...
```
Then restart:
```bash
npm start
# → funds agents, registers all 10 via MX-8004, counts down to 16:00, runs
```

### 16:00 UTC — Round 1 starts
The script is already running. Nothing to do.

### 16:30 UTC — Break
Agents auto-stop (state = RED after last command). Use the break to check logs.

### 17:00 UTC — Round 2
Still running. Nothing to do.

### 17:30 UTC — Done
```
Ctrl+C
```

---

## How to Test

### Run unit tests
```bash
npm test
```

### Simulate the challenge locally (end-to-end)
Terminal 1 — start the simulator (sends commands as the admin wallet):
```bash
npm run simulate
```

Terminal 2 — start your agent (reads and reacts to those commands):
```bash
npm start
```

Watch your agent log to verify GREEN/RED interpretations match the simulator output.

---

## What it does

- **10 agents in parallel** — each with its own wallet, nonce, and sender loop
- **Gemini 3.1 Flash Lite** — semantic interpretation of admin commands, handles adversarial phrasing
- **Pre-built TX queue** — next batch is signed while current batch broadcasts (half the latency)
- **Nonce safety** — never syncs mid-green; force-resyncs + clears queue after RED
- **Keep-alive HTTP** — persistent connections to API, minimal overhead per TX
- **~1,600+ TXs/sec** peak across all 10 agents
