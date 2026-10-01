import type { InjectionKey, Ref } from "vue";

export const enhancedTranscriptContrast: InjectionKey<Readonly<Ref<boolean>>> = Symbol(
  "enhanced-transcript-contrast",
);
