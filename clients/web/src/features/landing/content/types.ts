import type { MonoSpan } from "@/components/mono-chip";

export type { MonoSpan as SampleSpan };

export type SectionCopy = {
  label: string;
  title: string;
  description: string;
};

export type ContentLink = {
  label: string;
  href: string;
  external?: boolean;
};

export type Capability = {
  title: string;
  description: string;
  sample?: string | MonoSpan[];
  wide?: boolean;
};
