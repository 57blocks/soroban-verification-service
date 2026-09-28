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
  compare: { deployed: string[]; rebuilt: string[] };
};

export const trustSignals: TrustSignal[] = [
  {
    tone: "ok",
    glyph: "✓",
    title: `Verified by ${brandName}`,
    description:
      "Byte-for-byte match under this verifier's digest-pinned trusted image policy.",
    tag: "trusted image",
    compare: {
      deployed: ["a91c4e02", "7b3df610", "55e2c9a8", "0d4f7b21"],
      rebuilt: ["a91c4e02", "7b3df610", "55e2c9a8", "0d4f7b21"],
    },
  },
  {
    tone: "warn",
    glyph: "!",
    title: "Mismatch reported by another verifier",
    description:
      "A different policy, a different verdict — attribution keeps both signals visible.",
    tag: "rebuild mismatch",
    compare: {
      deployed: ["a91c4e02", "7b3df610", "55e2c9a8", "0d4f7b21"],
      rebuilt: ["a91c4e02", "7b3df610", "c4e81b93", "0d4f7b21"],
    },
  },
];
