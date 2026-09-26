import { storyChoiceVariables } from "../../../theme/story-choice.js";
import { onBeforeUnmount, watchEffect, type Ref } from "vue";
import {
  generatePlayerTheme,
  themeCssVariables,
  type PlayerThemeIntent,
} from "../../../theme/palette.js";

export function usePlayerTheme(intent: Ref<PlayerThemeIntent>) {
  // The standalone Player owns root tokens so body-portaled Reka surfaces share the theme.
  // Retain previous inline values so unmounting restores the exact baseline.
  const previousThemeProperties = new Map<string, { value: string; priority: string }>();
  let previousThemeMode: string | null = null;
  let themeApplied = false;
  function clearGeneratedTheme() {
    if (!themeApplied) return;
    const root = document.documentElement;
    for (const [property, previous] of previousThemeProperties) {
      if (previous.value) root.style.setProperty(property, previous.value, previous.priority);
      else root.style.removeProperty(property);
    }
    previousThemeProperties.clear();
    if (previousThemeMode === null) root.removeAttribute("data-phase2c-theme");
    else root.setAttribute("data-phase2c-theme", previousThemeMode);
    themeApplied = false;
  }
  function applyGeneratedTheme(update: {
    mode: "light" | "dark";
    variables: Record<string, string>;
  }) {
    const root = document.documentElement;
    if (!themeApplied) {
      previousThemeMode = root.getAttribute("data-phase2c-theme");
      themeApplied = true;
    }
    for (const [property, value] of Object.entries(update.variables)) {
      if (!previousThemeProperties.has(property))
        previousThemeProperties.set(property, {
          value: root.style.getPropertyValue(property),
          priority: root.style.getPropertyPriority(property),
        });
      root.style.setProperty(property, value);
    }
    root.dataset.phase2cTheme = update.mode;
  }
  watchEffect(() => {
    const theme = generatePlayerTheme(intent.value);
    applyGeneratedTheme({
      mode: intent.value.mode,
      variables: {
        ...themeCssVariables(theme),
        ...storyChoiceVariables(theme.roles["surface-control"]),
      },
    });
  });
  onBeforeUnmount(clearGeneratedTheme);
}
