import {
  INTEGER_TYPE,
  isCollection,
  members,
  nonNullType,
  resolved,
  STRING_TYPE,
  union,
  UNKNOWN_TYPE,
  type StaticType,
} from "../static-types.js";
import { narrowTo } from "./narrowing.js";

// The element types of lists, sets, and dicts: what a read or a loop gives, and what a store must have.

/**
 * The type of a list or set element or a dict value, or of a loop variable over an iterable, which goes through the
 * keys of a dict, or `undefined` for other types.
 */
export function elementType(type: StaticType, iteration = false): StaticType | undefined {
  const elements: StaticType[] = [];
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (iteration && value.kind === "dict") elements.push(STRING_TYPE);
    else if (isCollection(value)) elements.push(value.element);
    else if (iteration && value.kind === "range") elements.push(INTEGER_TYPE);
    else if (value.kind === "unknown") elements.push(UNKNOWN_TYPE);
    else return undefined;
  }
  return elements.length === 1 ? elements[0] : union(elements);
}

/**
 * The type an element stored in a list or set, or a value stored in a dict, of `type` must have: for a union of
 * collections, what every member's elements share, because the compiler does not know which member holds the
 * collection. `undefined` for other types.
 */
export function elementStoreType(type: StaticType): StaticType | undefined {
  let shared: StaticType | undefined;
  for (const member of members(nonNullType(type))) {
    const value = resolved(member);
    if (value.kind === "unknown") return UNKNOWN_TYPE;
    if (!isCollection(value)) return undefined;
    shared = shared === undefined ? value.element : narrowTo(shared, value.element);
  }
  return shared;
}
