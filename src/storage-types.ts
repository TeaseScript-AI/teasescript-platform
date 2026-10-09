import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";
import type { SourceSpan } from "./source.js";
import {
  isAssignable,
  openType,
  resolved,
  settle,
  union,
  type PropertyTable,
  type StaticType,
} from "./static-types.js";

/**
 * The type a storage key written as a string literal keeps for the whole project (ADR 0021 §6): its declared type, or
 * else the type that every load of the key accepts, with the load that gives it, which messages name.
 */
export interface StorageKeyType {
  readonly type: StaticType;
  readonly at: SourceSpan;
  /** Whether a load declares the type, by the variable it starts or is assigned to. */
  readonly declared: boolean;
  /**
   * Each distinct type of the loads without a declared type, in checking order, with its first load and its text (see
   * {@link typeKey}): a load must agree with the types that loads before it first read.
   */
  readonly loads: readonly StorageLoadType[];
}

/** A type that loads of a key read, with the first of them. */
export interface StorageLoadType {
  readonly type: StaticType;
  readonly at: SourceSpan;
  readonly text: string;
}

/** A load of a storage key written as a string literal, with the type it reads the stored value as, without `null`. */
export interface StorageLoad {
  readonly key: string;
  readonly type: StaticType;
  readonly at: SourceSpan;
  /** Whether the type is the declared type of the variable the load starts or is assigned to. */
  readonly declared: boolean;
}

/**
 * The type of each storage key that a load gives a type (ADR 0021 §6): the first declared type in checking order, which
 * every other load of the key takes. Without one, of the loads of the key, the one whose type every other load accepts,
 * so a value saved under the key fits every load; a part that one load leaves undecided, such as the elements of
 * `default: []`, takes what another load decides. A load that disagrees changes nothing here; the check that uses these
 * types reports it.
 */
export function storageKeyTypes(loads: readonly StorageLoad[]): Map<string, StorageKeyType> {
  const keys = new Map<
    string,
    { type: StaticType; at: SourceSpan; declared: boolean; loads: StorageLoadType[] }
  >();
  // A load of a type that an earlier load read adds nothing, so repeated loads add no work per earlier load.
  const added = (loads: StorageLoadType[], load: StorageLoad): void => {
    const text = typeKey(load.type);
    if (!loads.some((earlier) => earlier.text === text))
      loads.push({ type: detachedType(load.type), at: load.at, text });
  };
  for (const load of loads) {
    const kept = keys.get(load.key);
    if (load.declared) {
      if (kept === undefined)
        keys.set(load.key, {
          type: detachedType(load.type),
          at: load.at,
          declared: true,
          loads: [],
        });
      else if (!kept.declared)
        Object.assign(kept, { type: detachedType(load.type), at: load.at, declared: true });
      continue;
    }
    if (kept === undefined) {
      const loads: StorageLoadType[] = [];
      added(loads, load);
      keys.set(load.key, { type: detachedType(load.type), at: load.at, declared: false, loads });
      continue;
    }
    added(kept.loads, load);
    if (kept.declared) continue;
    const narrower = isAssignable(kept.type, load.type);
    const wider = isAssignable(load.type, kept.type);
    if (narrower && wider) settle(kept.type, detachedType(load.type), load.at);
    else if (narrower) Object.assign(kept, { type: detachedType(load.type), at: load.at });
  }
  return keys;
}

/**
 * A copy of a type that shares nothing with the places of a check: still undecided parts are new open slots, and
 * numbers derive from no variable. A key keeps it from one check to the next.
 */
export function detachedType(type: StaticType): StaticType {
  return runCompileTask(detachedTask(type));
}

function* detachedTask(typeToDetach: StaticType): CompileTask<StaticType> {
  const type = resolved(typeToDetach);
  switch (type.kind) {
    case "open":
      return { ...openType(), sawNull: type.sawNull };
    case "scalar":
      return type.values === undefined && type.origins === undefined
        ? type
        : { kind: "scalar", name: type.name };
    case "list":
    case "set":
    case "dict":
      return { kind: type.kind, element: yield* compileChild(detachedTask(type.element)) };
    case "object": {
      if (type.properties === null) return type;
      const properties: PropertyTable = new Map();
      for (const [name, value] of type.properties)
        properties.set(name, yield* compileChild(detachedTask(value)));
      return { kind: "object", properties };
    }
    case "union": {
      const parts: StaticType[] = [];
      for (const member of type.members) parts.push(yield* compileChild(detachedTask(member)));
      return union(parts);
    }
    default:
      return type;
  }
}

/** Whether two checks found the same key types, decided at the same places. */
export function sameStorageKeyTypes(
  left: ReadonlyMap<string, StorageKeyType>,
  right: ReadonlyMap<string, StorageKeyType>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, kept] of left) {
    const other = right.get(key);
    if (
      other === undefined ||
      other.at !== kept.at ||
      other.declared !== kept.declared ||
      !sameType(other.type, kept.type) ||
      other.loads.length !== kept.loads.length ||
      other.loads.some(
        (load, index) => load.at !== kept.loads[index]!.at || load.text !== kept.loads[index]!.text,
      )
    )
      return false;
  }
  return true;
}

/**
 * Whether a check reads the same key types from both: as {@link sameStorageKeyTypes}, but with union members and object
 * properties compared in their order, since a check copies the types as they are, and without the loads of a key whose
 * type a load declares, since a check reads those only for a key without a declared type.
 */
export function sameReadStorageKeyTypes(
  left: ReadonlyMap<string, StorageKeyType>,
  right: ReadonlyMap<string, StorageKeyType>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, kept] of left) {
    const other = right.get(key);
    if (
      other === undefined ||
      other.at !== kept.at ||
      other.declared !== kept.declared ||
      typeKey(other.type, false) !== typeKey(kept.type, false)
    )
      return false;
    if (
      !kept.declared &&
      (other.loads.length !== kept.loads.length ||
        other.loads.some(
          (load, index) =>
            load.at !== kept.loads[index]!.at ||
            typeKey(load.type, false) !== typeKey(kept.loads[index]!.type, false),
        ))
    )
      return false;
  }
  return true;
}

/** Whether two types are equal, with union members and object properties in any order. */
export function sameType(left: StaticType, right: StaticType): boolean {
  return typeKey(left) === typeKey(right);
}

/**
 * A text that equal types share: union members and object properties in a fixed order, or with `sorted` false, in the
 * order the type has them.
 */
export function typeKey(type: StaticType, sorted = true): string {
  return runCompileTask(typeKeyTask(type, sorted));
}

function* typeKeyTask(typeToName: StaticType, sorted: boolean): CompileTask<string> {
  const type = resolved(typeToName);
  switch (type.kind) {
    case "open":
      return type.sawNull ? "?null" : "?";
    case "scalar":
      return type.name;
    case "list":
    case "set":
    case "dict":
      return `${type.kind}<${yield* compileChild(typeKeyTask(type.element, sorted))}>`;
    case "object": {
      if (type.properties === null) return "object";
      const properties: string[] = [];
      for (const [name, value] of type.properties)
        properties.push(
          `${JSON.stringify(name)}:${yield* compileChild(typeKeyTask(value, sorted))}`,
        );
      return `{${(sorted ? properties.sort() : properties).join(",")}}`;
    }
    case "union": {
      const parts: string[] = [];
      for (const member of type.members)
        parts.push(yield* compileChild(typeKeyTask(member, sorted)));
      return `(${(sorted ? parts.sort() : parts).join("|")})`;
    }
    default:
      return type.kind;
  }
}
