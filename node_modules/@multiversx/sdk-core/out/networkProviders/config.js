"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultPagination = exports.defaultAxiosConfig = void 0;
const JSONbig = require("json-bigint")({ constructorAction: 'ignore' });
exports.defaultAxiosConfig = {
    timeout: 5000,
    // See: https://github.com/axios/axios/issues/983 regarding transformResponse
    transformResponse: [
        function (data) {
            return JSONbig.parse(data);
        }
    ]
};
exports.defaultPagination = {
    from: 0,
    size: 100
};
//# sourceMappingURL=config.js.map