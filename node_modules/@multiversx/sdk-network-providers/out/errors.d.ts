/**
 * The base class for exceptions (errors).
 */
export declare class Err extends Error {
    inner: Error | undefined;
    constructor(message: string, inner?: Error);
}
/**
 * Signals an unexpected condition.
 */
export declare class ErrUnexpectedCondition extends Err {
    constructor(message: string);
}
/**
 * Signals an error that happened during a request against the Network.
 */
export declare class ErrNetworkProvider extends Err {
    constructor(url: string, error: string, inner?: Error);
}
/**
 * Signals a generic error in the context of querying Smart Contracts.
 */
export declare class ErrContractQuery extends Err {
    constructor(originalError: Error);
}
