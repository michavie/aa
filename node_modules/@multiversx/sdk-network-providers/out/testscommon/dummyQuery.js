"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockQuery = void 0;
const primitives_1 = require("../primitives");
class MockQuery {
    constructor(init) {
        this.caller = new primitives_1.Address("");
        this.address = new primitives_1.Address("");
        this.func = "";
        this.args = [];
        this.value = "";
        Object.assign(this, init);
    }
    getEncodedArguments() {
        return this.args;
    }
}
exports.MockQuery = MockQuery;
//# sourceMappingURL=dummyQuery.js.map