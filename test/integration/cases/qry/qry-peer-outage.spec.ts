/** E2E-QRY-09 -- the retained aggregate stays useful while its other verifier is down. */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture } from "../../support/fixtures.js";
import { expectStatus, http, sleep } from "../../support/http.js";
import {
  PeerVerificationServiceControl,
  peerVerifierControl,
  peerVerifierOutagePrerequisite,
} from "../../support/peer-verifier-control.js";
import { aggregatedByHashUrl, staticVerifierManifestUrl, verifiersUrl } from "../../support/routes.js";
import type {
  AggregatedWasmStatus,
  TrustedVerifiersList,
  VerifierManifest,
} from "../../support/types.js";

const POLL_INTERVAL_MS = 5_000;

const sameRoot = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

// By result root, not by name: `verifier.name` on a relayed entry is the peer's own self-claimed label, and
// `unavailable_verifiers` stopped carrying our local id when `url` became the identity.
function includesVerifier(body: AggregatedWasmStatus, resultRoot: string): boolean {
  return body.source_code_verifications.some((entry) => sameRoot(entry.verifier?.url, resultRoot));
}

function namesPeerFailure(body: AggregatedWasmStatus, resultRoot: string): boolean {
  return body.unavailable_verifiers.some(
    (entry) => sameRoot(entry.url, resultRoot) && entry.reason === "fetch_failed",
  );
}

async function waitForAggregate(
  wasmHash: string,
  timeoutMs: number,
  predicate: (body: AggregatedWasmStatus) => boolean,
  description: string,
): Promise<AggregatedWasmStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: AggregatedWasmStatus | undefined;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    const response = await http(aggregatedByHashUrl(wasmHash));
    lastStatus = response.status;
    if (response.status === 200) {
      last = response.json as AggregatedWasmStatus;
      if (predicate(last)) return last;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for ${description}; last response status=${lastStatus ?? "none"}, ` +
      `cached entries=${last?.source_code_verifications.length ?? 0}, ` +
      `unavailable=${last?.unavailable_verifiers.map((entry) => entry.url).join(",") ?? "none"}.`,
  );
}

caseBlock(
  {
    id: "E2E-QRY-09/peer_unreachable",
    title: "the opposite environment's verifier becomes unavailable without erasing its cached claim",
    mode: "AUTO-INFRA",
    needs: [
      "SCVS_E2E_QUERY_URL",
      "SCVS_E2E_RESULT_ROOT",
      "SCVS_E2E_ENV",
      "SCVS_E2E_PEER_ECS_CLUSTER",
      "SCVS_E2E_AWS_REGION",
      "SCVS_E2E_PEER_OUTAGE_CONFIRM",
    ],
    prerequisites: ["P1", "P2", "P6"],
    unless: () => missingFixture("F-LEG-1") ?? peerVerifierOutagePrerequisite(),
  },
  () => {
    it(
      "retains the peer result, names the outage, and clears the outage after restoration",
      async () => {
        const control = peerVerifierControl();
        // `/verifiers` names every peer, but cannot tell which one belongs to this query deployment.
        const localManifestResponse = await http(staticVerifierManifestUrl());
        expectStatus(localManifestResponse, 200);
        const localManifest = localManifestResponse.json as VerifierManifest;
        expect(localManifest.id).toBe(`scvs-${control.testedEnvironment}`);

        const tvlResponse = await http(verifiersUrl());
        expectStatus(tvlResponse, 200);
        const active = (tvlResponse.json as TrustedVerifiersList).verifiers.filter(
          (verifier) => verifier.status === "active",
        );
        const local = active.find((verifier) => verifier.id === `scvs-${control.testedEnvironment}`);
        const peer = active.find((verifier) => verifier.id === control.peerVerifierId);
        expect(local).toBeDefined();
        expect(peer).toBeDefined();
        expect(local!.display_name).toBe(localManifest.display_name);

        const wasmHash = fixtures.contracts["F-LEG-1"].wasm_hash!;
        // This precondition makes a later unavailable row meaningful: it must arise after a healthy peer was
        // cached, not from a pre-existing outage or a peer that had never produced a result.
        await waitForAggregate(
          wasmHash,
          control.timeoutMs,
          (body) =>
            includesVerifier(body, local!.url) &&
            includesVerifier(body, peer!.url) &&
            !namesPeerFailure(body, peer!.url),
          "a healthy aggregate containing both dev and staging verifiers",
        );

        // The task definition identity check happens before the mutating command.
        const peerService = new PeerVerificationServiceControl(control);
        const original = await peerService.assertPeerIdentity();
        await peerService.stop(original);

        try {
          const degraded = await waitForAggregate(
            wasmHash,
            control.timeoutMs,
            (body) =>
              includesVerifier(body, local!.url) &&
              includesVerifier(body, peer!.url) &&
              namesPeerFailure(body, peer!.url),
            `${control.peerVerifierId} to be retained and named unavailable after its verification service stops`,
          );
          expect(namesPeerFailure(degraded, peer!.url)).toBe(true);
          for (const forbidden of ["status", "verdict", "result", "verified", "conclusion"]) {
            expect(degraded as unknown as Record<string, unknown>).not.toHaveProperty(forbidden);
          }
        } finally {
          // Recovery is unconditional: an assertion or query timeout must never leave the opposite environment
          // down.
          await peerService.restore(original);
        }

        const recovered = await waitForAggregate(
          wasmHash,
          control.timeoutMs,
          (body) =>
            includesVerifier(body, local!.url) &&
            includesVerifier(body, peer!.url) &&
            !namesPeerFailure(body, peer!.url),
          `${control.peerVerifierId} to be healthy in the retained aggregate after restoration`,
        );
        expect(namesPeerFailure(recovered, peer!.url)).toBe(false);
      },
      3 * (Number(process.env.SCVS_E2E_PEER_OUTAGE_TIMEOUT_MS) || 5 * 60_000) + env.requestTimeoutMs,
    );
  },
);
