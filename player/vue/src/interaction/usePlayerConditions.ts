import {
  computed,
  inject,
  provide,
  ref,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
import { useEventListener, useMediaQuery } from "@vueuse/core";

// Player conditions describe independent constraints, not device classes. Keep
// feature-specific fit measurements with their owner and pass them in here.
type Viewport = { width: number; height: number; left: number; top: number };
type PlayerConditions = {
  viewport: Ref<Viewport>;
  horizontalConstrained: ComputedRef<boolean>;
  verticalConstrained: ComputedRef<boolean>;
  touchAvailable: Ref<boolean>;
  hoverAvailable: Ref<boolean>;
  keyboardRaised: Ref<boolean>;
  touchAtScreenEdge: ComputedRef<boolean>;
  edgeClearance: ComputedRef<boolean>;
};
const key: InjectionKey<PlayerConditions> = Symbol("player-conditions");

export function providePlayerConditions(requiredDockWidth: ComputedRef<number>): PlayerConditions {
  const viewport = ref<Viewport>({
    width: window.innerWidth,
    height: window.innerHeight,
    left: 0,
    top: 0,
  });
  const touchAvailable = useMediaQuery("(any-pointer: coarse)");
  const hoverAvailable = useMediaQuery("(any-hover: hover)");
  const touchFirst = useMediaQuery("(pointer: coarse) and (hover: none)");
  const keyboardRaised = ref(false);
  let expandedHeight = window.visualViewport?.height ?? window.innerHeight;
  let previousWidth = window.visualViewport?.width ?? window.innerWidth;
  let previousScale = window.visualViewport?.scale ?? 1;

  function update() {
    const visual = window.visualViewport;
    const width = visual?.width ?? window.innerWidth;
    const height = visual?.height ?? window.innerHeight;
    const scale = visual?.scale ?? 1;
    const editing = document.activeElement?.matches("[data-composer-input]") ?? false;
    if (!editing || Math.abs(width - previousWidth) > 1 || Math.abs(scale - previousScale) > 0.01)
      expandedHeight = height;
    else expandedHeight = Math.max(expandedHeight, height);
    previousWidth = width;
    previousScale = scale;
    viewport.value = { width, height, left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0 };
    keyboardRaised.value = editing && touchAvailable.value && expandedHeight - height > 120;
  }

  update();
  useEventListener(window, "resize", update);
  useEventListener(window.visualViewport, "resize", update);
  useEventListener(window.visualViewport, "scroll", update);
  useEventListener(document, "focusin", update);
  useEventListener(document, "focusout", () => queueMicrotask(update));
  watch(touchAvailable, update);

  // A narrow touch laptop window does not reach the display edge. The scale
  // converts desktop-mode zoom, while 24px allows browser rounding and scrollbars.
  // Only the composer also depends on the keyboard being closed.
  const touchAtScreenEdge = computed(
    () =>
      touchFirst.value &&
      window.screen.width > 0 &&
      viewport.value.width * (window.visualViewport?.scale ?? 1) >= window.screen.width - 24,
  );

  const conditions: PlayerConditions = {
    viewport,
    horizontalConstrained: computed(() => viewport.value.width < requiredDockWidth.value),
    // Shared compact presentation threshold for limited usable height.
    verticalConstrained: computed(() => viewport.value.height <= 700),
    touchAvailable,
    hoverAvailable,
    keyboardRaised,
    touchAtScreenEdge,
    edgeClearance: computed(() => touchAtScreenEdge.value && !keyboardRaised.value),
  };
  provide(key, conditions);
  return conditions;
}

export function usePlayerConditions(): PlayerConditions {
  const conditions = inject(key);
  if (!conditions) throw new Error("Player conditions require the Player shell");
  return conditions;
}
