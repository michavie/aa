module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  moduleNameMapper: {
    // Prevent the heavy SDK imports from breaking unit tests
    "@multiversx/sdk-core": "<rootDir>/tests/__mocks__/sdk-core.ts",
    "@multiversx/sdk-wallet": "<rootDir>/tests/__mocks__/sdk-wallet.ts",
    "@ai-sdk/google": "<rootDir>/tests/__mocks__/ai-sdk-google.ts",
    "^ai$": "<rootDir>/tests/__mocks__/ai.ts",
  },
};
