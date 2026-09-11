/** The two control planes the SRC group drives, and nothing else. */
import { darkSourceControl, objectStoreFaultInjector, type ControlEndpoint } from "./env.js";
import { http, sleep } from "./http.js";

function endpointOf(control: ControlEndpoint, caseId: string): string {
  if (control.kind === "absent") {
    throw new Error(
      `${caseId} reached a control-plane call with no endpoint configured (${control.describe}). ` +
        `The case's own gate should have skipped it — this is a harness bug, not a runner one.`
    );
  }
  return control.controlUrl;
}

async function post(url: string, body: unknown, what: string): Promise<void> {
  const response = await http(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `${what} failed: POST ${url} answered ${response.status}. Body: ${response.text.slice(0, 400)}`
    );
  }
}

/** `F-DARK`'s source URL: on or off. */
export async function setDarkSourceAvailable(available: boolean, caseId: string): Promise<void> {
  await post(
    endpointOf(darkSourceControl, caseId),
    { available },
    `taking the dark source ${available ? "back online" : "offline"}`
  );
}

/** Confirms the state actually took, by reading the serving URL until it agrees. */
export async function waitForSourceUri(
  sourceUri: string,
  expectation: "reachable" | "gone",
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let last = 0;

  while (Date.now() < deadline) {
    // `cache: no-store` is not enough on its own — an intermediary may still hold the body — so the wait exists
    // on top of it rather than instead of it.
    const response = await http(sourceUri, { headers: { "cache-control": "no-cache" }, bare: true });
    last = response.status;
    const satisfied =
      expectation === "gone" ? response.status === 404 || response.status === 410 : response.ok;
    if (satisfied) return;
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `${sourceUri} did not become ${expectation} within ${timeoutMs} ms; last status ${last}. ` +
      `E2E-SRC-08 is about a source that is genuinely unreachable, so continuing here would assert ` +
      `against a state that was never established.`
  );
}

/** The one prefix `E2E-SRC-11` is allowed to break. Anything wider makes the run `E2E-PUB-16`. */
export const SOURCE_PREFIX = "sources/";

/** Fails or heals object-store **writes** under one result-root prefix. */
export async function setSourceRetentionFault(
  mode: "fail_writes" | "healthy",
  caseId: string
): Promise<void> {
  await post(
    endpointOf(objectStoreFaultInjector, caseId),
    { prefix: SOURCE_PREFIX, mode },
    `setting ${SOURCE_PREFIX} writes to ${mode}`
  );
}
