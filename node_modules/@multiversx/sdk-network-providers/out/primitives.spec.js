"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const primitives_1 = require("./primitives");
describe("test primitives", function () {
    it("should create address from bech32 and from pubkey", function () {
        return __awaiter(this, void 0, void 0, function* () {
            let aliceBech32 = "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th";
            let bobBech32 = "erd1spyavw0956vq68xj8y4tenjpq2wd5a9p2c6j8gsz7ztyrnpxrruqzu66jx";
            let alicePubkey = Buffer.from("0139472eff6886771a982f3083da5d421f24c29181e63888228dc81ca60d69e1", "hex");
            let bobPubkey = Buffer.from("8049d639e5a6980d1cd2392abcce41029cda74a1563523a202f09641cc2618f8", "hex");
            chai_1.assert.equal(new primitives_1.Address(aliceBech32).bech32(), primitives_1.Address.fromPubkey(alicePubkey).bech32());
            chai_1.assert.equal(new primitives_1.Address(bobBech32).bech32(), primitives_1.Address.fromPubkey(bobPubkey).bech32());
            chai_1.assert.equal(new primitives_1.Address(aliceBech32).toString(), aliceBech32);
            chai_1.assert.equal(new primitives_1.Address(bobBech32).toString(), bobBech32);
        });
    });
});
//# sourceMappingURL=primitives.spec.js.map