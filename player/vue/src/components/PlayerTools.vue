<script setup lang="ts">
defineProps<{
  open: boolean;
  toolLabel: string;
}>();

defineEmits<{
  dismiss: [];
}>();
</script>

<template>
  <aside id="leftPanel" class="left-panel" aria-label="Player tools">
    <div class="tool-strip-scroll" data-overflow="false">
      <div class="tool-strip">
        <section class="tool-column" data-tool-column-id="vue-scene" data-tool-id="scene">
          <header class="tool-column-header">
            <div class="tool-selector" aria-label="Tool shown in this column">{{ toolLabel }}</div>
            <span aria-hidden="true"></span>
            <button
              class="tool-column-close"
              type="button"
              aria-label="Close tool column"
              @click="$emit('dismiss')"
            >×</button>
          </header>
          <div class="tool-column-body">
            <slot></slot>
          </div>
        </section>
      </div>
    </div>
  </aside>

  <button
    v-if="open"
    class="left-scrim"
    type="button"
    aria-label="Close tools"
    @click="$emit('dismiss')"
  ></button>
</template>
