#!/usr/bin/env node
/** Static and read-only: parses the job definitions in `deploy-builder.yml` and `deploy-composer.yml` from disk. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : resolve(args[i + 1]);
};

const TARGETS = [
  { label: "builder", path: flag("builder", join(repoRoot, ".github/workflows/deploy-builder.yml")) },
  { label: "composer", path: flag("composer", join(repoRoot, ".github/workflows/deploy-composer.yml")) },
];

const DOCKER_SOCKET = "/var/run/docker.sock";
const TMPFS_HOST_PATHS = ["/tmp", "/dev/shm", "/run"];
const SCRATCH_VARIABLES = ["TMPDIR", "SCVS_HANDOFF_ROOT"];

const findings = [];
let mountsChecked = 0;

const within = (path, root) => path === root || path.startsWith(`${root}/`);

function containersOf(properties) {
  if (Array.isArray(properties.taskProperties)) {
    return properties.taskProperties.flatMap((task) =>
      (task.containers ?? []).map((container) => ({ ...container, volumes: task.volumes ?? [] })),
    );
  }
  return [{ name: "container", ...properties }];
}

for (const { label, path } of TARGETS) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    findings.push(`${label}: could not read ${path} — has it moved?`);
    continue;
  }

  const scannable = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const blobMatch =
    scannable.match(/--(?:ecs|container)-properties\s+"\{([\s\S]*?)\}"\s*\\/) ??
    scannable.match(/(?:ECS|CONTAINER)_PROPERTIES="\{([\s\S]*?)\}"\s*$/m);
  if (!blobMatch) {
    findings.push(
      `${label}: no properties block found in ${path} — expected either ` +
        `\`--ecs/container-properties "{...}"\` or \`ECS/CONTAINER_PROPERTIES="{...}"\``
    );
    continue;
  }

  let properties;
  try {
    // The blob is shell-escaped JSON whose only interpolations sit inside string values.
    properties = JSON.parse(`{${blobMatch[1]}}`.replace(/\\"/g, '"').replace(/\$\{[^}]*\}/g, "interpolated"));
  } catch (error) {
    findings.push(`${label}: the properties block in ${path} is not JSON once unescaped: ${error.message}`);
    continue;
  }

  const containers = containersOf(properties);
  if (containers.every((container) => (container.mountPoints ?? []).length === 0)) {
    findings.push(
      `${label}: no mountPoints found in ${path} — cannot check CE3. Both job definitions must ` +
        `bind-mount the docker socket and a shared scratch directory, so finding none means this ` +
        `parser lost the blob rather than that there is nothing to check`,
    );
    continue;
  }

  for (const container of containers) {
    const where = `${label}/${container.name}`;
    const hostVolumes = new Map(
      container.volumes.filter((volume) => volume.host).map((volume) => [volume.name, volume.host.sourcePath]),
    );
    const declaredVolumes = new Set(container.volumes.map((volume) => volume.name));
    const sharedPaths = [];

    for (const { sourceVolume, containerPath } of container.mountPoints ?? []) {
      mountsChecked += 1;
      if (!declaredVolumes.has(sourceVolume)) {
        findings.push(
          `${where}: mountPoint at ${containerPath} references volume "${sourceVolume}", which this ` +
            `definition does not declare — the mount would fail to register`,
        );
        continue;
      }
      const hostPath = hostVolumes.get(sourceVolume);
      if (hostPath === undefined) {
        findings.push(
          `${where}: volume "${sourceVolume}", mounted at ${containerPath}, declares no ` +
            `host.sourcePath — a Docker-managed volume, which is exactly the trap that produces an ` +
            `empty mount and "could not find Cargo.toml in /source"`,
        );
        continue;
      }
      if (hostPath !== containerPath) {
        findings.push(
          `${where}: volume "${sourceVolume}" binds host path ${hostPath} at container path ` +
            `${containerPath} — these must be IDENTICAL (CE3). The runner hands this path to the ` +
            `HOST's daemon, which resolves it against the host filesystem, so a differing pair mounts ` +
            `somewhere nobody intended`,
        );
        continue;
      }
      const tmpfs = TMPFS_HOST_PATHS.find((root) => within(hostPath, root));
      if (tmpfs) {
        findings.push(
          `${where}: volume "${sourceVolume}" binds host path ${hostPath}, and ${tmpfs} is a tmpfs on ` +
            `Amazon Linux 2023 — build output written there is charged to the writing container's ` +
            `memory limit and stays on the instance until it reboots. Use a disk-backed path such as /var/tmp`,
        );
        continue;
      }
      if (hostPath !== DOCKER_SOCKET) sharedPaths.push(containerPath);
    }

    const environment = new Map((container.environment ?? []).map((entry) => [entry.name, entry.value]));
    const scratch = SCRATCH_VARIABLES.filter((name) => environment.has(name)).map((name) => [name, environment.get(name)]);
    const mountsSocket = (container.mountPoints ?? []).some((mount) => mount.containerPath === DOCKER_SOCKET);
    if (mountsSocket && !environment.has("TMPDIR")) scratch.push(["TMPDIR", "/tmp"]);
    for (const [name, value] of scratch) {
      if (!sharedPaths.some((shared) => within(value, shared))) {
        findings.push(
          `${where}: ${name}=${value}${environment.has(name) ? "" : " (unset, so the default)"} is not ` +
            `inside a host-identical, disk-backed bind mount (${sharedPaths.join(", ") || "none"}) — ` +
            `the directories made there are handed to the host's daemon or the other container, and ` +
            `neither can see them`,
        );
      }
    }
  }
}

const inGha = Boolean(process.env.GITHUB_ACTIONS);
for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);

console.log(
  findings.length
    ? `\n${findings.length} CE3 finding(s) across ${TARGETS.length} workflow file(s). Every volume a ` +
        `job definition bind-mounts must be host-visible at its own path and disk-backed, and every ` +
        `scratch directory must sit inside one, because the runner hands those paths to the host's daemon.`
    : `✓ CE3 holds: ${mountsChecked} bind mount(s) across ${TARGETS.length} workflow file(s) are ` +
        `host-visible at identical, disk-backed paths, and every scratch directory sits inside one.`,
);
process.exit(findings.length ? 1 : 0);
