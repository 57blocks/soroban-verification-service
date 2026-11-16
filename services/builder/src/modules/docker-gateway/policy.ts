import { isAbsolute, normalize } from "node:path";
import { WORKSPACES_PATH } from "./protocol.js";

/**
 * What the runner may ask of the host's Docker daemon. The daemon runs as root, so anything not listed here is
 * refused: the runner only ever starts sandbox containers, waits on them and removes them.
 */

export type Denial = { ok: false; reason: string };

export type ContainerOp = "attach" | "start" | "wait" | "kill" | "remove" | "inspect";

export type Route =
  | { ok: true; kind: "ping" }
  | { ok: true; kind: "version" }
  | { ok: true; kind: "pull" }
  | { ok: true; kind: "create" }
  | { ok: true; kind: "container"; id: string; op: ContainerOp }
  | { ok: true; kind: "workspace-create" }
  | { ok: true; kind: "workspace-delete"; id: string };

const API_VERSION_PREFIX = /^\/v\d+\.\d+(?=\/)/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const WORKSPACE_ID = /^[A-Za-z0-9]{6,32}$/;
const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const DIGEST_TAG = /^sha256:[0-9a-f]{64}$/;
const ECR_REGISTRY = /^[0-9]{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/;

const deny = (reason: string): Denial => ({ ok: false, reason });

export function routeRequest(method: string, url: string): Route | Denial {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://gateway");
  } catch {
    return deny(`unparseable request target ${url}`);
  }
  const path = parsed.pathname.replace(API_VERSION_PREFIX, "");
  const segments = path.split("/").filter(Boolean);

  if (path === "/_ping" && (method === "GET" || method === "HEAD")) return { ok: true, kind: "ping" };
  if (path === "/version" && method === "GET") return { ok: true, kind: "version" };
  if (path === "/images/create" && method === "POST") return { ok: true, kind: "pull" };
  if (path === "/containers/create" && method === "POST") return { ok: true, kind: "create" };

  if (segments[0] === "containers" && segments.length >= 2) {
    const id = segments[1]!;
    const op = containerOp(method, segments.slice(2));
    if (op && !CONTAINER_ID.test(id)) return deny(`containers are addressed by their full id, not ${id}`);
    if (op) return { ok: true, kind: "container", id, op };
  }

  if (parsed.pathname === WORKSPACES_PATH && method === "POST") return { ok: true, kind: "workspace-create" };
  if (parsed.pathname.startsWith(`${WORKSPACES_PATH}/`) && method === "DELETE") {
    const id = parsed.pathname.slice(WORKSPACES_PATH.length + 1);
    if (WORKSPACE_ID.test(id)) return { ok: true, kind: "workspace-delete", id };
  }

  return deny(`${method} ${path} is not an operation the builder needs`);
}

function containerOp(method: string, rest: string[]): ContainerOp | undefined {
  if (rest.length === 0) {
    if (method === "DELETE") return "remove";
    return undefined;
  }
  if (rest.length !== 1) return undefined;
  const [action] = rest;
  if (method === "POST" && action === "attach") return "attach";
  if (method === "POST" && action === "start") return "start";
  if (method === "POST" && action === "wait") return "wait";
  if (method === "POST" && action === "kill") return "kill";
  if (method === "GET" && action === "json") return "inspect";
  return undefined;
}

/** A pull by digest. `ecrRegistry` names the ECR registry it is from, whose token the gateway supplies. */
export function checkPull(url: string): { ok: true; ecrRegistry?: { host: string; region: string } } | Denial {
  const query = new URL(url, "http://gateway").searchParams;
  for (const key of ["fromSrc", "repo", "message", "changes"]) {
    if (query.has(key)) return deny(`an image pull may not set ${key}`);
  }
  const from = query.get("fromImage") ?? "";
  const tag = query.get("tag") ?? "";
  if (!(tag ? DIGEST_TAG.test(tag) && !from.includes("@") : DIGEST_PINNED_IMAGE.test(from))) {
    return deny(`only images pinned by sha256 digest may be pulled, not ${from}${tag ? `:${tag}` : ""}`);
  }
  const host = from.split("/")[0] ?? "";
  const region = ECR_REGISTRY.exec(host)?.[1];
  return region ? { ok: true, ecrRegistry: { host, region } } : { ok: true };
}

