import type { InjectionKey, Ref } from "vue";
import type { InkContrastMethod } from "../../../theme/color.js";

export const playerInkComparison: InjectionKey<Readonly<Ref<InkContrastMethod>>> =
  Symbol("player-ink-comparison");
