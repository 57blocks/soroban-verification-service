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

/** One icon card in `CapabilityGrid`. `icon` is the `d` of a single 24x24 stroked path. */
export type Capability = {
  title: string;
  description: string;
  icon: string;
};
