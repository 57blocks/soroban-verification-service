import { Link } from "@tanstack/react-router";
import { legalLinks } from "@/config/site";
import { cn } from "@/lib/utils";
import { submissionAgreementCopy } from "../constants";

const byRoute = (to: (typeof legalLinks)[number]["to"]) =>
  legalLinks.find((link) => link.to === to) ?? { to, label: to };
const terms = byRoute("/terms");
const privacy = byRoute("/privacy");
const linkClass = "text-ink/[0.8] underline underline-offset-2 hover:text-ink";

/** Both documents open in a new tab, deliberately. */
const openInNewTab = (label: string) =>
  ({
    // `@tanstack/react-router`'s `Link` leaves the click to the browser whenever the target is neither absent
    // nor `_self` (link.js's `handleClick`), so this is a real new tab and not a client-side route change.
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
  /**
   * Supplied only where the submission actually happens. Given, the same sentence becomes an acceptance
   * control that must be acted on; omitted, it stays the notice it has always been.
   */
  acceptance?: {
    accepted: boolean;
    onAcceptedChange: (accepted: boolean) => void;
    /** Why the control cannot be used, when it cannot — an unloaded bundle has nothing to accept. */
    disabledReason?: string;
  };
};

/**
 * The consent line beside a submission control — the terms have to be linked where the act is. With
 * `acceptance`, it is a clickwrap: an unchecked box, and an affirmative act distinct from pressing submit
 * (versioned-terms-and-assent design.md TA-1).
 *
 * A native `<input type="checkbox">` rather than a `ui/` primitive: there is no checkbox primitive in this
 * kit, and adding a Radix dependency for one control buys nothing a native input does not already give.
 */
export const SubmissionAgreement = ({ className, acceptance }: SubmissionAgreementProps) => {
  if (!acceptance) {
    return (
      <p
        data-testid="submission-agreement"
        className={cn("m-0 mt-2 text-[0.8rem] leading-[1.5] text-ink/[0.55]", className)}
      >
        <AgreementText />
      </p>
    );
  }

  const disabled = acceptance.disabledReason !== undefined;
  return (
    <div className={cn("m-0 mt-2", className)}>
      <label
        htmlFor="accept-terms"
        data-testid="submission-agreement"
        className={cn(
          "flex items-start gap-2.5 text-[0.8rem] leading-[1.5]",
          disabled ? "text-ink/[0.4]" : "cursor-pointer text-ink/[0.75]",
        )}
      >
        <input
          id="accept-terms"
          data-testid="accept-terms"
          type="checkbox"
          checked={acceptance.accepted}
          disabled={disabled}
          onChange={(event) => acceptance.onAcceptedChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-yellow"
          {...(disabled ? { "aria-describedby": "accept-terms-blocked" } : {})}
        />
        <span>
          <AgreementText />
        </span>
      </label>
      {disabled && (
        <p
          id="accept-terms-blocked"
          data-testid="accept-terms-blocked"
          className="m-0 mt-1.5 text-[0.75rem] leading-[1.5] text-warning-fg"
        >
          {acceptance.disabledReason}
        </p>
      )}
    </div>
  );
};
