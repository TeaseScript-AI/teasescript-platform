// What the enclosing family's parts share: a store's destination, an enclosing case, and the written forms and value
// builders its families try.

import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import { collection, name, optional, type Form } from "../written/type-core-written.js";

/*
 * The stores at, below and above a stopped decision (#1416, #1440; S3, ADR 0021 rule 1.10): a store or argument
 * whose value holds a key whose decision stopped at its demand allowance keeps that key's obligation, its check against
 * its destination's complete type or its value marked. A generated family over the destination's origin (written, a
 * copy, a copy of a copy, a property a copy decides, one named `element`, an object a literal decides, a sibling
 * property), the store's site (a declaration, a replacement with a literal or with a host value), the written form
 * (lists one, two and four deep, a nullable element, a nullable list, text leaves), each tried with the values the
 * form's own predicate (`fits`) sorts, never the implementation's matcher; judged at every allowance around each
 * decision's work in the eight orders (`enclosingProblems`). The forms the candidate route does not take (S10: an
 * argument, a dead call's argument, a return, an add or `addAll`, a dict's or a set's element type) are judged at the
 * analysis: the mark at the store and the complete type its check carries (`Answers.requirement`). A store at or below
 * the stop is judged on the same domain where the source proves it apart from the stop (`certificateFamily`). CI runs
 * anchors of it; the whole family is a worker run outside CI.
 */

/** A store's destination: its binding, parameter or function's result (`result`), and its path below, in key steps. */
export interface Destination {
  readonly binding: string;
  readonly result?: boolean;
  readonly path: readonly string[];
}

export interface EnclosingCase {
  readonly name: string;
  readonly source: string;
  readonly into: Destination;
  /** The stored value's site. */
  readonly site: { readonly start: number; readonly end: number };
  /**
   * The destination's complete type by the source (its written type, or the one a copy gives it), `null` where an
   * object literal decides it, whose properties' types the store's own decisions give.
   */
  readonly form: Form | null;
  /** Whether the destination's binding is written (`let t: F`): its type known in every phase. */
  readonly written: boolean;
  /**
   * Whether the source proves `form` at the destination apart from every decision, a stopped one at it included
   * (#1440): the binding is written, or its declaration's start value holds, through one object literal
   * property per step, a read of a written binding at the destination or above it. Else a stop at or above the
   * destination leaves the store its mark, its type undecided.
   */
  readonly certified?: boolean;
  /** The values a run tries: each a host value, or the one the source stores (`host` false), with whether it fits. */
  readonly values: readonly { readonly value: SerializableRuntimeValue; readonly fits: boolean }[];
  readonly host: boolean;
  /** Whether the candidate route compiles it (S10): else it is judged at the analysis. */
  readonly slice: boolean;
}

export const object = (
  properties: Readonly<Record<string, SerializableRuntimeValue>>,
): SerializableRuntimeValue => ({
  kind: "object",
  properties: Object.entries(properties).map(([property, value]) => ({ name: property, value })),
});

/** A value as a TeaseScript literal. */
export function literalText(value: SerializableRuntimeValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value.kind === "list") return `[${value.items.map(literalText).join(", ")}]`;
  if (value.kind === "set") return `set[${value.items.map(literalText).join(", ")}]`;
  if (value.kind === "dict")
    return `dict{${value.entries.map((e) => `${e.key}: ${literalText(e.value)}`).join(", ")}}`;
  if (value.kind === "object")
    return `{${value.properties.map((p) => `${p.name}: ${literalText(p.value)}`).join(", ")}}`;
  throw new Error(`No literal of a ${value.kind}.`);
}

/** A collection of `kind` holding `items` (a dict's under the keys `a`, `b`, …). */
export function wrap(
  kind: "list" | "set" | "dict",
  ...items: SerializableRuntimeValue[]
): SerializableRuntimeValue {
  if (kind === "dict")
    return {
      kind: "dict",
      entries: items.map((value, index) => ({ key: String.fromCharCode(97 + index), value })),
    };
  return { kind, items };
}

export const listOf = (of: Form, depth: number): Form =>
  depth === 0 ? of : collection("list", listOf(of, depth - 1));
export const integer = name("integer");

/** The written forms: lists one, two and four deep, a nullable element, a nullable list, text leaves. */
export const FORMS: readonly Form[] = [
  listOf(integer, 1),
  listOf(integer, 2),
  listOf(integer, 4),
  collection("list", optional(integer)),
  optional(listOf(integer, 1)),
  listOf(name("string"), 2),
];
