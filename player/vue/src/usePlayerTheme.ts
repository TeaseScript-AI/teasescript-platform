import { storyChoiceVariables } from "../../theme/story-choice.js";
import { onBeforeUnmount, watchEffect, type Ref } from "vue";
import { legacySrgbCss } from "../../theme/color.js";
import {
  generatePlayerTheme,
  themeCssVariables,
  type PhotoSurfaces,
  type PlayerThemeIntent,
} from "../../theme/palette.js";

// Default palette per mode: warm rose light and cool blue dark.
export const defaultPlayerThemeIntents: Readonly<Record<"light" | "dark", PlayerThemeIntent>> =
  Object.freeze({
    light: Object.freeze({
      mode: "light",
      contrast: "standard",
      surfaceHue: 70,
      surfaceTint: 0.5,
      surfaceMaxChroma: 8.5,
      monochrome: false,
      accentSeed: Object.freeze({ l: 0.59208, c: 0.19138, h: 11.08 }),
    }),
    dark: Object.freeze({
      mode: "dark",
      contrast: "standard",
      surfaceHue: 240,
      surfaceTint: 0.5,
      surfaceMaxChroma: 8.5,
      monochrome: false,
      accentSeed: Object.freeze({ l: 0.52227, c: 0.23546, h: 264.72 }),
    }),
  });

// The theme's variables are registered colours, so a transition can fade them: every surface, text and accent colour
// that uses them then fades together. The root lists them as its transition properties; a duration makes them fade
// (`style.css`, while the photo colour changes).
const registeredColours = new Set<string>();
function registerColour(name: string) {
  if (registeredColours.has(name)) return;
  registeredColours.add(name);
  try {
    CSS.registerProperty({ name, syntax: "<color>", inherits: true, initialValue: "transparent" });
  } catch {
    // Already registered, or a browser without registered properties: the colour then changes at once.
  }
}

/**
 * Applies the theme of `intent`, with `photo`'s surfaces while the Stage photo colours the Player. With `blend` "srgb"
 * the colours are written in legacy sRGB syntax, so a fade between them blends in sRGB instead of Oklab.
 */
export function usePlayerTheme(
  intent: Readonly<Ref<PlayerThemeIntent>>,
  photo?: Readonly<Ref<PhotoSurfaces | null>>,
  blend?: Readonly<Ref<"oklab" | "srgb">>,
) {
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
    if (previousThemeMode === null) root.removeAttribute("data-player-theme");
    else root.setAttribute("data-player-theme", previousThemeMode);
    themeApplied = false;
  }
  function applyGeneratedTheme(update: {
    mode: "light" | "dark";
    variables: Record<string, string>;
  }) {
    const root = document.documentElement;
    if (!themeApplied) {
      previousThemeMode = root.getAttribute("data-player-theme");
      themeApplied = true;
    }
    for (const [property, value] of Object.entries({
      ...update.variables,
      "transition-property": Object.keys(update.variables).join(", "),
    })) {
      if (!previousThemeProperties.has(property))
        previousThemeProperties.set(property, {
          value: root.style.getPropertyValue(property),
          priority: root.style.getPropertyPriority(property),
        });
      root.style.setProperty(property, value);
    }
    root.dataset.playerTheme = update.mode;
  }
  watchEffect(() => {
    const theme = generatePlayerTheme(intent.value, photo?.value);
    const variables = {
      ...themeCssVariables(theme),
      ...storyChoiceVariables(theme.roles["surface-control"]),
      ...storyChoiceVariables(theme.roles["accent-solid"], "story-accent"),
    };
    for (const name of Object.keys(variables)) registerColour(name);
    const srgb = blend?.value === "srgb";
    applyGeneratedTheme({
      mode: intent.value.mode,
      variables: Object.fromEntries(
        Object.entries(variables).map(([name, value]) => [
          name,
          srgb ? legacySrgbCss(value) : value,
        ]),
      ),
    });
  });
  onBeforeUnmount(clearGeneratedTheme);
}
