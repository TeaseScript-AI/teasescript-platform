import { createHash } from "node:crypto";

import type { SerializableRuntimeValue, SourceSpan } from "../../src/index.js";

/*
 * Depth-safe comparison, writing and building of runtime data for the differential harness (docs/TESTING.md
 * "Differential harness"). Nothing here recurses, calls `assert.deepEqual`, or stringifies a nested value natively, so
 * a 10,000-level value is never the harness's own failure.
 */

/** Where in a value a mismatch is: property names and array indices from the top. */
export type StructurePath = readonly (string | number)[];

/** One difference: its path, and a bounded rendering of each side. */
export interface StructureMismatch {
  readonly path: StructurePath;
  readonly oracle: string;
  readonly candidate: string;
}

export interface StructureComparison {
  readonly equal: boolean;
  /** The first `limit` mismatches, depth first, in key and index order. */
  readonly mismatches: readonly StructureMismatch[];
  /** Whether the walk stopped at `limit` with more of the values unvisited. */
  readonly truncated: boolean;
}

/**
 * The kinds of positions an engine revision may number differently: instruction indices, temporary IDs, and source
 * spans. Script values are never positions.
 */
export type PositionKind = "instruction" | "temporary" | "sourceSpan";

/**
 * The record fields that hold positions, by name. A field not listed is compared exactly, so an unlisted position that
 * a relation would have translated shows as a mismatch, never as a dropped field. A relation that needs more fields
 * adds them here.
 */
const POSITION_FIELDS: ReadonlyMap<string, PositionKind> = new Map([
  ["nextInstruction", "instruction"],
  ["returnInstruction", "instruction"],
  ["owningInstruction", "instruction"],
  ["continuationInstruction", "instruction"],
  ["instruction", "instruction"],
  ["instructions", "instruction"],
  ["branches", "instruction"],
  ["destinationTemporary", "temporary"],
  ["span", "sourceSpan"],
  ["callSiteSpan", "sourceSpan"],
]);

/**
 * The mapping from oracle positions to candidate positions. Each method gives the candidate's position for the
 * oracle's, or `undefined` when it does not know it, which is a mapping failure. Script values are never mapped.
 */
export interface Correspondence {
  /** Whether every method returns its argument: then equal bytes are equal records. */
  readonly identity: boolean;
  instruction(index: number): number | undefined;
  temporary(id: number): number | undefined;
  sourceSpan(span: SourceSpan): SourceSpan | undefined;
}

/** The correspondence of one revision with itself. */
export const IDENTITY: Correspondence = {
  identity: true,
  instruction: (index) => index,
  temporary: (id) => id,
  sourceSpan: (span) => span,
};

/** A correspondence that could not answer: the comparison has no verdict, and the pair is a mapping failure. */
export class MappingFailure extends Error {
  public constructor(
    readonly path: StructurePath,
    readonly kind: PositionKind,
    readonly position: string,
  ) {
    super(`No ${kind} corresponds to the oracle's ${position} at ${renderPath(path)}.`);
    this.name = "MappingFailure";
  }
}

/** A value outside plain data, which neither comparison nor writing accepts. */
class NotPlainData extends Error {
  public constructor(
    readonly path: StructurePath,
    detail: string,
  ) {
    super(`${renderPath(path)} is not plain data: ${detail}.`);
    this.name = "NotPlainData";
  }
}

const SCALAR_CHARACTERS = 80;

/** A path as text, such as `$.frames[0].scopes[2]`. */
export function renderPath(path: StructurePath): string {
  let text = "$";
  for (const segment of path) text += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  return text;
}

/** A bounded description of a value: its kind with its length or key count, or at most 80 characters of a scalar. */
function renderValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value !== null && typeof value === "object") return `object(${Object.keys(value).length})`;
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (Object.is(value, -0)) text = "-0";
  else text = String(value);
  return text.length > SCALAR_CHARACTERS ? `${text.slice(0, SCALAR_CHARACTERS)}…` : text;
}

