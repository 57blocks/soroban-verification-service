import { checkCreate, checkPull, encodeRegistryAuth, goFold, routeRequest } from "../src/modules/docker-gateway/policy.js";

const ID = "c".repeat(64);
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;
const SOURCE = "/var/tmp/scvs-sandbox-abc123/source";
const VENDOR = "/var/tmp/scvs-sandbox-abc123/vendor";
const LEAVES = new Map([
  [SOURCE, "abc123"],
  [VENDOR, "abc123"],
]);
const PREFETCH = "scvs-prefetch-0a1b2c3d4e5f";
const context = { sandboxUser: "65532:65532", workspaceOfLeaf: (path: string) => LEAVES.get(path), prefetchNetwork: PREFETCH };

/** What the docker 29 CLI sends for the prefetch stage, recorded from a real `docker run`. */
function cliCreateBody(): Record<string, any> {
  return {
    Hostname: "",
    Domainname: "",
    User: "65532:65532",
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: ["CARGO_HOME=/out/cargo-home"],
    Cmd: ["vendor", "--locked"],
    Image: IMAGE,
    Volumes: {},
    WorkingDir: "/",
    Entrypoint: ["cargo"],
    Labels: {},
    NetworkingConfig: {
      EndpointsConfig: {
        [PREFETCH]: { IPAMConfig: null, Links: null, Aliases: null, DriverOpts: null, GwPriority: 0, NetworkID: "", IPAddress: "", DNSNames: null },
      },
    },
    HostConfig: {
      Binds: null,
      ContainerIDFile: "/var/tmp/scvs-build-x/prefetch.cid",
      LogConfig: { Type: "", Config: {} },
      NetworkMode: PREFETCH,
      PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: true,
      VolumeDriver: "",
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: ["ALL"],
      CgroupnsMode: "",
      Dns: null,
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      GroupAdd: null,
      IpcMode: "",
      Cgroup: "",
      Links: null,
      OomScoreAdj: 0,
      PidMode: "",
      Privileged: false,
      PublishAllPorts: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=64m", "/var/tmp": "rw,nosuid,nodev,noexec,size=64m" },
      UTSMode: "",
      UsernsMode: "",
      ShmSize: 0,
      Isolation: "",
      CpuShares: 0,
      Memory: 2147483648,
      NanoCpus: 2000000000,
      CgroupParent: "",
      BlkioWeight: 0,
      BlkioWeightDevice: [],
      BlkioDeviceReadBps: [],
      Devices: [],
      DeviceCgroupRules: null,
      DeviceRequests: null,
      MemoryReservation: 0,
      MemorySwap: 0,
      MemorySwappiness: -1,
      OomKillDisable: false,
      PidsLimit: 512,
      Ulimits: [],
      Mounts: [
        { Type: "bind", Source: SOURCE, Target: "/source", ReadOnly: true, BindOptions: { NonRecursive: true } },
        { Type: "bind", Source: VENDOR, Target: "/vendor", BindOptions: { NonRecursive: true } },
      ],
      MaskedPaths: null,
      ReadonlyPaths: null,
    },
  };
}

const create = (body: unknown, url = "/v1.44/containers/create") => checkCreate(url, body, context);

