import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";
import * as fs from "fs";

export interface StoredPemParts {
  address: string;
  secretHex: string;
  publicHex: string;
}

export function parseStoredPem(pemPath: string): StoredPemParts {
  const pem = fs.readFileSync(pemPath, "utf-8");
  const address = pem.match(/-----BEGIN PRIVATE KEY for (\S+)-----/)?.[1] ?? "";
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const combined = Buffer.from(body, "base64");
  const secretHex = combined.subarray(0, 32).toString("hex");
  const publicHex = combined.subarray(32).toString("hex");

  if (!address || secretHex.length !== 64 || publicHex.length !== 64) {
    throw new Error(`Invalid stored PEM at ${pemPath}`);
  }

  return { address, secretHex, publicHex };
}

export function signerFromStoredPem(pemPath: string): UserSigner {
  const { secretHex } = parseStoredPem(pemPath);
  return new UserSigner(UserSecretKey.fromString(secretHex));
}

export function toStoredPem(secretKey: UserSecretKey): string {
  const address = secretKey.generatePublicKey().toAddress().bech32();
  const combined = Buffer.from(secretKey.hex() + secretKey.generatePublicKey().hex(), "hex");
  return `-----BEGIN PRIVATE KEY for ${address}-----\n${combined.toString("base64")}\n-----END PRIVATE KEY for ${address}-----\n`;
}
