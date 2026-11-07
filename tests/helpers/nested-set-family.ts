import type { SerializableRuntimeValue } from "../../src/index.js";
import { COLLIDING_A, COLLIDING_B } from "./colliding-texts.js";

/*
 * A seeded family of nested lists, sets, objects and dicts for set validation (#1904): equal copies with their sets',
 * objects' and dicts' parts reordered, the colliding texts, signed zero and timer handles; and an oracle of its
 * duplicates written independently of the runtime's keys.
 */

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});
const set = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "set",
  items,
});
const object = (...parts: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "object",
  properties: parts.map(([name, value]) => ({ name, value })),
});
const dict = (...parts: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "dict",
  entries: parts.map(([key, value]) => ({ key, value })),
});

/** `count` values `depth` levels deep at most, from `seed`; every call draws from its own random state. */
export function* nestedSetFamily(
  seed: number,
  count: number,
  depth = 5,
): Generator<SerializableRuntimeValue> {
  let state = seed;
  const random = (): number => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const shuffled = <T>(items: readonly T[]): T[] => {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [result[index], result[other]] = [result[other]!, result[index]!];
    }
    return result;
  };
  const leaves: SerializableRuntimeValue[] = [0, -0, 1, "1", true, null, COLLIDING_A, COLLIDING_B];
  // An equal value: the same parts, with every set's, object's, and dict's parts in another order.
  const reordered = (value: SerializableRuntimeValue): SerializableRuntimeValue => {
    if (value === null || typeof value !== "object") return value;
    switch (value.kind) {
      case "list":
        return list(...value.items.map(reordered));
      case "set":
        return set(...shuffled(value.items.map(reordered)));
      case "object":
        return object(
          ...shuffled(
            value.properties.map((part): [string, SerializableRuntimeValue] => [
              part.name,
              reordered(part.value),
            ]),
          ),
        );
      case "dict":
        return dict(
          ...shuffled(
            value.entries.map((part): [string, SerializableRuntimeValue] => [
              part.key,
              reordered(part.value),
            ]),
          ),
        );
      default:
        return { ...value };
    }
  };
  const generated = (levels: number): SerializableRuntimeValue => {
    if (levels === 0 || random() < 0.25)
      return random() < 0.1
        ? { kind: "timerHandle", timerId: 1 + Math.floor(random() * 2) }
        : pick(leaves);
    const parts = Array.from({ length: Math.floor(random() * 4) }, () => generated(levels - 1));
    if (parts.length > 0 && random() < 0.3) parts.push(reordered(pick(parts)));
    const names = shuffled(["p", "q", "r", "s", COLLIDING_A]);
    switch (pick(["list", "set", "set", "object", "dict"])) {
      case "list":
        return list(...parts);
      case "set":
        return set(...parts);
      case "object":
        return object(
          ...parts.map((part, index): [string, SerializableRuntimeValue] => [names[index]!, part]),
        );
      default:
        return dict(
          ...parts.map((part, index): [string, SerializableRuntimeValue] => [names[index]!, part]),
        );
    }
  };
  for (let index = 0; index < count; index += 1) yield generated(depth);
}

/** A canonical text of a family value: a set's, object's, and dict's parts sorted, `-0` as `0`. */
function canonical(value: SerializableRuntimeValue): string {
  if (value === null || typeof value !== "object")
    return typeof value === "number" ? `n${value === 0 ? 0 : value}` : JSON.stringify(value);
  switch (value.kind) {
    case "list":
      return `L(${value.items.map(canonical).join(",")})`;
    case "set":
      return `S(${value.items.map(canonical).sort().join(",")})`;
    case "object":
      return `O(${value.properties
        .map((part) => `${JSON.stringify(part.name)}=${canonical(part.value)}`)
        .sort()
        .join(",")})`;
    case "dict":
      return `D(${value.entries
        .map((part) => `${JSON.stringify(part.key)}=${canonical(part.value)}`)
        .sort()
        .join(",")})`;
    case "timerHandle":
      return `H${value.timerId}`;
    default:
      throw new Error(`unexpected ${value.kind}`);
  }
}

/**
 * The validator's message for the first set, in validation order (parts first, in order), with two members of one
 * canonical text, under `path`; or `null`.
 */
export function firstDuplicate(value: SerializableRuntimeValue, path = "$"): string | null {
  if (value === null || typeof value !== "object") return null;
  const parts: [SerializableRuntimeValue, string][] =
    value.kind === "list" || value.kind === "set"
      ? value.items.map((item, index) => [item, `${path}.items[${index}]`])
      : value.kind === "object"
        ? value.properties.map((part, index) => [part.value, `${path}.properties[${index}].value`])
        : value.kind === "dict"
          ? value.entries.map((part, index) => [part.value, `${path}.entries[${index}].value`])
          : [];
  for (const [part, partPath] of parts) {
    const found = firstDuplicate(part, partPath);
    if (found !== null) return found;
  }
  if (value.kind !== "set") return null;
  const texts = value.items.map(canonical);
  return texts.some((text, index) => texts.indexOf(text) < index)
    ? `${path}.items contains a duplicate member.`
    : null;
}

/** Whether a family value holds a timer handle, an identity only the runtime creates. */
export function holdsHandle(value: SerializableRuntimeValue): boolean {
  if (value === null || typeof value !== "object") return false;
  switch (value.kind) {
    case "timerHandle":
      return true;
    case "list":
    case "set":
      return value.items.some(holdsHandle);
    case "object":
      return value.properties.some((part) => holdsHandle(part.value));
    case "dict":
      return value.entries.some((part) => holdsHandle(part.value));
    default:
      return false;
  }
}
