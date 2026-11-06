import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { analyseCore, solveDemands } from "../src/type-inference/core/answers.js";
import { Consumers } from "../src/type-inference/core/consumers.js";
import { indexPaths, stepsOf } from "../src/type-inference/core/contract/literal-index.js";
import { exportNames } from "../src/type-inference/core/contract/key-ids.js";
import { absentWriterAt, objectsAt } from "../src/type-inference/core/contract/objects.js";
import { DemandExhausted, withTestAllowance } from "../src/type-inference/core/budget.js";
import { firstWriter, REASON, type Writer } from "../src/type-inference/core/items.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";

/*
 * #1747 PR 1 (TABLE r4.386): the objects query (`contract/objects.ts`). Asked by no production path yet; here, for every
 * literal at each path of its index, and every binding read whole and one property down, at each property any object
 * of the source names and one none does, the pure `missing` writer it names (`absentWriterAt`) is the ordinary
 * completed read's at that property (`contractOfValueAt`), wherever the query covers the read.
 */

const GLOBALS = ["hostValue", "hostInit", "hostOther"];

/** #1736's families (Sol's `fresh-growth`): k calls of `read(x)`, each reading `x.p.f_i`, by the shape of `p`. */
function family(shape: string, k: number, absent: boolean): string {
  const names = Array.from({ length: k }, (_, i) => `f${i}`);
  const object = absent ? "{}" : "shared";
  const rows = [
    `let shared={${names.map((name) => `${name}:1`).join(",")}}`,
    "let xs=[shared]",
    "function take(x:object) { return x }",
    "function read(x:object) {",
    ...names.map((name, i) => `let got${i}=x.p.${name}`),
    "return 0 }",
  ];
  for (let i = 0; i < k; i++) {
    const p =
      shape === "plain"
        ? object
        : shape === "get-inline"
          ? `[${object}].get(hostValue, default:${object})`
          : shape === "get-shared"
            ? `xs.get(hostValue, default:${object})`
            : `take(${object})`;
    rows.push(
      shape === "different-steps"
        ? `let r${i}=read({noise:hostValue,a:{p:${object}},b:{p:${object}}}.${i % 2 === 0 ? "b" : "a"})`
        : `let r${i}=read({noise:hostValue,p:${p}})`,
    );
  }
  rows.push("exit");
  return rows.join("\n") + "\n";
}

const SHAPES = ["plain", "get-inline", "get-shared", "call", "different-steps"];

/** The passes of one analysis of `source` in `mode`. */
function passesOf(
  source: string,
  mode: (typeof MODES)[number],
  allowance: number | null = null,
): CorePass[] {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const passes: CorePass[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    passes.push(this.pass);
    check.call(this);
  };
  try {
    const run = () => inMode(mode, () => analyseCore(request));
    if (allowance === null) run();
    else withTestAllowance(allowance, run);
  } finally {
    Consumers.prototype.check = check;
  }
  return passes;
}

const text = (writer: Writer | null): string =>
  writer === null ? "none" : `${writer.kind}@${writer.file}:${writer.start}`;

