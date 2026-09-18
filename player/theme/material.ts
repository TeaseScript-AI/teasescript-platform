import {
  DynamicScheme,
  Hct,
  SchemeTonalSpot,
  argbFromHex,
  hexFromArgb,
} from "@material/material-color-utilities";
import { oklchToPickerHex, pickerHexToOklch, type OklchColor } from "./color.js";

/** Only plain inputs/semantic role values cross the MCU boundary. */
export function materialRoles(
  accent: OklchColor,
  dark: boolean,
  highContrast: boolean,
  surfaceHue: number,
  surfaceTint: number,
) {
  const scheme = new SchemeTonalSpot(
    Hct.fromInt(argbFromHex(oklchToPickerHex(accent))),
    dark,
    highContrast ? 0.5 : 0,
    "2025",
    "phone",
  );
  // MCU 0.4.0 has an extensionless base-class declaration import under NodeNext.
  // The public runtime class check establishes the inherited API without a cast.
  if (!(scheme instanceof DynamicScheme) || scheme.specVersion !== "2025")
    throw new Error("MCU did not preserve Material spec 2025");
  const color = (argb: number) => pickerHexToOklch(hexFromArgb(argb));
  const surface = (argb: number) => {
    // Keep MCU's resolved role tone; do not recreate its role-tone decisions.
    const tone = Hct.fromInt(argb).tone;
    // Experimental tint: 0..100% of a local, realizable neutral range. Unlike the old
    // post-slider cap, this scales the whole range before solving each role.
    const available = Hct.from(surfaceHue, 200, tone).chroma;
    const chroma = surfaceTint * Math.min(24, available);
    return color(Hct.from(surfaceTint === 0 ? 0 : surfaceHue, chroma, tone).toInt());
  };
  return {
    "surface-canvas": surface(scheme.surface),
    "surface-chrome": surface(scheme.surfaceContainerLow),
    "surface-raised": surface(scheme.surfaceContainer),
    "surface-floating": surface(scheme.surfaceContainerHigh),
    "surface-selected": surface(scheme.surfaceContainerHighest),
    "border-subtle": surface(scheme.outlineVariant),
    "border-default": surface(scheme.outline),
    "border-strong": surface(scheme.onSurfaceVariant),
    "text-primary": surface(scheme.onSurface),
    "text-secondary": surface(scheme.onSurfaceVariant),
    "text-on-accent": color(scheme.onPrimary),
    "accent-solid": color(scheme.primary),
    "accent-soft": color(scheme.primaryContainer),
    "accent-focus": color(scheme.primary),
    shadow: color(scheme.shadow),
    scrim: color(scheme.scrim),
  };
}
