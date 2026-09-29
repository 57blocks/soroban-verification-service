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

const PARAMS = {
  policyId: "test-policy-v1",
  acceptedTrustLevels: ["official_trusted"],
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

  assert.deepEqual(written.source_modes, ["private_uploaded_tarball", "source_uri"]);
  assert.deepEqual(returned.source_modes, written.source_modes);

  for (const refused of ["public_repo", "hosted_tarball"]) {
    assert.ok(!written.source_modes.includes(refused), `policy.json must not offer ${refused}`);
  }

  assert.ok(SOURCE_MODES.includes("source_uri" as never));
  for (const served of SERVED_SOURCE_MODES) {
    assert.ok(SOURCE_MODES.includes(served), `${served} is emitted but not in the wire vocabulary`);
  }

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
