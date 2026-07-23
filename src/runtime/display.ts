import type { SourceSpan } from "../source.js";
import { randomItem } from "./collections.js";
import { RuntimeFault } from "./errors.js";
import type { OutputSpeaker } from "./events.js";
import type { RandomSource } from "./random.js";
import { isRuntimeList } from "./value-guards.js";
import type { RuntimeSpeaker, RuntimeValue } from "./values.js";

export interface ResolvedOutputSpeaker {
  readonly speaker: OutputSpeaker;
  readonly usedIdentifierFallback: boolean;
}

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
): ResolvedOutputSpeaker {
  const explicit = optionalStringProperty(speaker, "displayName", span);
  if (explicit !== null) {
    if (explicit.length === 0) {
      throw new RuntimeFault(
        "TSR022",
        `Speaker '${speaker.identifier}' has no resolvable display name.`,
        span,
      );
    }
    return resolvedSpeaker(speaker, explicit, false, span);
  }

  const derived = [
    optionalStringProperty(speaker, "title", span) ??
      optionalStringProperty(speaker, "shortTitle", span),
    optionalStringProperty(speaker, "firstName", span),
    optionalStringProperty(speaker, "lastName", span),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ");

  return resolvedSpeaker(
    speaker,
    derived.length === 0 ? speaker.identifier : derived,
    derived.length === 0,
    span,
  );
}

function resolvedSpeaker(
  runtimeSpeaker: RuntimeSpeaker,
  displayName: string,
  usedIdentifierFallback: boolean,
  span: SourceSpan,
): ResolvedOutputSpeaker {
  return Object.freeze({
    speaker: Object.freeze({
      identifier: runtimeSpeaker.identifier,
      displayName,
      color: optionalStringProperty(runtimeSpeaker, "color", span),
      font: optionalStringProperty(runtimeSpeaker, "font", span),
      avatar: optionalStringProperty(runtimeSpeaker, "avatar", span),
    }),
    usedIdentifierFallback,
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
