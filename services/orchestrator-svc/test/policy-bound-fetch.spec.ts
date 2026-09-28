import {
  FetchPolicyError,
  ResponseTooLargeError,
  UpstreamNotDeliveredError,
  normalizePolicy,
} from "@scvs/core/fetch-policy";
import {
  fetchThroughDestinationPolicy,
  pinningLookup,
  type AddressResolver,
  type HopResponse,
} from "@scvs/core/policy-bound-fetch";

const POLICY = normalizePolicy({
  allowedSchemes: ["https:"],
  blockPrivateRanges: true,
  maxResponseBytes: 1024,
  timeoutMs: 5_000,
});

function redirectTo(location: string | undefined, status = 302): HopResponse {
  return { statusCode: status, headers: location ? { location } : {}, destroy: () => undefined };
}

function bodyOf(body: string, status = 200): HopResponse {
  const handlers = new Map<string, ((chunk?: unknown) => void)[]>();
  const response = {
    statusCode: status,
    headers: {} as Record<string, string>,
    destroy: () => undefined,
    on(event: string, handler: (chunk?: unknown) => void) {
      const existing = handlers.get(event) ?? [];
      handlers.set(event, [...existing, handler]);
      // Emit once both `data` and `end` are subscribed, matching the order `readBounded` attaches them.
      if (event === "end") {
        setImmediate(() => {
          for (const onData of handlers.get("data") ?? []) onData(Buffer.from(body));
          for (const onEnd of handlers.get("end") ?? []) onEnd();
        });
      }
      return response;
    },
  };
  return response as unknown as HopResponse;
}

function recordingRequester(hops: HopResponse[]) {
  const requested: string[] = [];
  const requestImpl = async (url: URL): Promise<HopResponse> => {
    requested.push(url.toString());
    const next = hops[requested.length - 1];
    if (!next) throw new Error(`test double had no reply scripted for hop ${requested.length}`);
    return next;
  };
  return { requested, requestImpl };
}

