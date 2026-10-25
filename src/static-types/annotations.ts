import type { TypeAnnotation, TypeName } from "../ast.js";
import { compileChild, runCompileTask, type CompileTask } from "../compiler/continuation.js";
import {
  ANY_OBJECT_TYPE,
  isScalarKind,
  NULL_TYPE,
  optional,
  scalar,
  union,
  UNKNOWN_TYPE,
  type StaticType,
} from "../static-types.js";

/** The type a written type means (ADR 0021): `T?` is `T | null`, and `list`, `set`, and `object` hold any values. */
export function typeFromAnnotation(annotation: TypeAnnotation): StaticType {
  return runCompileTask(annotationTask(annotation));
}

/** The type of each written type, built once: no value ever changes a written type. */
const annotationTypes = new WeakMap<TypeAnnotation, StaticType>();

function* annotationTask(annotation: TypeAnnotation): CompileTask<StaticType> {
  const known = annotationTypes.get(annotation);
  if (known !== undefined) return known;
  const type = yield* compileChild(writtenTypeTask(annotation));
  annotationTypes.set(annotation, type);
  return type;
}

function* writtenTypeTask(annotation: TypeAnnotation): CompileTask<StaticType> {
  switch (annotation.kind) {
    case "namedType":
      return namedType(annotation.name);
    case "listType":
    case "setType":
    case "dictType":
      return {
        kind:
          annotation.kind === "listType" ? "list" : annotation.kind === "setType" ? "set" : "dict",
        element: yield* compileChild(annotationTask(annotation.element)),
      };
    case "optionalType":
      return optional(yield* compileChild(annotationTask(annotation.value)));
    case "unionType": {
      const types: StaticType[] = [];
      for (const member of annotation.members)
        types.push(yield* compileChild(annotationTask(member)));
      return union(types);
    }
  }
}

function namedType(name: TypeName): StaticType {
  switch (name) {
    case "null":
      return NULL_TYPE;
    case "list":
    case "set":
    case "dict":
      return { kind: name, element: UNKNOWN_TYPE };
    case "object":
      return ANY_OBJECT_TYPE;
    default:
      return isScalarKind(name) ? scalar(name) : { kind: name };
  }
}
