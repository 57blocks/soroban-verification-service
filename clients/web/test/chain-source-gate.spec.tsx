import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describe, expect, test, vi } from "vitest";
import { useSourceArchive } from "@/features/verification/hooks/use-source-archive";
import { defaultValues } from "@/features/verification/constants";
import {
  chainSourceMismatchMessage,
  chainSourceRefusal,
} from "@/features/verification/utils/source-archive.util";
import { fileToSha256 } from "@/features/verification/utils/format.util";
import type { VerifyFormValues } from "@/features/verification/types";

vi.mock("@scvs/verify-api-client", async () => ({
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
  jobEventsPath: (await vi.importActual<typeof import("@scvs/verify-api-client")>("@scvs/verify-api-client"))
    .jobEventsPath,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/http", () => ({
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));

const CHAIN = "a".repeat(64);

describe("chainSourceRefusal", () => {
  test("refuses an archive that hashes to something the chain does not record", () => {
    const refusal = chainSourceRefusal(CHAIN, "b".repeat(64));
    expect(refusal).toContain(CHAIN);
    expect(refusal).toContain("b".repeat(64));
  });

  test("admits the archive the chain records, whatever the hex case", () => {
    expect(chainSourceRefusal(CHAIN, CHAIN)).toBeNull();
    expect(chainSourceRefusal(CHAIN.toUpperCase(), CHAIN)).toBeNull();
    expect(chainSourceRefusal(CHAIN, CHAIN.toUpperCase())).toBeNull();
  });

  test("stays silent when there is nothing to compare against", () => {
    expect(chainSourceRefusal(undefined, "b".repeat(64))).toBeNull();
    expect(chainSourceRefusal("", "b".repeat(64))).toBeNull();
    expect(chainSourceRefusal(CHAIN, "")).toBeNull();
  });
});

const serverRule = () =>
  readFileSync(
    resolve(process.cwd(), "../../services/verification-svc/src/modules/preflight/manifest.ts"),
    "utf8",
  )
    .replace(/["`]\s*\+\s*["`]/g, "")
    .replace(/\s+/g, " ");

describe("the refusal says what verification-svc says", () => {
  test("both sides carry the same guidance", () => {
    const server = serverRule();
    const browser = chainSourceMismatchMessage(CHAIN, "b".repeat(64));

    for (const phrase of [
      "hashes to",
      "records source_sha256=",
      "on chain",
    ]) {
      expect(server, `verification-svc no longer says: ${phrase}`).toContain(phrase);
      expect(browser, `the browser no longer says: ${phrase}`).toContain(phrase);
    }
  });

  test("both sides answer under one error code", () => {
    expect(serverRule()).toContain("source_archive_not_chain_recorded");
  });
});

const pick = async (chainSourceSha256: string | undefined, bytes: number[]) => {
  const { result } = renderHook(() => {
    const form = useForm<VerifyFormValues>({ defaultValues });
    return { form, archive: useSourceArchive(form, chainSourceSha256) };
  });

  await act(async () => {
    await result.current.archive.onSelectArchive(
      new File([new Uint8Array(bytes)], "counter.tar.gz"),
    );
  });

  return result;
};

const GZIP_BYTES = [0x1f, 0x8b, 0x08, 0x00];

describe("picking an archive the chain does not record", () => {
  test("is refused at the picker, with both hashes named", async () => {
    vi.mocked(toast.error).mockClear();
    const result = await pick(CHAIN, GZIP_BYTES);

    expect(result.current.archive.archive).toBeNull();
    expect(result.current.form.getValues("source_sha256")).toBe("");
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain(CHAIN);
  });

  test("is accepted when it is the archive the chain records", async () => {
    vi.mocked(toast.error).mockClear();
    const actual = await fileToSha256(new File([new Uint8Array(GZIP_BYTES)], "counter.tar.gz"));

    const result = await pick(actual, GZIP_BYTES);

    expect(result.current.archive.archive?.sha256).toBe(actual);
    expect(result.current.form.getValues("source_sha256")).toBe(actual);
    expect(toast.error).not.toHaveBeenCalled();
  });

  test("is accepted when the contract records no hash to compare against", async () => {
    vi.mocked(toast.error).mockClear();
    const result = await pick(undefined, GZIP_BYTES);

    expect(result.current.archive.archive).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
