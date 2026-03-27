/**
 * Agent Registration — MX-8004 Registry (BoN network)
 *
 * Usage:
 *   npm run register
 *   ONLY_AGENTS=2,3,4 npm run register
 */

import {
  Abi,
  Address,
  BigUIntType,
  BigUIntValue,
  BytesType,
  BytesValue,
  Field,
  FieldDefinition,
  SmartContractTransactionsFactory,
  Struct,
  StructType,
  TokenIdentifierType,
  TokenIdentifierValue,
  TransactionComputer,
  TransactionsFactoryConfig,
  U32Type,
  U32Value,
  U64Type,
  U64Value,
  VariadicValue,
} from "@multiversx/sdk-core";
import axios from "axios";
import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";
import { parseStoredPem, signerFromStoredPem } from "./wallets";

loadEnv();

const AGENTS_FILE = path.resolve(__dirname, "..", "agents.json");
const WALLETS_DIR = path.resolve(__dirname, "..", "wallets");
const AGENT_CONFIG_FILE = path.resolve(__dirname, "..", "agent.config.json");
const REGISTRY_ABI_FILE = path.resolve(__dirname, "..", "identity-registry.abi.json");
const txComputer = new TransactionComputer();
const AGENT_BASE_URI = process.env.AGENT_BASE_URI || "https://agent.molt.bot";
const ONLY_AGENT_INDEXES = new Set(
  (process.env.ONLY_AGENTS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value >= 0),
);

interface AgentWallet {
  index: number;
  address: string;
}

