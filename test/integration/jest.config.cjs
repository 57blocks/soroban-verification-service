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
  testSequencer: "<rootDir>/setup/test-sequencer.cjs",
  testTimeout: 60_000,
  slowTestThreshold: 30,
};
