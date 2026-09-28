export interface JestSmokeCase {
  readonly id: string;
  readonly file: string;
  readonly provisioned?: boolean;
  readonly fixtureId?: string;
}

export interface BrowserSmokeCase {
  readonly id: string;
  readonly file: string;
}

export const smokeJestCases: readonly JestSmokeCase[] = [
  { id: "E2E-VERIFY-HEALTH", file: "cases/verify/verify-health.spec.ts" },
  { id: "E2E-SUB-01/testnet", file: "cases/sub/sub-01-recipe-completion.spec.ts" },
  { id: "E2E-SUB-03", file: "cases/sub/sub-03-cli58.spec.ts" },
  { id: "E2E-SRC-05", file: "cases/src/src-visibility.spec.ts" },
  {
    id: "E2E-SRC-05/cli_58_private_upload",
    file: "cases/src/src-visibility.spec.ts",
    provisioned: true,
    fixtureId: "F-58-PRIV",
  },
  { id: "E2E-QRY-06", file: "cases/qry/qry-address-and-openness.spec.ts" },
  { id: "E2E-QRY-11", file: "cases/qry/qry-address-and-openness.spec.ts" },
  { id: "E2E-API-01", file: "cases/api-contract/openapi-contract.spec.ts" },
  { id: "E2E-PUB-14", file: "cases/pub/pub-layout-and-bulk-load.spec.ts" },
];

export const smokeBrowserCases: readonly BrowserSmokeCase[] = [
  { id: "E2E-WEB-01", file: "cases/web/web-01-public-console.pw.ts" },
];

export const smokeCaseIds = [...smokeBrowserCases, ...smokeJestCases].map(({ id }) => id);