interface RegistrationConfig {
  agentName?: string;
  manifestUri?: string;
  metadata?: Array<{ key: string; value: string }>;
  services?: Array<{
    service_id: number;
    price: string;
    token: string;
    nonce: number;
  }>;
}

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`); }
function warn(msg: string) { console.warn(`[${new Date().toISOString().slice(11, 23)}] ${msg}`); }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

function loadRegistrationConfig(): RegistrationConfig {
  if (!fs.existsSync(AGENT_CONFIG_FILE)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(AGENT_CONFIG_FILE, "utf-8"));
}

function loadRegistryAbi(): Abi {
  const raw = fs.readFileSync(REGISTRY_ABI_FILE, "utf-8")
    .replace(/\bTokenId\b/g, "TokenIdentifier")
    .replace(/\bNonZeroBigUint\b/g, "BigUint")
    .replace(/\bcounted-variadic\b/g, "variadic")
    .replace(/\bList</g, "variadic<")
    .replace(/\bPayment\b/g, "EgldOrEsdtTokenPayment");

  return Abi.create(JSON.parse(raw));
}

function createFactory(abi: Abi): SmartContractTransactionsFactory {
  return new SmartContractTransactionsFactory({
    config: new TransactionsFactoryConfig({ chainID: CONFIG.BON_CHAIN }),
    abi,
  });
}

function metadataToTyped(metadata: RegistrationConfig["metadata"] = []): Struct[] {
  const metadataType = new StructType("MetadataEntry", [
    new FieldDefinition("key", "", new BytesType()),
    new FieldDefinition("value", "", new BytesType()),
  ]);

  return metadata.map(entry => {
    const value = entry.value.startsWith("0x")
      ? Buffer.from(entry.value.slice(2), "hex")
      : Buffer.from(entry.value);

    return new Struct(metadataType, [
      new Field(new BytesValue(Buffer.from(entry.key)), "key"),
      new Field(new BytesValue(value), "value"),
    ]);
  });
}

function servicesToTyped(services: RegistrationConfig["services"] = []): Struct[] {
  const serviceType = new StructType("ServiceConfigInput", [
    new FieldDefinition("service_id", "", new U32Type()),
    new FieldDefinition("price", "", new BigUIntType()),
    new FieldDefinition("token", "", new TokenIdentifierType()),
    new FieldDefinition("nonce", "", new U64Type()),
  ]);

  return services.map(service => new Struct(serviceType, [
    new Field(new U32Value(service.service_id), "service_id"),
    new Field(new BigUIntValue(BigInt(service.price)), "price"),
    new Field(new TokenIdentifierValue(service.token), "token"),
    new Field(new U64Value(BigInt(service.nonce)), "nonce"),
  ]));
}

async function findExistingRegistrationTx(address: string): Promise<string | null> {
  try {
    const { data } = await axios.get(`${CONFIG.BON_API}/accounts/${address}/transactions`, {
      params: { size: 1000, order: "desc" },
      timeout: 8_000,
    });

    const existing = data.find((tx: any) =>
      tx.receiver === CONFIG.REGISTRY_ADDRESS &&
      tx.status === "success" &&
      tx.action?.name === "register_agent",
    );

    return existing?.txHash ?? null;
  } catch {
    return null;
  }
}

async function waitForFinalTx(txHash: string): Promise<any> {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    try {
      const { data } = await axios.get(`${CONFIG.BON_API}/transactions/${txHash}`, { timeout: 8_000 });
      const status = String(data?.status || "unknown");

      if (status === "success" || status === "fail" || status === "invalid") {
        return data;
      }
    } catch {
      // keep polling
    }

    await sleep(1_500);
  }

  return { status: "pending" };
}

async function registerAgent(
  wallet: AgentWallet,
  config: RegistrationConfig,
  factory: SmartContractTransactionsFactory,
): Promise<void> {
  const existingHash = await findExistingRegistrationTx(wallet.address);
  if (existingHash) {
    log(`A${wallet.index} already registered → ${existingHash}`);
    return;
  }

  const pemPath = path.join(WALLETS_DIR, `agent-${wallet.index}.pem`);
  const signer = signerFromStoredPem(pemPath);
  const { publicHex: pubKeyHex } = parseStoredPem(pemPath);
  const agentName = config.agentName ? `${config.agentName}-${wallet.index}` : `BON-Agent-${wallet.index}`;
  const agentUri = config.manifestUri || `${AGENT_BASE_URI.replace(/\/$/, "")}/${agentName}`;

  let acct: any;
  try {
    const { data } = await axios.get(`${CONFIG.BON_API}/accounts/${wallet.address}`, { timeout: 8_000 });
    acct = data;
  } catch (error: any) {
    warn(`A${wallet.index} account lookup failed: ${error?.message}`);
    return;
  }

  const balance = BigInt(acct.balance ?? "0");
  if (balance === 0n) {
    warn(`A${wallet.index} has no BoN EGLD`);
    return;
  }

  const tx = await factory.createTransactionForExecute(new Address(wallet.address), {
    contract: new Address(CONFIG.REGISTRY_ADDRESS),
    function: "register_agent",
    gasLimit: CONFIG.REG_GAS,
    arguments: [
      Buffer.from(agentName),
      Buffer.from(agentUri),
      Buffer.from(pubKeyHex, "hex"),
      VariadicValue.fromItemsCounted(...metadataToTyped(config.metadata)),
      VariadicValue.fromItemsCounted(...servicesToTyped(config.services)),
    ],
  });

  tx.nonce = BigInt(acct.nonce);
  tx.gasPrice = CONFIG.GAS_PRICE;
  tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));

  try {
    const { data } = await axios.post(`${CONFIG.BON_API}/transactions`, tx.toSendable(), {
      headers: { "Content-Type": "application/json" },
      timeout: 8_000,
    });

    log(`A${wallet.index} submitted → ${data.txHash}`);
    const receipt = await waitForFinalTx(data.txHash);
    log(`A${wallet.index} status: ${receipt.status}`);

    if (receipt.status !== "success") {
      const reason =
        receipt?.smartContractResults?.find((item: any) => item.returnMessage)?.returnMessage ||
        receipt?.returnMessage ||
        receipt?.logs?.events?.find((item: any) => item.identifier === "signalError")?.topics?.[1] ||
        "unknown";
      warn(`A${wallet.index} reason: ${reason}`);
    }

    log(`Explorer: https://bon-explorer.multiversx.com/transactions/${data.txHash}`);
  } catch (error: any) {
    warn(`A${wallet.index} registration failed: ${error?.response?.data?.error || error?.message}`);
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  MX-8004 Agent Registration (BoN)       ║");
  console.log("╚══════════════════════════════════════════╝\n");

  if (!fs.existsSync(AGENTS_FILE)) {
    console.error("agents.json not found — run `npm start` first.");
    process.exit(1);
  }

  const wallets: AgentWallet[] = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
  const selectedWallets = ONLY_AGENT_INDEXES.size
    ? wallets.filter(wallet => ONLY_AGENT_INDEXES.has(wallet.index))
    : wallets;
  const config = loadRegistrationConfig();
  const factory = createFactory(loadRegistryAbi());

  log(`Registry: ${CONFIG.REGISTRY_ADDRESS}`);
  log(`API: ${CONFIG.BON_API}`);
  log(`Agent URI: ${config.manifestUri || AGENT_BASE_URI}`);
  log(`Agents: ${selectedWallets.length}${ONLY_AGENT_INDEXES.size ? ` (${[...ONLY_AGENT_INDEXES].sort((a, b) => a - b).join(", ")})` : ""}\n`);

  for (const wallet of selectedWallets) {
    log(`Registering A${wallet.index}: ${wallet.address}`);
    await registerAgent(wallet, config, factory);
    await sleep(500);
  }

  log("Done. Verify at: https://bon-explorer.multiversx.com");
}

main().catch(error => {
  console.error("Fatal:", error);
  process.exit(1);
});
