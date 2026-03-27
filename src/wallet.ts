/**
 * Wallet generator — run once to create your agent wallet.
 * Outputs address + private key hex to configure in .env
 */
import { Mnemonic, UserSecretKey } from "@multiversx/sdk-wallet";

const mnemonic = Mnemonic.generate();
const secretKey = mnemonic.deriveKey(0);
const pubKey = secretKey.generatePublicKey();
const address = pubKey.toAddress();

console.log("=== NEW AGENT WALLET ===");
console.log(`Mnemonic    : ${mnemonic.toString()}`);
console.log(`Address     : ${address.bech32()}`);
console.log(`Private Key : ${secretKey.hex()}`);
console.log("");
console.log("Add to .env:");
console.log(`AGENT_ADDRESS=${address.bech32()}`);
console.log(`AGENT_PRIVATE_KEY_HEX=${secretKey.hex()}`);
console.log("");
console.log("Fund this address from your guild leader wallet, then register it via MX-8004.");
