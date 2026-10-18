import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ScalarTypeName } from "../src/ast.js";
import {
  assignedType,
  containsType,
  excludeType,
  isAssignable,
  isScalarKind,
  members,
  narrowTo,
  nonNullType,
  NULL_TYPE,
  openType,
  optional,
  PropertyTable,
  union,
  type ScalarValue,
  type StaticType,
} from "../src/static-types.js";
import { typeKey } from "../src/storage-types.js";
import type { TypeTerm } from "../src/type-inference/graph.js";
import { TypeTable, type TypeId } from "../src/type-inference/solver/types.js";
import { VALUE_KIND_NAMES, type ValueKind } from "../src/value-kinds.js";

// The type table of O4 stage 3a (work note §2) against the legacy's algebra in `static-types.ts`, over an enumerated
// catalog: every atom of the registry, null, unknown, never, restricted scalars, the collections of each atom, nested
// collections, objects, and unions, to depth three. The table computes every transfer through the legacy function, so
// what this pins is the conversion both ways: interning keeps the structure the legacy renders, and the legacy's answer
// for the converted types is its answer for the types the catalog builds.

interface Entry {
  readonly name: string;
  readonly type: StaticType;
}

const COLLECTION_KINDS: readonly ("list" | "set" | "dict")[] = ["list", "set", "dict"];

/**
 * The rendering of a type in the legacy's canonical form: `union` of one member normalizes the outer union it is given
 * (its members, `integer | number`, a member another includes), not every descendant; the catalog's unnormalized
 * entries are outer unions, which is what this oracle covers.
 */
function canonicalKey(type: StaticType): string {
  return key(union([type]));
}

const key = (type: StaticType): string => typeKey(type, true, true);

function scalar(name: ScalarTypeName, values?: readonly ScalarValue[]): StaticType {
  return values === undefined ? { kind: "scalar", name } : { kind: "scalar", name, values };
}

/** The type of a kind held without parts, or `undefined` for a kind with parts (a list, set, dict or object). */
function atomType(kind: ValueKind): StaticType | undefined {
  if (isScalarKind(kind)) return scalar(kind);
  if (kind === "null") return { kind: "null" };
  if (kind === "list" || kind === "set" || kind === "dict" || kind === "object") return undefined;
  return { kind };
}

function object(...properties: readonly (readonly [string, StaticType])[]): StaticType {
  return { kind: "object", properties: new PropertyTable(properties) };
}

/** A union as written, without the legacy's normalizing: the transfers meet it in that form too. */
function written(...types: StaticType[]): StaticType {
  return { kind: "union", members: types };
}

