import type { SourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import type { OutputSpeaker } from "./events.js";
import type { RandomSource } from "./random.js";
import { randomItem } from "./collections.js";
import { isRuntimeList } from "./value-guards.js";
import type { RuntimeSpeaker, RuntimeValue } from "./values.js";

export function toVisibleText(
  value: RuntimeValue,
  span: SourceSpan,
  random: RandomSource,
): string {
  if (isRuntimeList(value)) {
    return toVisibleText(randomItem(value.items, span, random), span, random);
  }
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  throw new RuntimeFault(
    "TSR021",
    "This value cannot be converted implicitly to visible text.",
    span,
  );
}

export function resolveOutputSpeaker(
  speaker: RuntimeSpeaker,
  span: SourceSpan,
): OutputSpeaker {
  const explicit = optionalStringProperty(speaker, "displayName", span);
  const displayName =
    explicit ??
    [
      optionalStringProperty(speaker, "title", span) ??
        optionalStringProperty(speaker, "shortTitle", span),
      optionalStringProperty(speaker, "firstName", span),
      optionalStringProperty(speaker, "lastName", span),
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(" ");
  if (displayName.length === 0) {
    throw new RuntimeFault(
      "TSR022",
      `Speaker '${speaker.identifier}' has no resolvable display name.`,
      span,
    );
  }
  return Object.freeze({
    identifier: speaker.identifier,
    displayName,
    color: optionalStringProperty(speaker, "color", span),
    font: optionalStringProperty(speaker, "font", span),
    avatar: optionalStringProperty(speaker, "avatar", span),
  });
}

function optionalStringProperty(
  speaker: RuntimeSpeaker,
  name: string,
  span: SourceSpan,
): string | null {
  const value = speaker.properties.get(name);
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RuntimeFault(
      "TSR030",
      `Speaker property '${name}' must be a string for output.`,
      span,
    );
  }
  return value;
}
