/**
 * BoN Agent Arena — Full Orchestrator
 *
 * ONE script to run everything:
 *   1. Generate 10 agent wallets (saved to agents.json, idempotent)
 *   2. Wait for GL wallet to receive funds (polls until balance arrives)
 *   3. Distribute EGLD from GL wallet to each agent wallet
 *   4. Register all agents via MX-8004 registry contract
 *   5. Count down to round start (16:00 UTC)
 *   6. Run all 10 agents in parallel:
 *        - One shared monitor loop (reads admin commands → LLM → GREEN/RED state)
 *        - Ten parallel sender loops (each fires TXs from its own wallet)
 *
 * Usage:
 *   cp .env.example .env   # fill in GL_PRIVATE_KEY_HEX, ADMIN/TARGET (after 15:00),
 *                          #   GOOGLE_GENERATIVE_AI_API_KEY, CHAIN_ID
 *   npm run start
 */

import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { UserSigner, UserSecretKey, Mnemonic } from "@multiversx/sdk-wallet";
import { Transaction, TransactionPayload, Address, TransactionComputer } from "@multiversx/sdk-core";
import axios, { AxiosInstance } from "axios";
import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as path from "path";

loadEnv();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const API_URL       = process.env.MULTIVERSX_API_URL          || "https://api.battleofnodes.com";
const CHAIN_ID      = process.env.CHAIN_ID                    || "BON-1";
const GOOGLE_KEY    = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";

// Set after 15:00 UTC when announced
const ADMIN_WALLET  = process.env.ADMIN_WALLET_ADDRESS        || "";
const TARGET_WALLET = process.env.TARGET_WALLET_ADDRESS       || "";

// Guild leader wallet — funds the agents
const GL_KEY        = process.env.GL_PRIVATE_KEY_HEX          || "";

// Tuning
const NUM_AGENTS    = parseInt(process.env.NUM_AGENTS    || "10");
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS || "300");
const BATCH_SIZE    = parseInt(process.env.SEND_BATCH_SIZE  || "8");
const SEND_MS       = parseInt(process.env.SEND_INTERVAL_MS || "80");

// Per-agent EGLD allocation (tune to stay under 500 EGLD total)
const EGLD_PER_AGENT = process.env.EGLD_PER_AGENT
  ? BigInt(process.env.EGLD_PER_AGENT)
  : BigInt("40000000000000000000"); // 40 EGLD in attoEGLD

const GAS_LIMIT     = BigInt(50_000);
const GAS_PRICE     = BigInt(1_000_000_000);
const FUND_GAS      = BigInt(60_000);
const REG_GAS       = BigInt(10_000_000);

const AGENTS_FILE   = path.resolve(__dirname, "..", "agents.json");
const REGISTRY_ADDR = process.env.IDENTITY_REGISTRY_ADDRESS
  || "erd1qqqqqqqqqqqqqpgq4mar8ex8aj2gnc0cq7ay372eqfd5g7t33frqcg776p";

// Round 1 starts 16:00 UTC March 27 2026
const ROUND1_START_UTC = new Date("2026-03-27T16:00:00Z").getTime();

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE (monitor updates, senders read)
// ─────────────────────────────────────────────────────────────────────────────

const sharedState = {
  isGreenLight: false,
  lastSeenTxHash: "",
};

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────────────────────────────────────

const http: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 5_000,
  headers: { "Content-Type": "application/json" },
});

const gemini = google("gemini-2.0-flash-exp", { apiKey: GOOGLE_KEY } as any);
const txComputer = new TransactionComputer();

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString().slice(11, 23); }
function log(msg: string)  { console.log( `[${ts()}] ${msg}`); }
function warn(msg: string) { console.warn(`[${ts()}] ⚠️  ${msg}`); }
function logAgent(idx: number, msg: string) { console.log(`[${ts()}][A${idx}] ${msg}`); }

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
    log(`Loaded ${existing.length} existing agent wallets from agents.json`);
    return existing;
  }

  log(`Generating ${NUM_AGENTS} agent wallets...`);
  const wallets: AgentWallet[] = [];

  for (let i = 0; i < NUM_AGENTS; i++) {
    const mnemonic = Mnemonic.generate();
    const secretKey = mnemonic.deriveKey(0);
    const address = secretKey.generatePublicKey().toAddress().bech32();
    wallets.push({
      index: i,
      address,
      privateKeyHex: secretKey.hex(),
      mnemonic: mnemonic.toString(),
    });
    log(`  Agent ${i}: ${address}`);
  }

  fs.writeFileSync(AGENTS_FILE, JSON.stringify(wallets, null, 2));
  log(`Saved to agents.json`);
  return wallets;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — WAIT FOR GL WALLET TO BE FUNDED
