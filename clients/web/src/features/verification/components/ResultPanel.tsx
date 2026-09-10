import type { ReactNode } from "react";
import { ExternalLink, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubmissionState } from "../types";
import {
  getSandboxDiagnostics,
  getWasmCompare,
  stringArray,
} from "../utils/diagnostics.util";
import { formatValue } from "../utils/format.util";
import { wasmStatusUrlFromReportUrl } from "../utils/rebuild-provenance.util";
import {
  resultLabel,
  resultSummaryEntries,
  troubleshootingMessage,
} from "../utils/result.util";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { MetaTile } from "./MetaTile";
import { MutedLabel } from "./MutedLabel";
import { WasmCompareGrid } from "./WasmCompareGrid";

const AdviceBox = ({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) => (
  <div className={cn("rounded-md bg-surface-alt p-3", className)}>
    <div className="flex items-start gap-2">
      <Wrench size={14} className="mt-0.5 shrink-0 text-ink-value" />
      <div className="min-w-0">
        <div className="text-[0.7rem] font-semibold uppercase tracking-[0.05em] text-ink-label">
          {title}
        </div>
        {children}
      </div>
    </div>
  </div>
);

const ArtifactLink = ({
  label,
  url,
  note,
}: {
  label: string;
  url: string;
  note?: string;
}) => (
  <div className="rounded-md bg-surface-alt p-3">
    <MutedLabel>{label}</MutedLabel>
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-1 inline-flex max-w-full items-start gap-1.5 break-all font-mono text-[0.8rem] text-ink underline decoration-ink/25 underline-offset-[3px] transition-colors hover:decoration-ink"
    >
      {url}
      <ExternalLink size={12} aria-hidden className="mt-0.5 shrink-0" />
    </a>
    {note && (
      <p className="m-0 mt-1.5 text-[0.75rem] leading-[1.5] text-ink/[0.66]">
        {note}
      </p>
    )}
  </div>
);

/** The two documents a verification publishes. */
const PublishedResults = ({
  reportUrl,
  reportSha256,
  wasmStatusUrl,
}: {
  reportUrl?: string;
  reportSha256?: string;
  wasmStatusUrl?: string;
}) => {
  if (!reportUrl && !reportSha256 && !wasmStatusUrl) return null;

  return (
    <div data-testid="published-results" className="grid gap-3">
      {reportUrl ? (
        <ArtifactLink
          label="Verification report"
          url={reportUrl}
          {...(reportSha256
            ? {
                note: `SHA-256 ${reportSha256} — the report's integrity digest, and its filename. Fetch the URL and hash it to confirm you have the same bytes.`,
              }
            : {})}
        />
      ) : (
        <div className="rounded-md bg-surface-alt p-3">
          <MutedLabel>Verification report</MutedLabel>
          <div className="mt-1 text-[0.875rem] text-ink-warm">
            Not published.
          </div>
        </div>
      )}

      {wasmStatusUrl && (
        <ArtifactLink
          label="Wasm status object"
          url={wasmStatusUrl}
          note="Every verification of this Wasm hash, and the permanent copies of each."
        />
      )}
    </div>
  );
};

type ResultPanelProps = {
  state: SubmissionState;
  result: Record<string, unknown>;
};

/** The published verification result: why it failed, how to act on it, and the report it produced. */
export const ResultPanel = ({ state, result }: ResultPanelProps) => {
  const reason = "reason" in result ? formatValue(result.reason) : "";
  const detail = "detail" in result ? formatValue(result.detail) : "";
  const diagnostics = getSandboxDiagnostics(result);
  const wasmCompare = getWasmCompare(diagnostics);
  const likelyCauses = stringArray(diagnostics?.likely_causes);
  const troubleshooting = troubleshootingMessage(state, result);
  // The verifier's own `likely_causes` are more specific than our static advice — prefer them.
  const showTroubleshooting = Boolean(troubleshooting && !likelyCauses.length);
  const summary = resultSummaryEntries(result);
  const artifactUrl =
    typeof result.artifact_url === "string" ? result.artifact_url : undefined;
  const artifactSha =
    typeof result.artifact_sha256 === "string"
      ? result.artifact_sha256
      : undefined;
  const wasmStatusUrl = wasmStatusUrlFromReportUrl(
    artifactUrl,
    typeof result.wasm_hash === "string" ? result.wasm_hash : undefined
  );
  // A verified job's diagnostics are the verifier's own configuration; a failed job's are the evidence.
  const isSettledFailure = state !== "verified" && state !== "queued";

  return (
    <section
      data-testid="verification-result"
      className="rounded-lg bg-surface p-6 shadow-panel"
    >
      <h2 className="m-0 mb-4 font-display text-[1.35rem] font-semibold">
        Verification result
      </h2>

      {(reason || detail) && (
        <div className="mb-4 rounded-md bg-warning-surface p-3">
          {reason && (
            <div className="text-[0.7rem] font-semibold uppercase tracking-[0.05em] text-warning-fg">
              {reason}
            </div>
          )}
          {detail && (
            <pre className="m-0 mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-warning-ink">
              {detail}
            </pre>
          )}
        </div>
      )}

      {showTroubleshooting && (
        <AdviceBox title="Troubleshooting" className="mb-4">
          <p className="m-0 mt-1 text-[0.875rem] leading-[1.5] text-ink-value">
            {troubleshooting}
          </p>
        </AdviceBox>
      )}

      {/* The published documents first: a reader who has just been told the verdict wants what it
          was published as, before the fields the comparison produced. */}
      <PublishedResults
        {...(artifactUrl ? { reportUrl: artifactUrl } : {})}
        {...(artifactSha ? { reportSha256: artifactSha } : {})}
        {...(wasmStatusUrl ? { wasmStatusUrl } : {})}
      />

      {summary.length > 0 && (
        <div
          data-testid="result-summary"
          className="mt-3 grid gap-3 text-[0.875rem] md:grid-cols-2"
        >
          {summary.map(([key, value]) => (
            <MetaTile
              key={key}
              label={resultLabel(key)}
              value={formatValue(value)}
              mono={key === "rebuilt_wasm_hash"}
            />
          ))}
        </div>
      )}

      {(likelyCauses.length > 0 || wasmCompare) && (
        <div className="mt-4 space-y-4">
          {likelyCauses.length > 0 && (
            <AdviceBox title="Likely causes">
              <ul className="m-0 mt-2 list-disc space-y-1 pl-5 text-[0.875rem] leading-[1.5] text-ink-value">
                {likelyCauses.map((cause) => (
                  <li key={cause}>{cause}</li>
                ))}
              </ul>
            </AdviceBox>
          )}

          {wasmCompare && <WasmCompareGrid compare={wasmCompare} />}
        </div>
      )}

      {diagnostics && (
        <DiagnosticsPanel
          diagnostics={diagnostics}
          wasmCompare={wasmCompare}
          defaultOpen={isSettledFailure}
        />
      )}
    </section>
  );
};
