/// <reference types="node" />
import { IAddress } from "./interface";
export declare class Address implements IAddress {
    private readonly value;
    constructor(value: string);
    static fromPubkey(pubkey: Buffer): IAddress;
    bech32(): string;
    toString(): string;
}
export declare class Nonce {
    private readonly value;
    constructor(value: number);
    valueOf(): number;
    hex(): string;
}
export declare function numberToPaddedHex(value: number): string;
export declare function isPaddedHex(input: string): boolean;
export declare function zeroPadStringIfOddLength(input: string): string;
