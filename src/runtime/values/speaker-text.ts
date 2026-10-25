import type { PlanSourceLocation } from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import { displayNameParts } from "../../speaker-terms.js";
import type { TemporalContext } from "../../temporal.js";
import { RuntimeFault } from "../errors.js";
import { copySpan } from "../../plan/source-location.js";
import type { SerializableRuntimeProperty } from "./serializable-values.js";
import { checkTextLength } from "./text-length.js";
import { isVisibleScalar, visibleText } from "./value-text.js";
import { describeShownValue } from "./value-types.js";
import { isList } from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

// A speaker's text fields as text: the name a message shows, and the `displayName` that a speaker without one of its
// own reads. The player profile's person fields read the same way.

/** A speaker's name or title as shown text, like any other shown value, or `null` when it is not set. */
export function speakerText(
  properties: readonly SerializableRuntimeProperty[],
  name: string,
  span: SourceSpan,
  context: TemporalContext,
): string | null {
  const value = properties.find((property) => property.name === name)?.value;
  if (value === undefined || value === null || typeof value === "string" || !isVisibleScalar(value))
    return optionalSpeakerString(properties, name, span);
  return visibleText(value, span, context);
}

/** A speaker's text property, or `null` when it is not set: `TSR030` for any other value. */
export function optionalSpeakerString(
  properties: readonly SerializableRuntimeProperty[],
  name: string,
  span: SourceSpan,
): string | null {
  const value = properties.find((property) => property.name === name)?.value;
  if (value === undefined || value === null) return null;
  if (isList(value) && name !== "font" && name !== "avatar")
    throw fault(
      "TSR030",
      `A list cannot be the speaker's ${name}. Select one element with "\${list}" or list.random.`,
      span,
    );
  if (typeof value !== "string")
    throw fault(
      "TSR030",
      `Speaker property '${name}' must be text (string), but this is ${describeShownValue(value)}.`,
      span,
    );
  return value;
}

/**
 * The `displayName` that a speaker whose own properties are `properties` and that has none of its own reads and shows
 * (see `displayNameParts`), or `undefined` when it has no field that gives one. Fails with `TSR084` for `operation`
 * when the name is longer than any text can be.
 */
export function derivedDisplayName(
  properties: readonly SerializableRuntimeProperty[],
  span: SourceSpan,
  context: TemporalContext,
  operation: string,
): string | undefined {
  const parts = displayNameParts(
    (name) => properties.some((property) => property.name === name),
    (name) => speakerText(properties, name, span, context),
  );
  if (parts === undefined) return undefined;
  checkTextLength(
    parts.reduce((length, part) => length + part.length + 1, -1),
    operation,
    span,
  );
  return parts.join(" ");
}

function fault(code: "TSR030", message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
