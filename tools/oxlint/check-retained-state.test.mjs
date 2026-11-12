import assert from "node:assert/strict";
import test from "node:test";

import { checkRetainedState, retainedStateDiagnostics } from "./check-retained-state.mjs";
import { repositoryRoot } from "./files.mjs";

/** The lines the check reports in one scratch file's `text`, checked whole or at its top level only. */
const reported = (text, level = "file") =>
  retainedStateDiagnostics([{ file: "src/type-inference/core/scratch.ts", text, level }])
    .map(({ line }) => line)
    .sort((x, y) => x - y);

test("the type core's owners make every collection they keep through `Retained` (#1072)", () => {
  assert.deepEqual(checkRetainedState(repositoryRoot), []);
});

test("a collection made where an owner can keep it is refused, in every such place (#1072)", () => {
  assert.deepEqual(
    reported(
      [
        "class Owner {",
        "  readonly byKey = new Map<string, number>();",
        "  readonly #hidden = new Set<string>();",
        "  readonly pair = [new WeakMap<object, number>(), new WeakMap<object, number>()];",
        "  readonly caches = { summaries: new WeakSet<object>() };",
        "  public constructor(readonly given: Map<string, number> = new Map()) {",
        "    this.later = new Map();",
        "  }",
        "  public fill(outer: Map<string, Map<string, number>>, key: string): void {",
        "    this.lazy ??= new Set();",
        "    this.nested = { inner: new Map() };",
        "    captured = { passes: new WeakMap() };",
        "  }",
        "}",
        "const mutable = new Map<string, number>();",
        "let table = new Set([1, 2]);",
        "let captured: object | null = null;",
        "function chained(owner: { slots: Map<string, number>[] }): void {",
        "  let steps: Map<string, number> | undefined;",
        "  owner.slots[0] = steps = new Map();",
        "}",
      ].join("\n"),
    ),
    // (line 3's private field twice: a collection kept as made, and a private field the recorder cannot see)
    [2, 3, 3, 4, 4, 5, 6, 7, 10, 11, 12, 15, 16, 20],
  );
});

test("a collection that stands where no owner keeps it as made passes (#1072)", () => {
  assert.deepEqual(
    reported(
      [
        "const TABLE: ReadonlySet<string> = new Set(['a', 'b']);",
        "const ROWS: ReadonlyMap<string, number> = new Map([['a', 1]]);",
        "function local(list: readonly string[], seen?: Set<string>): number {",
        "  const counts = new Map<string, number>();",
        "  const unique = seen ?? new Set<string>();",
        "  for (const each of new Set(list)) counts.set(each, 1);",
        "  use(new Map(counts), [...new Set(list)]);",
        "  if (new Set(list).has('a')) return counts.size;",
        "  return (new Map() as Map<string, number>).size;",
        "}",
        "const made = (): Set<string> => new Set();",
        "function copy(rows = new Map<string, number>()): Map<string, number> {",
        "  return new Map(rows);",
        "}",
        "function fill(outer: Map<string, Map<string, number>>, key: string): void {",
        "  let inner = outer.get(key);",
        "  if (inner === undefined) outer.set(key, (inner = new Map()));",
        "  outer.set(key, { list: [new Set<string>()] } as never);",
        "}",
        "function chosen(flag: boolean): Map<string, number> {",
        "  const map = flag ? new Map<string, number>() : new Map<string, number>([['b', 2]]);",
        "  return map;",
        "}",
      ].join("\n"),
    ),
    [],
  );
});

test("a file scoped at its top level is checked there only: its classes keep no retained state (#1072)", () => {
  const text = [
    "const memos = new WeakMap<object, number>();",
    "class Answers {",
    "  readonly #stores = new Map<string, number>();",
    "}",
  ].join("\n");
  assert.deepEqual(reported(text, "module"), [1]);
  assert.deepEqual(reported(text, "file"), [1, 3, 3]);
});

