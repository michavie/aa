/**
 * Agent Registration — MX-8004 Registry (BoN network)
 *
 * Run once after funding agents, before the challenge starts.
 *
 * Usage:
 *   npm run register
 *
 * Requirements:
 *   - agents.json + wallets/ must exist (run `npm start` first)
 *   - Each agent wallet must have BoN EGLD for gas (run `npm start` — it funds agents)
 */

import { UserSigner } from "@multiversx/sdk-wallet";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import axios from "axios";
import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";

loadEnv();

const AGENTS_FILE = path.resolve(__dirname, "..", "agents.json");
const WALLETS_DIR = path.resolve(__dirname, "..", "wallets");
const txComputer  = new TransactionComputer();

interface AgentWallet {
  index: number;
  address: string;
}

function log(msg: string)  { console.log( `[${new Date().toISOString().slice(11, 23)}] ${msg}`); }
function warn(msg: string) { console.warn(`[${new Date().toISOString().slice(11, 23)}] ⚠️  ${msg}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function registerAgent(w: AgentWallet): Promise<void> {
  const pemPath   = path.join(WALLETS_DIR, `agent-${w.index}.pem`);
  const signer    = UserSigner.fromPem(fs.readFileSync(pemPath, "utf-8"));
  const agentName = `BON-Agent-${w.index}`;

  // Derive pubkey hex from PEM header address is bech32 — need raw pubkey for the call data.
  // Parse the PEM body: base64(secretKeyBytes32 + pubKeyBytes32), pubkey is last 32 bytes.
  const pemBody   = fs.readFileSync(pemPath, "utf-8")
    .replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const combined  = Buffer.from(pemBody, "base64");
  const pubKeyHex = combined.slice(32).toString("hex");

  const dataStr = [
    "register_agent",
    Buffer.from(agentName).toString("hex"),
    Buffer.from(`https://agent.molt.bot/${agentName}`).toString("hex"),
    pubKeyHex,
    "00000000",
    "00000000",
  ].join("@");

  let acct: any;
  try {
    const { data } = await axios.get(`${CONFIG.BON_API}/accounts/${w.address}`, { timeout: 8_000 });
    acct = data;
  } catch (e: any) {
    warn(`  A${w.index} account lookup failed: ${e?.message}`);
    return;
  }

  const balance = BigInt(acct.balance ?? "0");
  if (balance === 0n) {
    warn(`  A${w.index} has no BoN EGLD — run \`npm start\` to fund agents first`);
    warn(`  Address: ${w.address}`);
    return;
  }

  const tx = new Transaction({
    nonce:    BigInt(acct.nonce),
    value:    BigInt(0),
    receiver: new Address(CONFIG.REGISTRY_ADDRESS),
    sender:   new Address(w.address),
    gasLimit: CONFIG.REG_GAS,
    gasPrice: CONFIG.GAS_PRICE,
    data:     Buffer.from(dataStr),
    chainID:  CONFIG.BON_CHAIN,
    version:  1,
  });
  tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));

  try {
    const { data } = await axios.post(`${CONFIG.BON_API}/transactions`, tx.toSendable(), {
      headers: { "Content-Type": "application/json" },
      timeout: 8_000,
    });
    log(`  A${w.index} registered → ${data.txHash}`);
    log(`  Explorer: https://bon-explorer.multiversx.com/transactions/${data.txHash}`);
  } catch (e: any) {
    warn(`  A${w.index} registration failed: ${e?.response?.data?.error || e?.message}`);
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  MX-8004 Agent Registration (BoN)        ║");
  console.log("╚══════════════════════════════════════════╝\n");

  if (!fs.existsSync(AGENTS_FILE)) {
    console.error("agents.json not found — run `npm start` first.");
    process.exit(1);
  }

  const wallets: AgentWallet[] = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));

  log(`Registry: ${CONFIG.REGISTRY_ADDRESS}`);
  log(`API:      ${CONFIG.BON_API}`);
  log(`Agents:   ${wallets.length}\n`);

  for (const w of wallets) {
    log(`Registering A${w.index}: ${w.address}`);
    await registerAgent(w);
    await sleep(500);
  }

  log("\nDone. Verify at: https://bon-explorer.multiversx.com");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
