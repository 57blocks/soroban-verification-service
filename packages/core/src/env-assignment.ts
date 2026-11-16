const RESERVED_ENV_PREFIXES = ["SCVS_", "AWS_", "ECS_", "DOCKER_"] as const;

/** Why a `--env` build option may not reach `docker run -e`, or undefined when it may. Shared by submit and builder. */
export function refusedEnvAssignment(entry: string): string | undefined {
  const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(entry)?.[1];
  if (!name) {
    return `--env ${JSON.stringify(entry)} gives no value; docker would copy the runner's own variable of that name into the build.`;
  }
  const reserved = RESERVED_ENV_PREFIXES.find((prefix) => name.toUpperCase().startsWith(prefix));
  if (reserved) return `--env ${name} sets a ${reserved} variable, which the verifier reserves.`;
  return undefined;
}