/** A path as a linked list, so that a deep walk does not copy its path at every level. */
interface PathNode {
  readonly parent: PathNode | null;
  readonly segment: string | number;
}

function pathOf(node: PathNode | null): StructurePath {
  const path: (string | number)[] = [];
  for (let at = node; at !== null; at = at.parent) path.push(at.segment);
  return path.reverse();
}

/** Whether an object, an array or a plain object, has the prototype of plain data. */
function isPlainObject(value: Readonly<Record<string, unknown>> | readonly unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The kind of `value` as plain data, or throws `NotPlainData`. */
function kindOf(value: unknown, at: PathNode | null): "array" | "object" | "scalar" {
  if (Array.isArray(value)) return "array";
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
      throw new NotPlainData(pathOf(at), typeof value);
    return "scalar";
  }
  // EVIDENCE: validation: `value` is a non-null object that is not an array.
  if (!isPlainObject(value as Readonly<Record<string, unknown>>))
    throw new NotPlainData(pathOf(at), "an object with a prototype");
  return "object";
}

/** The candidate's instruction or temporary for the oracle's `value`, or throws `MappingFailure`. */
function mappedPosition(
  correspondence: Correspondence,
  kind: "instruction" | "temporary",
  value: number,
  at: PathNode | null,
): number {
  const position =
    kind === "instruction" ? correspondence.instruction(value) : correspondence.temporary(value);
  if (position === undefined) throw new MappingFailure(pathOf(at), kind, renderValue(value));
  return position;
}

/**
 * Compares `oracle` and `candidate` completely with an explicit worklist. Scalars compare by `Object.is` (so `-0` and
 * `0` differ), arrays by length and position, and plain objects by their own enumerable keys in insertion order, then
 * their values: key order counts, because the runtime's canonical order is part of its output. Under a field of
 * `POSITION_FIELDS`, the oracle's positions are translated by `correspondence` first. Throws `MappingFailure` when the
 * correspondence cannot answer, and `NotPlainData` for a value outside plain data. `options.limit` is the most
 * mismatches it reports, through `mismatchLimit`: a positive safe integer, 10 by default; any other value throws a
 * `RangeError`, since a limit that keeps no mismatch would report equal values as different.
 */
