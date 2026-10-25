import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import {
  canonical,
  containsType,
  isKnown,
  resolved,
  valueKindOfType,
  type StaticType,
} from "../static-types.js";
import { VALUE_KINDS } from "../value-kinds.js";

// How a type is written and described for authors: its written name, and a plain-language description of its values.

/**
 * Whether a type can be written as an annotation without losing what the compiler knows. Objects with known properties
 * cannot, because a property type has no written form, and neither can a kind without a written type, such as camera
 * views and permanent buttons.
 */
export function isAnnotatable(type: StaticType): boolean {
  return (
    resolved(type).kind !== "unknown" &&
    !containsType(
      type,
      (part) =>
        part.kind === "never" ||
        part.kind === "open" ||
        !isWritten(part) ||
        (part.kind === "object" && part.properties !== null),
    )
  );
}

/** Whether an annotation can name the kind a type without members holds (`written`). */
function isWritten(type: StaticType): boolean {
  const kind = valueKindOfType(type);
  return kind === undefined || VALUE_KINDS[kind].written;
}

/** The author-facing type name, as written in an annotation where one exists. */
export function typeName(type: StaticType): string {
  return runCompileTask(typeNameTask(type));
}

function* typeNameTask(typeToName: StaticType): CompileTask<string> {
  const type = canonical(typeToName);
  switch (type.kind) {
    case "unknown":
    case "open":
      return "unknown";
    case "never":
      return "never";
    case "null":
      return "null";
    case "scalar":
      return type.name;
    case "list":
    case "set":
    case "dict": {
      const element = canonical(type.element);
      if (!isKnown(element)) return type.kind;
      const name = yield* compileChild(typeNameTask(element));
      const written = name.includes(" | ") ? `(${name})` : name;
      return type.kind === "list" ? `${written}[]` : `${written} ${type.kind}`;
    }
    case "object":
      return "object";
    case "union": {
      const nonNull = type.members.filter((member) => member.kind !== "null");
      const nullable = nonNull.length < type.members.length;
      if (nullable && nonNull.length === 1)
        return `${yield* compileChild(typeNameTask(nonNull[0]!))}?`;
      const names: string[] = [];
      for (const member of nonNull) names.push(yield* compileChild(typeNameTask(member)));
      if (nullable) names.push("null");
      return names.join(" | ");
    }
    default:
      return type.kind;
  }
}

/** A plain-language description of a value of `type` for diagnostics, as the runtime describes one (`description`). */
export function describeValue(type: StaticType): string {
  const value = canonical(type);
  switch (value.kind) {
    case "scalar":
      return VALUE_KINDS[value.name].description;
    case "list":
    case "set":
    case "dict": {
      const name = typeName(value);
      return name === value.kind ? `a ${value.kind}` : `a ${value.kind} (${name})`;
    }
    case "union":
      return value.members.map(describeValue).join(" or ");
    case "never":
      return "no value";
    case "unknown":
    case "open":
      return "a value";
    default:
      return VALUE_KINDS[value.kind].description;
  }
}