/** The catalog, built anew on each call: two calls give equal types that share no object. */
function catalog(): readonly Entry[] {
  const entries: Entry[] = [];
  const add = (name: string, type: StaticType): void => {
    entries.push({ name, type });
  };
  const atoms = VALUE_KIND_NAMES.filter((kind) => atomType(kind) !== undefined);
  for (const kind of atoms) add(kind, atomType(kind)!);
  add("unknown", { kind: "unknown" });
  add("never", { kind: "never" });
  add("integer{1|2}", scalar("integer", [1, 2]));
  add("number{1|2.5}", scalar("number", [1, 2.5]));
  add('string{"a"}', scalar("string", ["a"]));
  for (const kind of COLLECTION_KINDS)
    for (const atom of atoms) add(`${kind}<${atom}>`, { kind, element: atomType(atom)! });
  const nullableInteger = (): StaticType => union([scalar("integer"), { kind: "null" }]);
  add("list<unknown>", { kind: "list", element: { kind: "unknown" } });
  add("list<list<integer>>", {
    kind: "list",
    element: { kind: "list", element: scalar("integer") },
  });
  add("list<list<list<integer>>>", {
    kind: "list",
    element: { kind: "list", element: { kind: "list", element: scalar("integer") } },
  });
  add("list<(integer|null)>", { kind: "list", element: nullableInteger() });
  add("dict<list<string>>", { kind: "dict", element: { kind: "list", element: scalar("string") } });
  add("set<{a: integer}>", { kind: "set", element: object(["a", scalar("integer")]) });
  add("object", { kind: "object", properties: null });
  add("{}", object());
  add("{a: integer}", object(["a", scalar("integer")]));
  add("{a: number}", object(["a", scalar("number")]));
  add("{a: integer, b: string}", object(["a", scalar("integer")], ["b", scalar("string")]));
  add("{o: {a: integer}}", object(["o", object(["a", scalar("integer")])]));
  add("{a: (integer|null)}", object(["a", nullableInteger()]));
  add("{l: list<(integer|null)>}", object(["l", { kind: "list", element: nullableInteger() }]));
  add("written (integer|number)", written(scalar("integer"), scalar("number")));
  add("written (list<integer>|list<number>)", {
    kind: "union",
    members: [
      { kind: "list", element: scalar("integer") },
      { kind: "list", element: scalar("number") },
    ],
  });
  add("(integer|null)", nullableInteger());
  add("(number|null)", union([scalar("number"), { kind: "null" }]));
  add("(string|null)", union([scalar("string"), { kind: "null" }]));
  add("(integer|string|null)", union([scalar("integer"), scalar("string"), { kind: "null" }]));
  add("(boolean|duration|null)", union([scalar("boolean"), scalar("duration"), { kind: "null" }]));
  add(
    "(list<integer>|dict<string>)",
    union([
      { kind: "list", element: scalar("integer") },
      { kind: "dict", element: scalar("string") },
    ]),
  );
  add(
    "(list<integer>|null)",
    union([{ kind: "list", element: scalar("integer") }, { kind: "null" }]),
  );
  add("({a: integer}|null)", union([object(["a", scalar("integer")]), { kind: "null" }]));
  add(
    "({a: integer}|{b: string})",
    union([object(["a", scalar("integer")]), object(["b", scalar("string")])]),
  );
  add("(integer{1|2}|string)", union([scalar("integer", [1, 2]), scalar("string")]));
  add(
    "(list<(integer|null)>|string)",
    union([{ kind: "list", element: nullableInteger() }, scalar("string")]),
  );
  return entries;
}

/** The pairs of these 40 entries meet every transfer. */
const PAIRED = [
  "integer",
  "number",
  "string",
  "boolean",
  "duration",
  "range",
  "speaker",
  "null",
  "unknown",
  "never",
  "integer{1|2}",
  "number{1|2.5}",
  'string{"a"}',
  "list<integer>",
  "list<number>",
  "set<string>",
  "dict<integer>",
  "list<unknown>",
  "list<null>",
  "list<list<integer>>",
  "list<(integer|null)>",
  "dict<list<string>>",
  "set<{a: integer}>",
  "object",
  "{}",
  "{a: integer}",
  "{a: number}",
  "{a: integer, b: string}",
  "{o: {a: integer}}",
  "{a: (integer|null)}",
  "written (integer|number)",
  "written (list<integer>|list<number>)",
  "(integer|null)",
  "(number|null)",
  "(integer|string|null)",
  "(list<integer>|dict<string>)",
  "(list<integer>|null)",
  "({a: integer}|null)",
  "({a: integer}|{b: string})",
  "(integer{1|2}|string)",
];

/**
 * The legacy's answer with structurally equal union members kept once: where the legacy's `union` keeps two equal
 * objects that have property tables, an interned union holds their one id (the module comment of `types.ts`). The
 * legacy reaches that `union` from `narrowTo` and `assignedType` too, which join the parts they keep. Only that cause
 * is collapsed: a dropped member must hold an object with a property table.
 */
