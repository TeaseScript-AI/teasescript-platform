import { normalizeColor } from "../color.js";
import type { MessagePresentation } from "../message-presentation.js";
import type { SourceSpan } from "../source.js";
import type { RuntimeSpeakerSnapshot } from "./state.js";
import type { SerializableRuntimeValue } from "./serializable-values.js";
import { isObject } from "./value-predicates.js";
import { RuntimeFault } from "./errors.js";

export function resolveMessagePresentation(
  explicit: SerializableRuntimeValue,
  speaker: RuntimeSpeakerSnapshot | null,
  span: SourceSpan,
): MessagePresentation {
  const property = (name: string) =>
    speaker?.properties.find((item) => item.name === name)?.value ?? null;
  const options = fields(explicit, span);
  const mode = options.get("kind") ?? property("presentation") ?? "bubble";
  if (mode !== "bubble" && mode !== "prose") throw invalid("presentation", span);
  const defaults = fields(property(mode), span);
  for (const name of defaults.keys()) {
    if (!["position", "align", "color", "background", "font"].includes(name))
      throw invalid(name, span);
  }
  for (const name of options.keys()) {
    if (!["kind", "position", "align", "color", "background", "font"].includes(name))
      throw invalid(name, span);
  }
  const position = options.get("position") ?? defaults.get("position") ?? "center";
  const align = options.get("align") ?? defaults.get("align") ?? "center";
  if (position !== "left" && position !== "center" && position !== "right")
    throw invalid("position", span);
  if (align !== "left" && align !== "center" && align !== "right") throw invalid("align", span);
  const font = options.get("font") ?? defaults.get("font") ?? property("font");
  if (font !== null && typeof font !== "string") throw invalid("font", span);
  const defaultColor = normalizeColor(defaults.get("color")) ?? normalizeColor(property("color"));
  const defaultBackground =
    normalizeColor(defaults.get("background")) ??
    (mode === "prose" ? normalizeColor("transparent") : null);
  return Object.freeze({
    kind: mode,
    position,
    align,
    font,
    color: normalizeColor(options.get("color")) ?? defaultColor,
    background: normalizeColor(options.get("background")) ?? defaultBackground,
  });
}

function fields(
  value: SerializableRuntimeValue,
  span: SourceSpan,
): Map<string, SerializableRuntimeValue> {
  if (value === null) return new Map();
  if (!isObject(value)) throw invalid("options", span);
  return new Map(value.properties.map((property) => [property.name, property.value]));
}

function invalid(name: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault("TSR050", `Invalid message presentation '${name}'.`, span);
}
