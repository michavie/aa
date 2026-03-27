/**
 * Agent Registration — MX-8004 Registry
 *
 * Registration happens on MultiversX DEVNET (where the registry contract lives),
 * NOT on the BoN battle network. Run this once before 15:45 UTC.
 *
 * Usage:
 *   npm run register
 *
 * Requirements:
 *   - agents.json must exist (run `npm start` first to generate wallets, or just `npm run wallet`)
 *   - Each agent wallet must have devnet EGLD for gas (use the devnet faucet)
 *   - DEVNET_API_URL and DEVNET_CHAIN_ID in .env (defaults to public devnet)
 */

import { UserSigner, UserSecretKey } from "@multiversx/sdk-wallet";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import axios from "axios";
import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";

loadEnv();

// ─── Registration network (devnet — where the registry contract lives) ────────
const DEVNET_API   = CONFIG.DEVNET_API;
const DEVNET_CHAIN = CONFIG.DEVNET_CHAIN;
const REGISTRY     = CONFIG.REGISTRY_ADDRESS;

// ─── Agent wallets ────────────────────────────────────────────────────────────
const AGENTS_FILE  = path.resolve(__dirname, "..", "agents.json");

const REG_GAS      = CONFIG.REG_GAS;
const GAS_PRICE    = CONFIG.GAS_PRICE;
const txComputer   = new TransactionComputer();

interface AgentWallet {
  index: number;
  address: string;
  privateKeyHex: string;
}

// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`); }
function warn(msg: string) { console.warn(`[${new Date().toISOString().slice(11, 23)}] ⚠️  ${msg}`); }

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function registerAgent(w: AgentWallet): Promise<void> {
  const secretKey = UserSecretKey.fromString(w.privateKeyHex);
  const signer    = new UserSigner(secretKey);
  const agentName = `BON-Agent-${w.index}`;

  // register_agent(name: bytes, uri: bytes, pubkey: bytes,
  //   metadata: counted-variadic<MetadataEntry> = 0,
  //   services: counted-variadic<ServiceConfigInput> = 0)
  const dataStr = [
    "register_agent",
    Buffer.from(agentName).toString("hex"),
    Buffer.from(`https://agent.molt.bot/${agentName}`).toString("hex"),
    secretKey.generatePublicKey().hex(),
    "00000000", // 0 metadata entries
    "00000000", // 0 services entries
  ].join("@");

  let acct: any;
  try {
    const { data } = await axios.get(`${DEVNET_API}/accounts/${w.address}`, { timeout: 8_000 });
    acct = data;
  } catch (e: any) {
    warn(`  A${w.index} account lookup failed: ${e?.message}`);
    return;
  }

  const balance = BigInt(acct.balance ?? "0");
  if (balance === 0n) {
    warn(`  A${w.index} has no devnet EGLD — fund via https://devnet-wallet.multiversx.com/faucet`);
    warn(`  Address: ${w.address}`);
    return;
  }

  const tx = new Transaction({
    nonce:    BigInt(acct.nonce),
    value:    BigInt(0),
    receiver: new Address(REGISTRY),
    sender:   new Address(w.address),
    gasLimit: REG_GAS,
    gasPrice: GAS_PRICE,
    data:     Buffer.from(dataStr),
    chainID:  DEVNET_CHAIN,
    version:  1,
  });
  tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));

  try {
    const { data } = await axios.post(`${DEVNET_API}/transactions`, tx.toSendable(), {
      headers: { "Content-Type": "application/json" },
      timeout: 8_000,
    });
    log(`  A${w.index} registered → ${data.txHash}`);
    log(`  Explorer: https://devnet-explorer.multiversx.com/transactions/${data.txHash}`);
  } catch (e: any) {
    warn(`  A${w.index} registration failed: ${e?.response?.data?.error || e?.message}`);
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  MX-8004 Agent Registration (devnet)     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  if (!fs.existsSync(AGENTS_FILE)) {
    console.error("agents.json not found — run `npm start` first to generate wallets.");
    process.exit(1);
  }

  const wallets: AgentWallet[] = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));

  log(`Registry:  ${REGISTRY}`);
  log(`Devnet:    ${DEVNET_API}`);
  log(`Agents:    ${wallets.length}\n`);

  log("⚠️  Registration uses devnet EGLD for gas.");
  log("   Each agent wallet needs ~0.05 devnet EGLD.");
  log("   Faucet: https://devnet-wallet.multiversx.com/faucet\n");

  for (const w of wallets) {
    log(`Registering A${w.index}: ${w.address}`);
    await registerAgent(w);
    await sleep(500); // stagger to avoid nonce issues
  }

  log("\nDone. Verify at: https://devnet-explorer.multiversx.com");
  log("Check agent marketplace: https://bon.multiversx.com/guild-wars");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
