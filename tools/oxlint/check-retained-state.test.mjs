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

test("a private field is a readonly `Retained` collection, exposed by its class's `hidden`, or refused (#1072)", () => {
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
        "    Retained.owner(this, 'Owner', (owner) => ({ lazy: owner.#lazy, size: owner.#size?.size }));",
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
      ].join("\n"),
    ),
    [4, 5, 6, 15, 23, 26],
  );
});