describe("docker gateway routes", () => {
  it.each([
    ["HEAD", "/_ping", "ping"],
    ["GET", "/v1.44/version", "version"],
    ["POST", "/v1.44/images/create?fromImage=x&tag=sha256:abc", "pull"],
    ["POST", "/v1.44/containers/create", "create"],
    ["POST", `/v1.44/containers/${ID}/attach?stream=1&stdout=1`, "container"],
    ["POST", `/v1.44/containers/${ID}/wait?condition=removed`, "container"],
    ["POST", `/v1.44/containers/${ID}/start`, "container"],
    ["POST", `/v1.24/containers/${ID}/start`, "container"],
    ["POST", `/v1.44/containers/${ID}/kill?signal=TERM`, "container"],
    ["DELETE", `/v1.44/containers/${ID}?force=1`, "container"],
    ["GET", `/v1.44/containers/${ID}/json`, "container"],
    ["POST", "/scvs/v1/workspaces", "workspace-create"],
    ["DELETE", "/scvs/v1/workspaces/abc123", "workspace-delete"],
  ])("lets %s %s through as %s", (method, url, kind) => {
    const route = routeRequest(method, url);
    expect(route.ok && route.kind).toBe(kind);
  });

  it.each([
    ["GET", "/v1.44/containers/json"],
    ["POST", `/v1.44/containers/${ID}/exec`],
    ["POST", "/v1.44/exec/abc/start"],
    ["POST", `/v1.44/containers/${ID}/archive`],
    ["PUT", `/v1.44/containers/${ID}/archive?path=/`],
    ["POST", `/v1.44/containers/${ID}/update`],
    ["POST", `/v1.44/containers/${ID}/attach/ws`],
    ["POST", "/v1.44/build"],
    ["POST", "/v1.44/images/load"],
    ["POST", "/v1.44/volumes/create"],
    ["POST", "/v1.44/networks/create"],
    ["POST", "/v1.44/plugins/pull"],
    ["GET", "/v1.44/info"],
    ["POST", "/v1.44/auth"],
    ["GET", "/v1.44/events"],
    ["POST", "/v1.44/swarm/init"],
    ["POST", "/v1.44/session"],
    ["DELETE", "/scvs/v1/workspaces/../../etc"],
    // Below 1.24 a start may carry a HostConfig the gateway never checks.
    ["POST", `/v1.23/containers/${ID}/start`],
    ["POST", "/v1.12/containers/create"],
    ["GET", "/v0.99/version"],
  ])("refuses %s %s", (method, url) => {
    expect(routeRequest(method, url).ok).toBe(false);
  });

  it("addresses a container only by its full id", () => {
    const route = routeRequest("DELETE", "/v1.44/containers/abc123?force=1");
    expect(route.ok).toBe(false);
    expect(!route.ok && route.reason).toContain("full id");
  });
});

