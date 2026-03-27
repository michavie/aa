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
import { findActiveWindow, loadChallengeWindows, nextWindow } from "./challenge";
import { signerFromStoredPem, toStoredPem } from "./wallets";

loadEnv();

// ─────────────────────────────────────────────────────────────────────────────
// SECRETS (from .env only — private keys and API keys)
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_KEY    = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
const ADMIN_WALLET  = process.env.ADMIN_WALLET_ADDRESS         || "";
const TARGET_WALLET = process.env.TARGET_WALLET_ADDRESS        || "";

const GL_PEM_PATH  = process.env.GL_PEM_FILE
  ? path.resolve(process.env.GL_PEM_FILE)
  : path.resolve(__dirname, "..", "gl.pem");

const AGENTS_FILE  = path.resolve(__dirname, "..", "agents.json");
const WALLETS_DIR  = path.resolve(__dirname, "..", "wallets");
const IS_LOCAL_TEST = process.env.LOCAL_TEST_MODE === "1";
const LOCAL_AGENT_FUND = BigInt(process.env.LOCAL_AGENT_FUND_ATTO || "10000000000000000");
const CHALLENGE_WINDOWS = loadChallengeWindows(process.env);
const MAX_AGENT_FEE_BUDGET = BigInt(
  process.env.MAX_AGENT_FEE_BUDGET_ATTO || "500000000000000000000"
);
const SHOULD_ENFORCE_SCHEDULE = process.env.ENFORCE_SCHEDULE !== "0";

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  operatorGreenLight: false,
  sendEnabled: false,
  commandPending: false,
  budgetExhausted: false,
  estimatedAgentFeeSpend: 0n,
  lastSeenTxHash: "",
  processedCommandTxs: new Set<string>(),
};

const COMMAND_HISTORY_SIZE = 100;
const MAX_TRACKED_COMMAND_TXS = 2000;

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
const MIN_GAS_LIMIT = 50_000n;
const GAS_PER_DATA_BYTE = 1_500n;

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

const ts  = () => new Date().toISOString().slice(11, 23);
const log  = (msg: string) => console.log( `[${ts()}] ${msg}`);
const warn = (msg: string) => console.warn(`[${ts()}] ⚠️  ${msg}`);

