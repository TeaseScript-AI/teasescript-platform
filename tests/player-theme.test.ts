import assert from "node:assert/strict";
import test from "node:test";
import {
  contrastRatio,
  inSrgbGamut,
  mapToSrgb,
  oklchCss,
  pickerHexToOklch,
  oklchToPickerHex,
} from "../player/theme/color.js";
const white = { l: 1, c: 0, h: 0 };
const black = { l: 0, c: 0, h: 0 };
test("opaque contrast handles neutral endpoints", () => {
  assert.ok(Math.abs(contrastRatio(white, black) - 21) < 1e-6);
  assert.equal(contrastRatio(white, white), 1);
});

test("color adapter rejects invalid literal inputs", () => {
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

test("native picker adapters round-trip sRGB while keeping canonical OKLCH intent", () => {
  for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#abcdef", "#777777"]) {
    const color = pickerHexToOklch(hex);
    assert.ok(inSrgbGamut(color));
    assert.equal(oklchToPickerHex(color), hex);
  }
  assert.throws(() => pickerHexToOklch("red"), RangeError);
});
