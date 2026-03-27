import BigNumber from "bignumber.js";
/**
 * An object holding Network stake parameters.
 */
export declare class NetworkStake {
    private static default;
    /**
     * The Total Validators Number.
     */
    TotalValidators: number;
    /**
     * The Active Validators Number.
     */
    ActiveValidators: number;
    /**
     * The Queue Size.
     */
    QueueSize: number;
    /**
     * The Total Validators Number.
     */
    TotalStaked: BigNumber;
    constructor();
    /**
     * Constructs a configuration object from a HTTP response (as returned by the provider).
     */
    static fromHttpResponse(payload: any): NetworkStake;
}
