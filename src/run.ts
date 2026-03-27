/**
 * BoN Agent Arena — Full Orchestrator
 *
 * ONE script. Run `npm start`. It handles everything:
 *   1. Generate 10 agent wallets (saved to agents.json, idempotent on reruns)
 *   2. Wait for GL wallet to receive funds (polls until 15:00 distribution arrives)
 *   3. Distribute EGLD from GL wallet to each agent wallet
 *   4. Register all agents via MX-8004 registry contract
 *   5. Count down to round start (16:00 UTC)
 *   6. Run all 10 agents in parallel:
 *        - ONE shared monitor loop  (admin commands → LLM → GREEN/RED state)
 *        - TEN parallel sender loops (each wallet fires its own TX batches)
 *
 * Performance notes:
 *  - Nonce is ONLY synced at startup and after GREEN→RED (never mid-green)
 *  - Signing is done in parallel across agents (each has its own signer instance)
 *  - Broadcast uses axios keep-alive + pipeline for minimal latency
 *  - Pre-built TX objects are queued ahead of send interval to minimise sign latency
 *  - BATCH_SIZE * 10 agents = effective parallelism per tick
 *
 * Setup:
 *   cp .env.example .env   # add GL_PRIVATE_KEY_HEX + GOOGLE_GENERATIVE_AI_API_KEY
 *                          # add ADMIN/TARGET after 15:00 UTC announcement
 *   npm start
 */

import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { UserSigner, UserSecretKey, Mnemonic } from "@multiversx/sdk-wallet";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import axios, { AxiosInstance } from "axios";
import * as http from "http";
import * as https from "https";
import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as path from "path";

loadEnv();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const API_URL       = process.env.MULTIVERSX_API_URL           || "https://api.battleofnodes.com";
const CHAIN_ID      = process.env.CHAIN_ID                     || "BON-1";
const GOOGLE_KEY    = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
const ADMIN_WALLET  = process.env.ADMIN_WALLET_ADDRESS         || "";
const TARGET_WALLET = process.env.TARGET_WALLET_ADDRESS        || "";
const GL_KEY        = process.env.GL_PRIVATE_KEY_HEX           || "";
const REGISTRY_ADDR = process.env.IDENTITY_REGISTRY_ADDRESS
  || "erd1qqqqqqqqqqqqqpgq4mar8ex8aj2gnc0cq7ay372eqfd5g7t33frqcg776p";

const NUM_AGENTS    = parseInt(process.env.NUM_AGENTS       || "10");
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS || "250");
const BATCH_SIZE    = parseInt(process.env.SEND_BATCH_SIZE  || "10");
const SEND_MS       = parseInt(process.env.SEND_INTERVAL_MS || "60");

// 40 EGLD per agent in attoEGLD (= 40 * 10^18)
const EGLD_PER_AGENT = BigInt(process.env.EGLD_PER_AGENT || "40000000000000000000");

const GAS_LIMIT  = BigInt(50_000);
const GAS_PRICE  = BigInt(1_000_000_000);
const FUND_GAS   = BigInt(60_000);
const REG_GAS    = BigInt(25_000_000); // from starter kit REGISTER gas limit

const AGENTS_FILE      = path.resolve(__dirname, "..", "agents.json");
const ROUND1_START_UTC = new Date("2026-03-27T16:00:00Z").getTime();

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  isGreenLight:   false,
  lastSeenTxHash: "",
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP CLIENT (keep-alive for low-latency repeated requests)
// ─────────────────────────────────────────────────────────────────────────────

const client: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 4_000,
  headers: { "Content-Type": "application/json" },
  httpAgent:  new http.Agent ({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
});

// ─────────────────────────────────────────────────────────────────────────────
// SIGNING
// ─────────────────────────────────────────────────────────────────────────────

const txComputer = new TransactionComputer();

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

const ts  = () => new Date().toISOString().slice(11, 23);
const log  = (msg: string) => console.log( `[${ts()}] ${msg}`);
const warn = (msg: string) => console.warn(`[${ts()}] ⚠️  ${msg}`);

// ─────────────────────────────────────────────────────────────────────────────
// WALLET TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface AgentWallet {
  index: number;
  address: string;
  privateKeyHex: string;
  mnemonic: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — GENERATE / LOAD WALLETS
// ─────────────────────────────────────────────────────────────────────────────

