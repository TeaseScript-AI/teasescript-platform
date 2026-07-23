import type {
  RuntimeList,
  RuntimeObject,
  RuntimeSet,
  RuntimeSpeaker,
  RuntimeValue,
} from "./values.js";

export function isRuntimeList(
  value: RuntimeValue | undefined,
): value is RuntimeList {
  return typeof value === "object" && value !== null && value.kind === "list";
}

export function isRuntimeSet(
  value: RuntimeValue | undefined,
): value is RuntimeSet {
  return typeof value === "object" && value !== null && value.kind === "set";
}

export function isRuntimeObject(
  value: RuntimeValue | undefined,
): value is RuntimeObject {
  return typeof value === "object" && value !== null && value.kind === "object";
}

export function isRuntimeSpeaker(
  value: RuntimeValue | undefined,
): value is RuntimeSpeaker {
  return typeof value === "object" && value !== null && value.kind === "speaker";
}
