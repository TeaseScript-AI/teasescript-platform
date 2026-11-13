<script setup lang="ts">
import { aliased } from "@/aliased.js";
const shown = aliased;
</script>
<template>
  <p @click="import('../src/template.js')">{{ shown }}</p>
</template>
