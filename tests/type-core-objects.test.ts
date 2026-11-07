import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { analyseCore, solveDemands } from "../src/type-inference/core/answers.js";
import { Consumers } from "../src/type-inference/core/consumers.js";
import { indexPaths, stepsOf } from "../src/type-inference/core/contract/literal-index.js";
import { exportNames, keyBelowIn } from "../src/type-inference/core/contract/key-ids.js";
import { writtenOf } from "../src/type-inference/core/contract/terms.js";
import { absentWriterAt, objectsAt } from "../src/type-inference/core/contract/objects.js";
import { readGroupsAt } from "../src/type-inference/core/contract/others.js";
import type { ReadEntry } from "../src/type-inference/core/contract/model.js";
import {
  DemandExhausted,
  withTestAllowance,
  withTestDemandAllowance,
} from "../src/type-inference/core/budget.js";
import { firstWriter, REASON, type Writer } from "../src/type-inference/core/items.js";
import type { ObjectsProof } from "../src/type-inference/core/contract/model.js";
import type { ProofDemand } from "../src/type-inference/core/solver.js";
import { stepName } from "../src/type-inference/core/program.js";
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
  // (the properties the source reads, and those its objects hold)
  for (const projection of program.projOf.values()) {
    const step = stepName(projection.step);
    if (/^[A-Za-z_]\w*$/.test(step)) names.add(step);
  }
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
  // a property stored below a key, its value a `missing` an earlier literal names
  'let base={}\nlet b2={a:{}}\nb2.a.c=base.zz\nsay "${b2.a.c}"\nexit\n',
  // a projected copy, and elements added whole
  'let preset={stats:{a:1}}\nlet s=preset.stats\nsay "${s.zz}"\nexit\n',
  'let l2=[{a:1}]\nl2.addAll([{b:2}])\nsay "${l2.first.zz}"\nexit\n',
  // a key with a written type below it
  "function hd(x:dict) { return x.zz }\nlet vv=hd({a:1})\nexit\n",
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
    // (an allowance the family exceeds once its checks have begun: the pass stops, and every demand after it finishes
    // as it stood)
    const source = family(shape, 8, true);
    const total = passesOf(source, mode).at(-1)!.program.work.total;
    const pass = [0.9, 0.8, 0.7, 0.6, 0.5]
      .map((part) => passesOf(source, mode, Math.floor(total * part)).at(-1))
      .find((each) => each !== undefined && each.program.work.stopped !== null);
    assert.ok(pass !== undefined, shape);
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

test("the objects query covers a cycle of calls a literal seeds, and names its writer as the read does (#1747)", () => {
  // (the call cycle's result read whole: through both functions' results to the literals passed in)
  const source = CONTROLS.find((each) => each.includes("return g(x, n)"))!;
  for (const mode of MODES) {
    const [pass] = passesOf(source, mode, 30_000_000);
    inMode(mode, () => {
      const { program, contract, solver } = pass!;
      const r = [...program.occurrenceOf.entries()].find(
        ([, b]) => program.places[b]?.label === "r",
      )![0];
      const derived = solver.run(absentWriterAt(contract, r, [], "zz"));
      assert.ok(derived.covered, JSON.stringify(mode));
      let writer: Writer | null = null;
      for (const item of solver.run(contract.contractOfValueAt(r, ["zz"])))
        if (item.tag === "unknown" && item.reasons === REASON.missing)
          writer = firstWriter(writer, item.writer);
      assert.ok(writer !== null);
      assert.equal(text(derived.writer), text(writer), JSON.stringify(mode));
    });
  }
});

test("a key's read at the property stopped is not covered: the query names no writer the stopped read does not, in four modes (#1747, Codex r1)", () => {
  // (the read of `b.p` finishes; its read at `zz` stops at the demand allowance, its answer the budget's unknown)
  const source = 'let a={p:{}}\nlet b=a\na=b\nsay "${b.p.zz}"\nexit\n';
  for (const mode of MODES) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    const passes: CorePass[] = [];
    const check = Consumers.prototype.check;
    Consumers.prototype.check = function (this: Consumers) {
      passes.push(this.pass);
      check.call(this);
    };
    try {
      withTestDemandAllowance(64, () => inMode(mode, () => analyseCore(request)));
    } finally {
      Consumers.prototype.check = check;
    }
    const pass = passes.at(-1)!;
    const result = inMode(mode, () => compared(pass));
    assert.deepEqual(result.differences, [], JSON.stringify(mode));
  }
});

