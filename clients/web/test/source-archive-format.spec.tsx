import { act, renderHook } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describe, expect, test, vi } from "vitest";
import { useSourceArchive } from "@/features/verification/hooks/use-source-archive";
import { sourceArchiveAccept, defaultValues } from "@/features/verification/constants";
import { isAcceptedSourceArchiveName } from "@/features/verification/utils/source-archive.util";
import type { VerifyFormValues } from "@/features/verification/types";

vi.mock("@scvs/verify-api-client", () => ({
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/http", () => ({
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));

const select = async (name: string) => {
  const { result } = renderHook(() => {
    const form = useForm<VerifyFormValues>({ defaultValues });
    return { form, archive: useSourceArchive(form) };
  });

  await act(async () => {
    await result.current.archive.onSelectArchive(
      new File([new Uint8Array([0x1f, 0x8b, 0x08, 0x00])], name),
    );
  });

  return result;
};

/**
 * The picker's `accept` attribute filters, it does not decide — "All Files" is one click away — so the same
 * rule is applied to whatever comes back.
 */
describe("the archive picker takes gzip tarballs and zips", () => {
  test("the accept list offers exactly the three names the door admits", () => {
    expect(
      sourceArchiveAccept.split(",").filter((entry) => entry.startsWith(".")),
    ).toEqual([".tar.gz", ".tgz", ".zip"]);
  });

  test.each([
    [".tar.gz", "counter.tar.gz", true],
    [".tgz", "counter.tgz", true],
    ["uppercase", "COUNTER.TAR.GZ", true],
    // The endpoint judges the bytes; a name is all the browser can judge.
    [".zip", "counter.zip", true],
    ["a recompressed archive", "counter.tar.gz.zip", true],
    // Still refused, and not by omission: a bare tar has no name `stellar contract verify` accepts.
    ["a bare .tar", "counter.tar", false],
    ["no extension", "counter", false],
  ])("%s: accepted = %s", (_label, name, accepted) => {
    expect(isAcceptedSourceArchiveName(name)).toBe(accepted);
  });

  test("a refused file is not held, and says what to send", async () => {
    const result = await select("counter.tar");

    expect(result.current.archive.archive).toBeNull();
    expect(result.current.form.getValues("source_sha256")).toBe("");
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining(".tar.gz"),
    );
  });

  test("a zipped archive is hashed and held", async () => {
    const result = await select("counter.tar.gz.zip");

    expect(result.current.archive.archive?.name).toBe("counter.tar.gz.zip");
    // The hash is of the file the submitter picked — the container.
    expect(result.current.form.getValues("source_sha256")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an accepted file is hashed and held", async () => {
    const result = await select("counter.tar.gz");

    expect(result.current.archive.archive?.name).toBe("counter.tar.gz");
    expect(result.current.form.getValues("source_sha256")).toMatch(/^[0-9a-f]{64}$/);
  });
});
