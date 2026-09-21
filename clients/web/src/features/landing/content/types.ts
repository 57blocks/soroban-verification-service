// The shapes every module in this directory shares.

/** The eyebrow / heading / blurb block `SectionHead` renders above a section's items. */
export type SectionCopy = {
  label: string;
  title: string;
  description: string;
};

/** A destination a card or footer entry points at. `external` opens a new tab. */
export type ContentLink = {
  label: string;
  href: string;
  external?: boolean;
};

/**
 * One run of a monospace sample, and what its colour means.
 *
 * **Colour marks a verdict, never decoration.** `verdict` and `mismatch` are the two outcome tones; `key` and
 * `value` only separate a field's name from its content. A value with no outcome — whether a source is public,
 * which policy applied — takes no tone, because colouring it would assert a judgement the service does not
 * make.
 */
export type SampleSpan = {
  text: string;
  tone?: "verdict" | "mismatch" | "key" | "value";
};

/**
 * One card in `CardGrid`. `sample` is the monospace strip along its bottom — one illustrative value, never a
 * fetched one, and never a claim the section's copy does not already make. `wide` gives a card two columns,
 * which is what keeps a six-card section from reading as a grid of identical boxes.
 */
export type Capability = {
  title: string;
  description: string;
  sample?: string | SampleSpan[];
  wide?: boolean;
};
