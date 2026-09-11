/** Explicit ECS control for E2E-QRY-09 only. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env, managedE2eEnvironment, type ManagedE2eEnvironment } from "./env.js";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "verification-svc";
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

type EcsServiceSnapshot = {
  readonly desiredCount: number;
  readonly runningCount: number;
  readonly pendingCount: number;
  readonly taskDefinition: string;
};

export type PeerVerifierControl = {
  readonly testedEnvironment: ManagedE2eEnvironment;
  readonly peerEnvironment: ManagedE2eEnvironment;
  readonly peerVerifierId: string;
  readonly cluster: string;
  readonly region: string;
  readonly timeoutMs: number;
  readonly profile?: string;
};

function configured(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" || value === undefined ? undefined : value;
}

function peerEnvironmentOf(environment: ManagedE2eEnvironment): ManagedE2eEnvironment {
  return environment === "dev" ? "staging" : "dev";
}

function timeoutMs(): number {
  const raw = configured("SCVS_E2E_PEER_OUTAGE_TIMEOUT_MS");
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 30_000) {
    throw new Error("SCVS_E2E_PEER_OUTAGE_TIMEOUT_MS must be an integer of at least 30000.");
  }
  return value;
}

/** A missing control is a skip; a malformed armed control is a hard test setup failure. */
export function peerVerifierOutagePrerequisite(): string | undefined {
  if (!managedE2eEnvironment) {
    return "SCVS_E2E_ENV must be dev or staging for the peer-outage control";
  }

  const missing = ["SCVS_E2E_PEER_ECS_CLUSTER", "SCVS_E2E_AWS_REGION", "SCVS_E2E_PEER_OUTAGE_CONFIRM"]
    .filter((name) => configured(name) === undefined);
  if (missing.length > 0) return `missing ${missing.join(", ")}`;

  const peerEnvironment = peerEnvironmentOf(managedE2eEnvironment);
  const expectedConfirmation = `stop-${peerEnvironment}-${SERVICE_NAME}`;
  if (configured("SCVS_E2E_PEER_OUTAGE_CONFIRM") !== expectedConfirmation) {
    return `SCVS_E2E_PEER_OUTAGE_CONFIRM must equal ${expectedConfirmation}`;
  }

  try {
    timeoutMs();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export function peerVerifierControl(): PeerVerifierControl {
  const prerequisite = peerVerifierOutagePrerequisite();
  if (prerequisite) throw new Error(`Peer-outage control is not armed: ${prerequisite}.`);

  const testedEnvironment = managedE2eEnvironment!;
  const peerEnvironment = peerEnvironmentOf(testedEnvironment);
  return {
    testedEnvironment,
    peerEnvironment,
    peerVerifierId: `scvs-${peerEnvironment}`,
    cluster: configured("SCVS_E2E_PEER_ECS_CLUSTER")!,
    region: configured("SCVS_E2E_AWS_REGION")!,
    timeoutMs: timeoutMs(),
    profile: configured("SCVS_E2E_AWS_PROFILE"),
  };
}

/** The executor deliberately removes an ambient AWS_PROFILE. */
function awsEnvironment(profile: string | undefined): NodeJS.ProcessEnv {
  const { AWS_PROFILE: _ambientProfile, ...withoutAmbientProfile } = process.env;
  return profile === undefined ? withoutAmbientProfile : { ...withoutAmbientProfile, AWS_PROFILE: profile };
}

async function awsJson(control: PeerVerifierControl, operation: string, args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--region", control.region, "--output", "json"], {
      env: awsEnvironment(control.profile),
      timeout: control.timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } catch {
    // Do not print CLI output: an operator may have configured endpoint or account diagnostics that do not
    // belong in a Jest artifact.
    throw new Error(`AWS CLI ${operation} failed for ${SERVICE_NAME} in the configured peer cluster.`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AWS CLI ${label} response had an unexpected shape.`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`AWS CLI ${label} response did not contain a non-negative count.`);
  }
  return value as number;
}

export class PeerVerificationServiceControl {
  constructor(readonly control: PeerVerifierControl) {}

  async inspect(): Promise<EcsServiceSnapshot> {
    const response = record(
      await awsJson(this.control, "ecs describe-services", [
        "ecs",
        "describe-services",
        "--cluster",
        this.control.cluster,
        "--services",
        SERVICE_NAME,
      ]),
      "describe-services",
    );
    const failures = response.failures;
    if (Array.isArray(failures) && failures.length > 0) {
      throw new Error(`AWS ECS could not resolve ${SERVICE_NAME} in the configured peer cluster.`);
    }
    const service = Array.isArray(response.services) ? response.services[0] : undefined;
    const parsed = record(service, "describe-services service");
    const taskDefinition = parsed.taskDefinition;
    if (typeof taskDefinition !== "string" || taskDefinition === "") {
      throw new Error(`AWS ECS returned no task definition for ${SERVICE_NAME}.`);
    }
    return {
      desiredCount: nonNegativeInteger(parsed.desiredCount, "desiredCount"),
      runningCount: nonNegativeInteger(parsed.runningCount, "runningCount"),
      pendingCount: nonNegativeInteger(parsed.pendingCount, "pendingCount"),
      taskDefinition,
    };
  }

  async assertPeerIdentity(): Promise<EcsServiceSnapshot> {
    const snapshot = await this.inspect();
    const response = record(
      await awsJson(this.control, "ecs describe-task-definition", [
        "ecs",
        "describe-task-definition",
        "--task-definition",
        snapshot.taskDefinition,
      ]),
      "describe-task-definition",
    );
    const taskDefinition = record(response.taskDefinition, "describe-task-definition taskDefinition");
    const containers = taskDefinition.containerDefinitions;
    const container = Array.isArray(containers)
      ? containers.find((candidate) => record(candidate, "container definition").name === SERVICE_NAME)
      : undefined;
    const environment = record(container, "verification-svc container").environment;
    const verifierId = Array.isArray(environment)
      ? environment
          .map((item) => record(item, "container environment"))
          .find((item) => item.name === "SCVS_VERIFIER_ID")?.value
      : undefined;
    if (verifierId !== this.control.peerVerifierId) {
      throw new Error(
        `Refusing to control ${SERVICE_NAME}: its task definition identifies ${JSON.stringify(verifierId)}, ` +
          `but this ${this.control.testedEnvironment} run may only stop ${this.control.peerVerifierId}.`,
      );
    }
    return snapshot;
  }

  async stop(snapshot: EcsServiceSnapshot): Promise<void> {
    if (snapshot.desiredCount < 1 || snapshot.runningCount !== snapshot.desiredCount || snapshot.pendingCount !== 0) {
      throw new Error(
        `Refusing to stop an unhealthy peer service: desired=${snapshot.desiredCount}, ` +
          `running=${snapshot.runningCount}, pending=${snapshot.pendingCount}.`,
      );
    }
    await this.setDesiredCount(0);
    try {
      await this.waitFor(0);
    } catch (error) {
      // A partially applied stop must not strand the peer. Preserve the original cause after best-effort
      // recovery.
      try {
        await this.restore(snapshot);
      } catch {
        throw new Error("Peer stop did not settle and automatic restoration also failed; intervene before rerunning.");
      }
      throw error;
    }
  }

  async restore(snapshot: EcsServiceSnapshot): Promise<void> {
    await this.setDesiredCount(snapshot.desiredCount);
    await this.waitFor(snapshot.desiredCount);
  }

  private async setDesiredCount(desiredCount: number): Promise<void> {
    await awsJson(this.control, "ecs update-service", [
      "ecs",
      "update-service",
      "--cluster",
      this.control.cluster,
      "--service",
      SERVICE_NAME,
      "--desired-count",
      String(desiredCount),
    ]);
  }

  private async waitFor(desiredCount: number): Promise<void> {
    const deadline = Date.now() + this.control.timeoutMs;
    let latest: EcsServiceSnapshot | undefined;
    while (Date.now() < deadline) {
      latest = await this.inspect();
      if (
        latest.desiredCount === desiredCount &&
        latest.runningCount === desiredCount &&
        latest.pendingCount === 0
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
      `Peer ${SERVICE_NAME} did not settle at desired=${desiredCount} within ${this.control.timeoutMs} ms` +
        (latest
          ? ` (last desired=${latest.desiredCount}, running=${latest.runningCount}, pending=${latest.pendingCount}).`
          : "."),
    );
  }
}