function collapsed(type: StaticType): StaticType {
  switch (type.kind) {
    case "list":
    case "set":
    case "dict":
      return { kind: type.kind, element: collapsed(type.element) };
    case "object":
      if (type.properties === null) return type;
      return {
        kind: "object",
        properties: new PropertyTable(
          [...type.properties].map(([name, value]): [string, StaticType] => [
            name,
            collapsed(value),
          ]),
        ),
      };
    case "union": {
      const kept = new Map<string, StaticType>();
      for (const member of type.members.map(collapsed)) {
        if (!kept.has(key(member))) kept.set(key(member), member);
        else
          assert.ok(
            containsType(member, (part) => part.kind === "object" && part.properties !== null),
            `the legacy repeats ${key(member)} in a union`,
          );
      }
      const unique = [...kept.values()];
      return unique.length === 1 ? unique[0]! : { kind: "union", members: unique };
    }
    default:
      return type;
  }
}

test("interning is structural and converts back to the same type", () => {
  const table = new TypeTable();
  const first = catalog();
  const second = catalog();
  const ids = first.map(({ type }) => table.intern(type));
  first.forEach(({ name, type }, index) => {
    const id = ids[index]!;
    assert.equal(table.intern(second[index]!.type), id, `${name}: a separately built equal type`);
    assert.equal(table.toStatic(id), table.toStatic(id), `${name}: one object per id`);
    assert.equal(table.intern(table.toStatic(id)), id, `${name}: back from its StaticType`);
    // The table interns a union in the legacy's canonical form (its own `union` of the members), so an entry written
    // unnormalized renders as the type it denotes; `canonicalKey` renders the catalog entry the same way.
    assert.equal(key(table.toStatic(id)), canonicalKey(type), `${name}: the structure it renders`);
  });
  // Equal ids exactly for equal structure (no catalog union has two members that render alike).
  for (let left = 0; left < first.length; left += 1)
    for (let right = 0; right < first.length; right += 1)
      assert.equal(
        ids[left] === ids[right],
        canonicalKey(first[left]!.type) === canonicalKey(first[right]!.type),
        `${first[left]!.name} and ${first[right]!.name}`,
      );
  const list = table.toStatic(table.intern({ kind: "list", element: scalar("integer") }));
  assert.ok(list.kind === "list");
  assert.equal(list.element, table.toStatic(table.intern(scalar("integer"))), "shared structure");
  assert.equal(table.intern(scalar("integer", [2, 1, 2])), table.intern(scalar("integer", [1, 2])));
  assert.equal(
    table.intern(written(scalar("string"), written(scalar("integer"), { kind: "null" }))),
    table.intern(written({ kind: "null" }, scalar("integer"), scalar("string"))),
    "a nested union is flattened and its members sorted",
  );
  assert.throws(() => table.intern(openType()), /undecided slot/);
});

