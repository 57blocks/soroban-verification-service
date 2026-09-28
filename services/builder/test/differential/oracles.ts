export type Oracle = {
  readonly id: string;
  readonly cliver: string;
  readonly rsver: string;
  readonly tag: string;
  readonly env?: string;
  readonly image?: string;
  readonly tagResolvesElsewhere?: string;
};

export const CLI_27_0_0_RUST_1_96_0_IMAGE =
  "docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43";

export const ORACLES: readonly Oracle[] = [
  {
    id: "cli-27.0.0-rust-1.96.0",
    cliver: "27.0.0",
    rsver: "1.96.0",
    tag: "docker.io/stellar/stellar-cli:27.0.0",
    image: CLI_27_0_0_RUST_1_96_0_IMAGE,
    tagResolvesElsewhere: "sha256:c1297d0c2c6790dda6afaa3edd39a959ec12edd6ebe30282dd1d7a663e7c4109",
  },
  {
    id: "cli-25.1.0-rust-1.90.0",
    cliver: "25.1.0",
    rsver: "1.90.0",
    tag: "docker.io/stellar/stellar-cli:25.1.0-rust1.90.0-slim-bookworm",
    image: "docker.io/stellar/stellar-cli@sha256:f2026aa61b3d7896444c642c5f29489b7620afaffbb3e17653e2634306a20c4b",
  },
  {
    id: "cli-25.2.0-rust-1.90.0",
    cliver: "25.2.0",
    rsver: "1.90.0",
    tag: "docker.io/stellar/stellar-cli:25.2.0",
    image: "docker.io/stellar/stellar-cli@sha256:d568e243c18c306af45330d05276c4ebabce05a46c2197743a4fcadbbadab927",
  },
  {
    id: "cli-26.0.0-rust-1.94.1",
    cliver: "26.0.0",
    rsver: "1.94.1",
    tag: "docker.io/stellar/stellar-cli:26.0.0",
    image: "docker.io/stellar/stellar-cli@sha256:cb2fc3116a6ace37a77ca6bb88afb4bee57fc746cd556a4373f2c3ee95d4e917",
  },
  {
    id: "cli-26.1.0-rust-1.96.0",
    cliver: "26.1.0",
    rsver: "1.96.0",
    tag: "docker.io/stellar/stellar-cli:26.1.0",
    image: "docker.io/stellar/stellar-cli@sha256:94a5c730e5bed2727e9d58a4b082d2c1feb319ead9a355396c9119cff21f26a4",
  },
  {
    id: "cli-27.0.0-rust-1.95.0",
    cliver: "27.0.0",
    rsver: "1.95.0",
    tag: "docker.io/stellar/stellar-cli:27.0.0-rust1.95.0-slim-trixie",
    image: "docker.io/stellar/stellar-cli@sha256:eff8976647eecd437cd40f008e567241cb06aabe566f521c7689fc986c5957a2",
  },
  {
    id: "cli-27.1.0-rust-1.96.1",
    cliver: "27.1.0",
    rsver: "1.96.1",
    tag: "docker.io/stellar/stellar-cli:27.1.0-rust1.96.1-slim-trixie",
    image: "docker.io/stellar/stellar-cli@sha256:41ed60fb8dfdf10ee2fe125f459ae8b1d19823eea8ac4d9cab7cffc2d1778da6",
  },
  {
    id: "cli-27.1.0-rust-1.97.1",
    cliver: "27.1.0",
    rsver: "1.97.1",
    tag: "docker.io/stellar/stellar-cli:27.1.0-rust1.97.1-slim-trixie",
    image: "docker.io/stellar/stellar-cli@sha256:a8a41b70c69a074f62f0356d88ef2d0d721a517acb144ea76a2917bb62f2a7ae",
  },
];

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

export const BASELINE_ORACLE = ORACLES[0]!;

export function resolveOracleImage(oracle: Oracle): string | undefined {
  const candidate = oracle.image ?? (oracle.env ? process.env[oracle.env] : undefined);
  return candidate && DIGEST_PINNED.test(candidate) ? candidate : undefined;
}

export function missingOracleReason(oracle: Oracle): string | undefined {
  if (resolveOracleImage(oracle)) return undefined;
  const supplied = oracle.env ? process.env[oracle.env] : undefined;
  if (supplied) {
    return `${oracle.env} is set but is not digest-pinned (${supplied}); an oracle that can move proves nothing`;
  }
  return (
    `no digest pinned for ${oracle.tag} — set ${oracle.env} to the output of ` +
    `\`docker buildx imagetools inspect ${oracle.tag}\``
  );
}
