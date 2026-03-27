/**
 * One-time setup — generates all agent wallets.
 * Safe to rerun: skips files that already exist.
 *
 * For testing (also generates gl.pem): npm run setup:test
 *
 * Usage:
 *   npm run setup
 */
import { Mnemonic, UserSecretKey } from "@multiversx/sdk-wallet";
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";

const ROOT        = path.resolve(__dirname, "..");
const WALLETS_DIR = path.join(ROOT, "wallets");
const AGENTS_FILE = path.join(ROOT, "agents.json");

function toPem(secretKey: UserSecretKey): string {
  const address  = secretKey.generatePublicKey().toAddress().bech32();
  const combined = Buffer.from(secretKey.hex() + secretKey.generatePublicKey().hex(), "hex");
  return `-----BEGIN PRIVATE KEY for ${address}-----\n${combined.toString("base64")}\n-----END PRIVATE KEY for ${address}-----\n`;
}

console.log("╔══════════════════════════════════════════╗");
console.log("║  Agent Arena — Setup                     ║");
console.log("╚══════════════════════════════════════════╝\n");

// Agent wallets
fs.mkdirSync(WALLETS_DIR, { recursive: true });

const wallets: { index: number; address: string }[] = [];
let generated = 0;

for (let i = 0; i < CONFIG.NUM_AGENTS; i++) {
  const pemPath = path.join(WALLETS_DIR, `agent-${i}.pem`);

  if (fs.existsSync(pemPath)) {
    const addr = fs.readFileSync(pemPath, "utf-8").match(/-----BEGIN PRIVATE KEY for (\S+)-----/)?.[1] ?? "";
    wallets.push({ index: i, address: addr });
    console.log(`  A${i}: already exists — skip`);
  } else {
    const mnemonic  = Mnemonic.generate();
    const secretKey = mnemonic.deriveKey(0);
    const address   = secretKey.generatePublicKey().toAddress().bech32();
    fs.writeFileSync(pemPath, toPem(secretKey));
    wallets.push({ index: i, address });
    console.log(`  A${i}: ${address}`);
    generated++;
  }
}

fs.writeFileSync(AGENTS_FILE, JSON.stringify(wallets, null, 2));

console.log(`\n✅ ${generated} new agent wallet(s) generated, ${CONFIG.NUM_AGENTS - generated} reused`);
console.log(`   agents.json updated`);
console.log(`\n⚠️  Back up wallets/ and gl.pem — losing them = losing funds`);
