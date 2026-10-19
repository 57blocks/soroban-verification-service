<script setup>
import { githubRepoUrl, sourceIsPublic } from "../../../web/src/config/site.ts";
</script>

# Support

## Questions and problems

For a question about this verifier, or a problem with a job, contact its operator.

<LegalOperator />

When you report a problem with a job, include its `job_id`. If a build ran, include the build log too:
only you can read it, with the token returned when you submitted.

## Security vulnerabilities

Do not report a vulnerability in public. Email <a href="mailto:opensource@57blocks.com">opensource@57blocks.com</a>,
<span v-if="sourceIsPublic">or use the repository's <a :href="`${githubRepoUrl}/security/advisories/new`">private
vulnerability reporting</a>,</span> and expect an acknowledgement within 3 working days. See
[Report a vulnerability](../security/report-a-vulnerability.md) for what to include and what follows.

<div v-if="sourceIsPublic">

## Contributing

The source is on GitHub, at <a :href="githubRepoUrl">{{ githubRepoUrl }}</a>. Read
<a :href="`${githubRepoUrl}/blob/main/CONTRIBUTING.md`">CONTRIBUTING.md</a> before opening a pull request.

</div>
