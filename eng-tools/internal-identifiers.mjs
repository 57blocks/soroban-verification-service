/**
 * The detectors behind `check:secrets` and the redactors behind `export:public-tree`.
 * The account id is matched by SHA-256, never by value: a literal here would be the leak.
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

const publishedHosts = new Set(
  (rules.rules["internal-hostname"]?.published ?? []).map((h) => h.toLowerCase()),
);
const isPublished = (host) => publishedHosts.has(host.toLowerCase());

const accountDigests = new Set(rules.rules["aws-account-id"].digests);
const isAccountId = (s) => accountDigests.has(createHash("sha256").update(s).digest("hex"));

/** For the export's self-test only: adds a synthetic account id for this process. */
export function registerAccountId(value) {
  accountDigests.add(createHash("sha256").update(value).digest("hex"));
}

export const detectors = [
  {
    id: "aws-account-id",
    find: (text) => [...text.matchAll(/\b\d{12}\b/g)].filter((m) => isAccountId(m[0])).map((m) => m.index),
    redact: (text) => text.replace(/\b\d{12}\b/g, (m) => (isAccountId(m) ? "123456789012" : m)),
  },
  {
    id: "internal-hostname",
    // The domain is data, never a literal here: this file ships.
    find: (text) =>
      hostRe
        ? [...text.matchAll(hostRe("g"))].filter((m) => !isPublished(m[0])).map((m) => m.index)
        : [],
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
    redact: null,
  },
];

export function countIdentifiers(text) {
  const counts = {};
  for (const { id, find } of detectors) {
    const n = find(text).length;
    if (n > 0) counts[id] = n;
  }
  return counts;
}

export function redactIdentifiers(text) {
  return detectors.reduce((acc, d) => (d.redact ? d.redact(acc) : acc), text);
}
