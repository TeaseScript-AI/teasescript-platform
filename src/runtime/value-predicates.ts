import type {
  SerializableRuntimeDuration,
  SerializableRuntimeList,
  SerializableRuntimeObject,
  SerializableRuntimeRange,
  SerializableRuntimeSet,
  SerializableRuntimeValue,
  SerializableSpeakerReference,
  SerializableTimerHandle,
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
