import { socketCall } from "./socket-call.js";

/**
 * Empties a workspace from inside a container that sees nothing else, so a link a sandbox or the runner left
 * in it resolves inside that container and not on the host. The image is the gateway's own.
 */
export function emptyInContainer(socketPath: string, image: string): (root: string) => Promise<void> {
  return async (root) => {
    const created = await socketCall(socketPath, "POST", "/containers/create", {
      Image: image,
      User: "0:0",
      Entrypoint: ["find", "/w", "-mindepth", "1", "-delete"],
      Cmd: [],
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        // Root's files and the sandbox's both go, in directories either may have made sticky.
        CapAdd: ["DAC_OVERRIDE", "FOWNER"],
        SecurityOpt: ["no-new-privileges"],
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 64,
        Mounts: [{ Type: "bind", Source: root, Target: "/w", BindOptions: { NonRecursive: true } }],
      },
    });
    const id = (created.body as { Id?: unknown } | undefined)?.Id;
    if (created.status !== 201 || typeof id !== "string") {
      throw new Error(`could not create the workspace cleanup container (${created.status}): ${JSON.stringify(created.body)}`);
    }
    try {
      const started = await socketCall(socketPath, "POST", `/containers/${id}/start`);
      if (started.status !== 204 && started.status !== 304) {
        throw new Error(`could not start the workspace cleanup container (${started.status})`);
      }
      const waited = await socketCall(socketPath, "POST", `/containers/${id}/wait`);
      const code = (waited.body as { StatusCode?: unknown } | undefined)?.StatusCode;
      if (code !== 0) throw new Error(`the workspace cleanup container exited ${String(code)}`);
    } finally {
      await socketCall(socketPath, "DELETE", `/containers/${id}?force=1`).catch(() => undefined);
    }
  };
}
