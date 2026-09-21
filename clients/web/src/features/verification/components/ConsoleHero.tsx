import type { VerifyMode } from "../types";

const heroCopy: Record<VerifyMode, { title: string; lines: string[] }> = {
  submit: {
    title: "Verify a Soroban contract",
    lines: [
      "Submit a contract ID or Wasm hash, complete only the missing metadata or upload a manifest,",
      "and get a reproducible verification result that downstream tools can inspect.",
    ],
  },
  job: {
    title: "Verification job",
    lines: [
      "Track the current rebuild, share this job link, or return to the console to submit another contract.",
    ],
  },
};

export const ConsoleHero = ({ mode }: { mode: VerifyMode }) => {
  const { title, lines } = heroCopy[mode];

  return (
    <div className="mx-auto mb-[54px] max-w-console text-center">
      <div className="mb-4 inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-[0.875rem] font-semibold shadow-[inset_0_-2px_0_theme(colors.yellow.DEFAULT)]">
        <span aria-hidden>◈</span> Soroban source verification
      </div>
      <h1 className="m-0 text-3xl font-semibold leading-tight tracking-tight text-ink md:text-[2.75rem]">
        {title}
      </h1>
      <p className="m-0 mt-4 text-[1.05rem] leading-[1.7] text-ink-body">
        {lines.map((line, index) => (
          <span key={line}>
            {index > 0 && <br />}
            {line}
          </span>
        ))}
      </p>
    </div>
  );
};
