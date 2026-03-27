export class UserSigner {
  constructor(_key: any) {}
  async sign(_bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(64).fill(0xab); }
}
export class UserSecretKey {
  static fromString(_hex: string) { return new UserSecretKey(); }
  generatePublicKey() {
    return {
      toAddress: () => ({ bech32: () => "erd1test000000000000000000000000000000000000000000000000000000" }),
      hex: () => "aabb".repeat(16),
    };
  }
  hex() { return "ccdd".repeat(16); }
}
export class Mnemonic {
  static generate() { return new Mnemonic(); }
  toString() { return "word ".repeat(24).trim(); }
  deriveKey(_idx: number) { return new UserSecretKey(); }
}
