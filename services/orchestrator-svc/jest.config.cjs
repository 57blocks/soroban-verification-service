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
  testMatch: ["**/test/**/*.spec.ts"],
  setupFiles: ["<rootDir>/test/jest.setup.cjs"],
  // Reports a database that was already dirty before the suites started, so a red suite can be told apart from
  // a red database at a glance.
  globalSetup: "../../packages/db/testing/db-state-setup.cjs",
};
