# Terms and privacy

Using this verifier is governed by its operator's two legal documents:

- <a href="/terms">Terms of Service</a>
- <a href="/privacy">Privacy Notice</a>

<LegalOperator />

## How acceptance works

- **The two documents are one unit.** They are published together under a single version, and
  `GET /api/verification/v1/legal` serves them. That response's `ETag` is the SHA-256 of the exact bytes
  served.
- **A submission names the version it accepts.** The console asks you to accept the documents before
  you submit. Over the API, `accepted_terms_version` carries the version, and the job records it together
  with the hash of the documents it named.
- **Only the current version is accepted.** A submission that names any other version is refused with
  `terms_version_outdated`.
- **Acceptance can be required.** Once the operator's documents carry an effective date, a submission
  without `accepted_terms_version` is refused with `terms_acceptance_required`.
- **Any change is a new version.** Changing either document, by even one character, publishes it under
  a new version.

## Running your own verifier

The documents above belong to this verifier's operator. A verifier you run serves the documents you
configure for it, under your own name.
