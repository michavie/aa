/**
 * Local Red Light / Green Light Simulator
 *
 * Runs a fake admin wallet that sends commands to a fake target wallet,
 * both using a local MultiversX devnet or configurable API.
 *
 * Usage:
 *   npm run simulate
 *
 * What it does:
 *   - Sends random green/red commands to the TARGET wallet at random intervals
 *   - Includes adversarial commands designed to test your agent's LLM interpreter
 *   - Prints each command so you can verify your agent interprets it correctly
 *
 * Point your agent at the same API + admin/target wallets from .env, then run
 * both this script and `npm start` to do a full end-to-end simulation.
 */

import { UserSigner, UserSecretKey } from "@multiversx/sdk-wallet";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import axios from "axios";
import { config as loadEnv } from "dotenv";
import { CONFIG } from "./config";

loadEnv();

const API_URL       = CONFIG.BON_API;
const CHAIN_ID      = CONFIG.BON_CHAIN;
const ADMIN_KEY     = process.env.SIMULATE_ADMIN_KEY || process.env.GL_PRIVATE_KEY_HEX || "";
const TARGET_WALLET = process.env.TARGET_WALLET_ADDRESS || "";

const GAS_LIMIT     = CONFIG.FUND_GAS;
const GAS_PRICE     = CONFIG.GAS_PRICE;

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND SETS
// ─────────────────────────────────────────────────────────────────────────────

const GREEN_COMMANDS = [
  // Clear
  "go",
  "start",
  "proceed",
  "fire",
  "green light",
  "begin sending",
  "you may send transactions now",
  "unleash the bots",
  // Creative
  "the gates are open",
  "it's game time",
  "full speed ahead",
  "engines on",
  "send it",
  "let 'er rip",
  // Adversarial — designed to confuse keyword matchers
  "don't stop",
  "never stop sending",
  "stop stopping and start going",
  "the red light is off, it's green now",
  "pause? no. go.",
  "cease ceasing. commence.",
  "halt? absolutely not. proceed.",
  "what would you do if I said go? because I'm saying go",
];

const RED_COMMANDS = [
  // Clear
  "stop",
  "halt",
  "freeze",
  "pause",
  "cease",
  "red light",
  "stop all transactions",
  "kill it",
  // Creative
  "everyone stand down",
  "hold your horses",
  "pump the brakes",
  "abort",
  "time out",
  "hands in the air",
  "nobody moves",
  // Adversarial
  "don't go",
  "don't proceed",
  "the green light is now off",
  "proceed to halt",
  "you may now cease operations",
  "go ahead and stop",
  "I'd love for you to stop",
  "stopping time has arrived",
  "what does green mean? stop. that's what it means here",
];

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO: random sequence of green/red windows
// ─────────────────────────────────────────────────────────────────────────────

interface CommandEvent {
  command: string;
  isGreen: boolean;
  delayMs: number;         // wait before sending this command
  windowMs: number;        // how long this state lasts
  adversarial: boolean;
}

function buildScenario(rounds: number): CommandEvent[] {
  const events: CommandEvent[] = [];
  let currentGreen = false;

  for (let i = 0; i < rounds; i++) {
    currentGreen = !currentGreen;
    const commands = currentGreen ? GREEN_COMMANDS : RED_COMMANDS;
    const command  = commands[Math.floor(Math.random() * commands.length)];
    const adversarial = command.includes("don't") || command.includes("no.") ||
      command.includes("not") || command.includes("red light is") ||
      command.includes("proceed to halt") || command.includes("go ahead and stop");

    events.push({
      command,
      isGreen: currentGreen,
      delayMs: i === 0 ? 3_000 : rand(10_000, 20_000), // 10–20s between commands
      windowMs: rand(10_000, 30_000),
      adversarial,
    });
  }

  // Always end with RED so agent stops cleanly
  if (events.length > 0 && events[events.length - 1].isGreen) {
    events.push({
      command: "halt — simulation over",
      isGreen: false,
      delayMs: events[events.length - 1].windowMs,
      windowMs: 5_000,
      adversarial: false,
    });
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// TX SENDER
// ─────────────────────────────────────────────────────────────────────────────

const txComputer = new TransactionComputer();

async function sendCommand(
  command: string,
  signer: UserSigner,
  adminAddress: string,
  nonce: bigint
): Promise<void> {
  const tx = new Transaction({
    nonce,
    value:    BigInt(0),
    receiver: new Address(TARGET_WALLET),
    sender:   new Address(adminAddress),
    gasLimit: GAS_LIMIT,
    gasPrice: GAS_PRICE,
    data:     Buffer.from(command),
    chainID:  CHAIN_ID,
    version:  1,
  });
  tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));

  const { data } = await axios.post(`${API_URL}/transactions`, tx.toSendable(), {
    headers: { "Content-Type": "application/json" },
  });

  console.log(`  → ${data.txHash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Red Light / Green Light — Local Simulator  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  if (!ADMIN_KEY)     { console.error("Set SIMULATE_ADMIN_KEY or GL_PRIVATE_KEY_HEX in .env"); process.exit(1); }
  if (!TARGET_WALLET) { console.error("Set TARGET_WALLET_ADDRESS in .env"); process.exit(1); }

  const adminKey     = UserSecretKey.fromString(ADMIN_KEY);
  const signer       = new UserSigner(adminKey);
  const adminAddress = adminKey.generatePublicKey().toAddress().bech32();

  console.log(`Admin:  ${adminAddress}`);
  console.log(`Target: ${TARGET_WALLET}`);
  console.log(`API:    ${API_URL}\n`);

  // Get starting nonce
  const { data: acct } = await axios.get(`${API_URL}/accounts/${adminAddress}`);
  let nonce = BigInt(acct.nonce);

  const ROUNDS  = 10; // number of state changes
  const scenario = buildScenario(ROUNDS);

  console.log(`Scenario: ${scenario.length} commands\n`);
  scenario.forEach((e, i) => {
    const tag = e.adversarial ? " ⚠️  ADVERSARIAL" : "";
    console.log(`  ${i + 1}. [${e.isGreen ? "🟢 GREEN" : "🔴 RED  "}] "${e.command}"${tag}`);
  });
  console.log(`\nStarting in 3s... (make sure your agent is running)\n`);
  await sleep(3_000);

  let correctInterpretations = 0;
  let totalCommands = 0;

  for (const event of scenario) {
    await sleep(event.delayMs);

    const tag = event.adversarial ? " ⚠️  ADVERSARIAL" : "";
    console.log(`\n[${new Date().toISOString().slice(11,19)}] Sending [${event.isGreen ? "🟢 GREEN" : "🔴 RED  "}]${tag}`);
    console.log(`  Command: "${event.command}"`);

    try {
      await sendCommand(event.command, signer, adminAddress, nonce++);
      console.log(`  Expected: ${event.isGreen ? "SEND transactions" : "STOP transactions"}`);
      totalCommands++;
    } catch (e: any) {
      console.error(`  ⚠️  Failed to send: ${e?.response?.data?.error || e?.message}`);
    }
  }

  console.log(`\n✅ Simulation complete — ${totalCommands} commands sent.`);
  console.log(`Check your agent logs to verify it correctly interpreted each one.`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
