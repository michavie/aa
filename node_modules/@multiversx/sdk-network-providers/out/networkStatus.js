"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetworkStatus = void 0;
/**
 * An object holding network status configuration parameters.
 */
class NetworkStatus {
    constructor() {
        this.CurrentRound = 0;
        this.EpochNumber = 0;
        this.HighestFinalNonce = 0;
        this.Nonce = 0;
        this.NonceAtEpochStart = 0;
        this.NoncesPassedInCurrentEpoch = 0;
        this.RoundAtEpochStart = 0;
        this.RoundsPassedInCurrentEpoch = 0;
        this.RoundsPerEpoch = 0;
    }
    /**
     * Constructs a configuration object from a HTTP response (as returned by the provider).
     */
    static fromHttpResponse(payload) {
        let networkStatus = new NetworkStatus();
        networkStatus.CurrentRound = Number(payload["erd_current_round"]);
        networkStatus.EpochNumber = Number(payload["erd_epoch_number"]);
        networkStatus.HighestFinalNonce = Number(payload["erd_highest_final_nonce"]);
        networkStatus.Nonce = Number(payload["erd_nonce"]);
        networkStatus.NonceAtEpochStart = Number(payload["erd_nonce_at_epoch_start"]);
        networkStatus.NoncesPassedInCurrentEpoch = Number(payload["erd_nonces_passed_in_current_epoch"]);
        networkStatus.RoundAtEpochStart = Number(payload["erd_round_at_epoch_start"]);
        networkStatus.RoundsPassedInCurrentEpoch = Number(payload["erd_rounds_passed_in_current_epoch"]);
        networkStatus.RoundsPerEpoch = Number(payload["erd_rounds_per_epoch"]);
        return networkStatus;
    }
}
exports.NetworkStatus = NetworkStatus;
//# sourceMappingURL=networkStatus.js.map