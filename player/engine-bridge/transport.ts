import { createWorklist, type Worklist } from "../../src/external-data-capture.js";
import { BRIDGE_VERSION } from "./protocol.js";

/*
 * How a bridge message crosses a structured-clone port at any depth (#1877). Native clone recurses, and its limit
 * differs per engine, thread and direction: what one side serializes, the other may fail to deserialize, which loses
 * the Worker. So the sender measures each message:
 *
 * - nested at most `NATIVE_NESTING` levels through own properties, and acyclic, it crosses as it is;
 * - deeper or cyclic, it crosses as a flat form: one shallow shell per object and a link per nested object, which the
 *   receiver rebuilds iteratively. The flat form is built from the sender's own native clone of the message, so native
 *   clone still reads, refuses and normalizes it as before. Only when that clone overflows the sender's stack is the
 *   message itself flattened.
 *
 * A bridge message is data: the bridge promises nothing about accessors, which the measure reads too. A Proxy reached
 * only after the sender's native clone overflowed crosses as its data; a page cannot detect one. What another kind of
 * object holds (a `Map`'s entries, an `Error`'s cause) is cloned natively and not measured.
 */

/** A native stack overflow, as `checkpoint-json.ts` tells it: a `RangeError` in V8 and JavaScriptCore, an `InternalError` in SpiderMonkey. */
function isStackExhaustion(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error.name === "RangeError" && /call stack/i.test(error.message)) ||
      (error.name === "InternalError" && /recursion/i.test(error.message)))
  );
}

/** How deep a message may nest and still cross as it is: about a sixth of the smallest native limit measured. */
export const NATIVE_NESTING = 256;

const FLAT_KIND = "nested";
const PLACEHOLDER = 0;
const FLAT_KEYS = ["v", "kind", "nodes", "links"];

/** Any object of a message, read through its own enumerable string keys, whose values are unvalidated data. */
type Node = Readonly<Record<string, unknown>>;

/** The flat form of a deep message: `links` holds `parent, key, child` triples of `nodes` indices. */
interface FlatMessage {
  readonly v: typeof BRIDGE_VERSION;
  readonly kind: typeof FLAT_KIND;
  readonly nodes: (unknown[] | Record<string, unknown>)[];
  readonly links: (number | string)[];
}

/** What the measure walks: every object but a buffer view, which native clone copies by its bytes, not its properties. */
const isWalked = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !ArrayBuffer.isView(value);

/**
 * Whether `root` nests deeper than `NATIVE_NESTING` levels through own enumerable keys, or holds a cycle. It walks
 * every object through those keys without classifying it, so through them it never counts fewer levels than native
 * clone recurses through; what another kind of object holds (a `Map`'s entries) is not measured (see the header).
 * Heights are memoized per object, so a shared object is walked once; the longest chain bounds any traversal order.
 */
function nestsDeeper(root: unknown): boolean {
  if (!isWalked(root)) return false;
  const heights = new Map<Node, number>();
  const nodes = createWorklist<Node | undefined>();
  const keys = createWorklist<readonly string[] | undefined>();
  const next = createWorklist<number>();
  const best = createWorklist<number>();
  let top = 0;
  const enter = (node: Node): void => {
    nodes[top] = node;
    keys[top] = Object.keys(node);
    next[top] = 0;
    best[top] = 0;
    top += 1;
    heights.set(node, -1);
  };
  enter(root);
  while (top > 0) {
    const at = top - 1;
    const node = nodes[at]!;
    const names = keys[at]!;
    const index = next[at]!;
    if (index < names.length) {
      next[at] = index + 1;
      const child = node[names[index]!];
      if (!isWalked(child)) continue;
      const known = heights.get(child);
      if (known === -1) return true;
      if (known !== undefined) {
        if (known > best[at]!) best[at] = known;
        if (top + known > NATIVE_NESTING) return true;
        continue;
      }
      if (top >= NATIVE_NESTING) return true;
      enter(child);
      continue;
    }
    const height = best[at]! + 1;
    heights.set(node, height);
    top -= 1;
    nodes[top] = undefined;
    keys[top] = undefined;
    if (top > 0 && height > best[top - 1]!) best[top - 1] = height;
  }
  return false;
}

/** In native clone's own output, the objects it copied property by property: arrays and `Object.prototype` objects. */
const isClonedContainer = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);

const functionText = Function.prototype.toString;
const NATIVE_FUNCTION = /^function [\w$]*\(\) \{\s*\[native code\]\s*\}$/;
/** Per prototype: whether its own `constructor` reads as a built-in or platform function. */
const nativePrototypes = new WeakMap<object, boolean>();

/**
 * In a message as its sender built it, whether native clone copies `value` property by property: an array, or an object
 * with no built-in or platform type in its prototype chain. A chain's root (some realm's `Object.prototype`) is not
 * asked, so a plain object or class instance of any realm counts. A heuristic: it assumes unaltered prototypes and
 * constructors, and it decides only messages that the sender's native clone could not read at all.
 */
