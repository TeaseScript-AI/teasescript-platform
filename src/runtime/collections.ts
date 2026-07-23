import type { SourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import type { RandomSource } from "./random.js";
import { isRuntimeList, isRuntimeSet } from "./value-guards.js";
import {
  addSetValue,
  cloneRuntimeValue,
  createRuntimeList,
  createRuntimeSet,
  removeSetValue,
  runtimeEquals,
  RuntimeCopyError,
  RuntimeEqualityError,
  RuntimeSetElementError,
  setContains,
  type RuntimeList,
  type RuntimeValue,
} from "./values.js";

export interface CollectionCallResult {
  readonly handled: boolean;
  readonly value: RuntimeValue;
}

export function callCollectionMethod(
  receiver: RuntimeValue,
  name: string,
  positional: readonly RuntimeValue[],
  named: Readonly<Record<string, RuntimeValue>>,
  span: SourceSpan,
): CollectionCallResult {
  if (!isRuntimeList(receiver) && !isRuntimeSet(receiver)) {
    return { handled: false, value: null };
  }
  if (Object.keys(named).length !== 0) {
    throw new RuntimeFault(
      "TSR015",
      "Collection methods accept positional arguments only.",
      span,
    );
  }
  try {
    if (isRuntimeSet(receiver)) {
      switch (name) {
        case "add":
          expectArgumentCount(positional, 1, span);
          addSetValue(receiver, positional[0]!);
          return handled(null);
        case "remove":
          expectArgumentCount(positional, 1, span);
          removeSetValue(receiver, positional[0]!);
          return handled(null);
        case "clear":
          expectArgumentCount(positional, 0, span);
          receiver.items.length = 0;
          return handled(null);
        case "contains":
          expectArgumentCount(positional, 1, span);
          return handled(setContains(receiver, positional[0]!));
        case "toList":
          expectArgumentCount(positional, 0, span);
          return handled(
            createRuntimeList(receiver.items.map(cloneRuntimeValue)),
          );
        default:
          return { handled: false, value: null };
      }
    }

    switch (name) {
      case "add":
        expectArgumentCount(positional, 1, span);
        receiver.items.push(cloneRuntimeValue(positional[0]!));
        return handled(null);
      case "remove": {
        expectArgumentCount(positional, 1, span);
        const index = findRuntimeValue(receiver.items, positional[0]!);
        if (index >= 0) receiver.items.splice(index, 1);
        return handled(null);
      }
      case "removeFirst":
        expectArgumentCount(positional, 0, span);
        receiver.items.shift();
        return handled(null);
      case "removeLast":
        expectArgumentCount(positional, 0, span);
        receiver.items.pop();
        return handled(null);
      case "clear":
        expectArgumentCount(positional, 0, span);
        receiver.items.length = 0;
        return handled(null);
      case "contains":
        expectArgumentCount(positional, 1, span);
        return handled(findRuntimeValue(receiver.items, positional[0]!) >= 0);
      case "toSet":
        expectArgumentCount(positional, 0, span);
        return handled(createRuntimeSet(receiver.items));
      default:
        return { handled: false, value: null };
    }
  } catch (error) {
    translateCollectionError(error, span);
  }
}

export function getCollectionProperty(
  value: RuntimeValue,
  name: string,
  span: SourceSpan,
  random: RandomSource,
): RuntimeValue {
  if (!isRuntimeList(value) && !isRuntimeSet(value)) {
    throw new RuntimeFault("TSR017", `Value has no property '${name}'.`, span);
  }
  switch (name) {
    case "length":
      return value.items.length;
    case "first":
      return collectionEndpoint(value.items, 0, name, span);
    case "last":
      return collectionEndpoint(
        value.items,
        value.items.length - 1,
        name,
        span,
      );
    case "random":
      return randomItem(value.items, span, random);
    default:
      throw new RuntimeFault(
        "TSR017",
        `Unknown collection property '${name}'.`,
        span,
      );
  }
}

export function randomItem(
  items: readonly RuntimeValue[],
  span: SourceSpan,
  randomSource: RandomSource,
): RuntimeValue {
  if (items.length === 0) {
    throw new RuntimeFault(
      "TSR019",
      "Cannot select '.random' from an empty collection.",
      span,
    );
  }
  const random = randomSource.next();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new RuntimeFault(
      "TSR020",
      "The injected random source must return a number in [0, 1).",
      span,
    );
  }
  return items[Math.floor(random * items.length)]!;
}

export function assertListIndex(
  list: RuntimeList,
  index: number,
  span: SourceSpan,
): void {
  if (index < 0 || index >= list.items.length) {
    throw new RuntimeFault(
      "TSR025",
      `List index ${index} is outside the valid range.`,
      span,
    );
  }
}

function handled(value: RuntimeValue): CollectionCallResult {
  return { handled: true, value };
}

function collectionEndpoint(
  items: readonly RuntimeValue[],
  index: number,
  name: string,
  span: SourceSpan,
): RuntimeValue {
  if (items.length === 0) {
    throw new RuntimeFault(
      "TSR018",
      `Cannot read '.${name}' from an empty collection.`,
      span,
    );
  }
  return items[index]!;
}

function expectArgumentCount(
  values: readonly RuntimeValue[],
  expected: number,
  span: SourceSpan,
): void {
  if (values.length !== expected) {
    throw new RuntimeFault(
      "TSR028",
      `Expected ${expected} positional argument(s), received ${values.length}.`,
      span,
    );
  }
}

function findRuntimeValue(
  items: readonly RuntimeValue[],
  value: RuntimeValue,
): number {
  for (let index = 0; index < items.length; index += 1) {
    if (runtimeEquals(items[index]!, value)) return index;
  }
  return -1;
}

function translateCollectionError(error: unknown, span: SourceSpan): never {
  if (error instanceof RuntimeEqualityError) {
    throw new RuntimeFault("TSR029", error.message, span);
  }
  if (error instanceof RuntimeCopyError) {
    throw new RuntimeFault("TSR031", error.message, span);
  }
  if (error instanceof RuntimeSetElementError) {
    throw new RuntimeFault("TSR032", error.message, span);
  }
  throw error;
}
