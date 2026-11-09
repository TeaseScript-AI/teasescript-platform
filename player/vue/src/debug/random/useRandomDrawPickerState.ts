import { computed, ref, watch } from "vue";
import type { RandomDrawView } from "../../../../../src/index.js";
import { randomDrawChoices } from "./randomDrawPresentation";

/**
 * The random draw picker's state of one draw (DEBUGGER.md "Random draws"): the value typed for a number, and a
 * shuffle's items in the order shown. It starts anew whenever `drawKey` changes, the draw's identity
 * (`useDebugRandom`'s `drawKey`): draw IDs repeat across sessions, so another session's draw with the same ID starts
 * anew too, and the same draw shown again by a newer publication keeps what was typed.
 */
export function useRandomDrawPickerState(source: {
  readonly drawKey: string;
  readonly draw: RandomDrawView;
}) {
  const choices = computed(() => randomDrawChoices(source.draw));
  const typed = ref("");
  // The shuffle's items in the order shown, as their old indexes.
  const order = ref<number[]>([]);
  watch(
    () => source.drawKey,
    () => {
      typed.value = "";
      const items = choices.value.kind === "order" ? choices.value.items : [];
      order.value = items.map((_, index) => index);
    },
    { immediate: true },
  );
  /** Moves the item at `position` one place up (`-1`) or down (`1`). */
  function move(position: number, direction: -1 | 1) {
    const destination = position + direction;
    if (destination < 0 || destination >= order.value.length) return;
    const moved = [...order.value];
    [moved[position], moved[destination]] = [moved[destination]!, moved[position]!];
    order.value = moved;
  }
  return { choices, typed, order, move };
}
