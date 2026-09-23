import type { InjectionKey, Ref } from "vue";
export interface ScrimComparison {
  mode: "WCAG21" | "APCA_FILTER" | "ADAPTIVE_INK";
  apcaCutoff: number;
  enhanced: boolean;
}

export const scrimComparison: InjectionKey<Readonly<Ref<ScrimComparison>>> =
  Symbol("scrim-comparison");
