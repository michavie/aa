import { Mnemonic } from "@multiversx/sdk-wallet";
import * as fs from "fs";
import * as path from "path";
import { toStoredPem } from "./wallets";

const ROOT = path.resolve(__dirname, "..");
const GL_PEM_PATH = path.join(ROOT, "gl.pem");

console.log("╔══════════════════════════════════════════╗");
console.log("║  Agent Arena — Test GL Wallet            ║");
console.log("╚══════════════════════════════════════════╝\n");

if (fs.existsSync(GL_PEM_PATH)) {
  const existing = fs.readFileSync(GL_PEM_PATH, "utf-8");
  const address = existing.match(/-----BEGIN PRIVATE KEY for (\S+)-----/)?.[1] ?? "unknown";
  console.log(`Existing gl.pem preserved: ${address}`);
  process.exit(0);
}

const mnemonic = Mnemonic.generate();
const secretKey = mnemonic.deriveKey(0);
const address = secretKey.generatePublicKey().toAddress().bech32();
fs.writeFileSync(GL_PEM_PATH, toStoredPem(secretKey));

console.log(`Address:  ${address}`);
console.log(`Mnemonic: ${mnemonic.toString()}`);
console.log(`Saved:    ${GL_PEM_PATH}`);
