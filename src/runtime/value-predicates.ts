import type {
  SerializableRuntimeDate,
  SerializableRuntimeDateTime,
  SerializableRuntimeDuration,
  SerializableRuntimeTemporal,
  SerializableRuntimeTime,
  SerializableRuntimeTimestamp,
  SerializableRuntimeList,
  SerializableRuntimeObject,
  SerializableRuntimeRange,
  SerializableRuntimeSet,
  SerializableRuntimeDict,
  SerializableRuntimeValue,
  SerializableSpeakerReference,
  SerializableTimerHandle,
  SerializableMediaHandle,
  SerializablePermanentButtonHandle,
  SerializableCameraViewHandle,
  SerializableScriptReference,
} from "./serializable-values.js";

export function isList(value: SerializableRuntimeValue): value is SerializableRuntimeList {
  return typeof value === "object" && value !== null && value.kind === "list";
}

export function isSet(value: SerializableRuntimeValue): value is SerializableRuntimeSet {
  return typeof value === "object" && value !== null && value.kind === "set";
}

export function isDict(value: SerializableRuntimeValue): value is SerializableRuntimeDict {
  return typeof value === "object" && value !== null && value.kind === "dict";
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

export function isPermanentButton(
  value: SerializableRuntimeValue,
): value is SerializablePermanentButtonHandle {
  return typeof value === "object" && value !== null && value.kind === "permanentButtonHandle";
}

export function isCameraView(
  value: SerializableRuntimeValue,
): value is SerializableCameraViewHandle {
  return typeof value === "object" && value !== null && value.kind === "cameraView";
}

export function isScriptReference(
  value: SerializableRuntimeValue,
): value is SerializableScriptReference {
  return typeof value === "object" && value !== null && value.kind === "script";
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
    case "cameraView":
      return "a camera view";
    case "permanentButtonHandle":
      return "a permanent button";
    case "datetime":
      return "a date and time";
    case "script":
      return "a script reference";
    default:
      return `a ${value.kind}`;
  }
}

export function isDate(value: SerializableRuntimeValue): value is SerializableRuntimeDate {
  return typeof value === "object" && value !== null && value.kind === "date";
}

export function isTime(value: SerializableRuntimeValue): value is SerializableRuntimeTime {
  return typeof value === "object" && value !== null && value.kind === "time";
}

export function isDateTime(value: SerializableRuntimeValue): value is SerializableRuntimeDateTime {
  return typeof value === "object" && value !== null && value.kind === "datetime";
}

export function isTimestamp(
  value: SerializableRuntimeValue,
): value is SerializableRuntimeTimestamp {
  return typeof value === "object" && value !== null && value.kind === "timestamp";
}

/** A date, time, datetime, or timestamp. */
export function isTemporal(value: SerializableRuntimeValue): value is SerializableRuntimeTemporal {
  return isDate(value) || isTime(value) || isDateTime(value) || isTimestamp(value);
}
