import { Link } from "@tanstack/react-router";
import { legalLinks } from "@/config/site";
import { cn } from "@/lib/utils";
import { submissionAgreementCopy } from "../constants";

const byRoute = (to: (typeof legalLinks)[number]["to"]) =>
  legalLinks.find((link) => link.to === to) ?? { to, label: to };
const terms = byRoute("/terms");
const privacy = byRoute("/privacy");
const linkClass = "text-ink/[0.8] underline underline-offset-2 hover:text-ink";

const openInNewTab = (label: string) =>
  ({
    target: "_blank" as const,
    rel: "noopener noreferrer",
    "aria-label": `${label} (opens in a new tab)`,
  }) as const;

const AgreementText = () => (
  <>
    {submissionAgreementCopy}{" "}
    <Link to={terms.to} className={linkClass} {...openInNewTab(terms.label)}>
      {terms.label}
    </Link>{" "}
    and acknowledge the{" "}
    <Link to={privacy.to} className={linkClass} {...openInNewTab(privacy.label)}>
      {privacy.label}
    </Link>
    .
  </>
);

type SubmissionAgreementProps = {
  className?: string;
  acceptance?: {
    accepted: boolean;
    onAcceptedChange: (accepted: boolean) => void;
    disabledReason?: string;
    error?: string;
  };
};

export const SubmissionAgreement = ({ className, acceptance }: SubmissionAgreementProps) => {
  if (!acceptance) {
    return (
      <p
        data-testid="submission-agreement"
        className={cn("m-0 text-[0.8rem] leading-[1.5] text-ink/[0.7]", className)}
      >
        <AgreementText />
      </p>
    );
  }

  const disabled = acceptance.disabledReason !== undefined;
  const problem = acceptance.error ?? acceptance.disabledReason;
  return (
    <div
      className={cn(
        "rounded-md border bg-surface-alt p-3.5",
        acceptance.error ? "border-danger-fg" : "border-line-strong",
        className,
      )}
    >
      <label
        htmlFor="accept-terms"
        data-testid="submission-agreement"
        className={cn(
          "flex items-start gap-2.5 text-[0.8125rem] leading-[1.5]",
          disabled ? "text-ink/[0.4]" : "cursor-pointer text-ink",
        )}
      >
        <input
          id="accept-terms"
          data-testid="accept-terms"
          type="checkbox"
          checked={acceptance.accepted}
          disabled={disabled}
          required
          aria-invalid={acceptance.error ? true : undefined}
          onChange={(event) => acceptance.onAcceptedChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-yellow"
          {...(problem ? { "aria-describedby": "accept-terms-blocked" } : {})}
        />
        <span>
          <AgreementText />
          <span className="text-danger-mark">{" *"}</span>
        </span>
      </label>
      {problem && (
        <p
          id="accept-terms-blocked"
          data-testid="accept-terms-blocked"
          role={acceptance.error ? "alert" : undefined}
          className={cn(
            "m-0 mt-2 pl-[1.625rem] text-[0.75rem] font-medium leading-[1.5]",
            acceptance.error ? "text-danger-fg" : "text-warning-fg",
          )}
        >
          {problem}
        </p>
      )}
    </div>
  );
};
