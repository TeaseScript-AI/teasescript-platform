import { onScopeDispose } from "vue";
import { useEventListener } from "@vueuse/core";

// App owns one navigation modality for the Player and its body-portaled tools.
// Like React Aria's text-input policy, editing keys do not reveal focus rings:
// https://github.com/adobe/react-spectrum/blob/main/packages/react-aria/src/interactions/useFocusVisible.ts
export function usePlayerKeyboardFocus() {
  const root = document.documentElement;
  const attribute = "data-player-keyboard-focus";
  const previous = root.getAttribute(attribute);
  root.setAttribute(attribute, "true");

  useEventListener(document, "pointerdown", () => root.setAttribute(attribute, "false"), {
    capture: true,
  });
  useEventListener(
    document,
    "keydown",
    (event) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      const textInput =
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement &&
          ["text", "search", "email", "url", "tel", "password", "number"].includes(target.type)) ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (!textInput || event.key === "Tab" || event.key === "Escape")
        root.setAttribute(attribute, "true");
    },
    { capture: true },
  );

  onScopeDispose(() => {
    if (previous === null) root.removeAttribute(attribute);
    else root.setAttribute(attribute, previous);
  });
}
