import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReferenceAlignmentDto } from "@scvs/core";

export type ReferenceAlignment = ReferenceAlignmentDto;

const PIN_RELATIVE_PATH = join("docker", "stellar-cli.pin");
// `v28.0.0`, or a bare `28.0.0` if the pin is ever written without the tag prefix.
const VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function referenceAlignment(pinFile = findPinFile()): ReferenceAlignment {
  return parseReferenceAlignment(readFileSync(pinFile, "utf8"));
}

/** This required `MAIN_SHA` + two PR SHAs, because the pin described a three-way merge CI compiled. */
export function parseReferenceAlignment(pinText: string): ReferenceAlignment {
  const version = parsePinValues(pinText).get("STELLAR_CLI_VERSION");
  if (!version || !VERSION.test(version)) {
    throw new Error(`${PIN_RELATIVE_PATH} is missing STELLAR_CLI_VERSION=<semver>`);
  }

  return {
    repo: "stellar/stellar-cli",
    version,
    read_from: "docker/stellar-cli.pin",
  };
}

function parsePinValues(pinText: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of pinText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(\S+)$/.exec(trimmed);
    if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/g, ""));
  }
  return values;
}

function findPinFile(): string {
  const candidates = [
    ...parentCandidates(process.cwd()),
    ...parentCandidates(dirname(fileURLToPath(import.meta.url))),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Unable to locate ${PIN_RELATIVE_PATH}`);
  }
  return found;
}

function parentCandidates(start: string): string[] {
  const candidates: string[] = [];
  let current = resolve(start);
  while (true) {
    candidates.push(join(current, PIN_RELATIVE_PATH));
    const parent = dirname(current);
    if (parent === current) return candidates;
    current = parent;
  }
}
