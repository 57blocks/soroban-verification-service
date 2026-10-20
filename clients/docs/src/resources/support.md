<script setup>
import { githubRepoUrl } from "../../../web/src/config/site.ts";
</script>

# Support

## Questions and problems

For a question about this verifier, or a problem with a job, contact its operator.

<LegalOperator />

When you report a problem with a job, include its `job_id`. If a build ran, include the build log too:
only you can read it, with the token returned when you submitted.

## Security vulnerabilities

Do not report a vulnerability in public. Use the repository's
<a :href="`${githubRepoUrl}/security/advisories/new`">private vulnerability reporting</a>, or email
<a href="mailto:opensource@57blocks.com">opensource@57blocks.com</a>, and expect an acknowledgement within 3 working days. See
[Report a vulnerability](../security/report-a-vulnerability.md) for what to include and what follows.

## Bugs in the software

A bug in the software itself, rather than in one verifier's service, goes in a public
<a :href="`${githubRepoUrl}/issues/new/choose`">GitHub issue</a>. To fix it yourself, see
[Contribute](./contribute.md).