test("every transfer gives the legacy's answer", () => {
  const table = new TypeTable();
  const entries = catalog();
  const legacy = catalog();
  const ids = entries.map(({ type }) => table.intern(type));
  const mismatches: string[] = [];
  const compare = (what: string, id: TypeId, expected: StaticType): void => {
    const actual = key(table.toStatic(id));
    const wanted = canonicalKey(collapsed(expected));
    if (actual !== wanted)
      mismatches.push(`${what}: the table gives ${actual}, the legacy ${wanted}`);
  };
  entries.forEach(({ name }, index) => {
    const id = ids[index]!;
    const type = legacy[index]!.type;
    compare(`alternatives(${name})`, table.alternatives([id]), union([type]));
    compare(`optional(${name})`, table.optional(id), optional(type));
    compare(`nonNull(${name})`, table.nonNull(id), nonNullType(type));
    const actual = table.members(id).map((member) => key(table.toStatic(member)));
    const expected = members(type).map(key);
    if (actual.sort().join(" ") !== expected.sort().join(" "))
      mismatches.push(`members(${name}): the table gives ${actual}, the legacy ${expected}`);
  });
  const paired = PAIRED.map((name) => {
    const index = entries.findIndex((entry) => entry.name === name);
    assert.ok(index >= 0, name);
    return { name, id: ids[index]!, type: legacy[index]!.type };
  });
  for (const left of paired)
    for (const right of paired) {
      const pair = `${left.name}, ${right.name}`;
      compare(
        `alternatives(${pair})`,
        table.alternatives([left.id, right.id]),
        union([left.type, right.type]),
      );
      compare(`narrow(${pair})`, table.narrow(left.id, right.id), narrowTo(left.type, right.type));
      compare(
        `exclude(${pair})`,
        table.exclude(left.id, right.id),
        excludeType(left.type, right.type),
      );
      compare(
        `assigned(${pair})`,
        table.assigned(left.id, right.id),
        assignedType(left.type, right.type),
      );
      if (table.fits(left.id, right.id) !== isAssignable(left.type, right.type))
        mismatches.push(`fits(${pair}): the table disagrees with isAssignable`);
    }
  // `unknown` would make the merge unknown.
  const known = paired.filter(({ name }) => name !== "unknown");
  compare(
    "alternatives(every paired entry but unknown)",
    table.alternatives(known.map(({ id }) => id)),
    union(known.map(({ type }) => type)),
  );
  assert.equal(table.node(table.alternatives([])).kind, "never");
  assert.deepEqual(mismatches, []);
});

test("alternatives hold structurally equal objects once", () => {
  // The legacy's `union` keeps both: no object with a property table includes another.
  const table = new TypeTable();
  const id = table.intern(object(["a", scalar("integer")]));
  assert.equal(table.alternatives([id, table.intern(object(["a", scalar("integer")]))]), id);
});

test("a term interns as the legacy converts the written type", () => {
  const table = new TypeTable();
  const atom = (name: ValueKind): TypeTerm => ({ kind: "atom", name });
  for (const kind of VALUE_KIND_NAMES) {
    const type = atomType(kind);
    if (type === undefined)
      assert.throws(() => table.internTerm(atom(kind)), /with its parts/, kind);
    else assert.equal(table.internTerm(atom(kind)), table.intern(type), kind);
  }
  const cases: readonly (readonly [string, TypeTerm, StaticType])[] = [
    ["never", { kind: "never" }, { kind: "never" }],
    ["dynamic", { kind: "dynamic", why: "json" }, { kind: "unknown" }],
    [
      "written list",
      { kind: "list", element: { kind: "dynamic", why: "unwritten parts" } },
      { kind: "list", element: { kind: "unknown" } },
    ],
    [
      "integer | number",
      { kind: "union", members: [atom("integer"), atom("number")] },
      scalar("number"),
    ],
    [
      "integer?",
      { kind: "union", members: [atom("integer"), atom("null")] },
      optional(scalar("integer")),
    ],
    [
      "string | integer?",
      {
        kind: "union",
        members: [atom("string"), { kind: "union", members: [atom("integer"), atom("null")] }],
      },
      union([scalar("string"), optional(scalar("integer"))]),
    ],
    [
      "integer{2|1|2}",
      { kind: "restricted", name: "integer", values: [2, 1, 2] },
      scalar("integer", [1, 2]),
    ],
    [
      "{b: string, a: integer}",
      {
        kind: "object",
        properties: [
          { name: "b", type: atom("string") },
          { name: "a", type: atom("integer") },
        ],
      },
      object(["a", scalar("integer")], ["b", scalar("string")]),
    ],
    ["object", { kind: "object", properties: null }, { kind: "object", properties: null }],
  ];
  for (const [name, term, type] of cases)
    assert.equal(table.internTerm(term), table.intern(type), name);
  assert.throws(() => table.internTerm({ kind: "ref", place: 0 }), /resolves a ref/);
});

