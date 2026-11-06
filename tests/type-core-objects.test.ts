import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { Consumers } from "../src/type-inference/core/consumers.js";
import { indexPaths, stepsOf } from "../src/type-inference/core/contract/literal-index.js";
import { absentWriterAt } from "../src/type-inference/core/contract/objects.js";
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
function passesOf(source: string, mode: (typeof MODES)[number]): CorePass[] {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const passes: CorePass[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    passes.push(this.pass);
    check.call(this);
  };
  try {
    inMode(mode, () => analyseCore(request));
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
    asks.push([value, []]);
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
            const result = compared(pass);
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
    const { at, differences } = compared(pass!);
    assert.deepEqual(differences, []);
    const member = shape === "different-steps" ? /:a\.p$|:b\.p$/ : /:p$/;
    assert.ok(
      [...at].some((each) => member.test(each)),
      `${shape}: ${[...at].join(" ")}`,
    );
  }
});
