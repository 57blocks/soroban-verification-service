<script setup>
import { githubRepoUrl } from "../../../web/src/config/site.ts";
</script>

# Provide your legal documents

Your verifier serves your Terms of Service and Privacy Notice, under your name. The software ships none:
it does not start until you give it yours. Write them with your own legal advice; the
[Data and retention](../legal/data-and-retention.md) page describes what the software does with
submitters' data, which your Privacy Notice has to cover.

## The bundle

Both documents travel together in one JSON file, the **bundle**. Start from
<a :href="`${githubRepoUrl}/blob/main/config/legal-documents.example.json`">`config/legal-documents.example.json`</a>,
and replace every string in it.

| Field | Required | Meaning |
| --- | --- | --- |
| `schema` | Yes | `scvs-legal-documents-v1` |
| `version` | Yes | Your name for this revision. Submitters accept it by name |
| `effective_date` | No | When the documents are in force. Leave it `null` while they are a draft |
| `operator_name` | Yes | Who runs this verifier. Shown with the documents and in this documentation |
| `service_name` | Yes | The name of your service |
| `contact_url` | No | How to reach you. Shown in this documentation |
| `history_url` | No | Where earlier revisions can be read. Linked from the documents |
| `documents` | Yes | Exactly one document with `slug: "terms"` and one with `slug: "privacy"` |

Each document has a `title`, a `document_title` for the browser tab, an `intro`, a list of `sections`
and a list of `open_items`. A section has an `id`, a `heading` and `blocks`. A block is a paragraph,
written as a string, or a bulleted list, written as `{ "list": [ … ] }`. Inside text, `**bold**` and
`[label](https://…)` links are recognised; nothing else is formatted. A link whose target starts with
`/` opens a page of the console; any other opens in a new tab.

The console shows the documents at `/terms` and `/privacy`. While `effective_date` is `null`, it marks
them as a draft and lists the `open_items`.

## Giving it to the verifier

Set `SCVS_LEGAL_DOCUMENTS_SOURCE` on `verification-svc` to one of:

- a path to the file;
- an `https:` URL it is fetched from;
- the JSON itself.

The bundle is read when the service starts, and checked: a missing or malformed bundle stops the service.
To change the documents, change the bundle and restart. A URL is fetched again on every start, so host
it somewhere only you can change.

The verifier serves the bundle, byte for byte, at `GET /api/verification/v1/legal`, with its SHA-256 as
the `ETag`.

## Acceptance

- **While `effective_date` is `null`**, submitting does not require accepting the documents. The console
  still asks for it.
- **Once `effective_date` is set**, to an ISO 8601 date, every submission must name the current
  `version`. The date is not compared with today: a date in the future enforces acceptance at once, so
  set it when the documents are in force.
- **A submission that names any other version is refused**, whether or not the documents are in force.

A job records the version it accepted and the SHA-256 of the exact bundle served, so you can tell which
text each submitter agreed to.

## Changing the documents

Give every change a new `version`, however small: submitters accept a version by name, and the recorded
hash ties that name to exact bytes. The service refuses to start if a version that jobs have already
recorded now has different content.

When the version changes, anyone with the console open may still hold the previous version, and their
submission is refused with `terms_version_outdated` until the console loads the documents again, which
reloading the page does.