test("a list nested 20,000 deep interns and converts back without native recursion", () => {
  // 20,000 levels exhaust the default call stack for a recursive walk; 2,000 would not.
  const depth = 20_000;
  const deep = (): StaticType => {
    let type = scalar("integer");
    for (let level = 0; level < depth; level += 1) type = { kind: "list", element: type };
    return type;
  };
  const table = new TypeTable();
  const id = table.intern(deep());
  assert.equal(table.intern(deep()), id);
  let type = table.toStatic(id);
  let levels = 0;
  while (type.kind === "list") {
    type = type.element;
    levels += 1;
  }
  assert.equal(levels, depth);
  assert.equal(type.kind, "scalar");
  assert.equal(table.intern(table.toStatic(id)), id);
  // A union around the deep list goes through the canonicalizing branch of `intern` at depth (Astra's review r2).
  const optionalDeep = table.intern({ kind: "union", members: [deep(), NULL_TYPE] });
  assert.equal(table.nonNull(optionalDeep), id);
  assert.equal(table.intern({ kind: "union", members: [NULL_TYPE, deep()] }), optionalDeep);
  let term: TypeTerm = { kind: "atom", name: "integer" };
  for (let level = 0; level < depth; level += 1) term = { kind: "list", element: term };
  assert.equal(table.internTerm(term), id);
  assert.equal(table.fits(id, id), true);
  assert.equal(table.narrow(id, id), id);
});

test("the type table renders no text", () => {
  const source = readFileSync(
    new URL("../../src/type-inference/solver/types.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("typeKey"), false);
  assert.equal(source.includes("JSON.stringify"), false);
});

test("an unnormalized union interns as the type it denotes, whatever was interned before", () => {
  // Astra's review r1 of the type table: `list<number>` and `list<(integer|number)>` denote one type; the legacy's
  // `union` keeps the first spelling it is given, the table keeps one id and the canonical spelling.
  const a: StaticType = { kind: "list", element: { kind: "scalar", name: "number" } };
  const inner: StaticType = {
    kind: "union",
    members: [
      { kind: "scalar", name: "integer" },
      { kind: "scalar", name: "number" },
    ],
  };
  const b: StaticType = { kind: "list", element: inner };
  for (const first of ["a", "b"] as const)
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const table = new TypeTable();
      table.intern(first === "a" ? a : b);
      const u: StaticType = { kind: "union", members: order };
      const id = table.intern(u);
      assert.equal(table.intern(a), table.intern(b), `${first} first: one id for both spellings`);
      assert.equal(
        id,
        table.intern(a),
        `${first} first: the union of two spellings of one type is that type`,
      );
      for (const transfer of [
        table.nonNull(id),
        table.optional(table.nonNull(id)),
        table.narrow(id, id),
        table.assigned(id, id),
      ])
        assert.equal(
          typeKey(table.toStatic(table.nonNull(transfer)), true, true),
          "list<number>",
          `${first} first, order ${order[0] === a ? "a,b" : "b,a"}: the canonical spelling`,
        );
    }
});

test("the producers the solver interns from give canonical types", () => {
  // The legacy's `union` and `optional` normalize what they build: interning their result and interning the result
  // of interning it agree, and a nested union they build is already the table's canonical form.
  const table = new TypeTable();
  const integer: StaticType = { kind: "scalar", name: "integer" };
  const number: StaticType = { kind: "scalar", name: "number" };
  const built: StaticType[] = [
    union([integer, number]),
    optional(
      union([
        { kind: "list", element: number },
        { kind: "list", element: union([integer, number]) },
      ]),
    ),
    union([
      { kind: "set", element: union([integer, NULL_TYPE]) },
      { kind: "set", element: optional(integer) },
    ]),
  ];
  for (const type of built) {
    const id = table.intern(type);
    assert.equal(table.intern(table.toStatic(id)), id);
    assert.equal(typeKey(table.toStatic(id), true, true), typeKey(type, true, true));
  }
});