export function compareStructures(
  oracle: unknown,
  candidate: unknown,
  options: { readonly limit?: number; readonly correspondence?: Correspondence } = {},
): StructureComparison {
  const limit = mismatchLimit(options.limit);
  const correspondence = options.correspondence ?? IDENTITY;
  const mismatches: StructureMismatch[] = [];
  interface Work {
    readonly oracle: unknown;
    readonly candidate: unknown;
    readonly at: PathNode | null;
    /** The kind of the nearest enclosing instruction or temporary field, which maps its number leaves. */
    readonly position: "instruction" | "temporary" | null;
  }
  const work: Work[] = [{ oracle, candidate, at: null, position: null }];
  const mismatch = (item: Work, left: unknown, right: unknown) =>
    mismatches.push({
      path: pathOf(item.at),
      oracle: renderValue(left),
      candidate: renderValue(right),
    });
  while (work.length > 0) {
    if (mismatches.length >= limit) return { equal: false, mismatches, truncated: true };
    const item = work.pop()!;
    const left =
      item.position !== null && typeof item.oracle === "number"
        ? mappedPosition(correspondence, item.position, item.oracle, item.at)
        : item.oracle;
    const right = item.candidate;
    const leftKind = kindOf(left, item.at);
    const rightKind = kindOf(right, item.at);
    if (leftKind !== rightKind) {
      mismatch(item, left, right);
      continue;
    }
    if (leftKind === "scalar") {
      if (!Object.is(left, right)) mismatch(item, left, right);
      continue;
    }
    // EVIDENCE: validation: `kindOf` classified both sides as arrays or as plain objects.
    const leftObject = left as Readonly<Record<string, unknown>>;
    // EVIDENCE: validation: as above, for the candidate side.
    const rightObject = right as Readonly<Record<string, unknown>>;
    // An array by its length and every position, holes read as `undefined`; an object by its own keys.
    const keysOf = (value: unknown, record: Readonly<Record<string, unknown>>) =>
      Array.isArray(value)
        ? Array.from({ length: value.length }, (_, index) => String(index))
        : Object.keys(record);
    const leftKeys = keysOf(left, leftObject);
    const rightKeys = keysOf(right, rightObject);
    if (leftKind === "array") {
      if (leftKeys.length !== rightKeys.length) mismatch(item, left, right);
    } else if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      mismatch(item, left, right);
      continue;
    }
    const shared = Math.min(leftKeys.length, rightKeys.length);
    // Pushed last to first, so the walk visits keys and indices in order.
    for (let index = shared - 1; index >= 0; index -= 1) {
      const key = leftKeys[index]!;
      const segment = leftKind === "array" ? index : key;
      const field = leftKind === "object" ? POSITION_FIELDS.get(key) : undefined;
      const at: PathNode = { parent: item.at, segment };
      let oracleValue = leftObject[key];
      if (field === "sourceSpan") {
        // EVIDENCE: validation: a span field of a runtime record holds a source span.
        const span = correspondence.sourceSpan(oracleValue as SourceSpan);
        if (span === undefined)
          throw new MappingFailure(pathOf(at), field, renderValue(oracleValue));
        oracleValue = span;
      }
      work.push({
        oracle: oracleValue,
        candidate: rightObject[key],
        at,
        position:
          field === "instruction" || field === "temporary"
            ? field
            : field === undefined
              ? item.position
              : null,
      });
    }
  }
  return { equal: mismatches.length === 0, mismatches, truncated: false };
}

/** The most mismatches a comparison reports: `limit` when it is a positive safe integer, 10 when it is absent. */
export function mismatchLimit(limit: number | undefined): number {
  if (limit === undefined) return 10;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError(`A mismatch limit is a positive safe integer, not ${String(limit)}`);
  return limit;
}

/** The harness's writing could not write a value: the record has no verdict, and the pair is a serializer failure. */
export class SerializerFailure extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SerializerFailure";
  }
}

/**
 * Plain data as JSON text, written iteratively, the harness's transport and digest format. It differs from
 * `JSON.stringify` in one place: negative zero is written `-0`, a valid JSON number that `JSON.parse` reads back as
 * `-0`, so a signed-zero difference never hashes equal. `sortKeys` writes object keys in code-unit order. An object
 * property whose value is `undefined` is left out, and an array element that is `undefined` is `null`, as in JSON.
 * Throws `SerializerFailure` for a cycle, a non-finite number, or a value outside plain data.
 */
export function canonicalText(
  value: unknown,
  options: { readonly sortKeys?: boolean } = {},
): string {
  try {
    return writeCanonical(value, options.sortKeys === true);
  } catch (error) {
    if (error instanceof SerializerFailure) throw error;
    throw new SerializerFailure(`canonicalText failed: ${String(error)}`, { cause: error });
  }
}