/** The `X-Registry-Auth` the daemon reads: URL-safe base64 of the JSON, padding kept as Go's decoder expects. */
export function encodeRegistryAuth(auth: { username: string; password: string; serveraddress: string }): string {
  return Buffer.from(JSON.stringify(auth)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

export type CreateContext = {
  sandboxUser: string;
  /** The live workspace a bind source is a leaf of, if it is one. */
  workspaceOfLeaf: (path: string) => string | undefined;
};

export type CheckedCreate = { ok: true; workspaces: string[] };

/**
 * A container is created only in the sandbox's shape: its own uid, no capabilities, no privilege escalation, a
 * read-only root, resource limits, no host namespace or device, and binds of workspace leaves only.
 */
export function checkCreate(url: string, body: unknown, context: CreateContext): CheckedCreate | Denial {
  const query = new URL(url, "http://gateway").searchParams;
  for (const key of query.keys()) {
    if (key !== "platform") return deny(`a container may not be created with ?${key}`);
  }
  if (!isRecord(body)) return deny("the create body is not a JSON object");

  const problems: string[] = [];
  checkFields("", body, configRules(context), problems, ["HostConfig", "NetworkingConfig"]);

  const host = body.HostConfig;
  if (!isRecord(host)) {
    problems.push("HostConfig is missing");
  } else {
    checkFields("HostConfig.", host, HOST_RULES, problems, ["Mounts"]);
  }

  const workspaces = new Set<string>();
  const mounts = isRecord(host) ? host.Mounts : undefined;
  if (mounts !== undefined && mounts !== null) {
    if (!Array.isArray(mounts)) {
      problems.push("HostConfig.Mounts is not a list");
    } else {
      mounts.forEach((mount, index) => {
        const workspace = checkMount(`HostConfig.Mounts[${index}].`, mount, context, problems);
        if (workspace) workspaces.add(workspace);
      });
    }
  }

  checkNetworking(body.NetworkingConfig, problems);

  if (problems.length) return deny(problems.join("; "));
  return { ok: true, workspaces: [...workspaces] };
}

type Rule = (value: unknown) => string | undefined;

const any: Rule = () => undefined;
const unset: Rule = (value) => (isZero(value) ? undefined : "must be unset");
const absent: Rule = (value) => (value === undefined || value === null ? undefined : "must be absent");
const oneOf =
  (...allowed: unknown[]): Rule =>
  (value) =>
    allowed.includes(value ?? "") ? undefined : `must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`;
const positive: Rule = (value) => (typeof value === "number" && value > 0 ? undefined : "must be a positive limit");
const nonNegative: Rule = (value) =>
  value === undefined || value === null || (typeof value === "number" && value >= 0) ? undefined : "must not be negative";
const isTrue: Rule = (value) => (value === true ? undefined : "must be true");
const stringList: Rule = (value) =>
  value === undefined || value === null || (Array.isArray(value) && value.every((v) => typeof v === "string"))
    ? undefined
    : "must be a list of strings";

function configRules(context: CreateContext): Record<string, Rule> {
  return {
    Hostname: any,
    Domainname: any,
    User: (value) => (value === context.sandboxUser ? undefined : `must be ${context.sandboxUser}`),
    AttachStdin: unset,
    AttachStdout: any,
    AttachStderr: any,
    Tty: unset,
    OpenStdin: unset,
    StdinOnce: unset,
    Env: stringList,
    Cmd: stringList,
    Entrypoint: stringList,
    Image: (value) =>
      typeof value === "string" && DIGEST_PINNED_IMAGE.test(value) ? undefined : "must be pinned by sha256 digest",
    Labels: any,
    WorkingDir: any,
    StopSignal: any,
    StopTimeout: any,
    ArgsEscaped: any,
    NetworkDisabled: any,
  };
}

const HOST_RULES: Record<string, Rule> = {
  // Required limits and confinement.
  Privileged: unset,
  ReadonlyRootfs: isTrue,
  CapAdd: unset,
  CapDrop: (value) =>
    Array.isArray(value) && value.some((cap) => typeof cap === "string" && cap.toUpperCase() === "ALL")
      ? undefined
      : "must drop ALL",
  SecurityOpt: (value) => {
    const opts = Array.isArray(value) ? value : [];
    const nnp = (opt: unknown) => opt === "no-new-privileges" || opt === "no-new-privileges:true" || opt === "no-new-privileges=true";
    if (!opts.some(nnp)) return "must set no-new-privileges";
    return opts.every(nnp) ? undefined : "may set nothing but no-new-privileges";
  },
  Memory: positive,
  NanoCpus: positive,
  PidsLimit: positive,
  // An empty list unmasks /proc and /sys paths; only Docker's default may apply.
  MaskedPaths: absent,
  ReadonlyPaths: absent,
  NetworkMode: oneOf("", "default", "bridge", "none"),
  IpcMode: oneOf("", "private", "none"),
  CgroupnsMode: oneOf("", "private"),
  Runtime: oneOf("", "runc"),
  Isolation: oneOf("", "default"),
  RestartPolicy: (value) =>
    value === undefined || value === null || (isRecord(value) && oneOf("", "no")(value.Name) === undefined && isZero(value.MaximumRetryCount))
      ? undefined
      : "must not restart",
  LogConfig: (value) =>
    value === undefined || value === null || (isRecord(value) && isZero(value.Type) && isZero(value.Config))
      ? undefined
      : "must use the daemon's own log driver",
  OomScoreAdj: nonNegative,
  // Harmless whatever their value: the container's own view, or its share of what the limits above allow.
  AutoRemove: any,
  ContainerIDFile: any,
  ConsoleSize: any,
  Tmpfs: (value) =>
    value === undefined || value === null || (isRecord(value) && Object.entries(value).every(([k, v]) => isAbsolute(k) && typeof v === "string"))
      ? undefined
      : "must map absolute paths to option strings",
  ShmSize: any,
  Dns: stringList,
  DnsOptions: stringList,
  DnsSearch: stringList,
  CpuShares: any,
  CpuPeriod: any,
  CpuQuota: any,
  CpusetCpus: any,
  CpusetMems: any,
  BlkioWeight: any,
  MemoryReservation: any,
  MemorySwap: any,
  MemorySwappiness: any,
  KernelMemory: any,
  KernelMemoryTCP: any,
  Init: any,
};

function checkMount(where: string, mount: unknown, context: CreateContext, problems: string[]): string | undefined {
  if (!isRecord(mount)) {
    problems.push(`${where.slice(0, -1)} is not an object`);
    return undefined;
  }
  checkFields(where, mount, MOUNT_RULES, problems, ["Source", "BindOptions"]);
  const options = mount.BindOptions;
  if (!isRecord(options)) {
    problems.push(`${where}BindOptions must set NonRecursive`);
  } else {
    checkFields(`${where}BindOptions.`, options, BIND_OPTION_RULES, problems, []);
  }
  const source = mount.Source;
  if (typeof source !== "string" || !isAbsolute(source) || normalize(source) !== source) {
    problems.push(`${where}Source must be an absolute, normalised path`);
    return undefined;
  }
  const workspace = context.workspaceOfLeaf(source);
  if (!workspace) problems.push(`${where}Source ${source} is not a directory of a live sandbox workspace`);
  return workspace;
}

const MOUNT_RULES: Record<string, Rule> = {
  Type: oneOf("bind"),
  Target: (value) => (typeof value === "string" && isAbsolute(value) ? undefined : "must be an absolute path"),
  ReadOnly: any,
  Consistency: any,
};

const BIND_OPTION_RULES: Record<string, Rule> = {
  NonRecursive: isTrue,
  Propagation: oneOf("", "private", "rprivate"),
  ReadOnlyNonRecursive: any,
  ReadOnlyForceRecursive: any,
};

function checkNetworking(value: unknown, problems: string[]): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    problems.push("NetworkingConfig is not an object");
    return;
  }
  checkFields("NetworkingConfig.", value, { EndpointsConfig: any }, problems, []);
  const endpoints = value.EndpointsConfig;
  if (endpoints === undefined || endpoints === null) return;
  if (!isRecord(endpoints)) {
    problems.push("NetworkingConfig.EndpointsConfig is not an object");
    return;
  }
  for (const [network, settings] of Object.entries(endpoints)) {
    if (!["none", "bridge", "default"].includes(network)) {
      problems.push(`NetworkingConfig.EndpointsConfig may not join ${network}`);
      continue;
    }
    if (settings !== null && settings !== undefined && !isRecord(settings)) {
      problems.push(`NetworkingConfig.EndpointsConfig.${network} is not an object`);
      continue;
    }
    checkFields(`NetworkingConfig.EndpointsConfig.${network}.`, settings ?? {}, {}, problems, []);
  }
}

/** Every field must pass its rule; a field with no rule must be at its zero value. */
function checkFields(
  where: string,
  object: Record<string, unknown>,
  rules: Record<string, Rule>,
  problems: string[],
  handledElsewhere: string[],
): void {
  for (const [key, value] of Object.entries(object)) {
    if (handledElsewhere.includes(key)) continue;
    const rule = Object.prototype.hasOwnProperty.call(rules, key) ? rules[key]! : unset;
    const problem = rule(value);
    if (problem) problems.push(`${where}${key} ${problem}`);
  }
  for (const [key, rule] of Object.entries(rules)) {
    if (key in object || handledElsewhere.includes(key)) continue;
    const problem = rule(undefined);
    if (problem) problems.push(`${where}${key} ${problem}`);
  }
}

function isZero(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  // A map's keys are its meaning (`Volumes: {"/data": {}}`), so only an empty one is unset.
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
