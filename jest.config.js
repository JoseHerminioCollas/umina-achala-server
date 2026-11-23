export default {
  testEnvironment: "node",
  testTimeout: 20000,
  transform: { "^.+\\.js$": "babel-jest" },
  // umina-achala-chain is ES modules: transform it too
  transformIgnorePatterns: ["/node_modules/(?!umina-achala-chain/)"],
  // NETWORK is required by the chain code; the tests run as on testnet
  setupFiles: ["<rootDir>/__tests__/setupNetwork.js"],
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/__tests__/setupNetwork.js"],
};
