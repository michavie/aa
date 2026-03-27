/**
 * An object holding general Network statistics and parameters.
 */
export declare class NetworkGeneralStatistics {
    /**
     * The number of Shards.
     */
    Shards: number;
    /**
     * The Number of Blocks.
     */
    Blocks: number;
    /**
     * The Number of Accounts.
     */
    Accounts: number;
    /**
     * The Number of transactions.
     */
    Transactions: number;
    /**
     * The Refresh rate.
     */
    RefreshRate: number;
    /**
     * The Number of the current Epoch.
     */
    Epoch: number;
    /**
     * The Number of rounds passed.
     */
    RoundsPassed: number;
    /**
     * The Number of Rounds per epoch.
     */
    RoundsPerEpoch: number;
    constructor();
    /**
     * Constructs a stats object from a HTTP response (as returned by the provider).
     */
    static fromHttpResponse(payload: any): NetworkGeneralStatistics;
}
