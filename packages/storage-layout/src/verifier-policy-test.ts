import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDto } from "@scvs/core";
import { SERVED_SOURCE_MODES, writeVerifierPolicy } from "./publish.js";
import { SOURCE_MODES, VerifierPolicy } from "./shapes.js";
import { verifierPolicyKey } from "./keys.js";
import { createResultStorage } from "./storage-backend.js";

// Plain-script test, following registry-status-test.ts's convention — packages/* has no Jest config anywhere in
// this repo.

const PARAMS = {
  policyId: "test-policy-v1",
  acceptedTrustLevels: ["sdf_trusted"],
  digestPinnedOnly: true,
  tagOnlyAllowed: false,
  arbitraryUserImagesAllowed: false,
  requiresTarballSha256Match: true,
  resultArtifactsRetained: true,
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "scvs-verifier-policy-test-"));
  const storage = createResultStorage({ kind: "filesystem", root, publicRoot: "http://localhost/public" });

  const returned = await writeVerifierPolicy(storage, PARAMS);
  const written = JSON.parse(await readFile(join(root, verifierPolicyKey()), "utf8")) as VerifierPolicy;

  // What this verifier serves, and only that. `submit.service.ts`'s `createJob` constructs exactly two
  // source-ref shapes, so these are the two modes the door can produce.
  assert.deepEqual(written.source_modes, ["private_uploaded_tarball", "source_uri"]);
  assert.deepEqual(returned.source_modes, written.source_modes);

  // The half that was wrong for longer, and the more embarrassing one to publish: offering a route the door
  // refuses invites a submitter to build against it.
  for (const refused of ["public_repo", "hosted_tarball"]) {
    assert.ok(!written.source_modes.includes(refused), `policy.json must not offer ${refused}`);
  }

  assert.ok(SOURCE_MODES.includes("source_uri" as never));
  for (const served of SERVED_SOURCE_MODES) {
    assert.ok(SOURCE_MODES.includes(served), `${served} is emitted but not in the wire vocabulary`);
  }

  // A peer verifying from a public git repository is entitled to say so.
  const peer = { ...written, source_modes: ["public_repo", "hosted_tarball"] };
  parseDto(VerifierPolicy, peer);

  let rejected = false;
  try {
    parseDto(VerifierPolicy, { ...written, source_modes: ["carrier_pigeon"] });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "an unknown source mode must still be rejected");

  console.log("verifier-policy-test: ok");
}

await main();