/** The objects query against the ordinary read over a pass's literals and binding reads: counts and differences. */
function compared(pass: CorePass): {
  readonly covered: number;
  readonly asked: number;
  readonly at: Set<string>;
  readonly differences: string[];
} {
  const { contract, program, solver } = pass;
  const names = new Set<string>(["zz"]);
  const asks: (readonly [number, readonly string[]])[] = [];
  for (const literal of program.hasOf.keys()) {
    const index = contract.literalIndex(literal);
    asks.push([literal, []]);
    for (const object of index.root.objects?.list ?? [])
      for (const name of object.names) names.add(name);
    for (const [id, node] of indexPaths(contract, index)) {
      asks.push([literal, stepsOf(contract, id)]);
      for (const object of node.objects?.list ?? [])
        for (const name of object.names) names.add(name);
    }
  }
  for (const value of program.occurrenceOf.keys()) {
    asks.push([value, []], [value, ["element"]]);
    for (const name of names) asks.push([value, [name]]);
  }
  let covered = 0;
  const at = new Set<string>();
  const differences: string[] = [];
  for (const [value, rest] of asks)
    for (const step of names) {
      const derived = solver.run(absentWriterAt(contract, value, rest, step));
      if (!derived.covered) continue;
      covered += 1;
      at.add(`${program.places[value]?.label ?? value}:${rest.join(".")}`);
      let writer: Writer | null = null;
      for (const item of solver.run(contract.contractOfValueAt(value, [...rest, step])))
        if (item.tag === "unknown" && item.reasons === REASON.missing)
          writer = firstWriter(writer, item.writer);
      if (text(writer) !== text(derived.writer))
        differences.push(
          `${value} at ${[...rest, step].join(".")}: read ${text(writer)}, objects ${text(derived.writer)}`,
        );
    }
  return { covered, asked: asks.length * names.size, at, differences };
}

test("the objects query names a read's missing writer as the read does, wherever it covers it, in four modes (#1747)", () => {
  for (const shape of SHAPES)
    for (const absent of [true, false])
      for (const k of [4, 8]) {
        const source = family(shape, k, absent);
        for (const mode of MODES) {
          const label = `${shape}, k ${k}, absent ${absent}, ${JSON.stringify(mode)}`;
          let covered = 0;
          for (const pass of passesOf(source, mode)) {
            // (asked in the analysis's own mode: its sharing and order)
            const result = inMode(mode, () => compared(pass));
            assert.deepEqual(result.differences, [], label);
            covered += result.covered;
          }
          // (every family's member literals answer at their `p`)
          assert.ok(covered > 0, label);
        }
      }
});

test("the objects query covers each family's group members at the path its reads fold (#1747)", () => {
  for (const shape of SHAPES) {
    const source = family(shape, 4, true);
    const [pass] = passesOf(source, MODES[0]!);
    const { at, differences } = inMode(MODES[0]!, () => compared(pass!));
    assert.deepEqual(differences, []);
    const member = shape === "different-steps" ? /:a\.p$|:b\.p$/ : /:p$/;
    assert.ok(
      [...at].some((each) => member.test(each)),
      `${shape}: ${[...at].join(" ")}`,
    );
  }
});

/** Sources beside the families: each route the query follows or declines, at the reads its oracle asks. */
const CONTROLS = [
  // F11 at a prefix, a property stored below it, a stored `missing`, a host value beside a literal
  'let base={a:{},b:1}\nlet w={p:base,h:hostValue}\nbase.a.c=1\nlet y={q:base.zz}\nlet n={p:{a:base.zz}}\nsay "${w.p.a.c}"\nsay "${y.q.r}"\nsay "${n.p.a}"\nexit\n',
  // several objects in one list, the first lacking of each list, the earliest of the lists
  'let xs=[{a:1},{b:1},{a:1,b:1}]\nlet o={p:{a:1}}\no.p={b:1}\nlet e=xs.get(hostValue, default:{c:1})\nsay "${e.a}"\nsay "${o.p.c}"\nexit\n',
  // a fallback, an element added
  'let f={p:hostValue otherwise {a:1}}\nlet l=[{a:1}]\nl.add({b:2})\nsay "${f.p.zz}"\nexit\n',
  // a cycle of calls no literal seeds, and one a literal seeds
  'function f(x:object) { return g(x) }\nfunction g(y:object) { return f(y) }\nlet r=f({a:1})\nsay "${r.a}"\nexit\n',
  'function f(x:object, n:number) { if n > 0 { return g(x, n) }\nreturn x }\nfunction g(y:object, n:number) { return f(y, n - 1) }\nlet r=f({a:1}, hostValue)\nlet t=f({b:1}, 0)\nsay "${r.zz}"\nexit\n',
];

