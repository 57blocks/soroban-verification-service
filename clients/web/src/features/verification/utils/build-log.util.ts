export type LogSegment =
  | { kind: "lines"; text: string }
  | { kind: "folded"; label: string; text: string; lineCount: number };

type Boilerplate = { id: string; summary: (count: number) => string };

/** First match wins, so a narrower pattern must precede a wider one. */
const BOILERPLATE: (Boilerplate & { match: (line: string) => boolean })[] = [
  {
    id: "registry-auth",
    summary: () => "Authenticated to the verifier's image registry",
    match: (line) =>
      /^\$ docker login /.test(line) ||
      line === "Login Succeeded" ||
      /^WARNING! Your password will be stored unencrypted/.test(line) ||
      /^Configure a credential helper/.test(line) ||
      /docs\.docker\.com\/engine\/reference\/commandline\/login/.test(line),
  },
  {
    id: "image-pull",
    summary: (count) => `Pulled the build image (${count} progress lines)`,
    match: (line) =>
      /^[0-9a-f]{8,}: (Pulling fs layer|Waiting|Verifying Checksum|Download complete|Downloading|Extracting|Pull complete)/.test(
        line,
      ) ||
      /^(Unable to find image|Digest: sha256:|Status: (Downloaded|Image is up to date))/.test(line) ||
      /: Pulling from /.test(line),
  },
  {
    id: "crate-download",
    summary: (count) => `Downloaded ${count} crates`,
    match: (line) => /^ *Downloaded [\w-]+ v[\d.]/.test(line),
  },
  {
    id: "crate-vendor",
    summary: (count) => `Vendored ${count} crates into the offline registry`,
    match: (line) => /^ *Vendoring [\w-]+ v[\d.]/.test(line),
  },
  {
    id: "crate-compile",
    summary: (count) => `Compiled ${count} crates`,
    match: (line) => /^ *Compiling [\w-]+ v[\d.]/.test(line),
  },
];

const MIN_RUN_TO_FOLD = 4;

const classify = (line: string) => BOILERPLATE.find((rule) => rule.match(line));

export const foldBuildLog = (text: string): LogSegment[] => {
  if (!text) return [];
  const lines = text.split("\n");
  const segments: LogSegment[] = [];

  let plain: string[] = [];
  let run: { rule: Boilerplate; lines: string[]; matched: number } | null = null;

  const flushPlain = () => {
    while (plain.length && plain[plain.length - 1].trim() === "") plain.pop();
    if (plain.length) segments.push({ kind: "lines", text: plain.join("\n") });
    plain = [];
  };

  const flushRun = () => {
    if (!run) return;
    const { rule, lines: runLines, matched } = run;
    run = null;
    if (matched < MIN_RUN_TO_FOLD) {
      plain.push(...runLines);
      return;
    }
    flushPlain();
    segments.push({
      kind: "folded",
      label: rule.summary(matched),
      text: runLines.join("\n"),
      lineCount: runLines.length,
    });
  };

  for (const line of lines) {
    const rule = classify(line);

    if (run) {
      if (rule?.id === run.rule.id) {
        run.lines.push(line);
        run.matched += 1;
        continue;
      }
      if (!rule && line.trim() === "") {
        run.lines.push(line);
        continue;
      }
      const held: string[] = [];
      while (run.lines.length && run.lines[run.lines.length - 1].trim() === "") {
        held.unshift(run.lines.pop() as string);
      }
      flushRun();
      plain.push(...held);
    }

    if (rule) {
      // Not flushing `plain` here: `flushRun` pushes a run too short to fold back into it.
      run = { rule, lines: [line], matched: 1 };
      continue;
    }
    plain.push(line);
  }

  flushRun();
  flushPlain();
  return segments;
};

export const foldedLineCount = (segments: LogSegment[]) =>
  segments.reduce((total, segment) => total + (segment.kind === "folded" ? segment.lineCount : 0), 0);