describe("docker gateway: creating a container", () => {
  it("accepts the sandbox shape the builder's CLI sends", () => {
    expect(create(cliCreateBody())).toEqual({ ok: true, workspaces: ["abc123"] });
  });

  it("lets a gateway with no prefetch network give a container no network at all", () => {
    const body = cliCreateBody();
    const result = checkCreate("/v1.44/containers/create", body, { ...context, prefetchNetwork: undefined });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('HostConfig.NetworkMode must be "none"');
  });

  it("accepts a probe: no network and no mount", () => {
    const body = cliCreateBody();
    body.HostConfig.NetworkMode = "none";
    body.HostConfig.Mounts = null;
    body.NetworkingConfig = { EndpointsConfig: { none: {} } };
    expect(create(body)).toEqual({ ok: true, workspaces: [] });
  });

  it.each<[string, (body: Record<string, any>) => void, string]>([
    ["privileged", (b) => (b.HostConfig.Privileged = true), "HostConfig.Privileged must be unset"],
    ["a capability", (b) => (b.HostConfig.CapAdd = ["SYS_ADMIN"]), "HostConfig.CapAdd must be unset"],
    ["keeping capabilities", (b) => (b.HostConfig.CapDrop = ["NET_RAW"]), "HostConfig.CapDrop must drop ALL"],
    ["root", (b) => (b.User = "0:0"), "User must be 65532:65532"],
    ["the image's own user", (b) => delete b.User, "User must be 65532:65532"],
    ["a writable root", (b) => (b.HostConfig.ReadonlyRootfs = false), "HostConfig.ReadonlyRootfs must be true"],
    ["no no-new-privileges", (b) => (b.HostConfig.SecurityOpt = []), "must set no-new-privileges"],
    ["seccomp unconfined", (b) => b.HostConfig.SecurityOpt.push("seccomp=unconfined"), "may set nothing but no-new-privileges"],
    ["apparmor unconfined", (b) => b.HostConfig.SecurityOpt.push("apparmor=unconfined"), "may set nothing but no-new-privileges"],
    ["unmasked /proc", (b) => (b.HostConfig.MaskedPaths = []), "HostConfig.MaskedPaths must be absent"],
    ["writable /proc/sys", (b) => (b.HostConfig.ReadonlyPaths = []), "HostConfig.ReadonlyPaths must be absent"],
    ["no memory limit", (b) => (b.HostConfig.Memory = 0), "HostConfig.Memory must be a positive limit"],
    ["no cpu limit", (b) => delete b.HostConfig.NanoCpus, "HostConfig.NanoCpus must be a positive limit"],
    ["no pids limit", (b) => (b.HostConfig.PidsLimit = -1), "HostConfig.PidsLimit must be a positive limit"],
    ["the host network", (b) => (b.HostConfig.NetworkMode = "host"), `HostConfig.NetworkMode must be "none" or "${PREFETCH}"`],
    ["another container's network", (b) => (b.HostConfig.NetworkMode = `container:${ID}`), "HostConfig.NetworkMode must be"],
    ["the default bridge", (b) => (b.HostConfig.NetworkMode = "default"), "HostConfig.NetworkMode must be"],
    ["the bridge by name", (b) => (b.HostConfig.NetworkMode = "bridge"), "HostConfig.NetworkMode must be"],
    ["no network mode, which is the default bridge", (b) => delete b.HostConfig.NetworkMode, "HostConfig.NetworkMode must be"],
    ["a named network", (b) => (b.NetworkingConfig.EndpointsConfig = { scvs: {} }), "may not join scvs"],
    ["a second endpoint", (b) => (b.NetworkingConfig.EndpointsConfig.bridge = {}), "may not join bridge"],
    ["an endpoint alias", (b) => (b.NetworkingConfig.EndpointsConfig[PREFETCH].Aliases = ["x"]), "Aliases must be unset"],
    ["a fixed address", (b) => (b.NetworkingConfig.EndpointsConfig[PREFETCH].IPAMConfig = { IPv4Address: "172.30.0.9" }), "IPAMConfig must be unset"],
    ["an extra host entry", (b) => (b.HostConfig.ExtraHosts = ["crates.io:10.0.0.1"]), "HostConfig.ExtraHosts must be unset"],
    ["a DNS server", (b) => (b.HostConfig.Dns = ["10.0.0.2"]), "HostConfig.Dns must be unset"],
    ["a DNS option", (b) => (b.HostConfig.DnsOptions = ["ndots:0"]), "HostConfig.DnsOptions must be unset"],
    ["a DNS search domain", (b) => (b.HostConfig.DnsSearch = ["internal"]), "HostConfig.DnsSearch must be unset"],
    ["the host pid namespace", (b) => (b.HostConfig.PidMode = "host"), "HostConfig.PidMode must be unset"],
    ["the host ipc namespace", (b) => (b.HostConfig.IpcMode = "host"), "HostConfig.IpcMode must be one of"],
    ["the host uts namespace", (b) => (b.HostConfig.UTSMode = "host"), "HostConfig.UTSMode must be unset"],
    ["the host user namespace", (b) => (b.HostConfig.UsernsMode = "host"), "HostConfig.UsernsMode must be unset"],
    ["the host cgroup namespace", (b) => (b.HostConfig.CgroupnsMode = "host"), "HostConfig.CgroupnsMode must be one of"],
    ["a device", (b) => (b.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }]), "HostConfig.Devices must be unset"],
    ["a device rule", (b) => (b.HostConfig.DeviceCgroupRules = ["b *:* rwm"]), "HostConfig.DeviceCgroupRules must be unset"],
    ["a gpu", (b) => (b.HostConfig.DeviceRequests = [{ Count: -1 }]), "HostConfig.DeviceRequests must be unset"],
    ["a -v bind", (b) => (b.HostConfig.Binds = ["/:/host"]), "HostConfig.Binds must be unset"],
    ["another container's volumes", (b) => (b.HostConfig.VolumesFrom = [ID]), "HostConfig.VolumesFrom must be unset"],
    ["a sysctl", (b) => (b.HostConfig.Sysctls = { "kernel.x": "1" }), "HostConfig.Sysctls must be unset"],
    ["another runtime", (b) => (b.HostConfig.Runtime = "runsc"), "HostConfig.Runtime must be one of"],
    ["a cgroup parent", (b) => (b.HostConfig.CgroupParent = "/"), "HostConfig.CgroupParent must be unset"],
    ["an unkillable process", (b) => (b.HostConfig.OomScoreAdj = -1000), "HostConfig.OomScoreAdj must not be negative"],
    ["no oom kill", (b) => (b.HostConfig.OomKillDisable = true), "HostConfig.OomKillDisable must be unset"],
    ["a log driver", (b) => (b.HostConfig.LogConfig = { Type: "syslog", Config: { "syslog-address": "tcp://x:1" } }), "log driver"],
    ["a restart policy", (b) => (b.HostConfig.RestartPolicy = { Name: "always" }), "must not restart"],
    ["a published port", (b) => (b.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "80" }] }), "HostConfig.PortBindings must be unset"],
    ["an extra group", (b) => (b.HostConfig.GroupAdd = ["docker"]), "HostConfig.GroupAdd must be unset"],
    ["an annotation", (b) => (b.HostConfig.Annotations = { "io.x": "y" }), "HostConfig.Annotations must be unset"],
    ["a field this gateway does not know", (b) => (b.HostConfig.SomethingNew = "yes"), "HostConfig.SomethingNew must be unset"],
    ["a tag", (b) => (b.Image = "docker.io/stellar/stellar-cli:latest"), "Image must be pinned by sha256 digest"],
    ["stdin", (b) => (b.OpenStdin = true), "OpenStdin must be unset"],
    ["a tty", (b) => (b.Tty = true), "Tty must be unset"],
    ["an anonymous volume", (b) => (b.Volumes = { "/data": {} }), "Volumes must be unset"],
    ["unmasked /proc spelled in lower case", (b) => (b.HostConfig.maskedpaths = []), "HostConfig.maskedpaths must be spelled MaskedPaths"],
    ["writable /proc/sys spelled in lower case", (b) => (b.HostConfig.readonlypaths = []), "HostConfig.readonlypaths must be spelled ReadonlyPaths"],
    ["an empty user after the real one", (b) => (b.user = ""), "user repeats User in another case"],
    ["a second HostConfig in another case", (b) => (b.hostconfig = {}), "hostconfig must be spelled HostConfig"],
    ["a mount field in another case", (b) => (b.HostConfig.Mounts[0].bindoptions = {}), "bindoptions must be spelled BindOptions"],
    ["a restart policy spelled in lower case", (b) => (b.HostConfig.RestartPolicy = { name: "always" }), "must not restart"],
    ["a log driver spelled in lower case", (b) => (b.HostConfig.LogConfig = { type: "syslog" }), "log driver"],
    ["two tmpfs paths that differ only in case", (b) => (b.HostConfig.Tmpfs["/TMP"] = "rw"), "repeats HostConfig.Tmpfs./tmp in another case"],
    ["a limit too large to check exactly", (b) => (b.HostConfig.Memory = 2 ** 60), "too large to check exactly"],
    // JSON `1e400` parses to Infinity, and JSON.stringify forwards it as null: no limit at all.
    ["a memory limit that parses to Infinity", (b) => (b.HostConfig.Memory = Infinity), "HostConfig.Memory is not a finite number"],
    ["a cpu limit that parses to Infinity", (b) => (b.HostConfig.NanoCpus = Infinity), "HostConfig.NanoCpus is not a finite number"],
    ["a pid limit that parses to Infinity", (b) => (b.HostConfig.PidsLimit = Infinity), "HostConfig.PidsLimit is not a finite number"],
    // Go folds the long s (U+017F) onto s and the Kelvin sign (U+212A) onto k; JavaScript's toLowerCase does not.
    ["a second HostConfig spelled with a long s", (b) => (b["Ho\u017ftConfig"] = null), "is not a plain ASCII name"],
    ["an empty user spelled with a long s", (b) => (b["U\u017fer"] = ""), "is not a plain ASCII name"],
    ["unmasked /proc spelled with a long s", (b) => (b.HostConfig["Ma\u017fkedPaths"] = []), "is not a plain ASCII name"],
    ["a writable root spelled with a long s", (b) => (b.HostConfig["ReadonlyRootf\u017f"] = false), "is not a plain ASCII name"],
    ["no pid limit spelled with a long s", (b) => (b.HostConfig["Pid\u017fLimit"] = 0), "is not a plain ASCII name"],
    ["a network mode spelled with a Kelvin sign", (b) => (b.HostConfig["NetworkMode".replace("k", "\u212a")] = "host"), "is not a plain ASCII name"],
    ["a recursive bind spelled with a long s", (b) => (b.HostConfig.Mounts[0].BindOptions["NonRecur\u017five"] = false), "is not a plain ASCII name"],
  ])("refuses %s", (_name, edit, reason) => {
    const body = cliCreateBody();
    edit(body);
    const result = create(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(reason);
  });

  it("refuses the whole unconfined body the long s spells, and folds names as Go does", () => {
    const body = cliCreateBody();
    Object.assign(body, { "U\u017fer": "" });
    Object.assign(body.HostConfig, {
      "ReadonlyRootf\u017f": false,
      "\u017fecurityOpt": [],
      "Pid\u017fLimit": 0,
      "Ma\u017fkedPaths": [],
      "ReadonlyPath\u017f": [],
    });
    const result = create(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason.match(/is not a plain ASCII name/g)?.length).toBe(6);
    expect(goFold("Ho\u017ftConfig")).toBe(goFold("HostConfig"));
    expect(goFold("Networ\u212aMode")).toBe("networkmode");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a path outside every workspace", { Source: "/etc" }, "is not a directory of a live sandbox workspace"],
    ["a workspace's root", { Source: "/var/tmp/scvs-sandbox-abc123" }, "is not a directory of a live sandbox workspace"],
    ["a path below a leaf", { Source: `${VENDOR}/x` }, "is not a directory of a live sandbox workspace"],
    ["an unnormalised path", { Source: `${VENDOR}/../vendor` }, "absolute, normalised path"],
    ["the docker socket", { Source: "/var/run/docker.sock" }, "is not a directory of a live sandbox workspace"],
    ["a recursive bind", { BindOptions: {} }, "NonRecursive must be true"],
    ["a bind with no options", { BindOptions: undefined }, "BindOptions must set NonRecursive"],
    ["shared propagation", { BindOptions: { NonRecursive: true, Propagation: "rshared" } }, "Propagation must be one of"],
    ["a named volume", { Type: "volume" }, "Type must be one of"],
    ["a volume driver", { VolumeOptions: { DriverConfig: { Name: "local" } } }, "VolumeOptions must be unset"],
  ])("refuses a mount of %s", (_name, edit, reason) => {
    const body = cliCreateBody();
    Object.assign(body.HostConfig.Mounts[1], edit);
    const result = create(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(reason);
  });

  it("refuses a named container", () => {
    expect(create(cliCreateBody(), "/v1.44/containers/create?name=ecs-agent").ok).toBe(false);
  });

  it("refuses a body that is not an object", () => {
    expect(create(undefined).ok).toBe(false);
    expect(create([]).ok).toBe(false);
  });
});

