<script setup lang="ts">
import { onMounted, ref } from "vue";

type LegalBundle = { operator_name?: string; contact_url?: string | null };

const operator = ref<LegalBundle | null>(null);

onMounted(async () => {
  try {
    const response = await fetch("/api/verification/v1/legal");
    if (response.ok) operator.value = (await response.json()) as LegalBundle;
  } catch {
    operator.value = null;
  }
});
</script>

<template>
  <!-- One line on purpose: a line break inside the sentence renders as a space before the comma. -->
  <p v-if="operator?.operator_name">This verifier is operated by <strong>{{ operator.operator_name }}</strong><template v-if="operator.contact_url">, who can be reached at <a :href="operator.contact_url">{{ operator.contact_url }}</a></template>.</p>
</template>
