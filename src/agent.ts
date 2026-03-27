/**
 * BoN Challenge 5 — Agent Arena
 *
 * Strategy:
 *  - Poll admin wallet every ~300ms for new commands sent to TARGET wallet
 *  - Use Claude (Haiku) to semantically interpret command intent — not keyword matching
 *  - GREEN LIGHT → fire transactions to TARGET wallet in parallel batches at max speed
 *  - RED LIGHT   → immediate kill switch, zero transactions sent
 *  - Ambiguous   → default to STOP (being penalized for unpermitted TXs hurts more)
 *
 * Scoring: PermittedTxs − UnpermittedTxs  (can go negative — be precise)
 */

import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { UserSigner, UserSecretKey } from "@multiversx/sdk-wallet";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import axios, { AxiosInstance } from "axios";
import { config } from "dotenv";

config();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const API_URL        = process.env.MULTIVERSX_API_URL   || "https://api.battleofnodes.com";
const CHAIN_ID       = process.env.CHAIN_ID             || "BON-1";
const ADMIN_WALLET   = process.env.ADMIN_WALLET_ADDRESS || "";
const TARGET_WALLET  = process.env.TARGET_WALLET_ADDRESS || "";
const AGENT_ADDRESS  = process.env.AGENT_ADDRESS        || "";
const PRIVATE_KEY    = process.env.AGENT_PRIVATE_KEY_HEX || "";
const GOOGLE_KEY     = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";

const POLL_MS        = parseInt(process.env.POLL_INTERVAL_MS   || "300");
const BATCH_SIZE     = parseInt(process.env.SEND_BATCH_SIZE    || "8");
const SEND_MS        = parseInt(process.env.SEND_INTERVAL_MS   || "80");

const GAS_LIMIT      = BigInt(50_000);
const GAS_PRICE      = BigInt(1_000_000_000);

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

let isGreenLight          = false;
let localNonce            = BigInt(0);
let nonceSynced           = false;
let lastSeenTxHash        = "";
const interpretationCache = new Map<string, "GREEN" | "RED">();

// Stats
let statPermitted = 0;
let statTotal     = 0;
let statStartTime = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────────────────────────────────────

// Gemini Flash — very fast and cheap, perfect for high-frequency interpretation
const gemini = google("gemini-2.0-flash-exp", { apiKey: GOOGLE_KEY } as any);

const http: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 4_000,
  headers: { "Content-Type": "application/json" },
});

// ─────────────────────────────────────────────────────────────────────────────
// WALLET & SIGNING
// ─────────────────────────────────────────────────────────────────────────────

let signer: UserSigner;
const txComputer = new TransactionComputer();