describe("fetchThroughDestinationPolicy — redirect handling", () => {
  it("refuses a redirect to the cloud metadata endpoint, and never requests it", async () => {
    const { requested, requestImpl } = recordingRequester([
      redirectTo("http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
    ]);

    await expect(
      fetchThroughDestinationPolicy("https://source.example.com/archive.tar.gz", {
        policy: POLICY,
        maxRedirects: 5,
        requestImpl,
      }),
    ).rejects.toBeInstanceOf(FetchPolicyError);

    expect(requested).toEqual(["https://source.example.com/archive.tar.gz"]);
    expect(requested.join(" ")).not.toContain("169.254.169.254");
  });

  it("refuses an RFC1918 literal before opening any connection at all", async () => {
    const { requested, requestImpl } = recordingRequester([bodyOf("never reached")]);

    for (const url of [
      "https://10.0.0.1/archive.tar.gz",
      "https://192.168.1.1/archive.tar.gz",
      "https://172.16.0.1/archive.tar.gz",
      "https://127.0.0.1/archive.tar.gz",
      "https://[::1]/archive.tar.gz",
      "https://[::ffff:169.254.169.254]/archive.tar.gz",
    ]) {
      await expect(
        fetchThroughDestinationPolicy(url, { policy: POLICY, maxRedirects: 5, requestImpl }),
      ).rejects.toBeInstanceOf(FetchPolicyError);
    }
    expect(requested).toEqual([]);
  });

  it("re-validates every hop, not only the last one", async () => {
    const { requested, requestImpl } = recordingRequester([
      redirectTo("https://169.254.169.254/latest/meta-data/"),
      bodyOf("would have looked like a clean public final hop"),
    ]);

    await expect(
      fetchThroughDestinationPolicy("https://source.example.com/a.tar.gz", {
        policy: POLICY,
        maxRedirects: 5,
        requestImpl,
      }),
    ).rejects.toBeInstanceOf(FetchPolicyError);
    expect(requested).toEqual(["https://source.example.com/a.tar.gz"]);
  });

  it("follows a legitimate public redirect and returns the body", async () => {
    const { requested, requestImpl } = recordingRequester([
      redirectTo("https://codeload.github.com/o/r/tar.gz/refs/tags/v1"),
      bodyOf("archive-bytes"),
    ]);

    const fetched = await fetchThroughDestinationPolicy(
      "https://github.com/o/r/archive/refs/tags/v1.tar.gz",
      { policy: POLICY, maxRedirects: 5, requestImpl },
    );

    expect(Buffer.from(fetched.bytes).toString()).toBe("archive-bytes");
    expect(fetched.finalUrl).toBe("https://codeload.github.com/o/r/tar.gz/refs/tags/v1");
    expect(requested).toEqual([
      "https://github.com/o/r/archive/refs/tags/v1.tar.gz",
      "https://codeload.github.com/o/r/tar.gz/refs/tags/v1",
    ]);
  });

  it("resolves a relative Location against the current hop", async () => {
    const { requested, requestImpl } = recordingRequester([redirectTo("/elsewhere.tar.gz"), bodyOf("ok")]);

    await fetchThroughDestinationPolicy("https://source.example.com/deep/a.tar.gz", {
      policy: POLICY,
      maxRedirects: 5,
      requestImpl,
    });

    expect(requested[1]).toBe("https://source.example.com/elsewhere.tar.gz");
  });

  it("refuses an exhausted redirect budget rather than looping", async () => {
    const { requested, requestImpl } = recordingRequester(
      Array.from({ length: 10 }, (_, index) => redirectTo(`https://source.example.com/hop-${index + 1}`)),
    );

    await expect(
      fetchThroughDestinationPolicy("https://source.example.com/hop-0", {
        policy: POLICY,
        maxRedirects: 3,
        requestImpl,
      }),
    ).rejects.toBeInstanceOf(FetchPolicyError);
    expect(requested).toHaveLength(4);
  });

  it("does not treat a 3xx with no Location as a body, or as a refusal", async () => {
    const { requestImpl } = recordingRequester([redirectTo(undefined)]);
    await expect(
      fetchThroughDestinationPolicy("https://source.example.com/a.tar.gz", {
        policy: POLICY,
        maxRedirects: 5,
        requestImpl,
      }),
    ).rejects.toBeInstanceOf(UpstreamNotDeliveredError);
  });

  it("reports a non-2xx as a peer that did not deliver, never as a refusal", async () => {
    const { requestImpl } = recordingRequester([bodyOf("not found", 404)]);

    const error = await fetchThroughDestinationPolicy("https://source.example.com/a.tar.gz", {
      policy: POLICY,
      maxRedirects: 5,
      requestImpl,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UpstreamNotDeliveredError);
    expect(error).not.toBeInstanceOf(FetchPolicyError);
  });

  it("reports an exhausted chain deadline as a peer that did not deliver", async () => {
    const impatient = normalizePolicy({ ...POLICY, timeoutMs: 5 });
    const slowHop = async (): Promise<HopResponse> => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return redirectTo("https://source.example.com/next.tar.gz");
    };

    await expect(
      fetchThroughDestinationPolicy("https://source.example.com/a.tar.gz", {
        policy: impatient,
        maxRedirects: 5,
        requestImpl: slowHop,
      }),
    ).rejects.toBeInstanceOf(UpstreamNotDeliveredError);
  });

  it("refuses http:, which the guard this replaced accepted", async () => {
    const { requested, requestImpl } = recordingRequester([bodyOf("never reached")]);
    await expect(
      fetchThroughDestinationPolicy("http://source.example.com/a.tar.gz", {
        policy: POLICY,
        maxRedirects: 5,
        requestImpl,
      }),
    ).rejects.toBeInstanceOf(FetchPolicyError);
    expect(requested).toEqual([]);
  });

  it("stops reading a body that exceeds the cap", async () => {
    const { requestImpl } = recordingRequester([bodyOf("x".repeat(2048))]);
    await expect(
      fetchThroughDestinationPolicy("https://source.example.com/a.tar.gz", {
        policy: POLICY,
        maxRedirects: 5,
        requestImpl,
      }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe("pinningLookup — the DNS-rebinding answer", () => {
  const resolverReturning = (addresses: { address: string; family: number }[]): AddressResolver => {
    return (_hostname, _options, callback) => callback(null, addresses);
  };

  function invoke(lookup: ReturnType<typeof pinningLookup>, options: Record<string, unknown> = {}) {
    return new Promise<{ error: Error | null; args: unknown[] }>((resolve) => {
      (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
        "source.example.com",
        options,
        (...args: unknown[]) => resolve({ error: (args[0] as Error) ?? null, args }),
      );
    });
  }

  it("refuses when ANY resolved address is in a blocked range, not just when all of them are", async () => {
    const lookup = pinningLookup(
      POLICY,
      resolverReturning([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    );
    const { error } = await invoke(lookup);
    expect(error).toBeInstanceOf(FetchPolicyError);
    expect(String(error?.message)).toContain("169.254.169.254");
  });

  it("refuses each private range a rebind would aim at", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "100.64.0.1"]) {
      const { error } = await invoke(pinningLookup(POLICY, resolverReturning([{ address, family: 4 }])));
      expect(error).toBeInstanceOf(FetchPolicyError);
    }
    for (const address of ["::1", "fd00::1", "fe80::1"]) {
      const { error } = await invoke(pinningLookup(POLICY, resolverReturning([{ address, family: 6 }])));
      expect(error).toBeInstanceOf(FetchPolicyError);
    }
  });

  it("hands back exactly the addresses it validated — the pin", async () => {
    const addresses = [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ];
    const { error, args } = await invoke(pinningLookup(POLICY, resolverReturning(addresses)), { all: true });
    expect(error).toBeNull();
    expect(args[1]).toEqual(addresses);
  });

  it("resolves once per call, so there is no second lookup to rebind", async () => {
    let calls = 0;
    const counting: AddressResolver = (_hostname, _options, callback) => {
      calls += 1;
      callback(null, [{ address: calls === 1 ? "93.184.216.34" : "169.254.169.254", family: 4 }]);
    };
    const { error } = await invoke(pinningLookup(POLICY, counting));
    expect(error).toBeNull();
    expect(calls).toBe(1);
  });

  it("returns a single address when the caller did not ask for all", async () => {
    const { error, args } = await invoke(
      pinningLookup(POLICY, resolverReturning([{ address: "93.184.216.34", family: 4 }])),
    );
    expect(error).toBeNull();
    expect(args[1]).toBe("93.184.216.34");
    expect(args[2]).toBe(4);
  });

  it("reports a name that resolves to nothing as not delivered, rather than as a refusal", async () => {
    const { error } = await invoke(pinningLookup(POLICY, resolverReturning([])));
    expect(error).toBeInstanceOf(UpstreamNotDeliveredError);
    expect(error).not.toBeInstanceOf(FetchPolicyError);
  });

  it("propagates a resolver failure unchanged", async () => {
    const failing: AddressResolver = (_h, _o, callback) => callback(new Error("ENOTFOUND"));
    const { error } = await invoke(pinningLookup(POLICY, failing));
    expect(String(error?.message)).toContain("ENOTFOUND");
  });
});
