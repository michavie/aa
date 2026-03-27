import { IAddress } from "./interface";
export declare class TransactionReceipt {
    value: string;
    sender: IAddress;
    data: string;
    hash: string;
    static fromHttpResponse(response: {
        value: string;
        sender: string;
        data: string;
        txHash: string;
    }): TransactionReceipt;
}
