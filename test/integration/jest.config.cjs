/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: true }],
  },
  testMatch: ["<rootDir>/cases/**/*.spec.ts"],
  setupFiles: ["<rootDir>/setup/jest.setup.cjs"],
  globalTeardown: "<rootDir>/setup/global-teardown.cjs",
  // E2E-SEC-11/12's quota probes run last: they deliberately spend the deployment's submission budget down to
  // its ceiling, and in run #43 they took the two cases scheduled after them down with 503s.
  testSequencer: "<rootDir>/setup/test-sequencer.cjs",
  // No `globalSetup` from packages/db/testing: this suite never opens a database connection.
  testTimeout: 60_000,
  slowTestThreshold: 30,
};