// ─────────────────────────────────────────────────────────────────────────────

async function getGLAddress(): Promise<string> {
  const key = UserSecretKey.fromString(GL_KEY);
  return key.generatePublicKey().toAddress().bech32();
}

async function waitForFunds(glAddress: string): Promise<bigint> {
  log(`Waiting for funds to arrive in GL wallet: ${glAddress}`);
  log(`(Funds distributed at 15:00 UTC — polling every 10s)`);

  while (true) {
    try {
      const { data } = await http.get(`/accounts/${glAddress}`);
      const balance = BigInt(data.balance ?? "0");
      if (balance > BigInt("100000000000000000000")) { // > 100 EGLD
        log(`GL wallet funded: ${formatEGLD(balance)} EGLD`);
        return balance;
      }
      log(`GL balance: ${formatEGLD(balance)} EGLD — waiting...`);
    } catch (e: any) {
      warn(`Balance check failed: ${e?.message}`);
    }
    await sleep(10_000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — FUND AGENT WALLETS
// ─────────────────────────────────────────────────────────────────────────────

async function fundAgents(wallets: AgentWallet[], glAddress: string): Promise<void> {
  log(`Funding ${wallets.length} agent wallets from GL: ${glAddress}`);

  const glKey = UserSecretKey.fromString(GL_KEY);
  const glSigner = new UserSigner(glKey);

  // Get GL nonce
  const { data: acct } = await http.get(`/accounts/${glAddress}`);
  let glNonce = BigInt(acct.nonce);

  for (const wallet of wallets) {
    // Check if already funded
    try {
      const { data: agentAcct } = await http.get(`/accounts/${wallet.address}`);
      const existing = BigInt(agentAcct.balance ?? "0");
      if (existing >= EGLD_PER_AGENT / 2n) {
        log(`  Agent ${wallet.index} already has ${formatEGLD(existing)} EGLD — skipping`);
        glNonce++; // Don't increment if skipping
        glNonce--; // correct — don't skip nonce
        continue;
      }
    } catch { /* account doesn't exist yet, proceed */ }

    const tx = new Transaction({
      nonce: glNonce++,
      value: EGLD_PER_AGENT,
      receiver: new Address(wallet.address),
      sender: new Address(glAddress),
      gasLimit: FUND_GAS,
      gasPrice: GAS_PRICE,
      data: new TransactionPayload("fund"),
      chainID: CHAIN_ID,
      version: 1,
    });

    const bytes = txComputer.computeBytesForSigning(tx);
    const sig = await glSigner.sign(bytes);
    tx.applySignature(sig);

    try {
      const { data } = await http.post("/transactions", tx.toPlainObject());
      log(`  Agent ${wallet.index} funded → ${data.txHash}`);
    } catch (e: any) {
      warn(`  Agent ${wallet.index} funding failed: ${e?.response?.data?.error || e?.message}`);
    }

    await sleep(200); // Small delay between funding TXs
  }

  log(`Waiting 15s for funding TXs to settle...`);
  await sleep(15_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — REGISTER AGENTS
// ─────────────────────────────────────────────────────────────────────────────

async function registerAgent(wallet: AgentWallet, agentIndex: number): Promise<void> {
  const secretKey = UserSecretKey.fromString(wallet.privateKeyHex);
  const signer = new UserSigner(secretKey);
  const agentName = `BON-Agent-${agentIndex}`;

  // Encode register_agent call manually (matches MX-8004 register_agent ABI):
  //   register_agent(name: bytes, uri: bytes, pubkey: bytes,
  //                  metadata: counted-variadic<MetadataEntry>,
  //                  services: counted-variadic<ServiceConfigInput>)
  const nameHex    = Buffer.from(agentName).toString("hex");
  const uriHex     = Buffer.from(`https://agent.molt.bot/${agentName}`).toString("hex");
  const pubkeyHex  = secretKey.generatePublicKey().hex();
  // 0 metadata entries, 0 services entries
  const dataStr = `register_agent@${nameHex}@${uriHex}@${pubkeyHex}@00000000@00000000`;

  const { data: acct } = await http.get(`/accounts/${wallet.address}`);
  const nonce = BigInt(acct.nonce);

  const tx = new Transaction({
    nonce,
    value: BigInt(0),
    receiver: new Address(REGISTRY_ADDR),
    sender: new Address(wallet.address),
    gasLimit: REG_GAS,
    gasPrice: GAS_PRICE,
    data: new TransactionPayload(dataStr),
    chainID: CHAIN_ID,
    version: 1,
  });

  const bytes = txComputer.computeBytesForSigning(tx);
  const sig = await signer.sign(bytes);
  tx.applySignature(sig);

  try {
    const { data } = await http.post("/transactions", tx.toPlainObject());
    log(`  Agent ${agentIndex} registered → ${data.txHash}`);
  } catch (e: any) {
    warn(`  Agent ${agentIndex} registration failed: ${e?.response?.data?.error || e?.message}`);
  }
}

async function registerAllAgents(wallets: AgentWallet[]): Promise<void> {
  log(`Registering ${wallets.length} agents with MX-8004 registry...`);
  for (const wallet of wallets) {
    await registerAgent(wallet, wallet.index);
    await sleep(500); // stagger registrations
  }
  log(`All registrations submitted.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM COMMAND INTERPRETER (shared, called once per unique command)
// ─────────────────────────────────────────────────────────────────────────────

const interpretCache = new Map<string, "GREEN" | "RED">();

async function interpretCommand(rawCommand: string): Promise<"GREEN" | "RED"> {
  const key = rawCommand.trim().toLowerCase();
  if (interpretCache.has(key)) return interpretCache.get(key)!;

  try {
    const { text } = await Promise.race([
      generateText({
        model: gemini,
        maxTokens: 10,
        prompt: `You are the command interpreter for a "Red Light / Green Light" blockchain competition.

An admin sends plain-text commands to control whether agents should be sending transactions to a target wallet.
GREEN = agents SHOULD send transactions (go, start, proceed, fire, unleash, continue, etc.)
RED   = agents must STOP all transactions (stop, halt, freeze, pause, wait, hold, cease, etc.)

Commands may be casual, creative, or adversarial (double negatives, irony, misdirection — designed to confuse bots).
Determine the TRUE FINAL INTENT of the admin. What does the admin ultimately want the agents to do?
If uncertain, output RED (safe default — sending during a red window is heavily penalised).

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
    warn(`LLM failed (${e?.message}), defaulting RED`);
    return "RED";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MONITOR LOOP (one shared loop — updates sharedState.isGreenLight)
// ─────────────────────────────────────────────────────────────────────────────

async function pollAdminCommands(agentSenders: AgentSender[]): Promise<void> {
  if (!ADMIN_WALLET || !TARGET_WALLET) return;

  try {
    const { data } = await http.get(`/accounts/${ADMIN_WALLET}/transactions`, {
      params: { size: 10, order: "desc" },
    });

    const txs: any[] = Array.isArray(data) ? data : [];

    // Process oldest-to-newest to apply state changes in order
    const newTxs: any[] = [];
    for (const tx of txs) {
      if (tx.txHash === sharedState.lastSeenTxHash) break;
      newTxs.unshift(tx);
    }

    for (const tx of newTxs) {
      const receiver: string = tx.receiver || tx.receiverAddress || "";
      if (receiver.toLowerCase() !== TARGET_WALLET.toLowerCase()) continue;

      let command = "";
      if (tx.data) {
        try { command = Buffer.from(tx.data, "base64").toString("utf-8"); }
        catch { command = tx.data; }
      }
      if (!command.trim()) continue;

      log(`📡 Admin command: "${command}"`);

      const intent = await interpretCommand(command);
      const newGreen = intent === "GREEN";

      if (newGreen !== sharedState.isGreenLight) {
        const wasGreen = sharedState.isGreenLight;
        sharedState.isGreenLight = newGreen;

        if (newGreen) {
          console.log("\n🟢🟢🟢  GREEN LIGHT — SENDING  🟢🟢🟢\n");
        } else {
          console.log("\n🔴🔴🔴  RED LIGHT — STOPPED   🔴🔴🔴\n");

          // After RED: wait 3s for pending TXs to settle, then resync all nonces
          if (wasGreen) {
            setTimeout(async () => {
              log("Resyncing all agent nonces after red light...");
              await Promise.all(agentSenders.map(a => a.syncNonce()));
            }, 3_000);
          }
        }
      }
    }

    if (txs.length > 0) sharedState.lastSeenTxHash = txs[0].txHash;
  } catch (e: any) {
    warn(`Monitor error: ${e?.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-AGENT SENDER
// ─────────────────────────────────────────────────────────────────────────────

class AgentSender {
  index: number;
  address: string;
  signer: UserSigner;
  localNonce = BigInt(0);
  nonceSynced = false;
  statTotal = 0;
  statPermitted = 0;

  constructor(wallet: AgentWallet) {
    this.index = wallet.index;
    this.address = wallet.address;
    const key = UserSecretKey.fromString(wallet.privateKeyHex);
    this.signer = new UserSigner(key);
  }

  async syncNonce(): Promise<void> {
    try {
      const { data } = await http.get(`/accounts/${this.address}`);
      const chainNonce = BigInt(data.nonce ?? 0);
      // Only ever move nonce forward — pending TXs may not be confirmed yet
      if (chainNonce > this.localNonce || !this.nonceSynced) {
        this.localNonce = chainNonce;
        this.nonceSynced = true;
        logAgent(this.index, `Nonce → ${this.localNonce}`);
      }
    } catch (e: any) {
      warn(`A${this.index} nonce sync failed: ${e?.message}`);
    }
  }

  private nextNonce(): bigint {
    return this.localNonce++;
  }

  private async buildTx(nonce: bigint): Promise<object> {
    const tx = new Transaction({
      nonce,
      value: BigInt(0),
      receiver: new Address(TARGET_WALLET),
      sender: new Address(this.address),
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      data: new TransactionPayload("ping"),
      chainID: CHAIN_ID,
      version: 1,
    });

    const bytes = txComputer.computeBytesForSigning(tx);
    const sig = await this.signer.sign(bytes);
    tx.applySignature(sig);
    return tx.toPlainObject();
  }

  private async broadcast(txPlain: object): Promise<boolean> {
    try {
      await http.post("/transactions", txPlain);
      return true;
    } catch (e: any) {
      const msg: string = e?.response?.data?.error || e?.message || "";
      if (msg.toLowerCase().includes("nonce")) {
        // Only resync on nonce errors, and only if we're not currently green
        // (avoid resetting nonce mid-send)
        if (!sharedState.isGreenLight) {
          await this.syncNonce();
        }
      }
      return false;
    }
  }

  async fireBatch(): Promise<void> {
    if (!this.nonceSynced) return;

    // Build all TXs first (sign sequentially — can't parallelise signing with shared nonce counter)
    const txs: object[] = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      txs.push(await this.buildTx(this.nextNonce()));
    }

    // Broadcast all in parallel
    const results = await Promise.all(txs.map(t => this.broadcast(t)));
    const sent = results.filter(Boolean).length;

    this.statTotal += sent;
    if (sharedState.isGreenLight) this.statPermitted += sent;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — COUNTDOWN
// ─────────────────────────────────────────────────────────────────────────────

async function waitForRoundStart(): Promise<void> {
  const now = Date.now();
  const delay = ROUND1_START_UTC - now;

  if (delay <= 0) {
    log("Round 1 has already started (or it's time) — going live immediately.");
    return;
  }

  const mins = Math.floor(delay / 60_000);
  const secs = Math.floor((delay % 60_000) / 1000);
  log(`Round 1 starts in ${mins}m ${secs}s — agents standing by...`);

  // Print countdown every minute
  const interval = setInterval(() => {
    const remaining = ROUND1_START_UTC - Date.now();
    if (remaining <= 0) { clearInterval(interval); return; }
    const m = Math.floor(remaining / 60_000);
    const s = Math.floor((remaining % 60_000) / 1000);
    log(`⏱  Round 1 in ${m}m ${s}s`);
  }, 60_000);

  await sleep(delay);
  clearInterval(interval);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — RUN ALL AGENTS
// ─────────────────────────────────────────────────────────────────────────────

async function runAllAgents(wallets: AgentWallet[]): Promise<void> {
  log(`\n🚀 Starting ${wallets.length} agents in parallel\n`);

  // Create sender instances and sync nonces
  const senders = wallets.map(w => new AgentSender(w));
  log("Syncing initial nonces...");
  await Promise.all(senders.map(s => s.syncNonce()));

  // Single shared monitor loop
  const monitorTimer = setInterval(() => pollAdminCommands(senders), POLL_MS);

  // Per-agent sender loops
  const senderTimers = senders.map(sender =>
    setInterval(async () => {
      if (sharedState.isGreenLight) {
        await sender.fireBatch();
      }
    }, SEND_MS)
  );

  // Stats every 15s
  const statsTimer = setInterval(() => {
    const totalPermitted = senders.reduce((s, a) => s + a.statPermitted, 0);
    const totalSent      = senders.reduce((s, a) => s + a.statTotal, 0);
    const perAgent       = senders.map(a => `A${a.index}:${a.statPermitted}`).join(" ");
    log(`📊 total=${totalSent} permitted=${totalPermitted} | ${perAgent} | state=${sharedState.isGreenLight ? "🟢" : "🔴"}`);
  }, 15_000);

  // Graceful shutdown
  const shutdown = () => {
    sharedState.isGreenLight = false;
    clearInterval(monitorTimer);
    senderTimers.forEach(t => clearInterval(t));
    clearInterval(statsTimer);

    const totalPermitted = senders.reduce((s, a) => s + a.statPermitted, 0);
    const totalSent      = senders.reduce((s, a) => s + a.statTotal, 0);
    console.log(`\n[Done] Total TXs: ${totalSent} | Permitted: ${totalPermitted} | Score estimate: ${totalPermitted}`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("Agents running. Ctrl+C to stop.\n");

  // Keep alive
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function formatEGLD(attoEGLD: bigint): string {
  return (Number(attoEGLD) / 1e18).toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   BoN Challenge 5 — Agent Arena Orchestrator ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  if (!GL_KEY) {
    console.error("GL_PRIVATE_KEY_HEX is required in .env");
    process.exit(1);
  }
  if (!GOOGLE_KEY) {
    console.error("GOOGLE_GENERATIVE_AI_API_KEY is required in .env");
    process.exit(1);
  }
  if (!ADMIN_WALLET || !TARGET_WALLET) {
    console.warn("⚠️  ADMIN_WALLET_ADDRESS / TARGET_WALLET_ADDRESS not set yet.");
    console.warn("   These are announced at 15:00 UTC. Add them to .env before 16:00 UTC.");
    console.warn("   Continuing with setup (wallet gen + funding + registration)...\n");
  }

  const glAddress = await getGLAddress();
  log(`GL wallet: ${glAddress}`);
  log(`API:       ${API_URL} | Chain: ${CHAIN_ID}`);
  log(`Agents:    ${NUM_AGENTS} | Batch: ${BATCH_SIZE} TXs / ${SEND_MS}ms\n`);

  // ── Phase 1: Wallets
  const wallets = generateWallets();

  // ── Phase 2: Wait for funding
  await waitForFunds(glAddress);

  // ── Phase 3: Distribute funds
  await fundAgents(wallets, glAddress);

  // ── Phase 4: Register
  if (!ADMIN_WALLET || !TARGET_WALLET) {
    log("\n⚠️  ADMIN/TARGET wallets not set. Skipping registration — rerun after 15:00 UTC.");
    log("   Or set them in .env and rerun: npm run start");
    process.exit(0);
  }
  await registerAllAgents(wallets);

  log("\n✅ All agents funded and registered!\n");

  // ── Phase 5: Wait for round start
  await waitForRoundStart();

  // ── Phase 6: Run
  await runAllAgents(wallets);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