test("a private field is readonly, a `Retained` kind or exposed by its class's `hidden`, or refused (#1072)", () => {
  assert.deepEqual(
    reported(
      [
        "class Owner {",
        "  readonly #made = Retained.map<string, number>('Owner.#made');",
        "  #lazy: Map<string, number> | null = null;",
        "  #size: Set<string> | null = null;",
        "  readonly #given: Owner | null;",
        "  #slot = Retained.set<string>('Owner.#slot');",
        "  public constructor(given: Owner | null) {",
        "    this.#given = given;",
        "    Retained.owner(this, 'Owner', (owner) => ({ lazy: owner.#lazy, size: owner.#size?.size, given: owner.#given }));",
        "  }",
        "}",
        "class Static {",
        "  static readonly #hidden = (owner: Static) => ({ count: owner.#count });",
        "  #count = 0;",
        "  #other = 0;",
        "  public constructor() {",
        "    Retained.owner(this, 'Static', Static.#hidden);",
        "  }",
        "}",
        "class GuardIndex {",
        "  #narrowing = null;",
        "  #queries = null;",
        "  #other = null;",
        "}",
        "class Unregistered {",
        "  #state = 0;",
        "}",
        "class Held {",
        "  readonly #payload = Retained.held(this, new Map<string, number>());",
        "}",
      ].join("\n"),
    ),
    [3, 4, 6, 14, 15, 23, 26, 29],
  );
});

/** The lines the guard lines report in `text` as a core file of `level`, or as a test helper. */
const guarded = (text, level = "file") =>
  retainedStateDiagnostics([
    {
      file: level === "helper" ? "tests/helpers/scratch.ts" : "src/type-inference/core/scratch.ts",
      text,
      level,
    },
  ])
    .map(({ line }) => line)
    .sort((x, y) => x - y);

test("a native writer taken from a prototype is refused in any position, in core files and test helpers (#1072 R24)", () => {
  const lines = [
    "const bound = Map.prototype.set.bind(map);",
    "Set.prototype.add.call(set, 1);",
    "Array.prototype.push.apply(list, items);",
    "const writers = WeakMap.prototype;",
    "Reflect.get(Map.prototype, 'set');",
    "const index = Map.prototype['set'];",
    "WeakSet.prototype.delete.call(weak, key);",
    "const { set } = Map.prototype;",
    "const sorted = Array.prototype.slice.call(list);",
    "const read = Map.prototype.get.call(map, key);",
    "const known = Set.prototype.has;",
  ].join("\n");
  for (const level of ["file", "module", null, "helper"])
    assert.deepEqual(guarded(lines, level), [1, 2, 3, 4, 5, 6, 7, 8], String(level));
});

test("a maker is given a fresh literal or nothing (#1072 R25)", () => {
  assert.deepEqual(
    guarded(
      [
        "const fields = { n: 0 };",
        "Retained.record('a', fields);",
        "Retained.record('b', { n: 0 });",
        "Retained.record('c');",
        "Retained.arena('d', items);",
        "Retained.arena('e', [0]);",
        "Retained.arena('f');",
        "Retained.array('g', [...items]);",
        "Retained.array('h', []);",
        "Retained.array('i', [], extra);",
      ].join("\n"),
    ),
    [2, 4, 5, 10],
  );
});

test("`Reflect.set`, a frozen-state branch, `structuredClone` and an in-place definition are refused in the checked core files (#1072 R21)", () => {
  const lines = [
    "Reflect.set(value, 'n', 1);",
    "if (Object.isFrozen(value)) skip();",
    "Object.isSealed(value);",
    "Object.isExtensible(value);",
    "const copy = structuredClone(value);",
    "Reflect.get(value, 'n');",
    "Object.defineProperty(value, 'n', { get: () => 1 });",
    "Object.defineProperties(value, {});",
    "Reflect.defineProperty(value, 'n', { value: 1 });",
  ].join("\n");
  assert.deepEqual(guarded(lines, "file"), [1, 2, 3, 4, 5, 7, 8, 9]);
  assert.deepEqual(guarded(lines, "module"), [1, 2, 3, 4, 5, 7, 8, 9]);
  assert.deepEqual(guarded(lines, null), []);
  assert.deepEqual(guarded(lines, "helper"), []);
});

test("a function is registered right below the comment naming its captures (#1072 R26)", () => {
  assert.deepEqual(
    guarded(
      [
        "// (#1072 R26: captures `frontier`, an owner)",
        "const a = Retained.closure('a', () => frontier);",
        "const b = Retained.closure('b', () => frontier);",
        "// (#1072 R26: as `a`)",
        "const c = Retained.closure('c', () => frontier);",
        "// (#1072 R26: captures `frontier`, an owner, and",
        "// `steps`, fixed when it is made)",
        "use(Retained.closure('d', () => steps));",
        "// a comment naming nothing",
        "use(Retained.closure('e', () => steps));",
      ].join("\n"),
    ),
    [3, 10],
  );
});
