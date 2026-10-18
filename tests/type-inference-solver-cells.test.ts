import assert from "node:assert/strict";
import test from "node:test";

import { Cells } from "../src/type-inference/solver/cells.js";
import { TypeTable } from "../src/type-inference/solver/types.js";

/**
 * The cells of the solver (O4 stage 3a, work note §3.2): what `add` normalizes, what identity an item has, which
 * merges count as a change, and how a change under a cell reaches the cells that hold the value.
 */

const INTEGER = { kind: "atom", name: "integer" } as const;
const STRING = { kind: "atom", name: "string" } as const;

test("a union contributes its members as members of one permitted union; null, never and unknown normalize", () => {
  const table = new TypeTable();
  const cells = new Cells(table, 3);
  const union = table.internTerm({ kind: "union", members: [INTEGER, STRING] });
  assert.equal(cells.add(0, { tag: "w", type: union, pos: [7, 7] }), true);
  assert.deepEqual(
    cells.items(0).map((item) => [item.tag, item.group, table.node(item.type!).kind]),
    [
      ["m", "u@7", "atom"],
      ["m", "u@7", "atom"],
    ],
  );
  assert.equal(cells.add(1, { tag: "w", type: union, group: "written:1", pos: [3, 3] }), true);
  assert.deepEqual(
    cells.items(1).map((item) => item.group),
    ["written:1", "written:1"],
  );
  assert.equal(
    cells.add(2, { tag: "w", type: table.internTerm({ kind: "atom", name: "null" }), pos: [1, 1] }),
    true,
  );
  assert.equal(
    cells.add(2, { tag: "w", type: table.internTerm({ kind: "never" }), pos: [1, 1] }),
    false,
  );
  assert.equal(
    cells.add(2, {
      tag: "w",
      type: table.internTerm({ kind: "dynamic", why: "json" }),
      pos: [2, 2],
    }),
    true,
  );
  assert.deepEqual(
    cells.items(2).map((item) => [item.tag, item.why]),
    [
      ["n", undefined],
      ["d", "unknown"],
    ],
  );
});

test("a structural type becomes an item over this cell's derived part cells, one part cell per path", () => {
  const table = new TypeTable();
  const cells = new Cells(table, 1);
  const list = table.internTerm({ kind: "list", element: { kind: "list", element: INTEGER } });
  assert.equal(cells.add(0, { tag: "w", type: list, pos: [4, 4] }), true);
  const outer = cells.items(0)[0]!;
  assert.equal(outer.ctor, "list");
  const element = outer.parts!.element!;
  assert.equal(cells.name(element), "0/element");
  const inner = cells.items(element)[0]!;
  assert.equal(inner.ctor, "list");
  assert.equal(cells.name(inner.parts!.element!), "0/element/element");
  assert.equal(table.node(cells.items(inner.parts!.element!)[0]!.type!).kind, "atom");
  // the same type again is the same item: nothing changes
  assert.equal(cells.add(0, { tag: "w", type: list, pos: [9, 9] }), false);
  const object = table.internTerm({ kind: "object", properties: [{ name: "a", type: INTEGER }] });
  assert.equal(cells.add(0, { tag: "w", type: object, pos: [5, 5] }), true);
  const item = cells.items(0).find((it) => it.ctor === "object")!;
  assert.equal(cells.name(item.parts!.props!.get("a")!), "0/a");
});

test("identity ignores the position; an earlier position and a new declaration mark are changes", () => {
  const table = new TypeTable();
  const cells = new Cells(table, 1);
  const integer = table.internTerm(INTEGER);
  assert.equal(cells.add(0, { tag: "w", type: integer, pos: [9, 9] }), true);
  assert.equal(
    cells.add(0, { tag: "w", type: integer, pos: [12, 3] }),
    false,
    "a later site adds nothing",
  );
  assert.equal(
    cells.add(0, { tag: "w", type: integer, pos: [9, 2] }),
    true,
    "an earlier source site lowers",
  );
  assert.deepEqual(cells.items(0)[0]!.pos, [9, 2]);
  assert.equal(
    cells.add(0, { tag: "w", type: integer, pos: [9, 2], decl: true }),
    true,
    "the mark is a change",
  );
  assert.equal(cells.add(0, { tag: "w", type: integer, pos: [9, 2], decl: true }), false);
  assert.equal(cells.items(0).length, 1);
  // a member of another union is another item, as is the same type under another tag
  assert.equal(cells.add(0, { tag: "m", type: integer, group: "u1", pos: [1, 1] }), true);
  assert.equal(cells.add(0, { tag: "m", type: integer, group: "u2", pos: [1, 1] }), true);
  assert.equal(cells.items(0).length, 3);
});

test("a change in a part cell is reported for every cell that holds the value", () => {
  const table = new TypeTable();
  const cells = new Cells(table, 3);
  const part = cells.derived(0, "element");
  cells.add(0, { tag: "w", ctor: "list", parts: { element: part }, pos: [1, 1] });
  cells.add(1, { tag: "w", ctor: "list", parts: { element: part }, pos: [2, 1] }); // a copy sharing the part
  cells.drain();
  assert.equal(cells.dirty, false);
  cells.add(part, { tag: "w", type: table.internTerm(STRING), pos: [8, 8] });
  assert.deepEqual(cells.drain(), [0, 1, part]);
  assert.deepEqual(cells.drain(), []);
});
