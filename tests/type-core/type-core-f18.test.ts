// pins: a literal default's total, decision and default work | line /^\s*\{ total: \d/u
import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { nodeOf, SliceIndex } from "../../src/type-inference/core/check-result/slice-index.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import { VALUE_KIND_NAMES } from "../../src/value-kinds.js";
import { compactAnalysis, coreRequest } from "../helpers/type-core-analysis.js";
import {
  derive,
  snapshotReads,
  snapshotVisits,
  syntaxOf,
  Underivable,
} from "../helpers/type-core-derived.js";
import { readFixture } from "../helpers/type-core/type-core-fixture.js";
import { narrowingPassIn } from "../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";
import { roleClasses } from "../helpers/type-core/type-core-roles.js";
import { derivedContent, plannedContent, runGlobals } from "../helpers/type-core-route.js";
import { shapesOf } from "../helpers/type-core/type-core-rule.js";
import type { Expression } from "../../src/ast.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";

// #1072 (X05, A64): a typed `load` or `fromJson` reads its default at the call-site snapshot, one
// domain in its four layers: the solver's answer at the call, the admitted type of the place it lands in, the per-site
// type of the plan, and what the runtime reader keeps. The shapes of the fixture's `cp9-cells/s9b/f18-held/named/*`
// records, a host value in place of the asked text and flag the slice's syntax leaves out, in both of `fromJson`'s
// lowerings (no `files:`, its file-store instruction; `files: false`, an expression) and for `load`.

const GLOBALS = ["hostValue"];

/** The data a runtime probe gives a typed call: the host values, and the stored value of key `k`. */
interface Given {
  readonly globals: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly storage?: SerializableRuntimeValue;
}

/** A whole number, a number or text, or an object holding one as `n`, as stored data. */
function stored(
  value: number | string | { readonly n: number | string },
): SerializableRuntimeValue {
  return typeof value === "object"
    ? { kind: "object", properties: [{ name: "n", value: value.n }] }
    : value;
}

/** A typed call of each form, its default `d`, and the data each runtime probe gives it. */
const CALLS: readonly {
  readonly form: string;
  readonly call: (d: string) => string;
  readonly data: (value: number | string | { readonly n: number | string }) => Given;
}[] = [
  {
    form: "fromJson, instruction",
    call: (d: string) => `fromJson(hostValue, default: ${d})`,
    data: (value) => ({ globals: { hostValue: JSON.stringify(value) } }),
  },
  {
    form: "fromJson, expression",
    call: (d: string) => `fromJson(hostValue, default: ${d}, files: false)`,
    data: (value) => ({ globals: { hostValue: JSON.stringify(value) } }),
  },
  {
    form: "load",
    call: (d: string) => `load("k", default: ${d})`,
    data: (value) => ({ globals: { hostValue: "" }, storage: stored(value) }),
  },
];

/**
 * The named-default shapes: the statements before the call, those after it, the path of the value read (`result` or
 * `result.n`), the domain there at the call (its kinds, a number's family holding its whole numbers), and what the
 * default holds there when it runs (the stored `flag` is true).
 */
const SHAPES = [
  {
    name: "definite-integer",
    before: "let d = 0",
    after: "",
    path: [],
    domain: ["integer"],
    fallback: "0",
  },
  {
    name: "definite-number",
    before: "let d = 1.5",
    after: "",
    path: [],
    domain: ["number"],
    fallback: "1.5",
  },
  {
    name: "prior-branch",
    before: 'let d = 0\nif load("flag", default: false) { d = 1.5 }',
    after: "",
    path: [],
    domain: ["integer", "number"],
    fallback: "1.5",
  },
  // (a store after the call is not the call's: the snapshot)
  {
    name: "after-call",
    before: "let d = 0",
    after: "d = 1.5",
    path: [],
    domain: ["integer"],
    fallback: "0",
  },
  {
    name: "object-field-snapshot/integer-control",
    before: "let d = {n: 1.5}\nd.n = 0",
    after: "",
    path: ["n"],
    domain: ["integer"],
    fallback: "0",
  },
  {
    name: "object-field-snapshot/number-without-prior-field-write",
    before: "let d = {n: 1.5}",
    after: "",
    path: ["n"],
    domain: ["number"],
    fallback: "1.5",
  },
] as const;

