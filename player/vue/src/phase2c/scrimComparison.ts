import type { InjectionKey, Ref } from "vue";
import type { InkContrastMethod } from "../../../theme/color.js";

export interface ScrimComparison {
  method: InkContrastMethod;
  apcaTarget: number;
}

export const scrimComparison: InjectionKey<Readonly<Ref<ScrimComparison>>> =
  Symbol("scrim-comparison");