test("a key's stores at the property are each charged as the query reads them (#1747, Codex r1)", () => {
  // (n stores the analysis rejects below `box.p`: the query visits each, so its work grows with them)
  const units = [8, 32].map((n) => {
    const rows = ["let box={p:{a:1}}"];
    for (let i = 0; i < n; i++) rows.push(`box.p.a="bad${i}"`);
    rows.push('say "${box.p.a}"', "exit");
    // (the last pass: the one whose lists hold the rejected stores as dead)
    const pass = passesOf(rows.join("\n") + "\n", MODES[0]!, 30_000_000).at(-1)!;
    const { program, contract, solver } = pass;
    const box = [...program.occurrenceOf.entries()].find(
      ([, b]) => program.places[b]?.label === "box",
    )![0];
    return inMode(MODES[0]!, () => {
      solver.run(absentWriterAt(contract, box, ["p"], "a"));
      const before = program.work.total;
      solver.run(absentWriterAt(contract, box, ["p"], "a"));
      return program.work.total - before;
    });
  });
  assert.ok(units[1]! > units[0]! + 16, units.join(", "));
});

test("an objects query charges each writer it meets and each edge it reads, a seen one too (#1747, Codex r2)", () => {
  const work = (
    source: string,
    value: (pass: CorePass) => number,
    rest: readonly string[],
  ): number => {
    const pass = passesOf(source, MODES[0]!, 30_000_000).at(-1)!;
    const { program, contract, solver } = pass;
    return inMode(MODES[0]!, () => {
      solver.run(absentWriterAt(contract, value(pass), rest, "zz"));
      const before = program.work.total;
      solver.run(absentWriterAt(contract, value(pass), rest, "zz"));
      return program.work.total - before;
    });
  };
  // (n objects nested 0 … n deep: n F11 writers met along `element.p…`)
  const nested = (n: number): number => {
    const objects = Array.from({ length: n + 1 }, (_, d) => "{p:".repeat(d) + "{}" + "}".repeat(d));
    // (the array literal: the one whose index holds its element)
    const array = (pass: CorePass): number =>
      [...pass.program.hasOf.keys()].find((literal) =>
        pass.contract.literalIndex(literal).root.children.has("element"),
      )!;
    return work(`let xs=[${objects.join(",")}]\nexit\n`, array, ["element", ...Array(n).fill("p")]);
  };
  const [a, b] = [nested(4), nested(16)];
  assert.ok(b >= a + 12, `${a}, ${b}`);
  // (n bindings each copied into every other: n² edges among n nodes)
  const dense = (n: number): number => {
    const rows = Array.from({ length: n }, (_, i) => `let b${i}={}`);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) rows.push(`b${i}=b${j}`);
    rows.push('say "${b0.zz}"', "exit");
    return work(
      rows.join("\n") + "\n",
      (pass) => Math.max(...[...pass.program.occurrenceOf.keys()]),
      [],
    );
  };
  const [c, d] = [dense(4), dense(8)];
  // (every edge charged, a seen one too: 17 against 65 edges at n = 4 and 8)
  assert.ok(d >= c + 96, `${c}, ${d}`);
});

test("a declined objects query charges each entry it visits, and stops at the first decline (#1747, Codex r3)", () => {
  // (n bindings read into one array beside a host value: the host's query declines, the rest is not read for it)
  const units = [4, 64].map((n) => {
    const rows = Array.from({ length: n }, (_, i) => `let b${i}={p${i}:1}`);
    rows.push(
      `let xs=[hostValue,${Array.from({ length: n }, (_, i) => `b${i}`).join(",")}]`,
      "exit",
    );
    const pass = passesOf(rows.join("\n") + "\n", MODES[0]!, 30_000_000).at(-1)!;
    const { program, contract, solver } = pass;
    const array = [...program.hasOf.keys()].find((literal) =>
      contract.literalIndex(literal).root.children.has("element"),
    )!;
    return inMode(MODES[0]!, () => {
      // (each read group's entries counted as the walk takes them: the visits themselves, not only their charge)
      const element = contract.literalIndex(array).root.children.get("element")!;
      let visits = 0;
      const restore: (() => void)[] = [];
      for (const group of readGroupsAt(contract, element.reads, false)) {
        // (the group's own list, its iterator counting each entry taken, put back after)
        const read: { [Symbol.iterator]: () => Iterator<ReadEntry> } & ArrayLike<ReadEntry> =
          group.read;
        const prior = Object.getOwnPropertyDescriptor(read, Symbol.iterator);
        Object.defineProperty(read, Symbol.iterator, {
          configurable: true,
          value: function* (this: ArrayLike<ReadEntry>) {
            for (let at = 0; at < this.length; at += 1) {
              visits += 1;
              yield this[at]!;
            }
          },
        });
        restore.push(() => {
          if (prior === undefined) Reflect.deleteProperty(read, Symbol.iterator);
          else Object.defineProperty(read, Symbol.iterator, prior);
        });
      }
      try {
        solver.run(solver.proven(objectsAt(contract, array, ["element"])));
        visits = 0;
        const before = program.work.total;
        const { proof } = solver.run(solver.proven(objectsAt(contract, array, ["element", "zz"])));
        assert.equal(proof?.complete, false);
        return { units: program.work.total - before, visits };
      } finally {
        for (const undo of restore) undo();
      }
    });
  });
  // (it stops at the first decline: one entry visited, and the work not growing with the entries after it)
  for (const { visits } of units) assert.equal(visits, 1, JSON.stringify(units));
  assert.ok(units[1]!.units <= units[0]!.units + 8, JSON.stringify(units));
});