/** A domain's kinds as the reader keeps them: a number keeps a whole number too. */
function kept(kinds: readonly string[]): string {
  const out = new Set(kinds.filter((kind) => kind !== "empty" && kind !== "null"));
  if (out.has("number")) out.add("integer");
  return [...out].sort().join("|");
}

/** A value of the shape's domain at its path, as the whole value that holds it there. */
function at(
  path: readonly string[],
  value: number | string,
): number | string | { readonly n: number | string } {
  return path.length === 0 ? value : { n: value };
}

test("a typed default reads the call-site snapshot, the same domain in the answer, the admitted type, the plan and the runtime (F18, r4.81 (1))", () => {
  let compared = 0;
  for (const mode of MODES)
    for (const { form, call, data } of CALLS)
      for (const shape of SHAPES) {
        const read = shape.path.length === 0 ? "result" : "result.n";
        const source = `${shape.before}\nlet result = ${call("d")}\n${shape.after}\nsay ${read}\nexit\n`;
        const where = `${form} ${shape.name} (mode ${JSON.stringify(mode)})`;
        const files = [{ path: "main.tease", source }];
        const expected = kept(shape.domain);
        const layers = inMode(mode, () => {
          const request = coreRequest(files, GLOBALS);
          assert.ok(request !== null, where);
          const answers = analyseCore(request);
          const index = new SliceIndex(request.files.map((file) => file.program));
          const statement = index.lets.find((let_) => let_.name.name === "result")!;
          const typed = statement.initializer;
          const place = answers.storedPlace(nodeOf(answers, index, statement));
          assert.ok(place !== null, where);
          // layer 1: the solver's answer at the call, below it at the later read of its path
          const answer = (
            answers.at(nodeOf(answers, index, shape.path.length === 0 ? typed : index.shown[0]!))
              ?.items ?? []
          ).map((item) => item.tag);
          // layer 2: the admitted type of the place it lands in
          const admitted = answers.place(place.id, [...place.path, ...shape.path]).admitted;
          assert.notEqual(admitted.by, "undecided", where);
          // layer 3: the plan's type at the call's site
          const compiled = compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND);
          assert.ok(compiled.plan !== null, `${where}: ${compiled.diagnostics.map((d) => d.code)}`);
          const site = `${typed.span.start.offset}:${typed.span.end.offset}`;
          const planned = plannedContent(compiled.plan, source).filter(
            (entry) =>
              (entry.startsWith("expected ") || entry.startsWith("load ")) &&
              entry.split(" ")[1] === site,
          );
          assert.equal(planned.length, 1, `${where}: ${planned.join("; ")}`);
          // (a load's entry names its repair after its type)
          const type = planned[0]!
            .split(" ")
            .slice(2)
            .join(" ")
            .replace(/ repair=\w+$/, "");
          const plan =
            shape.path.length === 0
              ? type
              : (/\bn: ([a-z|]+)/.exec(type)?.[1] ?? `(no n in ${type})`);
          return {
            answer: kept(answer),
            admitted: kept(admitted.by === "undecided" ? [] : admitted.kinds),
            plan: kept(plan.split("|")),
            plannedRun: compiled.plan,
          };
        });
        // layer 4: what the reader keeps of a whole number, a number and text at the path; else the default's value
        const fallback = shape.fallback;
        const probes: readonly (readonly [string, number | string, string])[] = [
          ["integer", 2, "2"],
          ["number", 2.5, "2.5"],
          ["string", "x", "x"],
        ];
        const keeps = probes.flatMap(([kind, value, said]) => {
          const given = data(at(shape.path, value));
          const ran = runGlobals(layers.plannedRun, given.globals, [
            { key: "flag", value: true },
            ...(given.storage === undefined ? [] : [{ key: "k", value: given.storage }]),
          ]);
          assert.equal(ran.status, "halted", `${where}: ${String(value)}: ${ran.failure}`);
          const shown = ran.said.map((entry) => entry.text);
          assert.ok(shown.length === 1, `${where}: ${shown.join(", ")}`);
          if (shown[0] === said) return [kind];
          assert.equal(shown[0], fallback, `${where}: ${String(value)} takes the default`);
          return [];
        });
        const run = kept(keeps);
        assert.deepEqual(
          { answer: layers.answer, admitted: layers.admitted, plan: layers.plan, run },
          { answer: expected, admitted: expected, plan: expected, run: expected },
          where,
        );
        compared += 1;
      }
  assert.equal(compared, MODES.length * CALLS.length * SHAPES.length);
});

