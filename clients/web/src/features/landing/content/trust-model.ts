import { brandName } from "./brand";
import type { SectionCopy } from "./types";

export const trustModelHead: SectionCopy = {
  label: "Trust model",
  title: "Per-verifier attribution. No single verdict.",
  description:
    "Different verifiers run different policies. A contract verified by one and rejected by another isn't unverified — it's verified under a different policy.",
};

export type TrustSignal = {
  tone: "ok" | "warn";
  glyph: string;
  title: string;
  description: string;
  tag: string;
};

/**
 * The second card named Stellar Expert. Nothing in `config/trusted-verifiers.*.json` lists them, so the example
 * attributed a verdict to a third party that is not a peer of this deployment.
 */
export const trustSignals: TrustSignal[] = [
  {
    tone: "ok",
    glyph: "✓",
    title: `Verified by ${brandName}`,
    description:
      "Byte-for-byte match under this verifier's digest-pinned trusted image policy.",
    tag: "trusted image",
  },
  {
    tone: "warn",
    glyph: "!",
    title: "Mismatch reported by another verifier",
    description:
      "A different policy, a different verdict — attribution keeps both signals visible.",
    tag: "rebuild mismatch",
  },
];
