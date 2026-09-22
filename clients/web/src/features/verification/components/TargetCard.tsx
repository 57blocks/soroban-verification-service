import { Controller, type UseFormReturn } from "react-hook-form";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TargetType, VerifyFormValues } from "../types";
import { FieldShell } from "./FieldShell";
import { SegmentedChoice } from "./SegmentedChoice";
import { SubmissionAgreement } from "./SubmissionAgreement";

type TargetCardProps = {
  form: UseFormReturn<VerifyFormValues>;
  targetType: TargetType;
  onTargetTypeChange: (value: TargetType) => void;
  isSubmitting: boolean;
  onSubmit: () => void;
};

const contractIdRule = {
  validate: (value?: string) => {
    if (!value?.trim()) return "Enter the contract ID to verify";
    return /^C[A-Z2-7]{55}$/.test(value.trim())
      ? true
      : "Use a valid Soroban contract ID";
  },
};

const wasmHashRule = {
  validate: (value?: string) => {
    if (!value?.trim()) return "Enter the deployed Wasm hash";
    return /^[a-fA-F0-9]{64}$/.test(value.trim())
      ? true
      : "Use a 64-character hex Wasm hash";
  },
};

/** Step one: which deployed contract or Wasm hash to verify. */
export const TargetCard = ({
  form,
  targetType,
  onTargetTypeChange,
  isSubmitting,
  onSubmit,
}: TargetCardProps) => {
  const { errors } = form.formState;
  const isContractId = targetType === "contract_id";

  return (
    <section className="rounded-xl border border-line bg-surface shadow-panel">
      <div className="p-6">
        <div className="mb-6">
          <h2 className="m-0 text-[1.35rem] font-semibold">
            Contract to verify
          </h2>
          <p className="m-0 mt-1 text-[0.875rem] leading-[1.5] text-ink/[0.66]">
            Checked against chain metadata first — nothing is submitted until we
            know this contract can be verified.
          </p>
        </div>

        {/* The fields sit on the card. Tinting a block inside a white panel gave the form a second surface
            to read past before reaching the first input. */}
        <div className="grid gap-4 md:grid-cols-2">
          <FieldShell label="Network" htmlFor="network">
            <Controller
              control={form.control}
              name="network"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="network">
                    <SelectValue placeholder="Testnet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="testnet">Testnet</SelectItem>
                    <SelectItem value="mainnet">Mainnet</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </FieldShell>

          <FieldShell label="Lookup by">
            <SegmentedChoice
              selected={targetType}
              onSelect={onTargetTypeChange}
              options={[
                { value: "contract_id", label: "Contract ID" },
                { value: "wasm_hash", label: "Wasm hash" },
              ]}
            />
          </FieldShell>
        </div>

        <div className="mt-4">
          {isContractId ? (
            <FieldShell
              label="Contract ID"
              htmlFor="contractId"
              error={errors.contractId?.message}
            >
              <Input
                id="contractId"
                className="font-mono text-[0.85rem]"
                placeholder="CC3WUA4OKWZFEVD6PND6A4FESMZZLNCV6ENVHEXRJ2BABDLYMJJM77QF"
                {...form.register("contractId", contractIdRule)}
              />
            </FieldShell>
          ) : (
            <FieldShell
              label="Wasm hash"
              htmlFor="wasmHash"
              error={errors.wasmHash?.message}
            >
              <Input
                id="wasmHash"
                className="font-mono text-[0.85rem]"
                placeholder="4f16d0cdfbd698c43e3613faa8186aae3ea0cd4231298802d7ac58864e1f8839"
                {...form.register("wasmHash", wasmHashRule)}
              />
            </FieldShell>
          )}
        </div>

        {/* The action sits immediately after the field it acts on, not in the card
            header. The header button read as a page-level action — reviewers reached it before
            they had typed the identifier it needs, and its distance from the input is what made
            the ordering unclear. The consent line is here for the same reason: beside the control
            it qualifies, not as grey type under the heading. */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-4">
          <SubmissionAgreement className="max-w-[68ch] flex-1" />
          <Button
            type="button"
            onClick={onSubmit}
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            Check this contract
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            )}
          </Button>
        </div>
      </div>
    </section>
  );
};
