// The shapes every module in this directory shares.

// The monospace strip's span type is shared with the console, which renders real values in the same device;
// this directory keeps calling it `SampleSpan`, because on this page every value is a sample.
import type { MonoSpan } from "@/components/mono-chip";

export type { MonoSpan as SampleSpan };

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
 * One card in `CardGrid`. `sample` is the monospace strip along its bottom — one illustrative value, never a
 * fetched one, and never a claim the section's copy does not already make. `wide` gives a card two columns,
 * which is what keeps a six-card section from reading as a grid of identical boxes.
 */
export type Capability = {
  title: string;
  description: string;
  sample?: string | MonoSpan[];
  wide?: boolean;
};
