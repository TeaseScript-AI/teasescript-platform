import assert from "node:assert/strict";
import test from "node:test";
import Color from "colorjs.io";
import { pickerHexToOklch } from "../player/theme/color.js";
import { storyChoiceVariables } from "../player/theme/story-choice.js";

test("story-button lighting preserves readable labels for extreme and varied authored fills", () => {
  const colors = ["#ffffff", "#000000", "#777777", "#fff9b0", "#07163b", "#39ff14", "#ff00ff"];
  for (const color of colors) {
    const variables = storyChoiceVariables(pickerHexToOklch(color));
    const ink = variables["--story-choice-ink"]!;
    for (const state of ["top", "bottom", "hover-top", "hover-bottom", "pressed"]) {
      const fill = variables[`--story-choice-${state}`]!;
      // Regression oracle for the current material algorithm, not a project accessibility policy.
      assert.ok(Color.contrast(ink, fill, "WCAG21") >= 4.5 - 1e-6, `${color}: ${state}`);
      assert.ok(new Color(fill).inGamut("srgb"), `${color}: ${state} gamut`);
    }
  }
});
