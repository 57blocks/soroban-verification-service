import { act, render, renderHook, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, test, vi } from "vitest";
import { SourceAccessCard } from "@/features/verification/components/SourceAccessCard";
import { useSourceArchive } from "@/features/verification/hooks/use-source-archive";
import { buildInlineManifest } from "@/features/verification/utils/manifest.util";
import { defaultValues } from "@/features/verification/constants";
import type {
  SourceAccessMode,
  VerifyFormValues,
} from "@/features/verification/types";

vi.mock("@scvs/verify-api-client", () => ({
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/http", () => ({
  errorMessage: (_error: unknown, fallback: string) => fallback,
}));

const Card = ({ mode }: { mode: SourceAccessMode }) => {
  const form = useForm<VerifyFormValues>({ defaultValues });
  return (
    <SourceAccessCard
      form={form}
      mode={mode}
      onModeChange={() => {}}
      archive={null}
      onSelectArchive={() => {}}
    />
  );
};

const publishCheckbox = () => screen.queryByRole("checkbox");

/**
 * The declaration was `public_uri`-only, because a "publish this publicly" checkbox under a mode called
 * "Private archive" read as a contradiction of the choice just made.
 */
describe("the publish declaration is offered on both source-access paths", () => {
  test("a public URI submission is asked whether to publish the source", () => {
    render(<Card mode="public_uri" />);

    expect(publishCheckbox()).toBeInTheDocument();
    expect(screen.getByText(/Publish this source publicly/)).toBeInTheDocument();
  });

  test("an uploaded archive is asked too", () => {
    render(<Card mode="upload_archive" />);

    expect(publishCheckbox()).toBeInTheDocument();
    expect(screen.getByText(/Publish this source publicly/)).toBeInTheDocument();
  });

  test("the box is unchecked by default on the upload path", () => {
    render(<Card mode="upload_archive" />);

    expect(publishCheckbox()).not.toBeChecked();
    expect(defaultValues.is_public).toBe(false);
  });

  test("the archive picker itself is untouched", () => {
    render(<Card mode="upload_archive" />);

    expect(screen.getByText("Select archive")).toBeInTheDocument();
    expect(screen.getByText("No archive selected")).toBeInTheDocument();
  });
});

/**
 * The checkbox is on both paths now, so the declaration stays on screen and carrying it across the switch
 * reports the submitter's own answer.
 */
describe("switching to an upload carries the declaration and drops the URI", () => {
  test("keeps is_public, clears source_uri", () => {
    const { result } = renderHook(() => {
      const form = useForm<VerifyFormValues>({ defaultValues });
      return { form, archive: useSourceArchive(form) };
    });

    act(() => {
      result.current.form.setValue("is_public", true);
      result.current.form.setValue("source_uri", "https://example.org/src.tar.gz");
    });

    act(() => {
      result.current.archive.selectMode("upload_archive");
    });

    expect(result.current.form.getValues("is_public")).toBe(true);
    expect(result.current.form.getValues("source_uri")).toBe("");

    // The submission the API has always accepted, now reachable from the console again: an uploaded archive
    // declared public.
    const manifest = buildInlineManifest(
      result.current.form.getValues(),
      { upload_id: "u-1", source_sha256: "a".repeat(64) },
      "upload_archive",
    );
    expect(manifest.is_public).toBe(true);
    expect(manifest.upload_id).toBe("u-1");
    expect(manifest.source_uri).toBeUndefined();
  });

  // `is_public` is *declared*, never omitted: the server reads absence as false too, but a manifest that states
  // the declaration is what was actually submitted.
  test("the field is still sent, not dropped", () => {
    const manifest = buildInlineManifest(
      { ...defaultValues, is_public: false },
      undefined,
      "upload_archive",
    );

    expect(Object.prototype.hasOwnProperty.call(manifest, "is_public")).toBe(true);
    expect(manifest.is_public).toBe(false);
  });
});
