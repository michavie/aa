export class Address {
  constructor(public value: string) {}
  bech32() { return this.value; }
}
export class Transaction {
  nonce: bigint;
  signature?: Uint8Array;
  constructor(opts: any) { this.nonce = opts.nonce ?? 0n; }
  toSendable() { return { nonce: Number(this.nonce), signature: "aabbcc" }; }
}
export class TransactionComputer {
  computeBytesForSigning(_tx: any) { return new Uint8Array(32); }
}
