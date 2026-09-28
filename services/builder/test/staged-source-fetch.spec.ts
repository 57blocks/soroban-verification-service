import { materializeSource } from "../src/modules/builder/fetch-source.js";

const PRESIGNED_QUERY = "X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAEXAMPLE%2F20260902%2Fap-southeast-2%2Fs3%2Faws4_request";

function ref(source_uri: string) {
  return {
    sourceRef: { type: "source_uri", visibility: "public", source_uri, source_sha256: "a".repeat(64) },
  } as never;
}

describe("the sandbox fetches only a presigned staging URL", () => {
  it.each([
    ["a plain https host the submitter could have named", "https://evil.example.com/source.tar.gz"],
    ["an http URL", `http://sv-dev-scratch.s3.amazonaws.com/staging/x/build/fetched-source?${PRESIGNED_QUERY}`],
    ["a URL with no SigV4 parameters", "https://sv-dev-scratch.s3.amazonaws.com/staging/x/build/fetched-source"],
    ["a signature without a credential", "https://sv-dev-scratch.s3.amazonaws.com/x?X-Amz-Signature=deadbeef"],
  ])("refuses %s", async (_label, uri) => {
    const result = await materializeSource(ref(uri));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("source_unavailable");
      expect(result.reason).toBe("source_uri_refused");
    }
  });

  it("refuses a presigned-looking URL aimed at a private address", async () => {
    const result = await materializeSource(ref(`https://10.0.0.5/staging/x/build/fetched-source?${PRESIGNED_QUERY}`));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_uri_refused");
  });

  it("refuses the cloud metadata endpoint however it is dressed up", async () => {
    const result = await materializeSource(ref(`https://169.254.169.254/latest/meta-data/?${PRESIGNED_QUERY}`));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_uri_refused");
  });

  it("attempts a well-formed presigned URL rather than refusing it", async () => {
    const result = await materializeSource(
      ref(`https://sv-dev-scratch.s3.ap-southeast-2.invalid/staging/rb/build/fetched-source?${PRESIGNED_QUERY}`),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_uri_not_materialized");
  });
});
