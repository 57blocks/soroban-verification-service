import { env } from "../../support/env.js";
import { fixture, submissionFor } from "../../support/fixtures.js";
import { submitAndWait, type TerminalJob } from "../../support/job.js";
import { reportForJob } from "../../support/result-tree.js";
import type { SubmitBody, VerificationArtifact } from "../../support/types.js";

const PUBLISHING_JOB_STATUSES: readonly string[] = ["verified", "mismatch"];

export interface MarkerObservation {
  readonly terminal: TerminalJob & { readonly jobId: string };
  readonly artifact: VerificationArtifact;
  readonly artifactJson: string;
  readonly wasmHash: string;
  readonly marker: unknown;
}

export function requirePublishedVerdict(
  terminal: TerminalJob,
  fixtureId: string,
  caseId: string,
): void {
  if (PUBLISHING_JOB_STATUSES.includes(terminal.body.status)) return;

  throw new Error(
    `${caseId} precondition violated: ${fixtureId} finished as \`${terminal.body.status}\`, which ` +
      `publishes nothing (§7.1 — report artifacts exist only for published results), so this run ` +
      `observed no marker either way.\n\n` +
      `This is a fixture problem, not a conformance finding. Check, in order: the testnet contract ` +
      `is still live (test/fixtures/e2e/extend-testnet-ttl.sh); the shared public source archive at ` +
      `the fixture's source_uri still resolves; and — for F-S55-D only — that its on-chain bldopt ` +
      `replays cleanly, since registry.yaml records no rebuild validation for it and its recorded ` +
      `--meta=source_repo carries the shell quotes build-purpose-contracts.sh wrote.\n\n` +
      `Statuses seen: ${terminal.statusSequence.join(" → ")}. ` +
      `Progress: ${terminal.progressSteps.join(" → ") || "(none)"}. ` +
      `Last body: ${JSON.stringify(terminal.body)}`,
  );
}

export async function observeMarker(
  fixtureId: string,
  caseId: string,
  options: {
    readonly body?: SubmitBody;
    readonly isPublic?: boolean;
  } = {},
): Promise<MarkerObservation> {
  const body =
    options.body ??
    (await submissionFor(
      fixtureId,
      options.isPublic === undefined ? {} : { is_public: options.isPublic },
    ));

  const terminal = await submitAndWait(body, { requireFreshTargetJob: true });
  requirePublishedVerdict(terminal, fixtureId, caseId);

  const wasmHash = terminal.body.result?.wasm_hash ?? fixture(fixtureId).wasm_hash;
  if (!wasmHash) {
    throw new Error(
      `${caseId}: ${fixtureId} published a verdict but the job reported no wasm_hash, and the ` +
        `inventory records none either, so there is no document to look the report up under.`,
    );
  }

  const report = await reportForJob(terminal.body.result, wasmHash);
  if (!report) {
    throw new Error(
      `${caseId}: ${fixtureId} finished as \`${terminal.body.status}\` — a publishing verdict — but ` +
        `neither result.artifact_url nor a results_urls entry for ${wasmHash} led to a report. The ` +
        `marker lives only in that document, so there is nothing to read. Last body: ` +
        `${JSON.stringify(terminal.body)}`,
    );
  }

  return {
    terminal,
    artifact: report.artifact,
    artifactJson: JSON.stringify(report.artifact),
    wasmHash,
    marker: (report.artifact.trust as Record<string, unknown> | undefined)?.[
      "sep55_attestation_present"
    ],
  };
}

export function expectMarker(observation: MarkerObservation, expected: boolean): void {
  expect(typeof observation.marker).toBe("boolean");
  expect(observation.marker).toBe(expected);
}

export function expectSingleMarkerRepresentation(observation: MarkerObservation): void {
  const occurrences = observation.artifactJson.match(/sep55/gi)?.length ?? 0;
  expect(occurrences).toBe(1);
  expect(Object.keys(observation.artifact.trust)).toContain("sep55_attestation_present");
}

export const MARKER_CASE_TIMEOUT_MS = env.jobTimeoutMs + 120_000;