test("a computed key's load is external data in every layer, whatever its default (F19)", () => {
  const source = 'let key = "k"\nlet result = load(key, default: 0)\nsay result\nexit\n';
  const files = [{ path: "main.tease", source }];
  for (const mode of MODES)
    inMode(mode, () => {
      const request = coreRequest(files, GLOBALS);
      assert.ok(request !== null);
      const answers = analyseCore(request);
      const index = new SliceIndex(request.files.map((file) => file.program));
      const items = answers.at(nodeOf(answers, index, index.loads[0]!))?.items ?? [];
      assert.deepEqual(
        items.map((item) => item.tag),
        ["unknown"],
      );
      const compiled = compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND);
      assert.ok(compiled.plan !== null);
      // (the reader's type is any value: it keeps what is stored)
      assert.deepEqual(
        plannedContent(compiled.plan, source).filter((entry) => entry.startsWith("load ")),
        ["load 27:48 any repair=false"],
      );
      for (const [value, said] of [
        [1.5, "1.5"],
        ["x", "x"],
      ] as const) {
        const ran = runGlobals(compiled.plan, { hostValue: "" }, [{ key: "k", value }]);
        assert.deepEqual(
          ran.said.map((entry) => entry.text),
          [said],
        );
      }
    });
});

test("the call-site snapshot costs work linear in the typed defaults, nested or side by side, at three doublings, in both orders (F18)", () => {
  // (each typed call's default reads `d` at its call: its nodes mapped once, its read answered once, whatever nesting)
  const nested = (k: number): string => {
    let call = "d";
    for (let at = 0; at < k; at += 1) call = `fromJson(hostValue, default: ${call}, files: false)`;
    return `let d = 0\nlet result = ${call}\nd = 1.5\nsay result\nexit\n`;
  };
  const beside = (k: number): string =>
    `let d = 0\n${Array.from({ length: k }, (_, at) => `let r${at} = load("k${at}", default: d)\nsay r${at}\n`).join("")}d = 1.5\nexit\n`;
  for (const [shape, source, sizes] of [
    ["nested", nested, [8, 16, 32, 64]],
    ["beside", beside, [32, 64, 128, 256]],
  ] as const)
    for (const mode of MODES) {
      const totals = sizes.map((k) =>
        inMode(mode, () => {
          const request = coreRequest([{ path: "main.tease", source: source(k) }], GLOBALS);
          assert.ok(request !== null, `${shape} ${k}`);
          const answers = analyseCore(request);
          assert.equal(answers.budget.exhausted, null, `${shape} ${k}`);
          return answers.budget.total;
        }),
      );
      for (let at = 1; at < totals.length; at += 1)
        assert.ok(
          totals[at]! <= 2.3 * totals[at - 1]!,
          `${shape} (mode ${JSON.stringify(mode)}): ${totals.join(", ")}`,
        );
    }
});

