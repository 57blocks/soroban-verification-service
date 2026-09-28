import type { UseFormReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { fieldCopy } from "../constants";
import type { VerifyFormValues } from "../types";
import { sourceSha256Refusal } from "../utils/evidence-rules.util";
import { FieldShell } from "./FieldShell";

export const EvidenceFields = ({
  form,
}: {
  form: UseFormReturn<VerifyFormValues>;
}) => {
  const { errors } = form.formState;

  return (
    <div className="mb-6 grid gap-5 rounded-lg bg-surface-alt p-5">
      <FieldShell
        label={fieldCopy.source_sha256.label}
        hint={fieldCopy.source_sha256.hint}
        help={fieldCopy.source_sha256.description}
        error={errors.source_sha256?.message}
        required
        htmlFor="source_sha256"
      >
        <Input
          id="source_sha256"
          className="font-mono text-[0.85rem]"
          placeholder="28a14827..."
          {...form.register("source_sha256", {
            validate: (value) => sourceSha256Refusal(value) ?? true,
          })}
        />
      </FieldShell>

      <FieldShell
        label={fieldCopy.bldarg.label}
        hint={fieldCopy.bldarg.hint}
        help={fieldCopy.bldarg.description}
        htmlFor="bldarg"
      >
        <Input
          id="bldarg"
          className="font-mono text-[0.85rem]"
          placeholder="contract build"
          {...form.register("bldarg")}
        />
      </FieldShell>

      <FieldShell
        label={fieldCopy.bldopt.label}
        hint={fieldCopy.bldopt.hint}
        help={fieldCopy.bldopt.description}
        htmlFor="bldopt"
      >
        <Input
          id="bldopt"
          className="font-mono text-[0.85rem]"
          placeholder="--locked"
          {...form.register("bldopt")}
        />
      </FieldShell>
    </div>
  );
};
