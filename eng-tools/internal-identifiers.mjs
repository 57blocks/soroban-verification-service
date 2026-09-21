/**
 * The detectors behind `check:secrets` and the redactors behind `export:public-tree`, built from
 * `internal-identifiers.json` so the gate and the redactor cannot drift apart — a rule the gate knows
 * and the exporter does not is exactly the hole the prototype export shipped through.
 *
 * The account id is matched by SHA-256, never by value: this file ships, so a literal here would be
 * the leak it exists to prevent.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const rulesPath = fileURLToPath(new URL("./internal-identifiers.json", import.meta.url));
export const rules = JSON.parse(readFileSync(rulesPath, "utf8"));

const internalDomain = rules.rules["internal-hostname"]?.domain ?? null;
const hostRe = internalDomain
  ? (flags) =>
      new RegExp(`\\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+)${internalDomain.replace(/\./g, "\\.")}\\b`, `${flags}i`)
  : null;

// Since SCV-304 the published surface is a subdomain of the internal domain, so the rule's own shape
// can no longer tell them apart and the host has to be named. `pending` is the wrong instrument: it is
// a ratchet over debt, and it would refuse the next file that cites a schema.
const publishedHosts = new Set(
  (rules.rules["internal-hostname"]?.published ?? []).map((h) => h.toLowerCase()),
);
const isPublished = (host) => publishedHosts.has(host.toLowerCase());

const accountDigests = new Set(rules.rules["aws-account-id"].digests);
const isAccountId = (s) => accountDigests.has(createHash("sha256").update(s).digest("hex"));

/**
 * Teaches the account-id rule one more value, for the duration of the process. The export's own
 * self-test is the only caller: it needs a 12-digit run the rule genuinely matches, and taking the
 * real one would put the literal this file exists to forbid into the file that forbids it.
 */
export function registerAccountId(value) {
  accountDigests.add(createHash("sha256").update(value).digest("hex"));
}

/**
 * `find` returns match offsets, for counting. `redact` rewrites the text, and each one preserves the
 * shape of what it replaces so a redacted document still reads as the thing it was.
 */
export const detectors = [
  {
    id: "aws-account-id",
    find: (text) => [...text.matchAll(/\b\d{12}\b/g)].filter((m) => isAccountId(m[0])).map((m) => m.index),
    redact: (text) => text.replace(/\b\d{12}\b/g, (m) => (isAccountId(m) ? "123456789012" : m)),
  },
  {
    id: "internal-hostname",
    // The domain is data, not a literal in this file: the exported copy of this gate carries the
    // mechanism without carrying whose deployment it was written for.
    find: (text) =>
      hostRe
        ? [...text.matchAll(hostRe("g"))].filter((m) => !isPublished(m[0])).map((m) => m.index)
        : [],
    // The subdomain structure carries no secret and losing it would make a document unreadable; the
    // registrable domain is the whole finding.
    redact: (text) =>
      hostRe
        ? text.replace(hostRe("g"), (host, labels) => (isPublished(host) ? host : `${labels}example.com`))
        : text,
  },
  {
    id: "aws-resource-id",
    find: (text) =>
      [...text.matchAll(/\b(?:vpc|subnet|sg|igw|rtb|acl|eni|ami|vol|snap)-[0-9a-f]{8}(?:[0-9a-f]{9})?\b/g)]
        .map((m) => m.index),
    // Not a hex placeholder: any hex body still matches the rule, so the redaction would scan dirty.
    redact: (text) =>
      text.replace(
        /\b(vpc|subnet|sg|igw|rtb|acl|eni|ami|vol|snap)-[0-9a-f]{8}(?:[0-9a-f]{9})?\b/g,
        "$1-EXAMPLE",
      ),
  },
  {
    id: "internal-tracker",
    find: (text) => [...text.matchAll(/\b[a-z0-9-]+\.atlassian\.net\b/gi)].map((m) => m.index),
    // No redaction: a tracker URL in a shipped file is prose that has to be rewritten by a human,
    // because what it was citing has to survive the rewrite. The export fails instead.
    redact: null,
  },
];

/** `{ "<rule>": <count> }` for one file's text, omitting rules with no hit. */
export function countIdentifiers(text) {
  const counts = {};
  for (const { id, find } of detectors) {
    const n = find(text).length;
    if (n > 0) counts[id] = n;
  }
  return counts;
}

/** Every rule that has one, applied. Rules with no redactor are left for the gate to refuse. */
export function redactIdentifiers(text) {
  return detectors.reduce((acc, d) => (d.redact ? d.redact(acc) : acc), text);
}
