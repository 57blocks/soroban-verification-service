---
layout: home
title: Soroban Verifier Docs

hero:
  name: Soroban Verifier
  text: Documentation
  tagline: Check that a deployed Soroban contract was built from the source it claims, and read what each verifier found.
  actions:
    - theme: brand
      text: What is contract verification?
      link: /introduction/what-is-verification
    - theme: alt
      text: How it works
      link: /introduction/how-it-works
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: What a result means
    details: A verified result is a byte-for-byte match between a rebuild of the source and the Wasm on the chain. Nothing more, and nothing less.
    link: /introduction/what-is-verification
  - title: How a contract is verified
    details: Preflight, submit, rebuild in a sandbox whose build step has no network, then compare and publish.
    link: /introduction/how-it-works
  - title: Who says so
    details: Every result is attributed to the verifier that produced it. There is no single network-wide verdict.
    link: /introduction/trust-model
  - title: Which contracts qualify
    details: What the deployed Wasm records about its own build decides whether it can be verified, and how.
    link: /introduction/supported-contracts
---
