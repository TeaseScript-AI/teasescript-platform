import type { Constructor, Provenance, Tag } from "./cells.js";
import type { CellView } from "./interpret.js";

// The cell table (O4 stage 3a, work note §3.2): the interpretation of a final set, one executable row per rule, over
// the items' roles and flags. Each row names a cell's items (and the items of its part cells) and the view the
// interpretation must reach: the kind, the items whose forms are exported, a conflict's families in rank order,
// optionality and held. `tests/type-inference-solver-rules.test.ts` builds each row's cells and asserts the view.

/** An item of a row: a flat type by its registry name or `null`, or a constructor over a named part cell. */
export interface RuleItem {
  readonly name: string;
  readonly tag: Tag;
  readonly type?: string | undefined;
  readonly ctor?: Constructor | undefined;
  /** The part cell of a collection item, or the property cells of an object item, by their names in `parts`. */
  readonly part?: string | undefined;
  readonly props?: Readonly<Record<string, string>> | undefined;
  readonly pos: number;
  readonly decl?: boolean | undefined;
  readonly group?: string | undefined;
  readonly why?: Provenance | undefined;
}

export interface CellRule {
  readonly name: string;
  readonly items: readonly RuleItem[];
  readonly parts?: Readonly<Record<string, readonly RuleItem[]>> | undefined;
  readonly expect: {
    readonly kind: CellView["kind"];
    /**
     * The names of the items whose forms the view exports (one form per distinct type or structure); a group of
     * names is one member made of those items together (the witnesses of one constructor, O1 and option B).
     */
    readonly members: readonly (string | readonly string[])[];
    readonly families?: readonly string[] | undefined;
    readonly optional?: boolean | undefined;
    readonly held?: boolean | undefined;
  };
}

const w = (name: string, type: string, pos: number, decl = false): RuleItem => ({
  name,
  tag: "w",
  type,
  pos,
  decl,
});
const m = (name: string, type: string, pos: number, group: string, decl = false): RuleItem => ({
  name,
  tag: "m",
  type,
  pos,
  group,
  decl,
});
const b = (name: string, type: string, group: string): RuleItem => ({
  name,
  tag: "b",
  type,
  pos: 0,
  group,
});
const n = (name: string, pos: number): RuleItem => ({ name, tag: "n", type: "null", pos });
const p = (name: string, type: string, pos: number, why: Provenance): RuleItem => ({
  name,
  tag: "p",
  type,
  pos,
  why,
});
const d = (name: string, pos: number, why: Provenance): RuleItem => ({ name, tag: "d", pos, why });
const e = (name: string, pos: number): RuleItem => ({ name, tag: "e", pos });
const list = (name: string, part: string, pos: number, decl = false): RuleItem => ({
  name,
  tag: "w",
  ctor: "list",
  part,
  pos,
  decl,
});
const object = (name: string, props: Readonly<Record<string, string>>, pos: number): RuleItem => ({
  name,
  tag: "w",
  ctor: "object",
  props,
  pos,
});

