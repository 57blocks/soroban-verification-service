import type { VerifyMode } from "../types";

const heroCopy: Record<VerifyMode, { title: string; line: string }> = {
  submit: {
    title: "Verify a Soroban contract",
    line: "Submit a contract ID or Wasm hash, complete only the metadata the chain does not already carry, and get a reproducible result downstream tools can inspect.",
  },
  job: {
    title: "Verification job",
    line: "Track this rebuild, share the job link, or return to the console to submit another contract.",
  },
};

/**
 * The page header. Deliberately not a hero: this page is a tool, and the landing page is where the argument for
 * it is made — an eyebrow, one heading and one line, so the target form opens the first viewport.
 */
export const ConsoleHero = ({ mode }: { mode: VerifyMode }) => {
  const { title, line } = heroCopy[mode];

  return (
    <header className="mb-7">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-yellow-deep">
        Soroban source verification
      </div>
      <h1 className="m-0 mt-2 text-[1.75rem] font-bold leading-tight tracking-tight text-ink">
        {title}
      </h1>
      <p className="m-0 mt-1.5 max-w-[78ch] text-[0.9rem] leading-[1.6] text-ink-body">
        {line}
      </p>
    </header>
  );
};
