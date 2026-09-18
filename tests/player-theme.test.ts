import assert from "node:assert/strict";
import test from "node:test";
import {
  contrastRatio,
  inSrgbGamut,
  linearSrgb,
  mapToSrgb,
  normalizeColor,
  oklchCss,
  pickerHexToOklch,
  oklchToPickerHex,
} from "../player/theme/color.js";
import {
  generatePlayerTheme,
  themeCssVariables,
  type PlayerThemeIntent,
} from "../player/theme/palette.js";

const white = { l: 1, c: 0, h: 0 };
const black = { l: 0, c: 0, h: 0 };
test("color conversion matches independent neutral and primary reference values", () => {
  assert.equal(contrastRatio(white, black), 21);
  assert.equal(contrastRatio(white, white), 1);
  const red = linearSrgb({ l: 0.62795536, c: 0.25768331, h: 29.233885 });
  assert.ok(Math.abs(red[0] - 1) < 1e-6);
  assert.ok(Math.abs(red[1]) < 1e-6);
  assert.ok(Math.abs(red[2]) < 1e-6);
  assert.ok(Math.abs(contrastRatio({ l: 0.5, c: 0, h: 0 }, black) - 3.5) < 1e-6);
});

test("gamut reduction preserves lightness and hue, handles extreme seeds, rejects invalid numbers", () => {
  for (const l of [0, 0.01, 0.5, 0.99, 1]) {
    for (const h of [-720, 30, 120, 240, 1e10]) {
      const input = { l, c: Number.MAX_VALUE, h };
      const output = mapToSrgb(input);
      assert.ok(inSrgbGamut(output));
      assert.equal(output.l, l);
      assert.equal(output.h, normalizeColor(input).h);
      assert.ok(output.c <= input.c);
      assert.deepEqual(mapToSrgb(output), output);
    }
  }
  for (const color of [
    { l: NaN, c: 0, h: 0 },
    { l: 2, c: 0, h: 0 },
    { l: 0, c: -1, h: 0 },
    { l: 0, c: 0, h: Infinity },
  ]) {
    assert.throws(() => mapToSrgb(color), RangeError);
  }
  assert.throws(() => oklchCss(white, 2), RangeError);
});

test("bounded palette matrix is deterministic, in gamut, and reports measured role contrast", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const contrast of ["standard", "high"] as const) {
      for (const l of [0, 0.5, 1]) {
        for (const c of [0, 0.15, 0.4]) {
          for (const h of [0, 60, 120, 180, 240, 300]) {
            const intent: PlayerThemeIntent = {
              mode,
              contrast,
              surfaceSeed: { l, c, h },
              accentSeed: { l: 1 - l, c, h: h + 45 },
            };
            const before = JSON.stringify(intent);
            const theme = generatePlayerTheme(intent);
            assert.deepEqual(theme, generatePlayerTheme(intent));
            assert.equal(JSON.stringify(intent), before);
            for (const color of Object.values(theme.roles)) assert.ok(inSrgbGamut(color));
            for (const effect of Object.values(theme.effects)) assert.ok(inSrgbGamut(effect.color));
            assert.equal(
              Object.keys(themeCssVariables(theme)).length,
              Object.keys(theme.roles).length + 2,
            );
            for (const diagnostic of theme.diagnostics) {
              const colors: Readonly<Record<string, typeof white>> = theme.roles;
              const foreground = colors[diagnostic.foreground];
              const background = colors[diagnostic.background];
              assert.ok(foreground && background);
              assert.equal(diagnostic.ratio, contrastRatio(foreground, background));
              assert.equal(
                diagnostic.passes,
                diagnostic.target === null ? null : diagnostic.ratio >= diagnostic.target,
              );
              if (diagnostic.foreground.startsWith("text-") && diagnostic.target !== null)
                assert.equal(diagnostic.passes, true);
            }
            assert.ok(theme.roles["surface-floating"].l > theme.roles["surface-canvas"].l);
          }
        }
      }
    }
  }
});

test("surface changes preserve the accent interaction family and report boundary contrast", () => {
  const intent: PlayerThemeIntent = {
    mode: "dark",
    contrast: "high",
    surfaceSeed: white,
    accentSeed: { l: 0.6, c: 0.2, h: 30 },
  };
  const first = generatePlayerTheme(intent);
  const second = generatePlayerTheme({ ...intent, surfaceSeed: { l: 0, c: 0.3, h: 200 } });
  for (const role of ["accent-solid", "accent-hover", "accent-pressed"] as const)
    assert.deepEqual(first.roles[role], second.roles[role]);
  assert.ok(
    first.diagnostics.some(
      (item) => item.foreground === "accent-solid" && item.background === "surface-raised",
    ),
  );
  assert.equal(first.diagnostics.find((item) => item.foreground === "text-disabled")?.target, null);
});

test("native picker adapters round-trip sRGB while keeping canonical OKLCH intent", () => {
  for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#abcdef", "#777777"]) {
    const color = pickerHexToOklch(hex);
    assert.ok(inSrgbGamut(color));
    assert.equal(oklchToPickerHex(color), hex);
  }
  assert.throws(() => pickerHexToOklch("red"), RangeError);
});
