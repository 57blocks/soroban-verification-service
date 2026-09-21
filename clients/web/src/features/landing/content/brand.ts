// Copy for the three sections that have no `SectionHead`: the hero, the closing CTA, the footer.

export const brandName = "Soroban Verifier";

export const heroCopy = {
  title: "Does the deployed contract match its source?",
  /** The word the hero marks with the accent. It must appear in `title` exactly once. */
  highlight: "match",
  // Two sentences, broken onto their own lines on a wide viewport.
  lines: [
    "Submit a Soroban contract and its source.",
    "We rebuild it in a sandbox with no network and no credentials, compare the result byte for byte against the chain, and publish what we found.",
  ],
  cta: "Verify a contract",
};

export const closingCta = {
  label: "Ready to verify?",
  title: "Submit a contract. Read the source of trust.",
  secondaryCta: "View on GitHub",
};

export const footerBlurb =
  "Hosted source verification for Soroban on the Stellar network.";

// The code licence (LICENSE at the repository root), not the service terms — those are the linked documents
// beside it.
export const footerLegal = "Apache-2.0 · SCF Build Award · RFP Track";