describe("docker gateway: pulls", () => {
  it("pulls an image only by digest", () => {
    expect(checkPull(`/v1.44/images/create?fromImage=docker.io%2Fstellar%2Fstellar-cli&tag=sha256%3A${"a".repeat(64)}`).ok).toBe(true);
    expect(checkPull(`/v1.44/images/create?fromImage=docker.io%2Fstellar%2Fstellar-cli%40sha256%3A${"a".repeat(64)}`).ok).toBe(true);
    expect(checkPull("/v1.44/images/create?fromImage=docker.io%2Fstellar%2Fstellar-cli&tag=latest").ok).toBe(false);
    expect(checkPull("/v1.44/images/create?fromImage=docker.io%2Fstellar%2Fstellar-cli").ok).toBe(false);
  });

  it("never imports an image from a URL", () => {
    expect(checkPull(`/v1.44/images/create?fromSrc=http%3A%2F%2F169.254.169.254%2F&tag=sha256%3A${"a".repeat(64)}`).ok).toBe(false);
  });

  it("names the ECR registry a pull is from, and no other", () => {
    const digest = `sha256%3A${"a".repeat(64)}`;
    expect(checkPull(`/v1.44/images/create?fromImage=123456789012.dkr.ecr.ap-southeast-2.amazonaws.com%2Fsv-dev-composed-environments&tag=${digest}`)).toEqual({
      ok: true,
      ecrRegistry: { host: "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com", region: "ap-southeast-2" },
    });
    expect(checkPull(`/v1.44/images/create?fromImage=docker.io%2Fstellar%2Fstellar-cli&tag=${digest}`)).toEqual({ ok: true });
    expect(checkPull(`/v1.44/images/create?fromImage=123456789012.dkr.ecr.ap-southeast-2.amazonaws.com.evil.example%2Fx&tag=${digest}`)).toEqual({ ok: true });
  });

  it("encodes the registry auth as the daemon decodes it", () => {
    const encoded = encodeRegistryAuth({ username: "AWS", password: "p>?~".repeat(10), serveraddress: "r" });
    expect(encoded).not.toMatch(/[+/]/);
    expect(JSON.parse(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString())).toEqual({
      username: "AWS",
      password: "p>?~".repeat(10),
      serveraddress: "r",
    });
  });
});
