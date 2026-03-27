import { IAddress } from "./interface";
import { TransactionLogs } from "./transactionLogs";
export declare class ContractResults {
    readonly items: ContractResultItem[];
    constructor(items: ContractResultItem[]);
    static fromProxyHttpResponse(results: any[]): ContractResults;
    static fromApiHttpResponse(results: any[]): ContractResults;
}
export declare class ContractResultItem {
    hash: string;
    nonce: number;
    value: string;
    receiver: IAddress;
    sender: IAddress;
    data: string;
    previousHash: string;
    originalHash: string;
    gasLimit: number;
    gasPrice: number;
    callType: number;
    returnMessage: string;
    logs: TransactionLogs;
    constructor(init?: Partial<ContractResultItem>);
    static fromProxyHttpResponse(response: any): ContractResultItem;
    static fromApiHttpResponse(response: any): ContractResultItem;
    private static fromHttpResponse;
}