function generateWallets(): AgentWallet[] {
  if (fs.existsSync(AGENTS_FILE)) {
    const existing: AgentWallet[] = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
    log(`Loaded ${existing.length} existing wallets from agents.json`);
    return existing;
  }

  log(`Generating ${NUM_AGENTS} agent wallets...`);
  const wallets: AgentWallet[] = [];
  for (let i = 0; i < NUM_AGENTS; i++) {
    const mnemonic   = Mnemonic.generate();
    const secretKey  = mnemonic.deriveKey(0);
    const address    = secretKey.generatePublicKey().toAddress().bech32();
    wallets.push({ index: i, address, privateKeyHex: secretKey.hex(), mnemonic: mnemonic.toString() });
    log(`  A${i}: ${address}`);
  }

  fs.writeFileSync(AGENTS_FILE, JSON.stringify(wallets, null, 2));
  log(`Saved to agents.json — back this file up!`);
  return wallets;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — WAIT FOR GL WALLET TO BE FUNDED (polls until > 100 EGLD)
// ─────────────────────────────────────────────────────────────────────────────

async function getGLAddress(): Promise<string> {
  return UserSecretKey.fromString(GL_KEY).generatePublicKey().toAddress().bech32();
}

async function waitForFunds(glAddress: string): Promise<void> {
  log(`GL wallet: ${glAddress}`);
  log(`Polling for funds (distributed at 15:00 UTC)...`);

  while (true) {
    try {
      const { data } = await client.get(`/accounts/${glAddress}`);
      const balance = BigInt(data.balance ?? "0");
      if (balance > BigInt("100000000000000000000")) {
        log(`GL funded: ${fmt(balance)} EGLD — proceeding`);
        return;
      }
      log(`GL balance: ${fmt(balance)} EGLD — waiting...`);
    } catch (e: any) {
      warn(`Balance check: ${e?.message}`);
    }
    await sleep(10_000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — FUND AGENTS FROM GL WALLET
// ─────────────────────────────────────────────────────────────────────────────

async function fundAgents(wallets: AgentWallet[], glAddress: string): Promise<void> {
  log(`Funding ${wallets.length} agents from GL wallet...`);

  const glSigner = new UserSigner(UserSecretKey.fromString(GL_KEY));
  const { data: acct } = await client.get(`/accounts/${glAddress}`);
  let glNonce = BigInt(acct.nonce);

  for (const w of wallets) {
    try {
      const { data: agentAcct } = await client.get(`/accounts/${w.address}`);
      if (BigInt(agentAcct.balance ?? "0") >= EGLD_PER_AGENT / 2n) {
        log(`  A${w.index} already funded — skip`);
        continue;
      }
    } catch { /* new account */ }

    const tx = new Transaction({
      nonce:    glNonce++,
      value:    EGLD_PER_AGENT,
      receiver: new Address(w.address),
      sender:   new Address(glAddress),
      gasLimit: FUND_GAS,
      gasPrice: GAS_PRICE,
      data:     Buffer.from("fund"),
      chainID:  CHAIN_ID,
      version:  1,
    });
    tx.signature = await glSigner.sign(txComputer.computeBytesForSigning(tx));

    try {
      const { data } = await client.post("/transactions", tx.toSendable());
      log(`  A${w.index} funded → ${data.txHash}`);
    } catch (e: any) {
      warn(`  A${w.index} fund failed: ${e?.response?.data?.error || e?.message}`);
    }
    await sleep(200);
  }

  log(`Waiting 15s for funding TXs to settle...`);
  await sleep(15_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — REGISTER AGENTS (MX-8004 registry)
// ─────────────────────────────────────────────────────────────────────────────

async function registerAgent(w: AgentWallet): Promise<void> {
  const secretKey = UserSecretKey.fromString(w.privateKeyHex);
  const signer    = new UserSigner(secretKey);
  const agentName = `BON-Agent-${w.index}`;

  // register_agent(name: bytes, uri: bytes, pubkey: bytes,
  //   metadata: counted-variadic<MetadataEntry>,
  //   services: counted-variadic<ServiceConfigInput>)
  // Each arg is hex-encoded; counted-variadic with 0 items = @00000000
  const dataStr = [
    "register_agent",
    Buffer.from(agentName).toString("hex"),
    Buffer.from(`https://agent.molt.bot/${agentName}`).toString("hex"),
    secretKey.generatePublicKey().hex(),
    "00000000", // 0 metadata entries
    "00000000", // 0 services entries
  ].join("@");

  const { data: acct } = await client.get(`/accounts/${w.address}`);
  const tx = new Transaction({
    nonce:    BigInt(acct.nonce),
    value:    BigInt(0),
    receiver: new Address(REGISTRY_ADDR),
    sender:   new Address(w.address),
    gasLimit: REG_GAS,
    gasPrice: GAS_PRICE,
    data:     Buffer.from(dataStr),
    chainID:  CHAIN_ID,
    version:  1,
  });
  tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));

  try {
    const { data } = await client.post("/transactions", tx.toSendable());
    log(`  A${w.index} registered → ${data.txHash}`);
  } catch (e: any) {
    warn(`  A${w.index} register failed: ${e?.response?.data?.error || e?.message}`);
  }
}

async function registerAllAgents(wallets: AgentWallet[]): Promise<void> {
  log(`Registering ${wallets.length} agents with MX-8004...`);
  for (const w of wallets) {
    await registerAgent(w);
    await sleep(400);
  }
  log(`Registration done.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM INTERPRETER — Gemini Flash (fast + cheap, one call per unique command)
// ─────────────────────────────────────────────────────────────────────────────

const interpretCache = new Map<string, "GREEN" | "RED">();
const gemini = google("gemini-3.1-flash-lite-preview", { apiKey: GOOGLE_KEY } as any);

async function interpret(rawCommand: string): Promise<"GREEN" | "RED"> {
  const key = rawCommand.trim().toLowerCase();
  if (interpretCache.has(key)) return interpretCache.get(key)!;

  try {
    const { text } = await Promise.race([
      generateText({
        model: gemini,
        maxTokens: 10,
        prompt: `You are the command interpreter for a "Red Light / Green Light" blockchain competition.

An admin sends plain-text commands to control whether agents should SEND or STOP sending transactions.
GREEN = send transactions (go, start, proceed, fire, unleash, continue, open, etc.)
RED   = stop all transactions (stop, halt, freeze, pause, wait, hold, cease, end, etc.)

Commands may be casual, creative, or adversarial — double negatives, irony, misdirection — designed to confuse keyword-matching bots.
Determine the TRUE FINAL INTENT: what does the admin actually want agents to do right now?
If uncertain, output RED (safe — being penalised for unpermitted sends is heavily penalised).

Reply with exactly one word: GREEN or RED

Command: "${rawCommand}"`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_500)),
    ]);

    const result: "GREEN" | "RED" = text.trim().toUpperCase().startsWith("GREEN") ? "GREEN" : "RED";
    interpretCache.set(key, result);
    log(`[LLM] "${rawCommand}" → ${result}`);
    return result;
  } catch (e: any) {
    warn(`LLM failed (${e?.message}) → RED`);
    return "RED";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MONITOR LOOP — watches admin wallet, updates shared state
// ─────────────────────────────────────────────────────────────────────────────

async function pollAdminCommands(senders: AgentSender[]): Promise<void> {
  if (!ADMIN_WALLET || !TARGET_WALLET) return;
  try {
    const { data } = await client.get(`/accounts/${ADMIN_WALLET}/transactions`, {
      params: { size: 10, order: "desc" },
    });
    const txs: any[] = Array.isArray(data) ? data : [];

    // Oldest-to-newest so state changes apply in order
    const newTxs: any[] = [];
    for (const tx of txs) {
      if (tx.txHash === state.lastSeenTxHash) break;
      newTxs.unshift(tx);
    }

    for (const tx of newTxs) {
      const receiver: string = tx.receiver || tx.receiverAddress || "";
      if (receiver.toLowerCase() !== TARGET_WALLET.toLowerCase()) continue;

      let command = "";
      try { command = tx.data ? Buffer.from(tx.data, "base64").toString("utf-8") : ""; }
      catch { command = tx.data || ""; }
      if (!command.trim()) continue;

      log(`📡 Command: "${command}"`);
      const intent  = await interpret(command);
      const newGreen = intent === "GREEN";

      if (newGreen !== state.isGreenLight) {
        const wasGreen = state.isGreenLight;
        state.isGreenLight = newGreen;

        if (newGreen) {
          console.log("\n🟢🟢🟢  GREEN LIGHT — FIRING  🟢🟢🟢\n");
        } else {
          console.log("\n🔴🔴🔴  RED LIGHT — STOPPED  🔴🔴🔴\n");
          // After going red: wait for pending TXs to settle, then force-resync all nonces.
          // force=true clears stale pre-built TX queues and accepts chain nonce even if
          // lower than localNonce (some TXs may not have confirmed or may have failed).
          if (wasGreen) {
            setTimeout(async () => {
              log("Force-resyncing nonces after red light...");
              await Promise.all(senders.map(s => s.syncNonce(true)));
            }, 3_000);
          }
        }
      }
    }

    if (txs.length > 0) state.lastSeenTxHash = txs[0].txHash;
  } catch (e: any) {
    warn(`Monitor: ${e?.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-AGENT SENDER CLASS
// ─────────────────────────────────────────────────────────────────────────────

class AgentSender {
  readonly index:   number;
  readonly address: string;
  readonly signer:  UserSigner;

  localNonce  = BigInt(0);
  nonceSynced = false;

  statTotal     = 0;
  statPermitted = 0;

  // Pre-built TX queue — we sign ahead of the send interval to cut latency
  private txQueue: object[] = [];
  private building = false;

  constructor(w: AgentWallet) {
    this.index   = w.index;
    this.address = w.address;
    this.signer  = new UserSigner(UserSecretKey.fromString(w.privateKeyHex));
  }

  // force=true: always accept chain nonce (use after RED — we've stopped, trust the chain).
  // force=false: only move nonce forward (use at startup to not clobber pending TXs).
  async syncNonce(force = false): Promise<void> {
    try {
      const { data } = await client.get(`/accounts/${this.address}`);
      const chainNonce = BigInt(data.nonce ?? 0);
      if (force || chainNonce > this.localNonce || !this.nonceSynced) {
        this.localNonce = chainNonce;
        this.nonceSynced = true;
        // Always clear the pre-built queue on a forced sync —
        // stale TXs have wrong nonces and would fail immediately.
        if (force) this.txQueue = [];
        log(`[A${this.index}] Nonce → ${this.localNonce}${force ? " (forced)" : ""}`);
      }
    } catch (e: any) {
      warn(`[A${this.index}] Nonce sync: ${e?.message}`);
    }
  }

  private nextNonce(): bigint { return this.localNonce++; }

  private async buildTx(nonce: bigint): Promise<object> {
    const tx = new Transaction({
      nonce,
      value:    BigInt(0),
      receiver: new Address(TARGET_WALLET),
      sender:   new Address(this.address),
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      data:     Buffer.from("ping"),
      chainID:  CHAIN_ID,
      version:  1,
    });
    tx.signature = await this.signer.sign(txComputer.computeBytesForSigning(tx));
    return tx.toSendable();
  }

  // Pre-build next batch into the queue while the current one is in-flight
  async prefill(): Promise<void> {
    if (this.building || !this.nonceSynced || !state.isGreenLight) return;
    if (this.txQueue.length >= BATCH_SIZE * 2) return; // queue already full

    this.building = true;
    try {
      const toAdd = BATCH_SIZE * 2 - this.txQueue.length;
      for (let i = 0; i < toAdd; i++) {
        if (!state.isGreenLight) break; // abort if red light while building
        this.txQueue.push(await this.buildTx(this.nextNonce()));
      }
    } finally {
      this.building = false;
    }
  }

  async fireBatch(): Promise<void> {
    if (!this.nonceSynced) return;

    // Use pre-built TXs from queue, or build on-demand if queue is empty
    let batch: object[] = this.txQueue.splice(0, BATCH_SIZE);
    if (batch.length < BATCH_SIZE) {
      const needed = BATCH_SIZE - batch.length;
      for (let i = 0; i < needed; i++) {
        // Bail immediately if state flipped to RED while we were building
        if (!state.isGreenLight) {
          // Return the nonce budget we already consumed back to the queue is impossible,
          // but we must NOT send — just abort. The force-resync after RED will fix nonces.
          return;
        }
        batch.push(await this.buildTx(this.nextNonce()));
      }
    }

    // Broadcast all in parallel
    const results = await Promise.all(
      batch.map(tx =>
        client.post("/transactions", tx)
          .then(() => true)
          .catch((e: any) => {
            const msg: string = e?.response?.data?.error || e?.message || "";
            if (msg.toLowerCase().includes("nonce")) {
              // Force-resync on any nonce error so we start from correct position next green
              this.syncNonce(true).catch(() => {});
            }
            return false;
          })
      )
    );

    const sent = results.filter(Boolean).length;
    this.statTotal += sent;
    if (state.isGreenLight) this.statPermitted += sent;

    // Kick off prefill for next batch
    this.prefill().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — COUNTDOWN TO ROUND 1
// ─────────────────────────────────────────────────────────────────────────────

async function waitForRoundStart(): Promise<void> {
  const delay = ROUND1_START_UTC - Date.now();
  if (delay <= 0) { log("Round already started — going live now."); return; }

  const m = Math.floor(delay / 60_000);
  const s = Math.floor((delay % 60_000) / 1000);
  log(`⏱  Round 1 in ${m}m ${s}s — agents standing by...`);

  const tick = setInterval(() => {
    const r = ROUND1_START_UTC - Date.now();
    if (r <= 0) { clearInterval(tick); return; }
    log(`⏱  ${Math.floor(r / 60_000)}m ${Math.floor((r % 60_000) / 1000)}s to Round 1`);
  }, 60_000);

  await sleep(delay);
  clearInterval(tick);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — RUN ALL AGENTS
// ─────────────────────────────────────────────────────────────────────────────

async function runAllAgents(wallets: AgentWallet[]): Promise<void> {
  log(`\n🚀 Launching ${wallets.length} agents\n`);

  const senders = wallets.map(w => new AgentSender(w));

  log("Syncing initial nonces...");
  await Promise.all(senders.map(s => s.syncNonce()));

  // Shared monitor loop
  const monitorTimer = setInterval(() => pollAdminCommands(senders), POLL_MS);

  // Per-agent send loops — all fire independently
  const senderTimers = senders.map(sender =>
    setInterval(async () => {
      if (state.isGreenLight) await sender.fireBatch();
    }, SEND_MS)
  );

  // Prefill loops — build TXs ahead of time to cut fire latency
  const prefillTimers = senders.map(sender =>
    setInterval(() => {
      if (state.isGreenLight) sender.prefill().catch(() => {});
    }, SEND_MS / 2)
  );

  // Stats every 15s
  const statsTimer = setInterval(() => {
    const permitted = senders.reduce((s, a) => s + a.statPermitted, 0);
    const total     = senders.reduce((s, a) => s + a.statTotal, 0);
    const perAgent  = senders.map(a => `A${a.index}:${a.statPermitted}`).join(" ");
    log(`📊 permitted=${permitted} total=${total} | ${perAgent} | ${state.isGreenLight ? "🟢" : "🔴"}`);
  }, 15_000);

  const shutdown = () => {
    state.isGreenLight = false;
    [monitorTimer, ...senderTimers, ...prefillTimers, statsTimer].forEach(clearInterval);
    const permitted = senders.reduce((s, a) => s + a.statPermitted, 0);
    const total     = senders.reduce((s, a) => s + a.statTotal, 0);
    console.log(`\n✅ Done — TXs sent: ${total} | Permitted: ${permitted} | Est. score: ${permitted}`);
    process.exit(0);
  };

  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  log("All agents live. Ctrl+C to stop.\n");
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fmt   = (attoEGLD: bigint) => (Number(attoEGLD) / 1e18).toFixed(2);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  BoN Challenge 5 — Agent Arena Orchestrator  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  if (!GL_KEY)     { console.error("Missing: GL_PRIVATE_KEY_HEX");           process.exit(1); }
  if (!GOOGLE_KEY) { console.error("Missing: GOOGLE_GENERATIVE_AI_API_KEY"); process.exit(1); }

  if (!ADMIN_WALLET || !TARGET_WALLET) {
    console.warn("⚠️  ADMIN/TARGET wallets not set — announced at 15:00 UTC.");
    console.warn("   Add them to .env and rerun before 16:00 UTC.\n");
  }

  log(`API: ${API_URL}  Chain: ${CHAIN_ID}  Agents: ${NUM_AGENTS}  Batch: ${BATCH_SIZE}/${SEND_MS}ms`);

  const glAddress = await getGLAddress();

  // 1. Wallets
  const wallets = generateWallets();

  // 2. Wait for funds
  await waitForFunds(glAddress);

  // 3. Fund agents
  await fundAgents(wallets, glAddress);

  // 4. Register
  if (!ADMIN_WALLET || !TARGET_WALLET) {
    log("Skipping registration — ADMIN/TARGET not set. Rerun after 15:00 UTC.");
    process.exit(0);
  }
  await registerAllAgents(wallets);

  log("\n✅ All agents funded and registered\n");

  // 5. Countdown
  await waitForRoundStart();

  // 6. Run
  await runAllAgents(wallets);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
