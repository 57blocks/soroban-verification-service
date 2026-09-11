// Links referenced by more than one feature. Feature-local links stay in that feature.

export const githubRepoUrl =
  "https://github.com/57blocks/soroban-verification-service";

/**
 * The repository above is private, so every link into it answers 404 for a reader outside the organisation.
 * Publication is a mirror rather than a visibility change, so turning this on and repointing `githubRepoUrl`
 * at that mirror are one edit — not two.
 */
export const sourceIsPublic: boolean = false;

export const sdkReadmeUrl = `${githubRepoUrl}/tree/main/clients/sdk`;

/** The self-host entry point: both Compose files and what each one is for. */
export const dockerReadmeUrl = `${githubRepoUrl}/tree/main/docker`;

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
