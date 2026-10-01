import { Hct, TonalPalette, argbFromHex, hexFromArgb } from "@material/material-color-utilities";
import { oklchToPickerHex, pickerHexToOklch, type OklchColor } from "./color.js";

/** Only plain inputs/colours cross the MCU boundary; role policy lives in palette.ts. */
export function tonalColor(hue: number, chroma: number, tone: number): OklchColor {
  return pickerHexToOklch(hexFromArgb(TonalPalette.fromHueAndChroma(hue, chroma).tone(tone)));
}

export function accentTone(accent: OklchColor, tone: number): OklchColor {
  const seed = Hct.fromInt(argbFromHex(oklchToPickerHex(accent)));
  return tonalColor(seed.hue, seed.chroma, tone);
}
