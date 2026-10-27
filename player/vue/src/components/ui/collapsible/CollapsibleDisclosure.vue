<script setup lang="ts">
import { ChevronRight } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import CollapsibleTrigger from "./CollapsibleTrigger.vue";

// The Player's one toggle that unfolds text or details below it (UI-DESIGN-AND-ENGINEERING "Shared control baseline"):
// left-aligned, with a chevron before the label that turns down while open. Attributes, such as `data-*` and
// `disabled`, go to its button.
defineOptions({ inheritAttrs: false });
</script>

<template>
  <CollapsibleTrigger as-child>
    <!-- -ms-3 takes back the button's side padding, so the chevron lines up with the text around it. -->
    <Button v-bind="$attrs" variant="muted" class="group -ms-3 min-h-11 self-start justify-self-start">
      <ChevronRight class="group-data-[state=open]:rotate-90" aria-hidden="true" />
      <slot />
    </Button>
  </CollapsibleTrigger>
</template>
