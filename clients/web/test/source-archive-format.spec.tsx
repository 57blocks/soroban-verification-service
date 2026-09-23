import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describe, expect, test, vi } from "vitest";
import { useSourceArchive } from "@/features/verification/hooks/use-source-archive";
import { sourceArchiveAccept, defaultValues } from "@/features/verification/constants";
import {
  archiveFormatRefusal,
  sniffArchiveFormat,
} from "@/features/verification/utils/source-archive.util";
import type { VerifyFormValues } from "@/features/verification/types";

vi.mock("@scvs/verify-api-client", async () => ({
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
  // The real path, not a fake one: a spec that invented its own would pass against its own copy.
  jobEventsPath: (await vi.importActual<typeof import("@scvs/verify-api-client")>("@scvs/verify-api-client"))
    .jobEventsPath,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/http", () => ({
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));

const GZIP = [0x1f, 0x8b, 0x08, 0x00];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** `ustar` at offset 257 is the whole marker; the 257 bytes before it are a tar header's other fields. */
const TAR = [...Array(257).fill(0), 0x75, 0x73, 0x74, 0x61, 0x72];
const TEXT = [...Buffer.from("not an archive at all")];

const select = async (name: string, bytes: number[]) => {
  const { result } = renderHook(() => {
    const form = useForm<VerifyFormValues>({ defaultValues });
    return { form, archive: useSourceArchive(form) };
  });

  await act(async () => {
    await result.current.archive.onSelectArchive(new File([new Uint8Array(bytes)], name));
  });

  return result;
};

/**
 * The picker judges the bytes, never the name — the rule `POST /v1/uploads/source` applies. A name rule here
 * was strictly narrower than the endpoint it guards, and refused archives the API accepts.
 */
describe("the archive picker reads the magic number", () => {
  test.each([
    ["a gzip tarball", GZIP, "gzip"],
    ["a zip", ZIP, "zip"],
    ["a bare tar", TAR, "tar"],
    ["anything else", TEXT, "unknown"],
  ] as const)("%s", (_label, bytes, format) => {
    expect(sniffArchiveFormat(new Uint8Array(bytes))).toBe(format);
  });

  test("admits exactly the two formats the endpoint admits", () => {
    expect(archiveFormatRefusal(new Uint8Array(GZIP))).toBeNull();
    expect(archiveFormatRefusal(new Uint8Array(ZIP))).toBeNull();
    // Still refused, and not by omission: verification-svc's `uploadArchiveFormat` refuses a bare tar too.
    expect(archiveFormatRefusal(new Uint8Array(TAR))).toMatch(/uncompressed tar/);
    expect(archiveFormatRefusal(new Uint8Array(TEXT))).toMatch(/gzip-compressed tarball or a zip/);
  });

  test("the browser and the endpoint agree on which bytes are an archive", () => {
    // The web bundle does not depend on `@scvs/core`, so the copy is pinned against its original.
    const core = readFileSync(
      resolve(process.cwd(), "../../packages/core/src/archive-format.ts"),
      "utf8",
    );
    for (const marker of ["0x1f", "0x8b", "0x50", "0x4b", "0x0304", "0x0506", "0x0708", '"ustar"']) {
      expect(core, `packages/core no longer tests for ${marker}`).toContain(marker);
    }
  });
});

describe("what the picker does with the file it is handed", () => {
  test.each([
    // The name a browser gives a tarball downloaded twice: the counter lands before the last extension, so a
    // `.tar.gz` suffix rule refused it. It is a gzip archive and the endpoint takes it.
    "reflector-contract-6.0.1_reflector-pulse-contract_cli27.0.0.tar(2).gz",
    "counter.tar.gz",
    "counter.tgz",
    "counter",
  ])("hashes and holds %s, because its bytes are gzip", async (name) => {
    const result = await select(name, GZIP);

    expect(result.current.archive.archive?.name).toBe(name);
    expect(result.current.form.getValues("source_sha256")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses an archive-named file that is not one, and says the bytes are what was read", async () => {
    vi.mocked(toast.error).mockClear();
    const result = await select("counter.tar.gz", TEXT);

    expect(result.current.archive.archive).toBeNull();
    expect(result.current.form.getValues("source_sha256")).toBe("");
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining("not its name"));
  });

  test("tells a submitter holding a bare tar what to do with it", async () => {
    vi.mocked(toast.error).mockClear();
    await select("counter.tar", TAR);

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining("gzip"));
  });
});

describe("the picker's accept list", () => {
  test("offers `.gz` beside `.tar.gz`, or the OS greys out the name a re-download produces", () => {
    const suffixes = sourceArchiveAccept.split(",").filter((entry) => entry.startsWith("."));
    expect(suffixes).toEqual([".tar.gz", ".tgz", ".gz", ".zip"]);
  });
});
