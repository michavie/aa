"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetworkStake = void 0;
const bignumber_js_1 = __importDefault(require("bignumber.js"));
/**
 * An object holding Network stake parameters.
 */
class NetworkStake {
    constructor() {
        this.TotalValidators = 0;
        this.ActiveValidators = 0;
        this.QueueSize = 0;
        this.TotalStaked = new bignumber_js_1.default(0);
    }
    /**
     * Constructs a configuration object from a HTTP response (as returned by the provider).
     */
    static fromHttpResponse(payload) {
        let networkStake = new NetworkStake();
        networkStake.TotalValidators = Number(payload["totalValidators"]);
        networkStake.ActiveValidators = Number(payload["activeValidators"]);
        networkStake.QueueSize = Number(payload["queueSize"]);
        networkStake.TotalStaked = new bignumber_js_1.default(payload["totalStaked"]);
        return networkStake;
    }
}
exports.NetworkStake = NetworkStake;
//# sourceMappingURL=networkStake.js.map