import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../src/compiler.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { nodeOf, SliceIndex } from "../src/type-inference/core/consumer.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { derive, syntaxOf } from "./helpers/type-core-derived.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { narrowingPassIn } from "./helpers/type-core-narrowing.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";
import { derivedContent, plannedContent, runGlobals } from "./helpers/type-core-route.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";

// #1072 (X05, A64), TABLE r4.81 (1): a typed `load` or `fromJson` reads its default at the call-site snapshot, one
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

test("the S7 oracle derives a default that reads a variable at its call, as the plan reads it (F18)", () => {
  // (the latest store before the call, a later property store replacing its property, a `null` one leaving it open, a
  // copy holding what its source held then, a store in a branch joining the one before; each compared with the plan)
  // (and a later store, which the call does not read)
  for (const [before, fallback, later, shown] of [
    ["let d = 1.5\nd = 0", "d", "d = 2.5", "result"],
    ["let d = {n: 1.5}\nd.n = 0", "d", "d.n = 2.5", "result.n"],
    ["let d = {n: 0}\nd.n = null", "d", "d.n = 2.5", "result.n"],
    ["let d = 1.5\nd = 0", "{n: d}", "d = 2.5", "result.n"],
    ["let d = 1.5\nd = 0\nlet e = d", "e", "d = 2.5", "result"],
    ['let d = 0\nif load("flag", default: false) { d = 1.5 }', "d", "d = 2.5", "result"],
  ] as const)
    for (const mode of MODES) {
      const source = `${before}\nlet result = fromJson(hostValue, default: ${fallback}, files: false)\n${later}\nsay ${shown}\nexit\n`;
      const files = [{ path: "main.tease", source }];
      inMode(mode, () => {
        const request = coreRequest(files, GLOBALS);
        assert.ok(request !== null, source);
        const compiled = compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND);
        assert.ok(compiled.plan !== null, source);
        const derived = derive(syntaxOf(source), compactAnalysis(request)).content;
        assert.deepEqual(
          derivedContent(derived, source),
          plannedContent(compiled.plan, source),
          `${source} (mode ${JSON.stringify(mode)})`,
        );
      });
    }
});
