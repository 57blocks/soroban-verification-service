import { isNumber, isPlainObject, isString } from "es-toolkit";
import { formatBytes, formatValue } from "./format.util";

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  isPlainObject(value) ? (value as Record<string, unknown>) : undefined;

export const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(isString) : [];

const numberValue = (value: unknown): number | undefined =>
  isNumber(value) ? value : undefined;

export const getSandboxDiagnostics = (result?: Record<string, unknown>) =>
  objectValue(result?.sandbox_diagnostics);

export const getWasmCompare = (diagnostics?: Record<string, unknown>) =>
  objectValue(diagnostics?.wasm_compare);

export const diagnosticsText = (
  diagnostics: Record<string, unknown> | undefined,
  key: string,
) => (typeof diagnostics?.[key] === "string" ? diagnostics[key] : "");

const countLabel = (left?: number, right?: number) =>
  left === undefined && right === undefined
    ? "none"
    : `${left ?? "none"} vs ${right ?? "none"}`;

const sameDifferent = (same: boolean) => (same ? "Same" : "Different");

const setDiffStatus = (diff?: Record<string, unknown>) => {
  if (!diff) return "Unknown";
  const onlyDeployed = stringArray(diff.only_deployed);
  const onlyRebuilt = stringArray(diff.only_rebuilt);
  return onlyDeployed.length === 0 && onlyRebuilt.length === 0
    ? "Same"
    : "Different";
};

const commonPreview = (diff?: Record<string, unknown>) => {
  const common = stringArray(diff?.common);
  if (!common.length) return "none";
  return (
    common.slice(0, 5).join(", ") +
    (common.length > 5 ? `, +${common.length - 5} more` : "")
  );
};

export const wasmCompareSummaryEntries = (
  compare?: Record<string, unknown>,
) => {
  if (!compare) return [];
  const deployed = objectValue(compare.deployed);
  const rebuilt = objectValue(compare.rebuilt);
  const importDiff = objectValue(compare.import_diff);
  const exportDiff = objectValue(compare.export_diff);
  const customDiff = objectValue(compare.custom_section_diff);
  const sectionDiffs = Array.isArray(compare.section_diffs)
    ? (compare.section_diffs.filter(
        (item) => item && typeof item === "object",
      ) as Record<string, unknown>[])
    : [];
  const deployedSize = numberValue(deployed?.size_bytes);
  const rebuiltSize = numberValue(rebuilt?.size_bytes);
  const deployedFunctions = numberValue(deployed?.function_count);
  const rebuiltFunctions = numberValue(rebuilt?.function_count);
  const deployedCode = numberValue(deployed?.code_count);
  const rebuiltCode = numberValue(rebuilt?.code_count);

  return [
    {
      label: "Imports",
      value: setDiffStatus(importDiff),
      detail: commonPreview(importDiff),
    },
    {
      label: "Exports",
      value: setDiffStatus(exportDiff),
      detail: commonPreview(exportDiff),
    },
    {
      label: "Custom sections",
      value: setDiffStatus(customDiff),
      detail: commonPreview(customDiff),
    },
    {
      label: "Functions",
      value: sameDifferent(deployedFunctions === rebuiltFunctions),
      detail: countLabel(deployedFunctions, rebuiltFunctions),
    },
    {
      label: "Code bodies",
      value: sameDifferent(deployedCode === rebuiltCode),
      detail: countLabel(deployedCode, rebuiltCode),
    },
    {
      label: "Wasm size",
      value: sameDifferent(deployedSize === rebuiltSize),
      detail:
        deployedSize !== undefined || rebuiltSize !== undefined
          ? `${deployedSize !== undefined ? formatBytes(deployedSize) : "none"} vs ${
              rebuiltSize !== undefined ? formatBytes(rebuiltSize) : "none"
            }`
          : "none",
    },
    {
      label: "Section diffs",
      value: sectionDiffs.length ? `${sectionDiffs.length} changed` : "None",
      detail:
        sectionDiffs
          .slice(0, 3)
          .map((item) => {
            const key = typeof item.key === "string" ? item.key : "section";
            return `${key}: ${formatValue(item.deployed)} vs ${formatValue(item.rebuilt)}`;
          })
          .join("; ") || "none",
    },
  ];
};