test("two typed calls of one default read at different snapshots are two sharing classes, as their contracts differ (F18)", () => {
  // (a class promises its members the same kinds at every path, `Contract.classOf`: a typed call's contract now follows
  // its default at its call, so the default's snapshot is part of the call's class)
  for (const call of [
    (d: string) => `load("k", default: ${d})`,
    (d: string) => `fromJson(hostValue, default: ${d}, files: false)`,
  ]) {
    const source = `let d = 0\nlet x = ${call("d")}\nd = 1.5\nlet y = ${call("d")}\nsay x\nsay y\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
    assert.ok(request !== null, source);
    for (const reversed of [false, true]) {
      const pass = narrowingPassIn(request, reversed);
      const results = pass.program.constraints.flatMap((c) =>
        c.kind === "load" || (c.kind === "operation" && c.contract.name === "fromJson")
          ? [c.result]
          : [],
      );
      assert.equal(results.length, 2, source);
      const kinds = results.map((value) =>
        pass.solver
          .run(pass.contract.contractOfValue(value))
          .map((item) => item.tag)
          .sort()
          .join("|"),
      );
      assert.deepEqual(kinds, ["integer", "number"], source);
      assert.notEqual(
        pass.contract.classOf(results[0]!, false),
        pass.contract.classOf(results[1]!, false),
        source,
      );
    }
  }
});

test("a literal default keeps the contract's own walk: cp9-cells/F18/load-integer costs main's units, in four modes (F18)", () => {
  // (only a default that reads a variable or computes takes the value side's walk at its call; literal data costs what
  // it did, its typed default's run 4 units and the decision of `x` 15, the analysis 246)
  const record = readFixture().find((entry) => entry.name === "cp9-cells/F18/load-integer");
  assert.ok(record !== undefined);
  const request = coreRequest(record.files);
  assert.ok(request !== null);
  for (const mode of MODES) {
    const { budget } = inMode(mode, (): Answers => analyseCore(request));
    assert.deepEqual(
      {
        total: budget.total,
        decisions: budget.decisions.map((d) => d.units),
        default: budget.finished.filter((f) => f.key.startsWith("dk")).map((f) => f.units),
      },
      { total: 246, decisions: [15], default: [4] },
      JSON.stringify(mode),
    );
  }
});

const EVERY = VALUE_KIND_NAMES.map((kind) =>
  kind === "object" ? "{}" : ["list", "set", "dict"].includes(kind) ? `${kind}<any>` : kind,
)
  .sort()
  .join("|");
const FLAG = 'load("flag", default: false)';

const X2 =
  "the plan's joined part takes every store of its variable, one after the call or in an arm that exits";
const LOOP = { refused: "a variable a loop stores" };

/**
 * #1760's witnesses, from #1755's reviews r1 to r3: a source, `@` where `let result = <typed call>` stands, the read
 * the call defaults to, and the type the S7 oracle derives at the call from the syntax alone (`null`: no structure), or
 * the reason it refuses. `finding` names a row where the plan's per-site type differs: reported, not adjusted to it.
 */
const WITNESSES: readonly {
  readonly name: string;
  readonly source: string;
  readonly read: string;
  readonly derived: string | null | { readonly refused: string };
  readonly finding?: string;
}[] = [
  { name: "the latest store", source: "let d = 0\nd = 1.5\n@", read: "d", derived: "number" },
  {
    name: "a store after the call",
    source: "let d = 0\n@\nd = 1.5",
    read: "d",
    derived: "integer",
  },
  {
    name: "a later property store",
    source: "let d = {n: 1.5}\nd.n = 0\n@",
    read: "d",
    derived: "{n: integer}",
  },
  {
    name: "a later property store, its part",
    source: "let d = {n: 1.5}\nd.n = 0\n@",
    read: "d.n",
    derived: "integer",
  },
  {
    name: "a property store to a property named element",
    source: "let d = {element: 1.5}\nd.element = 0\n@",
    read: "d",
    derived: "{element: integer}",
  },
  {
    name: "a property named element, read",
    source: "let d = {element: 1.5}\nd.element = 0\n@",
    read: "d.element",
    derived: "integer",
  },
  {
    name: "a nested property named element",
    source: "let d = {n: {element: 1.5}}\nd.n.element = 0\n@",
    read: "d",
    derived: "{n: {element: integer}}",
  },
  { name: "a null field", source: "let d = {n: null}\n@", read: "d", derived: `{n: ${EVERY}}` },
  {
    name: "a copy at the copy",
    source: "let d = 0\nlet e = d\nd = 1.5\n@",
    read: "e",
    derived: "integer",
  },
  {
    name: "an object copy at the copy",
    source: "let d = {n: 0}\nlet e = d\nd.n = 1.5\n@",
    read: "e",
    derived: "{n: integer}",
  },
  {
    name: "a join with null at the root",
    source: `let d = 0\nif ${FLAG} { d = null }\n@`,
    read: "d",
    derived: "integer|null",
  },
  {
    name: "a join with null in a part",
    source: `let d = {n: 0}\nif ${FLAG} { d.n = null }\n@`,
    read: "d",
    derived: "{n: integer|null}",
  },
  {
    name: "a join with null in a part, read",
    source: `let d = {n: 0}\nif ${FLAG} { d.n = null }\n@`,
    read: "d.n",
    derived: "integer|null",
  },
  {
    name: "a join with a whole null field",
    source: `let d = {n: 0}\nif ${FLAG} { d = {n: null} }\n@`,
    read: "d",
    derived: "{n: integer|null}",
  },
  {
    name: "a join of nested arms",
    source: `let d = 0\nif ${FLAG} {\n  if load("g", default: false) { d = null }\n}\n@`,
    read: "d",
    derived: "integer|null",
  },
  {
    name: "host data in a join",
    source: `let d = 0\nif ${FLAG} { d = hostValue }\n@`,
    read: "d",
    derived: null,
  },
  {
    name: "X2 unwritten",
    source: `let d = 0\nif ${FLAG} { d = 1.5 }\n@`,
    read: "d",
    derived: "number",
  },
  {
    name: "X2 written",
    source: `let d: number = 0\nif ${FLAG} { d = 1 }\n@`,
    read: "d",
    derived: "number",
  },
  {
    name: "X2 written nullable",
    source: `let d: number? = 0\nif ${FLAG} { d = 1 }\n@`,
    read: "d",
    derived: "null|number",
  },
  {
    name: "X2 written, copied",
    source: `let d: number = 0\nif ${FLAG} { d = 1 }\nlet e = d\n@`,
    read: "e",
    derived: "number",
  },
  {
    name: "a written type without a join",
    source: "let d: number = 0\n@",
    read: "d",
    derived: "number",
  },
  {
    name: "both arms",
    source: `let d = 0\nif ${FLAG} { d = 1.5 } else { d = null }\n@`,
    read: "d",
    derived: "null|number",
  },
  {
    name: "an else if",
    source: `let d = 0\nif ${FLAG} { d = 1.5 } else if load("g", default: false) { d = null }\n@`,
    read: "d",
    derived: "null|number",
  },
  {
    name: "a call in the arm that stores",
    source: `let d = 0\nif ${FLAG} {\n  d = 1.5\n  @\n}`,
    read: "d",
    derived: "number",
  },
  {
    name: "a call in the other arm",
    source: `let d = {n: 0}\nif ${FLAG} { d = {n: null} } else {\n  @\n}`,
    read: "d",
    derived: "{n: integer}",
    finding: X2,
  },
  {
    name: "a store after a join",
    source: `let d = 0\nif ${FLAG} { d = 1 }\n@\nd = 1.5`,
    read: "d",
    derived: "integer",
    finding: X2,
  },
  {
    name: "a property store after a join",
    source: `let d = {n: 0}\nif ${FLAG} { d.n = 1 }\n@\nd.n = 1.5`,
    read: "d",
    derived: "{n: integer}",
    finding: X2,
  },
  {
    name: "an arm that exits",
    source: `let d = 0\nif ${FLAG} {\n  d = 1.5\n  exit\n}\n@`,
    read: "d",
    derived: "integer",
    finding: X2,
  },
  {
    name: "an arm that exits, null",
    source: `let d = 0\nif ${FLAG} {\n  d = null\n  exit\n}\n@`,
    read: "d",
    derived: "integer",
    finding: X2,
  },
  { name: "a null element", source: "let d = [null]\n@", read: "d", derived: "list<any>" },
  {
    name: "a null element in a copied part",
    source: "let e = [null]\nlet d = {n: e}\n@",
    read: "d",
    derived: "{n: list<any>}",
  },
  {
    name: "a store after an exit",
    source: `let d = 0\nif ${FLAG} {\n  exit\n  d = 1.5\n}\n@`,
    read: "d",
    derived: "integer",
  },
  {
    name: "an arm whose condition is false",
    source: "let d = 0\nif false { d = 1.5 }\n@",
    read: "d",
    derived: "integer",
  },
  {
    name: "an else after a true condition",
    source: "let d = 0\nif true { d = 1.5 } else { d = null }\n@",
    read: "d",
    derived: "number",
  },
  {
    name: "a sibling binding's written type",
    source: `if ${FLAG} {\n  let d: number = 0\n} else {\n  let d = 0\n  if load("g", default: false) { d = 1 }\n  @\n}`,
    read: "d",
    derived: "integer",
  },
  {
    name: "X2 written, a self-copy in the arm",
    source: `let d: number = 0\nif ${FLAG} { d = d }\n@`,
    read: "d",
    derived: "number",
  },
  {
    name: "X2 written, a copy back in the arm",
    source: `let d: number = 0\nlet e = d\nif ${FLAG} { d = e }\n@`,
    read: "d",
    derived: "number",
  },
  {
    name: "X2 written, a store in a nested arm ruled out",
    source: `let d: number = 0\nif ${FLAG} {\n  if false { d = 1.5 }\n}\n@`,
    read: "d",
    derived: "number",
  },
  {
    name: "X2 written, a store in an else ruled out",
    source: `let d: number = 0\nif ${FLAG} { say "a" } else if true { say "b" } else { d = 1.5 }\n@`,
    read: "d",
    derived: "number",
  },
  {
    name: "X2 written, a store after a nested exit",
    source: `let d: number = 0\nif ${FLAG} {\n  if true { exit }\n  d = 1.5\n}\n@`,
    read: "d",
    derived: "number",
  },
  {
    name: "a self-copy after a join",
    source: `let d = 0\nif ${FLAG} { d = 1 }\nd = d\n@`,
    read: "d",
    derived: "integer",
  },
  {
    name: "a property self-copy",
    source: "let d = {n: 0}\nd.n = d.n\n@",
    read: "d",
    derived: "{n: integer}",
  },
  {
    name: "a stored typed load",
    source: 'let d = load("n", default: 0)\n@',
    read: "d",
    derived: "integer",
  },
  {
    name: "a stored typed parse",
    source: "let d = fromJson(hostValue, default: {n: 0}, files: false)\n@",
    read: "d",
    derived: "{n: integer}",
  },
  {
    name: "a loop variable apart",
    source: "for entry in [0] {\n  let e = entry\n}\nlet d = 0\n@",
    read: "d",
    derived: "integer",
  },
  {
    name: "a call after an exit",
    source: "let d: number = 0\nexit\n@",
    read: "d",
    derived: { refused: "a variable read where no path reaches" },
  },
  {
    name: "a call in an arm ruled out",
    source: "let d: number = 0\nif false {\n  @\n}",
    read: "d",
    derived: { refused: "a variable read where no path reaches" },
  },
  {
    name: "a call in a loop reading an outer variable",
    source: "let d: number = 0\nfor entry in [0] {\n  @\n}",
    read: "d",
    derived: { refused: "a variable read inside a loop" },
  },
  {
    name: "a call in a repeat reading an outer variable",
    source: "let d: number = 0\nrepeat 1 {\n  @\n}",
    read: "d",
    derived: { refused: "a variable read inside a loop" },
  },
  {
    name: "a default that computes from a variable",
    source: "let d = 0\n@",
    read: "toInteger(d, default: 0)",
    derived: { refused: "a default that computes from a variable" },
  },
  {
    name: "a stored selection of a literal's element",
    source: "let d = 0\nlet e = [d][0]\n@",
    read: "e",
    derived: "integer",
  },
  {
    name: "a stored read through an unmodelled value",
    source: "let d = 0\nlet e = [d, 1][hostValue]\n@",
    read: "e",
    derived: { refused: "a read through an unmodelled value" },
  },
  {
    name: "a stored computation",
    source: "let d = toInteger(hostValue, default: 0)\n@",
    read: "d",
    derived: { refused: "a stored computation" },
  },
  {
    name: "a computation in a stored typed parse",
    source:
      "let d = fromJson(hostValue, default: toInteger(hostValue, default: 0), files: false)\n@",
    read: "d",
    derived: { refused: "a stored computation" },
  },
  {
    name: "a property store on host data",
    source: "let d = hostValue\nd.n = 1\n@",
    read: "d",
    derived: { refused: "a property store below a value of no modelled structure" },
  },
  {
    name: "a refused read inside a stored literal",
    source: "let d = 0\nrepeat 2 { d = 1 }\nlet e = [d]\n@",
    read: "e",
    derived: LOOP,
  },
  {
    name: "a method call",
    source: "let d = [0]\nlet x = d.get(0, default: 1)\n@",
    read: "d",
    derived: { refused: "a method call on the variable" },
  },
  {
    name: "a loop's store after the call",
    source: "let d = 0\n@\nrepeat 2 { d = 1.5 }",
    read: "d",
    derived: LOOP,
  },
  {
    name: "a loop's store before the call",
    source: "let d = 0\nrepeat 2 { d = 1.5 }\n@",
    read: "d",
    derived: LOOP,
  },
  {
    name: "a call in a loop",
    source: "let d = 0\nfor entry in [0] {\n  @\n}",
    read: "entry",
    derived: LOOP,
  },
];

test("the S7 oracle reads a typed default's variable at its call's snapshot, from the syntax alone, as the plan types it (F18, #1760)", (t) => {
  let compared = 0;
  for (const witness of WITNESSES)
    for (const form of ["parse", "load"] as const) {
      const typed =
        form === "parse"
          ? `fromJson(hostValue, default: ${witness.read}, files: false)`
          : `load("k", default: ${witness.read})`;
      const source = `${witness.source.replace("@", `let result = ${typed}`)}\nexit\n`;
      const where = `${witness.name}, ${form}`;
      const files = [{ path: "main.tease", source }];
      const start = source.indexOf(typed);
      const atCall = (entries: readonly string[]) =>
        entries.filter(
          (entry) =>
            (entry.startsWith("expected ") || entry.startsWith("load ")) &&
            entry.split(" ")[1] === `${start}:${start + typed.length}`,
        );
      for (const mode of MODES)
        inMode(mode, () => {
          const request = coreRequest(files, GLOBALS);
          assert.ok(request !== null, where);
          const derivation = (() => {
            try {
              return derive(syntaxOf(source), compactAnalysis(request)).content;
            } catch (error) {
              if (error instanceof Underivable) return error;
              throw error;
            }
          })();
          // (every witness has a plan: a refusal is of a source the slice admits)
          const compiled = compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND);
          assert.ok(compiled.plan !== null, `${where}: ${compiled.diagnostics.map((d) => d.code)}`);
          if (typeof witness.derived === "object" && witness.derived !== null) {
            assert.ok(derivation instanceof Underivable, where);
            assert.equal(derivation.message, witness.derived.refused, where);
            return;
          }
          assert.ok(!(derivation instanceof Underivable), `${where}: ${String(derivation)}`);
          const derived = atCall(derivedContent(derivation, source));
          // (a load with no structure reads `any`, a parse none)
          const type = (entries: readonly string[]) => {
            const text = entries[0]
              ?.split(" ")
              .slice(2)
              .join(" ")
              .replace(/ repair=\w+$/, "");
            return text === undefined || text === "any" ? null : text;
          };
          assert.equal(type(derived), witness.derived, where);
          const planned = atCall(plannedContent(compiled.plan, source));
          if (witness.finding === undefined) assert.deepEqual(planned, derived, where);
          else if (mode === MODES[0])
            t.diagnostic(`finding (${witness.finding}): ${where}: the plan ${planned.join("; ")}`);
          compared += 1;
        });
    }
  assert.equal(
    compared,
    WITNESSES.filter((witness) => typeof witness.derived !== "object" || witness.derived === null)
      .length *
      2 *
      MODES.length,
  );
});

test("the S7 oracle keys each default's reads by its outermost typed call, as the compiler's readAt maps them (F18, #1760)", (t) => {
  const sources = [
    ...readFixture()
      .filter((record) => record.files.length === 1)
      .map((record) => record.files[0]!.source),
    ...CALLS.flatMap(({ call }) =>
      SHAPES.map(
        (shape) => `${shape.before}\nlet result = ${call("d")}\n${shape.after}\nsay "x"\nexit\n`,
      ),
    ),
    ...shapesOf(roleClasses().classes).map((shape) => shape.source),
    ...WITNESSES.map(
      (witness) =>
        `${witness.source.replace("@", `let result = fromJson(hostValue, default: ${witness.read}, files: false)`)}\nexit\n`,
    ),
  ];
  let calls = 0;
  let reads = 0;
  for (const source of sources) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
    if (request === null) continue;
    const program = new CoreProgram(request);
    const nodeAt = (expression: { readonly span: Expression["span"] }) => ({
      file: 0,
      start: expression.span.start.offset,
      end: expression.span.end.offset,
    });
    const keys = new Set<unknown>();
    const keyed = snapshotReads(syntaxOf(source).statements);
    for (const { call, reads: inDefault } of keyed) {
      const read = inDefault.filter((expression) => program.exprAt(nodeAt(expression)) !== null);
      assert.ok(read.length > 0, `${source}: a default with no node`);
      const at = new Set(read.map((expression) => program.readAt(nodeAt(expression))));
      assert.equal(at.size, 1, `${source}: one call's reads at ${at.size} nodes`);
      const [key] = at;
      for (const expression of read)
        assert.notEqual(
          key,
          program.exprAt(nodeAt(expression)),
          `${source}: a read at its own node`,
        );
      // (the call's own snapshot node: a parse's call node, a load's default probe, at the call's span; not another
      // node there, as the call's entry or its result)
      assert.deepEqual(
        key?.span ? [key.file, key.kind, key.span.start.offset, key.span.end.offset] : null,
        [
          0,
          call.kind === "loadExpression" ? "default-probe" : "expression",
          call.span.start.offset,
          call.span.end.offset,
        ],
        `${source}: a default's reads keyed at another node`,
      );
      keys.add(key);
      reads += read.length;
    }
    assert.equal(keys.size, keyed.length, `${source}: two calls keyed at one node`);
    calls += keyed.length;
  }
  t.diagnostic(
    `${sources.length} sources, ${calls} outermost typed calls, ${reads} reads in their defaults`,
  );
  assert.ok(calls > 0);
});

test("the S7 oracle's snapshot reader walks a program once, each statement visited once, at three doublings (#1760)", () => {
  for (const size of [250, 500, 1000]) {
    const lines = ["let d0 = 0"];
    for (let at = 1; at <= size; at += 1)
      lines.push(
        `let d${at} = d${at - 1}`,
        `let r${at} = fromJson(hostValue, default: d${at}, files: false)`,
      );
    const source = `${lines.join("\n")}\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
    assert.ok(request !== null);
    const syntax = syntaxOf(source);
    const before = snapshotVisits();
    const { content } = derive(syntax, compactAnalysis(request));
    const after = snapshotVisits();
    // (each statement visited once; each call captures the one value its default reads)
    assert.deepEqual(
      [after.statements - before.statements, after.captured - before.captured],
      [2 * size + 2, size],
      `${size}`,
    );
    assert.equal(
      derivedContent(content, source).filter((entry) => entry.endsWith(" integer")).length,
      size,
    );
  }
});
