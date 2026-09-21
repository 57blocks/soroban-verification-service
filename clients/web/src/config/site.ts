// Links referenced by more than one feature. Feature-local links stay in that feature.

export const githubRepoUrl =
  "https://github.com/57blocks/soroban-verification-service";

/**
 * The repository above is private, so every link into it answers 404 for a reader outside the organisation.
 * It was created private and is still private — the flip to public had not happened as of 2026-09-21, and
 * nothing here changes until it does.
 */
export const sourceIsPublic: boolean = false;

export const sdkReadmeUrl = `${githubRepoUrl}/tree/main/clients/sdk`;

/** The self-host entry point: what standing up your own verifier actually requires. */
export const selfHostGuideUrl = `${githubRepoUrl}/blob/main/docs/self-hosted-deployment.md`;

export const docsUrl = `${githubRepoUrl}/tree/main/docs`;

export const securityPolicyUrl = `${githubRepoUrl}/blob/main/SECURITY.md`;

/** The company credit in both footers. */
export const companyUrl = "https://57blocks.com";

export const sep58SpecUrl =
  "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0058.md";

/** The two legal documents, linked from both footers and from the submission control. */
export const legalLinks = [
  { to: "/terms", label: "Terms of Service" },
  { to: "/privacy", label: "Privacy Notice" },
] as const;
