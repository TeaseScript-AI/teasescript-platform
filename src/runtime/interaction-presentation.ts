import { isNormalizedOpaqueColor } from "../color.js";

/** Read the canonical captured choice value while validating checkpoint lineage. */
export function capturedChoicePresentation(
  value: unknown,
): { text: string; background?: string } | null {
  if (typeof value === "string") return { text: value };
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "object" ||
    !("properties" in value) ||
    !Array.isArray(value.properties)
  )
    return null;
  let text: string | undefined;
  let background: string | undefined;
  for (const property of value.properties) {
    if (typeof property !== "object" || property === null) return null;
    if (property.name === "text" && text === undefined && typeof property.value === "string")
      text = property.value;
    else if (
      property.name === "background" &&
      background === undefined &&
      isNormalizedOpaqueColor(property.value)
    )
      background = property.value;
    else return null;
  }
  return text === undefined || background === undefined ? null : { text, background };
}
