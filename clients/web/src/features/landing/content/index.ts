// The landing page's copy, one module per section. A section owns its `SectionHead` text and its items
// together, so changing what a section claims is a change to exactly one file.

export type { Capability, ContentLink, SectionCopy } from "./types";

export {
  brandName,
  closingCta,
  footerBlurb,
  footerLegal,
  heroCopy,
  rotatingWords,
} from "./brand";
export { trustStripItems } from "./trust-strip";
export { audienceCards, audienceHead, visibleAudienceCards } from "./audiences";
export type { AudienceAction, AudienceCard, VisibleAudienceCard } from "./audiences";
export { pipelineHead, pipelineStages } from "./pipeline";
export type { PipelineStage } from "./pipeline";
export { architectureHead, architectureLayers } from "./architecture";
export type { ArchitectureLayer } from "./architecture";
export { trustModelHead, trustSignals } from "./trust-model";
export type { TrustSignal } from "./trust-model";
export {
  platformCapabilities,
  platformHead,
  securityCapabilities,
  securityHead,
} from "./capabilities";
export { selfHostHead, selfHostModes } from "./self-host";
export type { SelfHostMode } from "./self-host";