/**
 * The visits `absentWriterAt` makes over a covered query's proof graph, counted from the proofs themselves: each node,
 * each key and each store at the property below it, each writer, each list and each child edge, a seen one too.
 */
function queryVisits(
  pass: CorePass,
  first: ProofDemand<ObjectsProof>,
  rest: readonly string[],
  step: string,
): number {
  const { contract, solver, definitions } = pass;
  // (the absence query's and its demand factory's entries, and the query path's naming: R, its length)
  let visits = 2 + rest.length;
  const seen = new Set<string>([first.key]);
  const open = [first];
  while (open.length > 0) {
    const { proof } = solver.run(solver.proven(open.pop()!));
    visits += 1; // each support node is charged by its worklist take
    for (const { key, place, path } of proof!.keys) {
      visits += 1 + (definitions.byKey.get(keyBelowIn(contract, key, [step])) ?? []).length;
      if (writtenOf(pass.program.place(place).kind) !== null) visits += path.length + 3;
    }
    visits += proof!.prior.length + proof!.lists.length + proof!.children.length;
    for (const child of proof!.children)
      if (!seen.has(child.key)) {
        seen.add(child.key);
        open.push(child);
      }
  }
  return visits;
}

test("a covered objects query charges exactly the visits its proof graph holds, over the families and the controls (#1747)", () => {
  // (the lead's invariant after three uncharged loops: the module's own counter against an independent count, so a
  // fourth loop cannot pass by a bound)
  const sources = [...SHAPES.map((shape) => family(shape, 8, true)), ...CONTROLS];
  let checked = 0;
  for (const source of sources) {
    const pass = passesOf(source, MODES[0]!, 30_000_000).at(-1)!;
    const { program, contract, solver } = pass;
    inMode(MODES[0]!, () => {
      for (const literal of program.hasOf.keys()) {
        // (the empty path, and a non-empty one where the literal holds a child: R = 0 and R = 1)
        const first = [...contract.literalIndex(literal).root.children.keys()][0];
        for (const rest of first === undefined ? [[]] : [[], [first]])
          for (const step of ["zz", "a", "p"]) {
            const ask = () => absentWriterAt(contract, literal, rest, step);
            // (warmed: every proof built, so the second ask is the traversal alone)
            if (!solver.run(ask()).covered) continue;
            const before = program.work.counts().get("objectSteps") ?? 0;
            solver.run(ask());
            const charged = (program.work.counts().get("objectSteps") ?? 0) - before;
            assert.equal(
              charged,
              queryVisits(pass, objectsAt(contract, literal, rest), rest, step),
              `${rest.join(".")}.${step}: ${source}`,
            );
            checked += rest.length === 0 ? 1 : 100;
          }
      }
    });
  }
  // (asks on both paths: some empty, some not)
  assert.ok(checked % 100 > 20 && checked >= 100, String(checked));
});

test("an objects query's construction copies no path suffix and reads each input step a constant number of times, however deep (#1747, charging round)", () => {
  // (R4's witness: a literal n deep read along its n steps; the walk copies a suffix only where a child entry needs it,
  // through the charged helper, so the input path's own positions are read 3n times and its slices none)
  const rows = [8, 32].map((n) => {
    const source = `let xs=${"{p:".repeat(n)}{}${"}".repeat(n)}\nexit\n`;
    const pass = passesOf(source, MODES[0]!, 30_000_000).at(-1)!;
    const { program, contract, solver } = pass;
    const literal = [...program.hasOf.keys()].find(
      (value) => program.places[value]?.site?.start === source.indexOf("{"),
    )!;
    return inMode(MODES[0]!, () => {
      solver.run(contract.contractOfValueAt(literal, [...Array<string>(n).fill("p"), "zz"]));
      // (the path's own positions, each a getter counting its reads; and its native slices counted)
      let [slices, reads] = [0, 0];
      const observed: string[] = [];
      for (let at = 0; at < n; at += 1)
        Object.defineProperty(observed, at, {
          enumerable: true,
          get: () => {
            reads += 1;
            return "p";
          },
        });
      Object.defineProperty(observed, "slice", {
        value: function (this: string[], start?: number, end?: number) {
          slices += 1;
          return Array.prototype.slice.call(this, start, end);
        },
        configurable: true,
      });
      const before = program.work.counts().get("objectSteps") ?? 0;
      const { proof } = solver.run(solver.proven(objectsAt(contract, literal, observed)));
      const units = (program.work.counts().get("objectSteps") ?? 0) - before;
      assert.equal(proof?.complete, true);
      return { n, slices, reads, units };
    });
  });
  for (const { n, slices, reads } of rows) {
    assert.equal(slices, 0, String(n));
    assert.equal(reads, 3 * n, String(n));
  }
  // (and its charged work grows with the depth, at most linearly)
  assert.ok(
    rows[1]!.units > rows[0]!.units && rows[1]!.units <= 4.5 * rows[0]!.units,
    JSON.stringify(rows),
  );
});
