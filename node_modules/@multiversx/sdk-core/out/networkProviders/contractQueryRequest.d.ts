import { IContractQuery } from "./interface";
export declare class ContractQueryRequest {
    private readonly query;
    constructor(query: IContractQuery);
    toHttpRequest(): any;
}
