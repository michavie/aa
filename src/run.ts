/**
 * BoN Agent Arena — Full Orchestrator
 *
 * ONE script. Run `npm start`. It handles everything:
 *   1. Generate 10 agent wallets (saved to agents.json, idempotent on reruns)
 *   2. Wait for GL wallet to receive funds (polls until balance > 100 EGLD)
 *   3. Distribute EGLD from GL wallet to each agent wallet
 *   4. Run all 10 agents in parallel:
 *        - ONE shared monitor loop  (admin commands → LLM → GREEN/RED state)
 *        - TEN parallel sender loops (each wallet fires its own TX batches)
 *
 * Performance notes:
 *  - Nonce is ONLY synced at startup and after GREEN→RED (never mid-green)
 *  - Signing is done in parallel across agents (each has its own signer instance)
 *  - Broadcast uses axios keep-alive + pipeline for minimal latency
 *  - Pre-built TX objects are queued ahead of send interval to minimise sign latency
 *  - CONFIG.BATCH_SIZE * 10 agents = effective parallelism per tick
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
import { CONFIG } from "./config";

loadEnv();

// ─────────────────────────────────────────────────────────────────────────────
// SECRETS (from .env only — private keys and API keys)
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_KEY    = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
const ADMIN_WALLET  = process.env.ADMIN_WALLET_ADDRESS         || "";
const TARGET_WALLET = process.env.TARGET_WALLET_ADDRESS        || "";
const GL_KEY        = process.env.GL_PRIVATE_KEY_HEX           || "";

const AGENTS_FILE = path.resolve(__dirname, "..", "agents.json");

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
  baseURL: CONFIG.BON_API,
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

  log(`Generating ${CONFIG.NUM_AGENTS} agent wallets...`);
  const wallets: AgentWallet[] = [];
  for (let i = 0; i < CONFIG.NUM_AGENTS; i++) {
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
      if (BigInt(agentAcct.balance ?? "0") >= CONFIG.EGLD_PER_AGENT / 2n) {
        log(`  A${w.index} already funded — skip`);
        continue;
      }
    } catch { /* new account */ }

    const tx = new Transaction({
      nonce:    glNonce++,
      value:    CONFIG.EGLD_PER_AGENT,
      receiver: new Address(w.address),
      sender:   new Address(glAddress),
      gasLimit: CONFIG.FUND_GAS,
      gasPrice: CONFIG.GAS_PRICE,
      data:     Buffer.from("fund"),
      chainID:  CONFIG.BON_CHAIN,
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
// LLM INTERPRETER — Gemini Flash (fast + cheap, one call per unique command)
// ─────────────────────────────────────────────────────────────────────────────

const interpretCache = new Map<string, "GREEN" | "RED">();
const gemini = google(CONFIG.GEMINI_MODEL, { apiKey: GOOGLE_KEY } as any);

// System prompt: stripped of inline comments, ~150 tokens (was ~500).
// Uses system+prompt split so Gemini can cache the static system portion.
const INTERPRET_SYSTEM = `\
Red Light / Green Light game. Agents send blockchain transactions.
GREEN = SEND. RED = STOP.

Examples:
"go"→GREEN "start"→GREEN "fire away"→GREEN "all systems go"→GREEN "unleash it"→GREEN
"stop"→RED "halt"→RED "freeze"→RED "stand down"→RED "nobody moves"→RED
"don't stop"→GREEN "cease all ceasing"→GREEN "never halt"→GREEN
"don't go"→RED "don't proceed"→RED "let's not start yet"→RED
"you may proceed to halt"→RED "go ahead and stop"→RED "I'd love for you to freeze"→RED
"pause... just kidding, go!"→GREEN "stop... jk keep going"→GREEN
"stop means go here, so: stop"→GREEN "go means stop here, so: go"→RED
"pump the brakes"→RED "it's game time"→GREEN

Rules: resolve double negatives and jokes to TRUE FINAL INTENT. Honour vocab redefinitions. Uncertain→RED.
Reply with one word only: GREEN or RED`;

async function interpret(rawCommand: string): Promise<"GREEN" | "RED"> {
  const key = rawCommand.trim().toLowerCase();
  if (interpretCache.has(key)) return interpretCache.get(key)!;

  try {
    const { text } = await Promise.race([
      generateText({
        model:     gemini,
        system:    INTERPRET_SYSTEM,
        prompt:    `"${rawCommand}"`,
        maxTokens: 3,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), CONFIG.LLM_TIMEOUT_MS)),
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

// Shared immutable values — allocated once, reused across all TXs
const PING_DATA  = Buffer.from("ping");
const ZERO_VALUE = BigInt(0);

class AgentSender {
  readonly index:    number;
  readonly address:  string;
  readonly signer:   UserSigner;
  // Cached Address objects — Address construction is not free, avoid per-TX allocation
  private readonly senderAddr:   Address;
  private readonly receiverAddr: Address;

  localNonce  = BigInt(0);
  nonceSynced = false;

  statTotal     = 0;
  statPermitted = 0;

  // Pre-built TX queue — we sign ahead of the send interval to cut latency
  private txQueue: object[] = [];
  private building = false;

  constructor(w: AgentWallet) {
    this.index        = w.index;
    this.address      = w.address;
    this.signer       = new UserSigner(UserSecretKey.fromString(w.privateKeyHex));
    this.senderAddr   = new Address(w.address);
    this.receiverAddr = new Address(TARGET_WALLET);
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
      value:    ZERO_VALUE,
      receiver: this.receiverAddr,
      sender:   this.senderAddr,
      gasLimit: CONFIG.GAS_LIMIT,
      gasPrice: CONFIG.GAS_PRICE,
      data:     PING_DATA,
      chainID:  CONFIG.BON_CHAIN,
      version:  1,
    });
    tx.signature = await this.signer.sign(txComputer.computeBytesForSigning(tx));
    return tx.toSendable();
  }

  // Pre-build next batch into the queue while the current one is in-flight
  async prefill(): Promise<void> {
    if (this.building || !this.nonceSynced || !state.isGreenLight) return;
    if (this.txQueue.length >= CONFIG.BATCH_SIZE * 2) return; // queue already full

    this.building = true;
    try {
      const toAdd = CONFIG.BATCH_SIZE * 2 - this.txQueue.length;
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
    let batch: object[] = this.txQueue.splice(0, CONFIG.BATCH_SIZE);
    if (batch.length < CONFIG.BATCH_SIZE) {
      const needed = CONFIG.BATCH_SIZE - batch.length;
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
// PHASE 5 — RUN ALL AGENTS
// ─────────────────────────────────────────────────────────────────────────────

async function runAllAgents(wallets: AgentWallet[]): Promise<void> {
  log(`\n🚀 Launching ${wallets.length} agents\n`);

  const senders = wallets.map(w => new AgentSender(w));

  log("Syncing initial nonces...");
  await Promise.all(senders.map(s => s.syncNonce()));

  // Shared monitor loop
  let monitorRunning = true;
  (async () => {
    while (monitorRunning) {
      await pollAdminCommands(senders);
      await sleep(CONFIG.POLL_INTERVAL_MS);
    }
  })();

  // Per-agent send loops — all fire independently
  const senderTimers = senders.map(sender =>
    setInterval(async () => {
      if (state.isGreenLight) await sender.fireBatch();
    }, CONFIG.SEND_INTERVAL_MS)
  );

  // Prefill loops — build TXs ahead of time to cut fire latency
  const prefillTimers = senders.map(sender =>
    setInterval(() => {
      if (state.isGreenLight) sender.prefill().catch(() => {});
    }, CONFIG.SEND_INTERVAL_MS / 2)
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
    monitorRunning = false;
    [...senderTimers, ...prefillTimers, statsTimer].forEach(clearInterval);
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

  log(`API: ${CONFIG.BON_API}  Chain: ${CONFIG.BON_CHAIN}  Agents: ${CONFIG.NUM_AGENTS}  Batch: ${CONFIG.BATCH_SIZE}/${CONFIG.SEND_INTERVAL_MS}ms`);

  const glAddress = await getGLAddress();

  // 1. Wallets
  const wallets = generateWallets();

  // 2. Wait for funds
  await waitForFunds(glAddress);

  // 3. Fund agents
  await fundAgents(wallets, glAddress);

  log("\n✅ All agents funded. Run `npm run register` on devnet before going live.\n");

  // 4. Run
  await runAllAgents(wallets);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
