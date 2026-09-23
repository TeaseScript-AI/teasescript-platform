import type { InjectionKey, Ref } from "vue";
export interface ScrimComparison {
  mode: "WCAG21" | "APCA_FILTER";
  apcaCutoff: number;
}

export const scrimComparison: InjectionKey<Readonly<Ref<ScrimComparison>>> =
  Symbol("scrim-comparison");