function txTimeLabel(tx: any): string {
  const raw = Number(tx?.timestamp ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return "unknown-time";
  return new Date(raw * 1000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// WALLET TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface AgentWallet {
  index: number;
  address: string;
}

function agentPemPath(index: number): string {
  return path.join(WALLETS_DIR, `agent-${index}.pem`);
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

  fs.mkdirSync(WALLETS_DIR, { recursive: true });
  log(`Generating ${CONFIG.NUM_AGENTS} agent wallets...`);
  const wallets: AgentWallet[] = [];
  for (let i = 0; i < CONFIG.NUM_AGENTS; i++) {
    const mnemonic  = Mnemonic.generate();
    const secretKey = mnemonic.deriveKey(0);
    const address   = secretKey.generatePublicKey().toAddress().bech32();
    fs.writeFileSync(agentPemPath(i), toStoredPem(secretKey));
    wallets.push({ index: i, address });
    log(`  A${i}: ${address}`);
  }

  fs.writeFileSync(AGENTS_FILE, JSON.stringify(wallets, null, 2));
  log(`Saved wallets/ and agents.json — back these up!`);
  return wallets;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — WAIT FOR GL WALLET TO BE FUNDED (polls until > 100 EGLD)
// ─────────────────────────────────────────────────────────────────────────────

function getGLAddress(): string {
  const pem   = fs.readFileSync(GL_PEM_PATH, "utf-8");
  const match = pem.match(/-----BEGIN PRIVATE KEY for (\S+)-----/);
  if (!match) throw new Error(`Invalid PEM file: ${GL_PEM_PATH}`);
  return match[1];
}

async function waitForFunds(glAddress: string): Promise<void> {
  log(`GL wallet: ${glAddress}`);
  log(`Polling for funds (distributed at 15:00 UTC)...`);
  const minBalance = IS_LOCAL_TEST
    ? BigInt("100000000000000000")
    : BigInt("100000000000000000000");

  while (true) {
    try {
      const { data } = await client.get(`/accounts/${glAddress}`);
      const balance = BigInt(data.balance ?? "0");
      if (balance > minBalance) {
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

function isWithinChallengeWindow(now: Date): boolean {
  if (!SHOULD_ENFORCE_SCHEDULE || IS_LOCAL_TEST) return true;
  return findActiveWindow(now, CHALLENGE_WINDOWS) !== null;
}

function refreshSendEnabled(): void {
  const scheduleOpen = isWithinChallengeWindow(new Date());
  state.sendEnabled =
    state.operatorGreenLight &&
    !state.commandPending &&
    !state.budgetExhausted &&
    scheduleOpen;
}

function estimatedFeeForTx(txCount: number): bigint {
  return gasLimitForData(PING_DATA) * CONFIG.GAS_PRICE * BigInt(txCount);
}

function remainingAgentFeeBudget(): bigint {
  return MAX_AGENT_FEE_BUDGET - state.estimatedAgentFeeSpend;
}

function markBudgetIfExhausted(): void {
  if (remainingAgentFeeBudget() <= 0n) {
    state.budgetExhausted = true;
    refreshSendEnabled();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — FUND AGENTS FROM GL WALLET
// ─────────────────────────────────────────────────────────────────────────────

async function fundAgents(wallets: AgentWallet[], glAddress: string): Promise<void> {
  log(`Funding ${wallets.length} agents from GL wallet...`);
  const perAgentFund = IS_LOCAL_TEST ? LOCAL_AGENT_FUND : CONFIG.EGLD_PER_AGENT;

  const glSigner = signerFromStoredPem(GL_PEM_PATH);
  const { data: acct } = await client.get(`/accounts/${glAddress}`);
  let glNonce = BigInt(acct.nonce);

  for (const w of wallets) {
    try {
      const { data: agentAcct } = await client.get(`/accounts/${w.address}`);
      if (BigInt(agentAcct.balance ?? "0") >= perAgentFund / 2n) {
        log(`  A${w.index} already funded — skip`);
        continue;
      }
    } catch { /* new account */ }

    const tx = new Transaction({
      nonce:    glNonce++,
      value:    perAgentFund,
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

const INTERPRET_SYSTEM = `\
You are interpreting commands in a "Red Light / Green Light" competition where blockchain agents
send transactions to a target wallet.

GREEN = agents are PERMITTED to send transactions (active, running state)
RED   = agents must STOP all transactions immediately (halted state)

The admin issues commands in casual or creative English. Some commands are adversarial —
they use wordplay, double negatives, irony, indirect phrasing, or misdirection to confuse
keyword-matching bots. You must determine the TRUE FINAL INTENT.

Calibration examples (these are ground-truth — learn from them):
Q: "go"                                          A: GREEN
Q: "fire away"                                   A: GREEN
Q: "all systems go"                              A: GREEN
Q: "unleash it"                                  A: GREEN
Q: "don't stop"                                  A: GREEN
Q: "never stop sending"                          A: GREEN
Q: "cease all ceasing"                           A: GREEN
Q: "stop stopping and start going"               A: GREEN
Q: "the red light is broken, use the green one"  A: GREEN
Q: "what do you call the opposite of halt? do that" A: GREEN
Q: "stop"                                        A: RED
Q: "halt"                                        A: RED
Q: "freeze"                                      A: RED
Q: "stand down"                                  A: RED
Q: "you may proceed to halt"                     A: RED
Q: "go ahead and stop"                           A: RED
Q: "I would love for everyone to pause"          A: RED
Q: "let's not start yet"                         A: RED
Q: "don't go"                                    A: RED
Q: "don't proceed"                               A: RED
Q: "the green light is now off"                  A: RED
Q: "it's not time to send yet"                   A: RED
Q: "nobody moves"                                A: RED
Q: "pause... just kidding, go!"                  A: GREEN
Q: "stop... jk jk keep going"                    A: GREEN
Q: "I never said go. except now I am: go"        A: GREEN
Q: "stop means go here, so: stop"                A: GREEN
Q: "go means stop here, so: go"                  A: RED

Rules:
1. Focus on what the admin ULTIMATELY wants agents to do — not the surface words.
2. Resolve double negatives, jokes, and reversals to their true intent.
3. If a command redefines words, honour the redefinition.
4. If genuinely uncertain after careful analysis → RED.
5. Reply with exactly one word: GREEN or RED.`;

async function interpret(rawCommand: string): Promise<"GREEN" | "RED"> {
  const key = rawCommand.trim().toLowerCase();
  if (interpretCache.has(key)) return interpretCache.get(key)!;

  try {
    const { text } = await Promise.race([
      generateText({
        model:     gemini,
        maxTokens: 5,
        messages: [
          { role: "user", content: `${INTERPRET_SYSTEM}\n\nQ: "${rawCommand}"  A:` },
        ],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), CONFIG.LLM_TIMEOUT_MS)),
    ]);

    const result: "GREEN" | "RED" = text.trim().toUpperCase().startsWith("GREEN") ? "GREEN" : "RED";
    interpretCache.set(key, result);
    log(`[LLM] command=${JSON.stringify(rawCommand)} => ${result}`);
    return result;
  } catch (e: any) {
    warn(`LLM failed (${e?.message}) → RED`);
    return "RED";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MONITOR LOOP — watches admin wallet, updates shared state
// ─────────────────────────────────────────────────────────────────────────────

async function primeLastSeenTxHash(): Promise<void> {
  if (!ADMIN_WALLET || !TARGET_WALLET) return;
  try {
    const { data } = await client.get(`/accounts/${TARGET_WALLET}/transactions`, {
      params: {
        size: COMMAND_HISTORY_SIZE,
        order: "desc",
        sender: ADMIN_WALLET,
        receiver: TARGET_WALLET,
        _t: Date.now(),
      },
    });
    const txs: any[] = Array.isArray(data) ? data : [];
    const commandTxs = txs.filter(tx =>
      String(tx.sender || tx.senderAddress || "").toLowerCase() === ADMIN_WALLET.toLowerCase(),
    );
    for (const tx of commandTxs) {
      state.processedCommandTxs.add(tx.txHash);
    }
    if (commandTxs.length > 0) {
      state.lastSeenTxHash = commandTxs[0].txHash;
      log(`Primed monitor cursor at ${state.lastSeenTxHash} (${commandTxs.length} prior admin txs ignored)`);
    }
  } catch (e: any) {
    warn(`Prime monitor cursor: ${e?.message}`);
  }
}

function rememberProcessedCommandTx(txHash: string): void {
  state.processedCommandTxs.add(txHash);
  if (state.processedCommandTxs.size <= MAX_TRACKED_COMMAND_TXS) return;
  const oldest = state.processedCommandTxs.values().next().value;
  if (oldest) state.processedCommandTxs.delete(oldest);
}

async function pollAdminCommands(senders: AgentSender[]): Promise<void> {
  if (!ADMIN_WALLET || !TARGET_WALLET) return;
  try {
    const { data } = await client.get(`/accounts/${TARGET_WALLET}/transactions`, {
      params: {
        size: COMMAND_HISTORY_SIZE,
        order: "desc",
        sender: ADMIN_WALLET,
        receiver: TARGET_WALLET,
        _t: Date.now(),
      },
    });
    const txs: any[] = Array.isArray(data) ? data : [];
    const newTxs = txs
      .filter(tx => {
        const sender = String(tx.sender || tx.senderAddress || "").toLowerCase();
        const receiver = String(tx.receiver || tx.receiverAddress || "").toLowerCase();
        return (
          sender === ADMIN_WALLET.toLowerCase() &&
          receiver === TARGET_WALLET.toLowerCase() &&
          !state.processedCommandTxs.has(tx.txHash)
        );
      })
      .sort((a, b) => {
        const timeDiff = Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0);
        if (timeDiff !== 0) return timeDiff;
        return String(a.txHash).localeCompare(String(b.txHash));
      });

    for (const tx of newTxs) {
      const receiver: string = tx.receiver || tx.receiverAddress || "";
      let command = "";
      try { command = tx.data ? Buffer.from(tx.data, "base64").toString("utf-8") : ""; }
      catch { command = tx.data || ""; }
      rememberProcessedCommandTx(tx.txHash);
      state.lastSeenTxHash = tx.txHash;
      if (!command.trim()) continue;

      log(
        `📡 Admin tx=${tx.txHash} time=${txTimeLabel(tx)} sender=${tx.sender || tx.senderAddress || ""} receiver=${receiver} command=${JSON.stringify(command)}`,
      );
      // Any new admin command pauses senders until semantic classification finishes.
      const previousGreen = state.operatorGreenLight;
      const wasSending = state.sendEnabled;
      state.commandPending = true;
      refreshSendEnabled();
      const intent  = await interpret(command);
      const newGreen = intent === "GREEN";
      state.commandPending = false;
      state.operatorGreenLight = newGreen;
      refreshSendEnabled();
      log(
        `🧠 Classified tx=${tx.txHash} intent=${intent} previous=${previousGreen ? "GREEN" : "RED"} current=${newGreen ? "GREEN" : "RED"} sendEnabled=${state.sendEnabled}`,
      );

      if (newGreen !== previousGreen) {
        if (state.sendEnabled) {
          console.log("\n🟢🟢🟢  GREEN LIGHT — FIRING  🟢🟢🟢\n");
        } else {
          console.log("\n🔴🔴🔴  RED LIGHT — STOPPED  🔴🔴🔴\n");
          // After going red: wait for pending TXs to settle, then force-resync all nonces.
          // force=true clears stale pre-built TX queues and accepts chain nonce even if
          // lower than localNonce (some TXs may not have confirmed or may have failed).
          if (wasSending) {
            setTimeout(async () => {
              log("Force-resyncing nonces after red light...");
              await Promise.all(senders.map(s => s.syncNonce(true)));
            }, 3_000);
          }
        }
      } else if (!state.sendEnabled) {
        const activeWindow = findActiveWindow(new Date(), CHALLENGE_WINDOWS);
        const upcomingWindow = nextWindow(new Date(), CHALLENGE_WINDOWS);
        if (state.budgetExhausted) {
          warn("Send blocked: agent fee budget exhausted");
        } else if (!activeWindow && SHOULD_ENFORCE_SCHEDULE && !IS_LOCAL_TEST) {
          const label = upcomingWindow ? `${upcomingWindow.label} starts ${upcomingWindow.start.toISOString()}` : "no upcoming rounds";
          warn(`Send blocked by schedule: ${label}`);
        }
      }
    }
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

function gasLimitForData(data: Buffer): bigint {
  return MIN_GAS_LIMIT + BigInt(data.length) * GAS_PER_DATA_BYTE;
}

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
    this.signer       = signerFromStoredPem(agentPemPath(w.index));
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
      gasLimit: gasLimitForData(PING_DATA),
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
    if (this.building || !this.nonceSynced || !state.sendEnabled) return;
    if (this.txQueue.length >= CONFIG.BATCH_SIZE * 2) return; // queue already full

    this.building = true;
    try {
      const toAdd = CONFIG.BATCH_SIZE * 2 - this.txQueue.length;
      for (let i = 0; i < toAdd; i++) {
        if (!state.sendEnabled) break; // abort if red light while building
        this.txQueue.push(await this.buildTx(this.nextNonce()));
      }
    } finally {
      this.building = false;
    }
  }

  async fireBatch(): Promise<void> {
    if (!this.nonceSynced) return;
    if (!state.sendEnabled) return;

    // Use pre-built TXs from queue, or build on-demand if queue is empty
    let batch: object[] = this.txQueue.splice(0, CONFIG.BATCH_SIZE);
    if (batch.length < CONFIG.BATCH_SIZE) {
      const needed = CONFIG.BATCH_SIZE - batch.length;
      for (let i = 0; i < needed; i++) {
        // Bail immediately if state flipped to RED while we were building
        if (!state.sendEnabled) {
          // Return the nonce budget we already consumed back to the queue is impossible,
          // but we must NOT send — just abort. The force-resync after RED will fix nonces.
          return;
        }
        batch.push(await this.buildTx(this.nextNonce()));
      }
    }

    const maxAffordable = Number(remainingAgentFeeBudget() / estimatedFeeForTx(1));
    if (maxAffordable <= 0) {
      state.budgetExhausted = true;
      refreshSendEnabled();
      return;
    }
    if (batch.length > maxAffordable) {
      batch = batch.slice(0, maxAffordable);
    }
    const feeEstimate = estimatedFeeForTx(batch.length);

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
    state.estimatedAgentFeeSpend += feeEstimate;
    markBudgetIfExhausted();
    this.statTotal += sent;
    if (state.sendEnabled) this.statPermitted += sent;

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
  await primeLastSeenTxHash();

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
      refreshSendEnabled();
      if (state.sendEnabled) await sender.fireBatch();
    }, CONFIG.SEND_INTERVAL_MS)
  );

  // Prefill loops — build TXs ahead of time to cut fire latency
  const prefillTimers = senders.map(sender =>
    setInterval(() => {
      refreshSendEnabled();
      if (state.sendEnabled) sender.prefill().catch(() => {});
    }, CONFIG.SEND_INTERVAL_MS / 2)
  );

  // Stats every 15s
  const statsTimer = setInterval(() => {
    const permitted = senders.reduce((s, a) => s + a.statPermitted, 0);
    const total     = senders.reduce((s, a) => s + a.statTotal, 0);
    const perAgent  = senders.map(a => `A${a.index}:${a.statPermitted}`).join(" ");
    log(`📊 permitted=${permitted} total=${total} fees≈${fmt(state.estimatedAgentFeeSpend)} EGLD | ${perAgent} | ${state.sendEnabled ? "🟢" : "🔴"}`);
  }, 15_000);

  const shutdown = () => {
    state.operatorGreenLight = false;
    state.commandPending = false;
    refreshSendEnabled();
    monitorRunning = false;
    [...senderTimers, ...prefillTimers, statsTimer].forEach(clearInterval);
    const permitted = senders.reduce((s, a) => s + a.statPermitted, 0);
    const total     = senders.reduce((s, a) => s + a.statTotal, 0);
    console.log(`\n✅ Done — TXs sent: ${total} | Permitted: ${permitted} | Est. score: ${permitted}`);
    process.exit(0);
  };

  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  refreshSendEnabled();
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

  if (!fs.existsSync(GL_PEM_PATH)) { console.error(`Missing GL wallet PEM: ${GL_PEM_PATH}\n  Run: npm run wallet`); process.exit(1); }
  if (!GOOGLE_KEY) { console.error("Missing: GOOGLE_GENERATIVE_AI_API_KEY"); process.exit(1); }

  if (!ADMIN_WALLET || !TARGET_WALLET) {
    console.warn("⚠️  ADMIN/TARGET wallets not set — announced at 15:00 UTC.");
    console.warn("   Add them to .env and rerun before 16:00 UTC.\n");
  }

  log(`API: ${CONFIG.BON_API}  Chain: ${CONFIG.BON_CHAIN}  Agents: ${CONFIG.NUM_AGENTS}  Batch: ${CONFIG.BATCH_SIZE}/${CONFIG.SEND_INTERVAL_MS}ms${IS_LOCAL_TEST ? "  [LOCAL TEST]" : ""}`);

  const glAddress = getGLAddress();

  // 1. Wallets
  const wallets = generateWallets();

  // 2. Wait for funds
  await waitForFunds(glAddress);

  // 3. Fund agents
  await fundAgents(wallets, glAddress);

  log("\n✅ All agents funded. Run `npm run register` on BON before going live.\n");

  // 4. Run
  await runAllAgents(wallets);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