function isOriginalContainer(value: unknown): value is Node {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return true;
  for (
    let prototype: unknown = Object.getPrototypeOf(value);
    typeof prototype === "object" && prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    if (Object.getPrototypeOf(prototype) === null) return true;
    let native = nativePrototypes.get(prototype);
    if (native === undefined) {
      const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      native =
        typeof constructor === "function" && NATIVE_FUNCTION.test(functionText.call(constructor));
      nativePrototypes.set(prototype, native);
    }
    if (native) return false;
  }
  return true;
}

/** A shell for `value`'s own keys, without a prototype, so no ambient setter sees what is written to it. */
function shellOf(value: Node): unknown[] | Record<string, unknown> {
  if (Array.isArray(value)) {
    const shell = new Array<unknown>(value.length);
    Object.setPrototypeOf(shell, null);
    return shell;
  }
  const shell: Record<string, unknown> = Object.create(null);
  return shell;
}

/** Sets `shell`'s own key `key`, an index or name, as an ordinary data property. */
function define(shell: unknown[] | Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(shell, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** `root` as a flat form, with `isContainer` deciding which objects become shells and which stay leaves. */
function flatten(root: Node, isContainer: (value: unknown) => value is Node): FlatMessage {
  const ids = new Map<Node, number>();
  const nodes = createWorklist<unknown[] | Record<string, unknown>>();
  const sources = createWorklist<Node | undefined>();
  const links = createWorklist<number | string>();
  let nodeCount = 0;
  let linkCount = 0;
  const idOf = (value: Node): number => {
    const known = ids.get(value);
    if (known !== undefined) return known;
    ids.set(value, nodeCount);
    nodes[nodeCount] = shellOf(value);
    sources[nodeCount] = value;
    return nodeCount++;
  };
  idOf(root);
  for (let id = 0; id < nodeCount; id += 1) {
    const value = sources[id]!;
    sources[id] = undefined;
    const shell = nodes[id]!;
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (isContainer(child)) {
        define(shell, key, PLACEHOLDER);
        links[linkCount++] = id;
        links[linkCount++] = key;
        links[linkCount++] = idOf(child);
      } else define(shell, key, child);
    }
  }
  return {
    v: BRIDGE_VERSION,
    kind: FLAT_KIND,
    nodes: arrayOf(nodes, nodeCount),
    links: arrayOf(links, linkCount),
  };
}

/** The first `count` items of `list` as an array without a prototype, which native clone carries as an array. */
function arrayOf<T>(list: Worklist<T>, count: number): T[] {
  const array = new Array<T>(count);
  Object.setPrototypeOf(array, null);
  for (let index = 0; index < count; index += 1) array[index] = list[index]!;
  return array;
}

/**
 * `message` as its port should clone it: itself, or a flat form when it nests too deep. A measure that throws (a revoked
 * Proxy) leaves `message` as it is, for native clone to decide. Throws what native clone throws for a deep message it
 * refuses, as a port's clone would.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: a message stays unvalidated data until its receiver's envelope reader checks it.
export function encodeMessage(message: unknown): unknown {
  let deep: boolean;
  try {
    deep = nestsDeeper(message);
  } catch {
    return message;
  }
  if (!deep || !isWalked(message)) return message;
  let copy: unknown;
  try {
    copy = structuredClone(message);
  } catch (error) {
    if (!isStackExhaustion(error)) throw error;
    return flatten(message, isOriginalContainer);
  }
  return isClonedContainer(copy) ? flatten(copy, isClonedContainer) : copy;
}

const isIndex = (value: unknown, count: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < count;

/** The message `data` carries: decoded from a well-formed flat form, else `data` itself. Checks all before linking. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: a received message stays unvalidated data until the envelope reader after this checks it.
export function decodeMessage(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  if (!("kind" in data) || data.kind !== FLAT_KIND || !("v" in data) || data.v !== BRIDGE_VERSION)
    return data;
  const own = Object.keys(data);
  if (own.length !== FLAT_KEYS.length || !FLAT_KEYS.every((key) => own.includes(key))) return data;
  const nodes: unknown = "nodes" in data ? data.nodes : undefined;
  const links: unknown = "links" in data ? data.links : undefined;
  if (!Array.isArray(nodes) || !Array.isArray(links)) return data;
  const count = nodes.length;
  if (count === 0 || links.length % 3 !== 0) return data;
  for (let index = 0; index < count; index += 1) if (!isClonedContainer(nodes[index])) return data;
  for (let index = 0; index < links.length; index += 3) {
    const parent: unknown = links[index];
    const key: unknown = links[index + 1];
    if (!isIndex(parent, count) || !isIndex(links[index + 2], count) || typeof key !== "string")
      return data;
    const slot = Object.getOwnPropertyDescriptor(nodes[parent], key);
    if (slot === undefined || !slot.enumerable || !("value" in slot) || slot.value !== PLACEHOLDER)
      return data;
  }
  for (let index = 0; index < links.length; index += 3) {
    // EVIDENCE: validation: the loop above checked each triple's indices, key and placeholder slot.
    const parent = nodes[links[index] as number] as Record<string, unknown>;
    // EVIDENCE: validation: the loop above checked each triple's indices, key and placeholder slot.
    parent[links[index + 1] as string] = nodes[links[index + 2] as number];
  }
  return nodes[0];
}
