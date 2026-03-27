import BigNumber from "bignumber.js";
/**
 * An object holding Network configuration parameters.
 */
export declare class NetworkConfig {
    /**
     * The chain ID. E.g. "1" for the Mainnet.
     */
    ChainID: string;
    /**
     * The gas required by the Network to process a byte of the transaction data.
     */
    GasPerDataByte: number;
    /**
     * The round duration.
     */
    RoundDuration: number;
    /**
     * The number of rounds per epoch.
     */
    RoundsPerEpoch: number;
    /**
     * The Top Up Factor for APR calculation
     */
    TopUpFactor: number;
    /**
     * The Top Up Factor for APR calculation
     */
    TopUpRewardsGradientPoint: BigNumber;
    GasPriceModifier: number;
    /**
     * The minimum gas limit required to be set when broadcasting a transaction.
     */
    MinGasLimit: number;
    /**
     * The minimum gas price required to be set when broadcasting a transaction.
     */
    MinGasPrice: number;
    /**
     * The oldest transaction version accepted by the Network.
     */
    MinTransactionVersion: number;
    constructor();
    /**
     * Constructs a configuration object from a HTTP response (as returned by the provider).
     */
    static fromHttpResponse(payload: any): NetworkConfig;
}