function initWallet() {
  const key = UserSecretKey.fromString(PRIVATE_KEY);
  signer = new UserSigner(key);
  log(`Wallet ready: ${AGENT_ADDRESS}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// NONCE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function syncNonce(): Promise<void> {
  try {
    const { data } = await http.get(`/accounts/${AGENT_ADDRESS}`);
    const chainNonce = BigInt(data.nonce ?? 0);

    // Only move nonce forward, never backward — we may have pending TXs
    if (chainNonce > localNonce || !nonceSynced) {
      localNonce = chainNonce;
      nonceSynced = true;
      log(`Nonce synced → ${localNonce}`);
    }
  } catch (e: any) {
    warn(`Nonce sync failed: ${e?.message}`);
  }
}

function nextNonce(): bigint {
  return localNonce++;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM COMMAND INTERPRETER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uses Claude Haiku to semantically determine if an admin command means
 * "start sending transactions" (GREEN) or "stop sending transactions" (RED).
 *
 * The prompt is engineered for adversarial inputs — double negatives,
 * sarcasm, creative phrasing, confusing language, etc.
 *
 * Default on error: RED (safe — never penalised for stopping too soon).
 */
async function interpretCommand(rawCommand: string): Promise<"GREEN" | "RED"> {
  const key = rawCommand.trim().toLowerCase();

  if (interpretationCache.has(key)) {
    const cached = interpretationCache.get(key)!;
    log(`[LLM cached] "${rawCommand}" → ${cached}`);
    return cached;
  }

  try {
    const { text } = await Promise.race([
      generateText({
        model: gemini,
        maxTokens: 10,
        prompt: `You are interpreting control signals for a blockchain transaction agent in a "Red Light / Green Light" competition.

The agent sends transactions to a target wallet. An admin issues plain-text commands to control when transactions are allowed.

Your task: determine whether this command means the agent should START (or continue) sending transactions, or STOP sending transactions.

Rules:
- GREEN = transactions are PERMITTED. The admin is saying "go", "start", "proceed", "continue", or equivalent.
- RED   = transactions are FORBIDDEN. The admin is saying "stop", "halt", "freeze", "pause", or equivalent.
- Commands may use double negatives, irony, creative language, or adversarial phrasing designed to confuse keyword-based bots.
- Interpret the TRUE FINAL INTENT — what the admin ultimately wants the agent to do.
- If genuinely uncertain, output RED (safe default — being penalised for unpermitted sends is worse).

Reply with exactly one word: GREEN or RED

Admin command: "${rawCommand}"`,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM timeout")), 2_500)
      ),
    ]);

    const result: "GREEN" | "RED" = text.trim().toUpperCase().startsWith("GREEN")
      ? "GREEN"
      : "RED";

    interpretationCache.set(key, result);
    log(`[LLM] "${rawCommand}" → ${result}`);
    return result;
  } catch (e: any) {
    warn(`LLM failed (${e?.message}), defaulting to RED`);
    return "RED";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION BUILDER & SENDER
// ─────────────────────────────────────────────────────────────────────────────

async function buildAndSignTx(nonce: bigint): Promise<object> {
  const tx = new Transaction({
    nonce,
    value:    BigInt(0),
    receiver: new Address(TARGET_WALLET),
    sender:   new Address(AGENT_ADDRESS),
    gasPrice: GAS_PRICE,
    gasLimit: GAS_LIMIT,
    data:     Buffer.from("ping"),
    chainID:  CHAIN_ID,
    version:  1,
  });

  tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
  return tx.toSendable();
}

async function broadcastTx(txPlain: object): Promise<string | null> {
  try {
    const { data } = await http.post("/transactions", txPlain);
    return data?.txHash ?? null;
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || "unknown";
    if (msg.toLowerCase().includes("nonce")) {
      warn(`Nonce error — resyncing: ${msg}`);
      await syncNonce();
    }
    return null;
  }
}

async function fireBatch(): Promise<void> {
  if (!isGreenLight || !nonceSynced) return;

  // Build and sign all TXs before broadcasting (minimise time gap between checks)
  const txObjects: object[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    txObjects.push(await buildAndSignTx(nextNonce()));
  }

  // Fire all in parallel
  const results = await Promise.allSettled(txObjects.map(broadcastTx));

  const sent = results.filter(
    (r): r is PromiseFulfilledResult<string | null> =>
      r.status === "fulfilled" && r.value !== null
  ).length;

  statTotal += sent;
  if (isGreenLight) statPermitted += sent;

  const elapsed = ((Date.now() - statStartTime) / 1000).toFixed(0);
  log(`🟢 Batch +${sent}/${BATCH_SIZE} | total=${statTotal} permitted=${statPermitted} t=${elapsed}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN WALLET MONITOR
// ─────────────────────────────────────────────────────────────────────────────

async function pollAdminCommands(): Promise<void> {
  if (!ADMIN_WALLET || !TARGET_WALLET) return;

  try {
    const { data } = await http.get(`/accounts/${ADMIN_WALLET}/transactions`, {
      params: { size: 10, order: "desc" },
    });

    const txs: any[] = Array.isArray(data) ? data : [];

    // Walk from oldest to newest so state transitions apply in order
    const newTxs: any[] = [];
    for (const tx of txs) {
      if (tx.txHash === lastSeenTxHash) break;
      newTxs.unshift(tx);
    }

    for (const tx of newTxs) {
      // Only care about transactions sent TO the target wallet
      const receiver: string = tx.receiver || tx.receiverAddress || "";
      if (receiver.toLowerCase() !== TARGET_WALLET.toLowerCase()) continue;

      // Decode the data field (MultiversX API returns base64)
      let command = "";
      if (tx.data) {
        try {
          command = Buffer.from(tx.data, "base64").toString("utf-8");
        } catch {
          command = tx.data;
        }
      }

      if (!command.trim()) continue;

      log(`📡 Admin command: "${command}"`);

      const intent = await interpretCommand(command);
      const newGreen = intent === "GREEN";

      if (newGreen !== isGreenLight) {
        const wasGreen = isGreenLight;
        isGreenLight = newGreen;
        console.log(
          isGreenLight
            ? "\n🟢🟢🟢 GREEN LIGHT — SENDING\n"
            : "\n🔴🔴🔴 RED LIGHT — STOPPED\n"
        );
        // After going RED: wait for pending TXs to settle, then resync nonce
        if (wasGreen && !isGreenLight) {
          setTimeout(() => syncNonce(), 3_000);
        }
      }
    }

    if (txs.length > 0) {
      lastSeenTxHash = txs[0].txHash;
    }
  } catch (e: any) {
    warn(`Monitor error: ${e?.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${msg}`);
}

function warn(msg: string) {
  const t = new Date().toISOString().slice(11, 23);
  console.warn(`[${t}] ⚠️  ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  BoN Agent Arena — Challenge 5 Bot   ║");
  console.log("╚══════════════════════════════════════╝");

  // Validate required config
  const missing = [
    !ADMIN_WALLET   && "ADMIN_WALLET_ADDRESS",
    !TARGET_WALLET  && "TARGET_WALLET_ADDRESS",
    !AGENT_ADDRESS  && "AGENT_ADDRESS",
    !PRIVATE_KEY    && "AGENT_PRIVATE_KEY_HEX",
    !GOOGLE_KEY     && "GOOGLE_GENERATIVE_AI_API_KEY",
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    console.error("Copy .env.example → .env and fill in the values.");
    process.exit(1);
  }

  log(`API:    ${API_URL}`);
  log(`Admin:  ${ADMIN_WALLET}`);
  log(`Target: ${TARGET_WALLET}`);
  log(`Poll:   ${POLL_MS}ms  |  Batch: ${BATCH_SIZE} TXs every ${SEND_MS}ms`);

  initWallet();
  await syncNonce();

  statStartTime = Date.now();

  // Monitor loop — check for admin commands
  const monitorTimer = setInterval(pollAdminCommands, POLL_MS);

  // Sender loop — fire transactions when green
  const senderTimer = setInterval(async () => {
    if (isGreenLight && nonceSynced) {
      await fireBatch();
    }
  }, SEND_MS);

  // Stats print
  const statsTimer = setInterval(() => {
    const elapsed = ((Date.now() - statStartTime) / 60_000).toFixed(1);
    const tps = (statTotal / ((Date.now() - statStartTime) / 1000)).toFixed(1);
    log(`📊 Stats: total=${statTotal} permitted=${statPermitted} elapsed=${elapsed}m avg=${tps}tx/s state=${isGreenLight ? "🟢GREEN" : "🔴RED"}`);
  }, 15_000);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[Agent] Shutting down...");
    isGreenLight = false; // Kill switch
    clearInterval(monitorTimer);
    clearInterval(senderTimer);
    clearInterval(statsTimer);
    console.log(`[Agent] Final: ${statTotal} total TXs, ${statPermitted} during green light`);
    process.exit(0);
  });

  console.log("[Agent] Running. Ctrl+C to stop.\n");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
