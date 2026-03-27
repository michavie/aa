/**
 * All non-secret configuration lives here.
 * Secrets (private keys, API keys) stay in .env.
 * Edit this file to tune agent behaviour.
 */
export const CONFIG = {
  // ─── Networks ─────────────────────────────────────────────────────────────
  // Battle of Nodes — main competition network (TX sending + monitoring)
  BON_API:        "https://api.battleofnodes.com",
  BON_CHAIN:      "BON-1",

  // ─── Contracts ────────────────────────────────────────────────────────────
  REGISTRY_ADDRESS: "erd1qqqqqqqqqqqqqpgq4mar8ex8aj2gnc0cq7ay372eqfd5g7t33frqcg776p",

  // ─── Agent setup ──────────────────────────────────────────────────────────
  NUM_AGENTS:     10,
  EGLD_PER_AGENT: BigInt("40000000000000000000"), // 40 EGLD in attoEGLD

  // ─── TX parameters ────────────────────────────────────────────────────────
  GAS_LIMIT:  BigInt(50_000),
  GAS_PRICE:  BigInt(1_000_000_000),
  FUND_GAS:   BigInt(60_000),
  REG_GAS:    BigInt(30_000_000),

  // ─── Throughput tuning ────────────────────────────────────────────────────
  // 10 agents × BATCH_SIZE TXs every SEND_INTERVAL_MS ≈ peak TXs/sec
  POLL_INTERVAL_MS: 500,  // poll just under one block (600ms) — commands can only land once/block
  SEND_INTERVAL_MS: 60,   // how often to fire a TX batch (per agent) — 10 fires per 600ms block
  BATCH_SIZE:       9,    // 9 TXs × 10 fires = 90/block — safe under 99 TX/account/block limit

  // ─── LLM ──────────────────────────────────────────────────────────────────
  GEMINI_MODEL:   "gemini-3.1-flash-lite-preview",
  LLM_TIMEOUT_MS: 2_500,
} as const;
