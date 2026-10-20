import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDto } from "./validate.js";
import {
  PeerRegistryStatusObject,
  baseProjection,
  isSameVerifier,
  ownEntryOf,
  parseStrictRegistryStatusObject,
  registryStatusOrUnverified,
  reportSha256FromUrl,
  toResultUrl,
  toSourceCodeUri,
  upgradeLegacyEntry,
  type PeerRegistryVerification,
} from "./registry.js";
import { parseSchemaVersion } from "./validators/schema-version.js";

const here = dirname(fileURLToPath(import.meta.url));
const draftFixtures = resolve(here, "../../../test/fixtures/registry");
const sepFixtures = resolve(here, "../../../test/fixtures/registry-sep");

type Doc = Record<string, unknown> & { source_code_verifications: Record<string, unknown>[] };

const load = (dir: string, name: string): Doc => JSON.parse(readFileSync(resolve(dir, name), "utf8"));

const rejects = (label: string, document: unknown): void => {
  assert.throws(() => parseStrictRegistryStatusObject(document), `producer should have rejected: ${label}`);
};
const rejectsAsPeer = (label: string, document: unknown): void => {
  assert.throws(() => parseDto(PeerRegistryStatusObject, document), `consumer should have rejected: ${label}`);
};

function main(): void {
  const sep = load(sepFixtures, "200-verified.json");
  parseStrictRegistryStatusObject(sep);
  parseDto(PeerRegistryStatusObject, sep);

  const withEntry = (mutate: (entry: Record<string, unknown>) => void): Doc => {
    const document = structuredClone(sep);
    mutate(document.source_code_verifications[0]);
    return document;
  };
  const withDoc = (mutate: (document: Doc) => void): Doc => {
    const document = structuredClone(sep);
    mutate(document);
    return document;
  };

  rejects("missing schema", withDoc((d) => delete d.schema));
  rejects("wrong schema", withDoc((d) => (d.schema = "stellar-verification-aggregate")));
  rejects("schema_version 1.1 against the producer shape", withDoc((d) => (d.schema_version = "1.1")));
  for (const field of ["wasm_hash", "updated_at"]) rejects(`missing ${field}`, withDoc((d) => delete d[field]));

  for (const field of ["recipe_source", "image_trust_level", "source_sha256", "processed_at"]) {
    rejects(`verified without ${field}`, withEntry((e) => delete e[field]));
  }
  const pending = withEntry((e) => {
    e.status = "unverified";
    for (const field of ["recipe_source", "image_trust_level", "source_sha256", "processed_at", "bldimg", "bldarg", "bldopt", "source_uri", "verified_source_code_uris", "results_urls"]) {
      delete e[field];
    }
  });
  parseStrictRegistryStatusObject(pending);
  for (const [field, value] of [
    ["recipe_source", "submitted"],
    ["image_trust_level", "official_trusted"],
    ["source_sha256", "b".repeat(64)],
    ["processed_at", "2026-09-02T09:30:00Z"],
  ] as const) {
    const doc = structuredClone(pending);
    doc.source_code_verifications[0][field] = value;
    rejects(`unverified carrying ${field}`, doc);
  }
  const OPTIONAL_WITH_A_VERDICT = [
    "bldimg",
    "bldarg",
    "bldopt",
    "source_uri",
    "results_urls",
    "verified_source_code_uris",
  ] as const;
  for (const field of OPTIONAL_WITH_A_VERDICT) {
    const doc = structuredClone(pending);
    doc.source_code_verifications[0][field] = structuredClone(sep.source_code_verifications[0][field]);
    rejects(`unverified carrying ${field}`, doc);
  }
  for (const field of OPTIONAL_WITH_A_VERDICT) {
    parseStrictRegistryStatusObject(withEntry((e) => delete e[field]));
  }

  rejects("recipe_source outside the enum", withEntry((e) => (e.recipe_source = "guessed")));
  rejects("image_trust_level outside the enum", withEntry((e) => (e.image_trust_level = "trusted")));
  rejects("out_of_band on a producer entry", withEntry((e) => (e.out_of_band = true)));
  rejects("source_repo on a producer entry", withEntry((e) => (e.source_repo = "https://github.com/x/y")));

  rejects("verified carrying rebuilt_hash", withEntry((e) => (e.rebuilt_hash = "a".repeat(64))));
  rejects(
    "mismatched without rebuilt_hash",
    withEntry((e) => {
      e.status = "mismatched";
      delete e.rebuilt_hash;
    }),
  );
  parseStrictRegistryStatusObject(
    withEntry((e) => {
      e.status = "mismatched";
      e.rebuilt_hash = "0".repeat(64);
    }),
  );

  rejects("status: mismatch", withEntry((e) => (e.status = "mismatch")));

  rejects("empty source_code_verifications", withDoc((d) => (d.source_code_verifications = [])));

  rejects("short flag in bldopt", withEntry((e) => (e.bldopt = ["-p foo"])));

  {
    const ordered = withEntry((e) => (e.bldarg = ["contract", "build", "--verifiable"]));
    assert.deepEqual(parseStrictRegistryStatusObject(ordered).source_code_verifications[0].bldarg, [
      "contract",
      "build",
      "--verifiable",
    ]);
  }
  rejects("bldarg with a non-string", withEntry((e) => (e.bldarg = ["contract", 1])));

  rejects("bare-string results_urls on a producer entry", withEntry((e) => (e.results_urls = ["https://x/reports/a.json"])));
  rejects("results_urls entry with an unknown type", withEntry((e) => (e.results_urls = [{ type: "mirror", url: "https://x" }])));
  rejects("results_urls entry with no url", withEntry((e) => (e.results_urls = [{ type: "report" }])));
  rejects(
    "results_urls sha256 uppercase",
    withEntry((e) => (e.results_urls = [{ type: "report", url: "https://x/r.json", sha256: "A".repeat(64) }])),
  );
  parseStrictRegistryStatusObject(
    withEntry((e) => (e.results_urls = [{ type: "sbom", url: "https://x/reports/a.spdx.json", sha256: "c".repeat(64) }])),
  );
  rejects(
    "results_urls entry typed `signature`, a value withdrawn with the signing scheme",
    withEntry((e) => (e.results_urls = [{ type: "signature", url: "https://x/a.sig", sha256: "c".repeat(64) }])),
  );

  parseStrictRegistryStatusObject(
    withEntry((e) => (e.results_urls = [{ type: "report", location: "verifier_self_storage", url: "https://x/reports/a.json", sha256: "c".repeat(64) }])),
  );
  rejects(
    "results_urls entry with an unknown location",
    withEntry((e) => (e.results_urls = [{ type: "report", location: "ipfs", url: "https://x/reports/a.json", sha256: "c".repeat(64) }])),
  );

  rejects("source_sha256 uppercase", withEntry((e) => (e.source_sha256 = "B".repeat(64))));
  rejects("source_sha256 wrong length", withEntry((e) => (e.source_sha256 = "b".repeat(63))));
  for (const uri of [
    "https://example.com/source.tar.gz",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "ar://abc123",
    "git://example.com/repo.git",
    "/home/dev/contract.tar.gz",
  ]) {
    parseStrictRegistryStatusObject(withEntry((e) => (e.source_uri = uri)));
  }
  rejects("source_uri: neither a scheme nor an absolute path", withEntry((e) => (e.source_uri = "example.com/source.tar.gz")));

  rejects("verified_source_code_uris: not an array", withEntry((e) => (e.verified_source_code_uris = "https://x")));
  rejects("verified_source_code_uris: bare string on the producer side", withEntry((e) => (e.verified_source_code_uris = ["https://x"])));
  rejects("verified_source_code_uris: entry with no location", withEntry((e) => (e.verified_source_code_uris = [{ url: "https://x" }])));
  rejects(
    "verified_source_code_uris: entry with an unknown location",
    withEntry((e) => (e.verified_source_code_uris = [{ location: "ipfs", url: "https://x" }])),
  );
  parseStrictRegistryStatusObject(
    withEntry((e) => (e.verified_source_code_uris = [{ location: "verifier_self_storage", url: "https://x/sources/a.tar.gz" }])),
  );

  const BARE_STRING_LINKS = "200-verified.json";
  const examples = readdirSync(draftFixtures).filter((name) => name.endsWith(".json"));
  assert.equal(examples.length, 5, "expected the draft's five status examples");
  assert.ok(
    (load(draftFixtures, BARE_STRING_LINKS).source_code_verifications[0].results_urls as unknown[]).some(
      (link) => typeof link === "string",
    ),
    "the draft fixture no longer carries the bare-string links this case exists for",
  );
  for (const name of examples) {
    const document = load(draftFixtures, name);
    parseDto(PeerRegistryStatusObject, document);
    rejects(`draft example ${name} against the producer shape`, document);
  }

  {
    const peer = parseDto(PeerRegistryStatusObject, load(draftFixtures, BARE_STRING_LINKS));
    const links = (peer.source_code_verifications[0].results_urls ?? []).map(toResultUrl);
    assert.ok(links.length > 0, "the fixture carries links to normalise");
    for (const link of links) {
      assert.equal(typeof link, "object");
      assert.ok(link.url && link.type, "a normalised link carries both a url and a type");
    }
  }

  const draft = load(draftFixtures, "200-out-of-band.json");

  for (const version of ["1.0", "1.1", "1.7", "1.10"]) {
    const peer = structuredClone(draft);
    peer.schema_version = version;
    assert.equal(parseDto(PeerRegistryStatusObject, peer).schema_version, version);
    const sepPeer = structuredClone(sep);
    sepPeer.schema_version = version;
    assert.equal(parseDto(PeerRegistryStatusObject, sepPeer).schema_version, version);
  }
  for (const [label, version] of [
    ["a MAJOR we do not implement", "2.0"],
    ["MAJOR 0", "0.9"],
    ["no MINOR component", "1"],
    ["a patch component", "1.0.0"],
    ["a v prefix", "v1.1"],
    ["not a string", 1.1],
    ["absent", undefined],
  ] as const) {
    const peer = structuredClone(draft);
    peer.schema_version = version;
    rejectsAsPeer(label, peer);
  }
  assert.deepEqual(parseSchemaVersion("1.11"), { major: 1, minor: 11 });
  assert.equal(parseSchemaVersion("1.01"), undefined);

  rejectsAsPeer("empty entries", { ...structuredClone(draft), source_code_verifications: [] });
  {
    const peer = structuredClone(draft);
    peer.source_code_verifications[0].results_urls = [{ url: "https://x" }];
    rejectsAsPeer("results_urls item with no type", peer);
  }
  {
    const peer = structuredClone(draft);
    peer.source_code_verifications[0].verified_source_code_uris = ["https://x/sources/a.tar.gz"];
    assert.deepEqual(parseDto(PeerRegistryStatusObject, peer).source_code_verifications[0].verified_source_code_uris, [
      "https://x/sources/a.tar.gz",
    ]);
    peer.source_code_verifications[0].verified_source_code_uris = [
      { location: "verifier_self_storage", url: "https://x/sources/a.tar.gz" },
    ];
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(parseDto(PeerRegistryStatusObject, peer).source_code_verifications[0].verified_source_code_uris),
      ),
      [{ location: "verifier_self_storage", url: "https://x/sources/a.tar.gz" }],
    );
    peer.source_code_verifications[0].verified_source_code_uris = [{ url: "https://x" }];
    rejectsAsPeer("verified_source_code_uris item with no location", peer);
  }
  for (const [label, field, value] of [
    ["recipe_source a later MINOR added", "recipe_source", "attested_by_publisher"],
    ["image_trust_level a later MINOR added", "image_trust_level", "reproducible_bootstrap"],
  ] as const) {
    const peer = structuredClone(draft);
    peer.schema_version = "1.1";
    peer.source_code_verifications[0][field] = value;
    assert.equal(
      parseDto(PeerRegistryStatusObject, peer).source_code_verifications[0][field],
      value,
      `${label} is read as it came`,
    );
  }
  for (const [label, link] of [
    ["a type a later MINOR added", { type: "license", url: "https://x/LICENSE" }],
    ["a location a later MINOR added", { type: "report", location: "ipfs", url: "ipfs://bafy" }],
  ] as const) {
    const peer = structuredClone(draft);
    peer.schema_version = "1.1";
    peer.source_code_verifications[0].results_urls = [link];
    const parsed = parseDto(PeerRegistryStatusObject, peer);
    assert.deepEqual(
      JSON.parse(JSON.stringify(parsed.source_code_verifications[0].results_urls)),
      [link],
      `${label} is relayed as it came`,
    );
  }
  {
    const peer = structuredClone(draft);
    peer.source_code_verifications[0].results_urls = [{ url: "https://x/r.json" }];
    rejectsAsPeer("results_urls item with no type", peer);
  }

  {
    const peer = structuredClone(draft);
    peer.source_code_verifications[0].status = "something-the-sep-added-later";
    const parsed = parseDto(PeerRegistryStatusObject, peer);
    assert.equal(registryStatusOrUnverified(parsed.source_code_verifications[0].status), "unverified");
  }
  {
    const peer = structuredClone(draft) as Doc & { x_extensions?: unknown };
    peer.x_extensions = ["57b.candidate-sources/1.0"];
    peer.source_code_verifications[0].some_future_field = "value";
    const parsed = parseDto(PeerRegistryStatusObject, peer) as unknown as Doc;
    assert.equal("x_extensions" in parsed, true);
    assert.equal(parsed.source_code_verifications[0].some_future_field, "value");

    const projected = baseProjection(peer) as Doc;
    assert.equal("x_extensions" in projected, false);
    assert.equal("some_future_field" in projected.source_code_verifications[0], false);
    assert.equal("out_of_band" in projected.source_code_verifications[0], true, "draft vocabulary is declared (consumer side)");
    assert.equal("x_extensions" in peer, true, "projection must not mutate its input");
    const projectedSep = baseProjection(sep) as Doc;
    for (const key of ["schema", "schema_version", "wasm_hash", "updated_at"]) assert.equal(key in projectedSep, true, key);
    for (const key of ["recipe_source", "image_trust_level", "bldarg", "results_urls", "verified_source_code_uris"]) {
      assert.equal(key in projectedSep.source_code_verifications[0], true, key);
    }
    parseStrictRegistryStatusObject(projectedSep);
  }

  assert.equal(isSameVerifier({ name: "A", url: "https://a" }, { name: "B", url: "https://a" }), true, "url wins over name");
  assert.equal(isSameVerifier({ name: "A", url: "https://a" }, { name: "A", url: "https://b" }), false);
  assert.equal(isSameVerifier({ name: "A" }, { name: "A", url: "https://a" }), true, "name is the fallback when either side lacks a url");
  assert.equal(isSameVerifier({ name: "A" }, { name: "a" }), false, "case-sensitive");

  {
    const own = { verifier: { url: "HTTPS://Root.example/v/" }, status: "verified" };
    const foreign = { verifier: { url: "https://other.example/" }, status: "mismatched" };
    const unnamed = { verifier: { name: "Unnamed" }, status: "verified" };
    const entries = (list: object[]) => list as PeerRegistryVerification[];
    assert.equal(ownEntryOf(entries([foreign, own]), "https://root.example/v"), own, "matched on the normalised root");
    assert.equal(ownEntryOf(entries([foreign]), "https://root.example/v"), undefined, "a foreign entry is never ours");
    assert.equal(ownEntryOf(entries([unnamed, foreign]), "https://root.example/v"), undefined);
    assert.equal(ownEntryOf(entries([unnamed, { ...unnamed }]), "https://root.example/v"), unnamed, "no url anywhere: the first entry");
  }

  assert.equal(reportSha256FromUrl(`https://v.example/public/reports/${"a".repeat(64)}.json`), "a".repeat(64));
  assert.equal(reportSha256FromUrl(`https://v.example/public/reports/${"a".repeat(64)}.json?x=1`), "a".repeat(64));
  assert.equal(reportSha256FromUrl("https://gateway.irys.xyz/AbCdEf"), undefined);
  assert.deepEqual(toResultUrl(`https://v.example/reports/${"b".repeat(64)}.json`), {
    type: "report",
    url: `https://v.example/reports/${"b".repeat(64)}.json`,
    sha256: "b".repeat(64),
  });
  assert.deepEqual(toResultUrl("https://gateway.irys.xyz/AbCdEf"), { type: "report", url: "https://gateway.irys.xyz/AbCdEf" });
  assert.deepEqual(toResultUrl({ type: "sbom", url: "https://x/a.spdx.json", sha256: "c".repeat(64) }), {
    type: "sbom",
    url: "https://x/a.spdx.json",
    sha256: "c".repeat(64),
  });

  assert.deepEqual(toSourceCodeUri("https://v.example/public/sources/x.tar.gz"), {
    location: "verifier_self_storage",
    url: "https://v.example/public/sources/x.tar.gz",
  });
  assert.deepEqual(toSourceCodeUri({ location: "arweave", url: "https://gateway.irys.xyz/tx" }), {
    location: "arweave",
    url: "https://gateway.irys.xyz/tx",
  });

  const legacy = {
    verifier: { url: "https://v.example/public/", name: "57Blocks" },
    status: "verified",
    out_of_band: true,
    bldimg: "docker.io/stellar/stellar-cli@sha256:" + "1".repeat(64),
    bldopt: ["--package=foo"],
    source_sha256: "b".repeat(64),
    processed_at: "2026-08-20T00:00:00Z",
    results_urls: [`https://v.example/public/reports/${"a".repeat(64)}.json`, "https://gateway.irys.xyz/tx"],
    verified_source_code_uris: ["https://v.example/public/sources/x.tar.gz"],
  } as unknown as PeerRegistryVerification;
  assert.equal(upgradeLegacyEntry(legacy, undefined), undefined, "a verdict cannot be upgraded without a trust level");
  assert.equal(
    upgradeLegacyEntry({ ...legacy, verifier: { name: "57Blocks" } }, { imageTrustLevel: "upstream_pinned" }),
    undefined,
    "an entry with no verifier.url cannot be upgraded: the result root is the identity, and inventing one " +
      "from whichever root we happened to read would assert something the document never said",
  );
  {
    const upgraded = upgradeLegacyEntry(legacy, { imageTrustLevel: "upstream_pinned" });
    assert.ok(upgraded);
    assert.equal(upgraded.recipe_source, "submitted", "out_of_band: true was published as recipe_source === submitted");
    assert.equal(upgraded.image_trust_level, "upstream_pinned");
    assert.equal("out_of_band" in upgraded, false);
    assert.deepEqual(upgraded.results_urls, [
      { type: "report", url: `https://v.example/public/reports/${"a".repeat(64)}.json`, sha256: "a".repeat(64) },
      { type: "report", url: "https://gateway.irys.xyz/tx" },
    ]);
    assert.deepEqual(upgraded.verified_source_code_uris, [
      { location: "verifier_self_storage", url: "https://v.example/public/sources/x.tar.gz" },
    ]);
    parseStrictRegistryStatusObject({
      ...structuredClone(sep),
      source_code_verifications: [upgraded],
    });
  }
  {
    const notOutOfBand = upgradeLegacyEntry({ ...legacy, out_of_band: undefined }, { imageTrustLevel: "official_trusted" });
    assert.equal(notOutOfBand?.recipe_source, "on_chain_metadata");
  }
  assert.equal(
    upgradeLegacyEntry({ ...legacy, source_sha256: undefined }, { imageTrustLevel: "official_trusted" }),
    undefined,
    "a verdict with no source_sha256 cannot be made conformant",
  );
  {
    const pendingEntry = upgradeLegacyEntry(
      { verifier: { url: "https://v.example/public/", name: "57Blocks" }, status: "unverified" },
      undefined,
    );
    assert.deepEqual(pendingEntry, {
      verifier: { url: "https://v.example/public/", name: "57Blocks" },
      status: "unverified",
    });
    assert.deepEqual(upgradeLegacyEntry({ ...legacy, status: "unverified" }, undefined), {
      verifier: { url: "https://v.example/public/", name: "57Blocks" },
      status: "unverified",
    });
  }
  {
    const mismatched = upgradeLegacyEntry(
      { ...legacy, status: "mismatched", rebuilt_hash: "0".repeat(64), verified_source_code_uris: undefined, verified_source_code_uri: "https://v.example/s.tar.gz" } as PeerRegistryVerification,
      { imageTrustLevel: "official_trusted" },
    );
    assert.equal(mismatched?.rebuilt_hash, "0".repeat(64));
    assert.deepEqual(mismatched?.verified_source_code_uris, [
      { location: "verifier_self_storage", url: "https://v.example/s.tar.gz" },
    ]);
  }

  assert.equal(registryStatusOrUnverified("verified"), "verified");
  assert.equal(registryStatusOrUnverified("something-new"), "unverified");
  assert.equal(registryStatusOrUnverified(undefined), "unverified");

  console.log(
    `Registry status-object shapes: the SEP producer document + SO1–SO5 negatives, ${examples.length} draft examples as peer ` +
      "documents, SO7 MAJOR-branching, CV9 projection, verifier identity and legacy upgrade passed",
  );
}

main();
