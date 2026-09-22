/**
 * The two spellings a SHA-256 digest is written in across this system, each defined once.
 *
 * They were restated as literals at a dozen call sites — every DTO field, validator and helper that needed
 * one carried its own copy. Identical copies are not the danger; a copy that drifts is, and nothing would
 * have caught it, because each site's test only ever exercises its own literal.
 *
 * This module sits below everything so any of them can import it: `registry.ts` already imports the
 * validators, so the shape cannot live there without a cycle.
 */

/** A bare 32-byte digest as lower-case hex — the one spelling this system writes. */
export const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** The same digest carrying OCI's algorithm prefix, as an image or layer reference spells it. */
export const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