test("the objects query names a read's missing writer as the read does on each control route, in four modes (#1747)", () => {
  for (const source of CONTROLS)
    for (const mode of MODES) {
      const label = `${JSON.stringify(mode)}\n${source}`;
      // (with room for the oracle's reads after the analysis, each control's at every literal path and property)
      let covered = 0;
      for (const pass of passesOf(source, mode, 30_000_000)) {
        const result = inMode(mode, () => compared(pass));
        assert.deepEqual(result.differences, [], label);
        covered += result.covered;
      }
      assert.ok(covered > 0, label);
    }
});

/** A family's member literals: those whose index stands at `p` below their root. */
function members(pass: CorePass): number[] {
  return [...pass.program.hasOf.keys()].filter((literal) =>
    pass.contract.literalIndex(literal).root.children.has("p"),
  );
}

test("an objects query a demand stop interrupts leaves no answer, and asked again names the writer a fresh pass does (#1747)", () => {
  for (const shape of SHAPES) {
    const source = family(shape, 8, true);
    const mode = MODES[0]!;
    const [pass] = passesOf(source, mode);
    const [fresh] = passesOf(source, mode);
    const literals = members(pass!);
    assert.ok(literals.length > 0, shape);
    inMode(mode, () => {
      for (const [at, literal] of literals.entries()) {
        const ask = () => absentWriterAt(pass!.contract, literal, ["p"], "f0");
        let stopped = false;
        try {
          pass!.solver.demand(ask(), 1);
        } catch (error) {
          if (!(error instanceof DemandExhausted)) throw error;
          stopped = true;
        }
        assert.ok(stopped, shape);
        const again = pass!.solver.run(ask());
        const other = fresh!.solver.run(
          absentWriterAt(fresh!.contract, members(fresh!)[at]!, ["p"], "f0"),
        );
        assert.ok(again.covered && other.covered, shape);
        assert.equal(text(again.writer), text(other.writer), shape);
      }
    });
  }
});

test("an objects query's name is asked again in a fresh pass (#1747)", () => {
  for (const shape of SHAPES) {
    const source = family(shape, 4, true);
    const mode = MODES[0]!;
    const [pass] = passesOf(source, mode);
    const literal = members(pass!)[0]!;
    const demand = objectsAt(pass!.contract, literal, ["p"]);
    inMode(mode, () => pass!.solver.run(pass!.contract.pass.solver.proven(demand)));
    const names = [demand.key];
    const exported = exportNames(pass!.contract, names);
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    const answers = inMode(mode, () =>
      exported === null
        ? solveDemands(request, names)
        : solveDemands(request, exported.names, exported.packet),
    );
    assert.deepEqual(answers, [[]], shape);
  }
});

test("each family's objects queries at its members' path cost what the family's size does (#1747)", () => {
  for (const shape of SHAPES) {
    const units = [8, 16].map((k) => {
      const mode = MODES[0]!;
      const [pass] = passesOf(family(shape, k, true), mode);
      const before = pass!.program.work.total;
      inMode(mode, () => {
        for (const literal of members(pass!))
          pass!.solver.run(pass!.solver.proven(objectsAt(pass!.contract, literal, ["p"])));
      });
      return pass!.program.work.total - before;
    });
    // (linear: twice the members, at most about twice the work; k² would be four times)
    assert.ok(units[1]! <= 2.5 * units[0]!, `${shape}: ${units.join(", ")}`);
  }
});

test("after the analysis stops, an objects query covers no read: its unfinished queries decline (#1747)", () => {
  for (const shape of SHAPES) {
    const mode = MODES[0]!;
    // (an allowance the family exceeds: the pass stops, and every demand after it finishes as it stood)
    const passes = passesOf(family(shape, 8, true), mode, 2_000);
    const pass = passes.at(-1)!;
    assert.ok(pass.program.work.stopped !== null, shape);
    inMode(mode, () => {
      for (const literal of members(pass))
        assert.equal(
          pass.solver.run(absentWriterAt(pass.contract, literal, ["p"], "f0")).covered,
          false,
          shape,
        );
    });
  }
});
