<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";

// Intentionally component-local: presentation changes must preserve this draft.
const draft = ref("");
const count = ref(0);
</script>

<template>
  <div class="space-y-4 p-4 text-sm" data-tool-lifetime-fixture>
    <p>Local tool state survives shell changes and hiding or switching tools.</p>
    <label class="grid gap-2">
      Local draft
      <input v-model="draft" class="min-w-0 rounded border bg-background p-2" />
    </label>
    <Button variant="outline" @click="count++">Local count: {{ count }}</Button>
    <p v-for="row in 30" :key="row">Scroll fixture {{ row }}: return to the same reading position after hiding this tool.</p>
  </div>
</template>
