import type {
  SerializableRuntimeDuration,
  SerializableRuntimeList,
  SerializableRuntimeObject,
  SerializableRuntimeRange,
  SerializableRuntimeSet,
  SerializableRuntimeValue,
  SerializableSpeakerReference,
  SerializableTimerHandle,
  SerializableMediaHandle,
} from "./serializable-values.js";

export function isList(value: SerializableRuntimeValue): value is SerializableRuntimeList {
  return typeof value === "object" && value !== null && value.kind === "list";
}

export function isSet(value: SerializableRuntimeValue): value is SerializableRuntimeSet {
  return typeof value === "object" && value !== null && value.kind === "set";
}

export function isObject(value: SerializableRuntimeValue): value is SerializableRuntimeObject {
  return typeof value === "object" && value !== null && value.kind === "object";
}

export function isRange(value: SerializableRuntimeValue): value is SerializableRuntimeRange {
  return typeof value === "object" && value !== null && value.kind === "range";
}

export function isSpeakerReference(
  value: SerializableRuntimeValue,
): value is SerializableSpeakerReference {
  return typeof value === "object" && value !== null && value.kind === "speakerReference";
}

export function isDuration(value: SerializableRuntimeValue): value is SerializableRuntimeDuration {
  return typeof value === "object" && value !== null && value.kind === "duration";
}

export function isTimerHandle(value: SerializableRuntimeValue): value is SerializableTimerHandle {
  return typeof value === "object" && value !== null && value.kind === "timerHandle";
}

export function isMediaHandle(value: SerializableRuntimeValue): value is SerializableMediaHandle {
  return typeof value === "object" && value !== null && value.kind === "mediaHandle";
}

/** A plain-language description of a runtime value's kind for error messages, such as "a number". */
export function describeRuntimeValue(value: SerializableRuntimeValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return "text (string)";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "true or false (boolean)";
  switch (value.kind) {
    case "object":
      return "an object";
    case "speakerReference":
      return "a speaker";
    case "timerHandle":
      return "a timer handle";
    case "mediaHandle":
      return "a media handle";
    default:
      return `a ${value.kind}`;
  }
}