export const CELL_RULES: readonly CellRule[] = [
  {
    name: "a witness alone is its family",
    items: [w("a", "integer", 5)],
    expect: { kind: "known", members: ["a"] },
  },
  {
    name: "integer beside number is number (ADR 1.2)",
    items: [w("a", "integer", 5), w("b", "number", 9)],
    expect: { kind: "known", members: ["b"] },
  },
  {
    name: "two families: the earliest position is the working kind (Q3.1)",
    items: [w("a", "string", 5), w("b", "integer", 9)],
    expect: { kind: "conflict", members: ["a"], families: ["string", "integer"] },
  },
  {
    name: "the declaration's family first, whatever its position (Q3.1r)",
    items: [w("a", "integer", 9, true), w("b", "string", 5)],
    expect: { kind: "conflict", members: ["a"], families: ["integer", "string"] },
  },
  {
    name: "a defined union is permitted",
    items: [m("a", "integer", 5, "u1"), m("b", "string", 5, "u1")],
    expect: { kind: "known", members: ["a", "b"] },
  },
  {
    name: "a witness that fits the working union stays permitted (Q3.8)",
    items: [
      m("a", "integer", 5, "u1", true),
      m("b", "string", 5, "u1", true),
      w("c", "integer", 9),
    ],
    expect: { kind: "known", members: ["a", "b"] },
  },
  {
    name: "a union stored into an established kind is a conflict at that store (Q3.8)",
    items: [w("a", "integer", 5, true), m("b", "integer", 9, "u1"), m("c", "string", 9, "u1")],
    expect: { kind: "conflict", members: ["a"], families: ["integer", "string"] },
  },
  {
    name: "a second union stored later is a conflict where it does not fit",
    items: [
      m("a", "integer", 5, "u1", true),
      m("b", "string", 5, "u1", true),
      m("c", "boolean", 9, "u2"),
    ],
    expect: { kind: "conflict", members: ["a", "b"], families: ["integer", "string", "boolean"] },
  },
  {
    name: "a defined union before a witness at the same site (the operation's own result)",
    items: [w("a", "regex", 5), m("b", "regex", 5, "op@5"), m("c", "integer", 5, "op@5")],
    expect: { kind: "known", members: ["b", "c"] },
  },
  {
    name: "a written bound exports as the bound",
    items: [b("a", "integer", "written:0")],
    expect: { kind: "bound", members: ["a"] },
  },
  {
    name: "a witness outside the bound is the bound's conflict (stage 4), the export stays the bound",
    items: [b("a", "integer", "written:0"), w("b", "string", 5)],
    expect: { kind: "bound", members: ["a"] },
  },
  {
    name: "a bound with a null member is optional",
    items: [b("a", "integer", "written:0"), b("b", "null", "written:0")],
    expect: { kind: "bound", members: ["a", "b"], optional: true },
  },
  {
    name: "null only",
    items: [n("a", 5)],
    expect: { kind: "nullOnly", members: [], optional: true },
  },
  {
    name: "dynamic only is unknown and held",
    items: [d("a", 3, "host")],
    expect: { kind: "unknown", members: [], held: true },
  },
  {
    name: "a known null beside a witness is optionality (Q3.5)",
    items: [w("a", "integer", 5), n("b", 9)],
    expect: { kind: "known", members: ["a"], optional: true },
  },
  {
    name: "a value the compiler cannot know beside a witness is held, not optional (Q3.2a)",
    items: [w("a", "integer", 5), d("b", 9, "json")],
    expect: { kind: "known", members: ["a"], held: true },
  },
  {
    name: "a possibility a witness covers adds nothing",
    items: [w("a", "integer", 5), p("b", "integer", 9, "json")],
    expect: { kind: "known", members: ["a"] },
  },
  {
    name: "a possibility no witness covers is held",
    items: [w("a", "integer", 5), p("b", "number", 9, "json")],
    expect: { kind: "known", members: ["a"], held: true },
  },
  {
    name: "possibilities alone decide nothing: unknown and held",
    items: [p("a", "integer", 9, "json"), p("b", "number", 9, "json")],
    expect: { kind: "unknown", members: [], held: true },
  },
  {
    name: "a null member of a defined union is optionality",
    items: [m("a", "integer", 5, "u1"), n("b", 5)],
    expect: { kind: "known", members: ["a"], optional: true },
  },
  {
    name: "a list over a part empty by construction",
    items: [list("a", "E", 5)],
    parts: { E: [e("x", 5)] },
    expect: { kind: "known", members: ["a"] },
  },
  {
    name: "a list whose part conflicts is one list; the conflict is the part's",
    items: [list("a", "E", 5)],
    parts: { E: [w("x", "integer", 6, true), w("y", "string", 9)] },
    expect: { kind: "known", members: ["a"] },
  },
  {
    name: "a list empty by construction and a list with members are one member over both element cells",
    items: [list("a", "E1", 5), list("b", "E2", 9)],
    parts: { E1: [e("x", 5)], E2: [w("y", "integer", 10)] },
    expect: { kind: "known", members: [["a", "b"]] },
  },
  {
    name: "two object literals of one place are one schema over both property cells (option B)",
    items: [object("a", { x: "P1" }, 5), object("b", { x: "P2" }, 9)],
    parts: { P1: [w("x", "integer", 6, true)], P2: [w("y", "string", 10, true)] },
    expect: { kind: "known", members: [["a", "b"]] },
  },
  {
    name: "a list beside a scalar is a conflict",
    items: [list("a", "E", 5, true), w("b", "integer", 9)],
    parts: { E: [w("x", "integer", 6, true)] },
    expect: { kind: "conflict", members: ["a"], families: ["list", "integer"] },
  },
];
