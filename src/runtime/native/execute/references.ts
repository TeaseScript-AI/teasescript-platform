import type { NameLocation } from "../prepare/scopes.js";
import { NativeNotImplementedError } from "../operations/not-implemented.js";
import { NativeDict, NativeObject, type NativeValue } from "../values/native-value.js";
import type { NativeMachine, NativeReference } from "./machine.js";

export function isNativeReference(value: NativeValue | NativeReference | undefined): value is NativeReference {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "reference";
}

/** The value of a variable of the running activation, its file's root or the session's globals. */
export function readLocation(machine: NativeMachine, location: NameLocation): NativeValue | undefined {
  switch (location.kind) {
    case "local":
      return machine.current.scopes[location.depth]![location.slot];
    case "root":
      return machine.root.scopes[0]![location.slot];
    case "global":
      return machine.globals[location.index];
  }
}

/** The value standing at a prepared reference's place now. */
export function resolveReference(machine: NativeMachine, reference: NativeReference): NativeValue {
  let value = readLocation(machine, reference.root);
  for (const step of reference.steps) {
    if (step.kind === "index" && Array.isArray(value) && step.index < value.length) value = value[step.index];
    else if (step.kind === "key" && value instanceof NativeDict) value = value.entries.get(step.key);
    else if (step.kind === "property" && value instanceof NativeObject) value = value.properties.get(step.name);
    else value = undefined;
    if (value === undefined) break;
  }
  // A place whose path no longer leads anywhere is what today's engine detaches a reference for.
  if (value === undefined) throw new NativeNotImplementedError("a prepared reference whose place has changed");
  return value;
}
