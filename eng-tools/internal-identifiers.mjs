/**
 * The detectors behind `check:secrets` and the redactors behind `export:public-tree`.
 * The account id is matched by SHA-256, never by value: a literal here would be the leak.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const rulesPath = fileURLToPath(new URL("./internal-identifiers.json", import.meta.url));
export const rules = JSON.parse(readFileSync(rulesPath, "utf8"));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const internalDomains = rules.rules["internal-hostname"]?.domains ?? [];
const hostRe = internalDomains.length
  ? (flags) =>
      new RegExp(
        `\\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+)(?:${internalDomains.map(escape).join("|")})\\b`,
        `${flags}i`,
      )
  : null;

const resourcePrefixes = rules.rules["deployment-resource-name"]?.prefixes ?? [];
const resourceRe = resourcePrefixes.length
  ? new RegExp(`(?<![a-z0-9-])(?:${resourcePrefixes.map(escape).join("|")})[a-z0-9]`, "gi")
  : null;

const trackerKeys = rules.rules["internal-tracker"]?.keys ?? [];
const trackerKeyRe = trackerKeys.length
  ? new RegExp(`\\b(?:${trackerKeys.map(escape).join("|")})-\\d+\\b`, "gi")
  : null;

const repositoryDigests = new Set(rules.rules["internal-repository"]?.digests ?? []);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const findRepositoryNames = (text) =>
  [...text.matchAll(/[A-Za-z0-9][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)+/g)]
    .filter((m) => repositoryDigests.has(sha256(m[0].toLowerCase())))
    .map((m) => m.index);

const secretArnRe = /\barn:aws[a-z-]*:secretsmanager:[a-z0-9-]*:\d*:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}\b/g;

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
    id: "deployment-resource-name",
    find: (text) => (resourceRe ? [...text.matchAll(resourceRe)].map((m) => m.index) : []),
    redact: null,
  },
  {
    id: "internal-repository",
    find: (text) => (repositoryDigests.size ? findRepositoryNames(text) : []),
    redact: null,
  },
  {
    id: "secrets-manager-arn",
    find: (text) => [...text.matchAll(secretArnRe)].map((m) => m.index),
    redact: null,
  },
  {
    id: "internal-tracker",
    find: (text) => [
      ...[...text.matchAll(/\b[a-z0-9-]+\.atlassian\.net\b/gi)].map((m) => m.index),
      ...(trackerKeyRe ? [...text.matchAll(trackerKeyRe)].map((m) => m.index) : []),
    ],
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
