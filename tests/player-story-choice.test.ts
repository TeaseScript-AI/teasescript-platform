import assert from "node:assert/strict";
import test from "node:test";
import Color from "colorjs.io";
import { authoredColorToOklch, pickerHexToOklch } from "../player/theme/color.js";
import { storyChoiceVariables } from "../player/theme/story-choice.js";

test("story-button ink follows the APCA black/white choice", () => {
  for (const [fill, expected] of [
    ["gold", "black"],
    ["seagreen", "white"],
    ["oklch(59.208% 0.19138 11.08)", "white"],
    ["hsl(265 45% 50%)", "white"],
  ] as const) {
    const base = authoredColorToOklch(fill);
    const variables = storyChoiceVariables(base);
    assert.ok(new Color(variables["--story-choice-ink"]!).deltaE(expected) < 1e-6, fill);
  }
});

test("story-button lighting keeps the chosen ink preferable across fill states", () => {
  const colors = ["#ffffff", "#000000", "#777777", "#fff9b0", "#07163b", "#39ff14", "#ff00ff"];
  for (const color of colors) {
    const variables = storyChoiceVariables(pickerHexToOklch(color));
    const ink = variables["--story-choice-ink"]!;
    const otherInk = new Color(ink).to("srgb").coords[0]! < 0.5 ? "white" : "black";
    for (const state of ["top", "bottom", "hover-top", "hover-bottom", "pressed"]) {
      const fill = variables[`--story-choice-${state}`]!;
      assert.ok(
        Math.abs(Color.contrast(fill, ink, "APCA")) >=
          Math.abs(Color.contrast(fill, otherInk, "APCA")),
        `${color}: ${state}`,
      );
      assert.ok(new Color(fill).inGamut("srgb"), `${color}: ${state} gamut`);
    }
  }
});
