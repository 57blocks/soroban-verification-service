<script setup lang="ts">
import { onMounted, ref } from "vue";

const origin = ref("https://verifier.example.org");
onMounted(() => {
  origin.value = window.location.origin;
});
</script>

<template>
  <div class="language-sh vp-adaptive-theme">
    <button title="Copy Code" class="copy"></button>
    <span class="lang">sh</span>
    <pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>ORIGIN={{ origin }}</span></span></code></pre>
  </div>
</template>