function writeCanonical(value: unknown, sortKeys: boolean): string {
  const parts: string[] = [];
  interface Frame {
    readonly value: object;
    /** An array's elements, or `null` for an object. */
    readonly items: readonly unknown[] | null;
    readonly record: Readonly<Record<string, unknown>>;
    readonly keys: readonly string[];
    index: number;
    wrote: boolean;
  }
  const stack: Frame[] = [];
  const open = new Set<object>();
  /** Writes a scalar, or opens a frame for a container. Returns whether something was written. */
  const enter = (item: unknown): boolean => {
    if (item === null) parts.push("null");
    else if (typeof item === "boolean") parts.push(item ? "true" : "false");
    else if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new SerializerFailure(`${item} is not a JSON number.`);
      parts.push(Object.is(item, -0) ? "-0" : String(item));
    } else if (typeof item === "string") parts.push(JSON.stringify(item));
    else if (typeof item === "object") {
      if (open.has(item)) throw new SerializerFailure("The value is cyclic.");
      const array = Array.isArray(item);
      // EVIDENCE: validation: `item` is a non-null object, read only by its own enumerable keys.
      const record = item as Readonly<Record<string, unknown>>;
      if (!array && !isPlainObject(record))
        throw new SerializerFailure("An object with a prototype is not plain data.");
      const keys = array ? [] : Object.keys(record);
      if (sortKeys) keys.sort();
      open.add(item);
      parts.push(array ? "[" : "{");
      stack.push({
        value: item,
        items: Array.isArray(item) ? item : null,
        record,
        keys,
        index: 0,
        wrote: false,
      });
    } else throw new SerializerFailure(`A ${typeof item} is not plain data.`);
    return true;
  };
  enter(value);
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const items = frame.items;
    if (items !== null) {
      if (frame.index < items.length) {
        if (frame.index > 0) parts.push(",");
        const item = items[frame.index];
        frame.index += 1;
        enter(item === undefined ? null : item);
        continue;
      }
    } else if (frame.index < frame.keys.length) {
      const key = frame.keys[frame.index]!;
      frame.index += 1;
      const item = frame.record[key];
      if (item === undefined) continue;
      if (frame.wrote) parts.push(",");
      frame.wrote = true;
      parts.push(JSON.stringify(key), ":");
      enter(item);
      continue;
    }
    parts.push(items !== null ? "]" : "}");
    open.delete(frame.value);
    stack.pop();
  }
  return parts.join("");
}

/** The SHA-256 of `canonicalText(value)`. */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalText(value)).digest("hex");
}

/*
 * Deep runtime values, built iteratively, for the depth witnesses.
 */

/** `depth` lists, each holding the next, around `leaf`. */
export function deepList(
  depth: number,
  leaf: SerializableRuntimeValue = 0,
): SerializableRuntimeValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) value = { kind: "list", items: [value] };
  return value;
}

/**
 * `depth` sets, each holding the next and an integer of its own level counted from 1, around `leaf`: with the default
 * leaf every set's two members differ, so the value is valid.
 */
export function deepSetChain(
  depth: number,
  leaf: SerializableRuntimeValue = 0,
): SerializableRuntimeValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) value = { kind: "set", items: [level + 1, value] };
  return value;
}

/**
 * A set of `width` distinct integers in a fixed, non-sorted insertion order (`(index * 7) mod width`; `width` is not a
 * multiple of 7), and with `duplicateAt`, the same set given with its member at that position given a
 * second time at the end: a value an admission must reject or deduplicate, never silently reorder.
 */
export function wideSet(width: number, duplicateAt?: number): SerializableRuntimeValue {
  if (width % 7 === 0) throw new RangeError("wideSet's width must not be a multiple of 7.");
  const items: SerializableRuntimeValue[] = [];
  for (let index = 0; index < width; index += 1) items.push((index * 7) % width);
  if (duplicateAt !== undefined) items.push(items[duplicateAt]!);
  return { kind: "set", items };
}

/** `depth` levels cycling through list, object, dict and set, around `leaf`. */
export function mixedNest(
  depth: number,
  leaf: SerializableRuntimeValue = 0,
): SerializableRuntimeValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    switch (level % 4) {
      case 0:
        value = { kind: "list", items: [value] };
        break;
      case 1:
        value = { kind: "object", properties: [{ name: "inner", value }] };
        break;
      case 2:
        value = { kind: "dict", entries: [{ key: "inner", value }] };
        break;
      default:
        value = { kind: "set", items: [value] };
    }
  }
  return value;
}
