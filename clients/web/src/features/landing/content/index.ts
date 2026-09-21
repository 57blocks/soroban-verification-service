// The landing page's copy, one module per section. A section owns its `SectionHead` text and its items
// together, so changing what a section claims is a change to exactly one file.

export type { Capability, ContentLink, SampleSpan, SectionCopy } from "./types";

export {
  brandName,
  closingCta,
  footerBlurb,
  footerLegal,
  heroCopy,
} from "./brand";
export { trustStripItems } from "./trust-strip";
export { audienceCards, audienceHead, visibleAudienceCards } from "./audiences";
export type { AudienceAction, AudienceCard, VisibleAudienceCard } from "./audiences";
export { pipelineHead, pipelineSample, pipelineStages } from "./pipeline";
export type { PipelineStage } from "./pipeline";
export { resultCards, resultHead } from "./result";
export { trustModelHead, trustSignals } from "./trust-model";
export type { TrustSignal } from "./trust-model";
export { securityCapabilities, securityHead } from "./security";
