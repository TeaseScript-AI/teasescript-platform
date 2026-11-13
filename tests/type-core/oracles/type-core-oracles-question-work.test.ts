// The oracle's questions' work: their cost per cell returned is flat on the families, and a binding's admitted type
// reads its copied value at its own field (#1948, #2065).

import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import {
  inMode,
  MODES,
  occurrences,
  QUESTION_UNITS_PER_CELL,
} from "../../helpers/type-core-oracles.js";
import { DOUBLING } from "../../helpers/type-core/type-core-work.js";
import { main, cellsOf } from "../../helpers/type-core/type-core-oracles-setup.js";

/** A family's sources at `sizes` (`shape` of the generator at `module`), with the generator's globals. */
async function family(module: string, shape: string, sizes: readonly number[]) {
  // EVIDENCE: each generator exports `shapes` (a size to a source or its files) and `globals` (tests/families/README.md).
  const generator = (await import(pathToFileURL(resolve(module)).href)) as {
    readonly shapes: Record<string, (size: number) => string | SourceFile[]>;
    readonly globals?: readonly string[];
  };
  return sizes.map((size) => {
    const made = generator.shapes[shape]!(size);
    return {
      files: typeof made === "string" ? main(made) : made,
      globals: generator.globals ?? [],
    };
  });
}

/**
 * The occurrences' questions' units per cell they return (`Questions`' measure), at the family's natural allowance in
 * the first mode, each source answered whole.
 */
function perCell(
  sources: readonly { files: SourceFile[]; globals: readonly string[] }[],
): number[] {
  return sources.map(({ files, globals }) => {
    const request = coreRequest(files, globals);
    assert.ok(request !== null);
    return inMode(MODES[0]!, () => {
      const answers = analyseCore(request);
      assert.equal(answers.budget.exhausted, null);
      answers.apart(() => undefined);
      const before = answers.budget.finishing;
      const asked = answers.apart(() => occurrences(answers, (items) => items));
      const cells = asked.map(cellsOf).reduce((a, b) => a + b, 0);
      return (answers.budget.finishing - before) / cells;
    });
  });
}

/** Each step's relative rise of a series. */
const rises = (series: readonly number[]) =>
  series.slice(1).map((value, index) => value / series[index]! - 1);

test("the oracle's questions cost per cell they return is flat on W19-record, and on W24-varied, r3-root-copies and W32-own-test rises by a falling step, a log factor, below K (#1837, #1941)", async () => {
  const gates = "tests/families/copies/copy-work/guard-call-handler-and-store-flow-products.mjs";
  // (flat: under 1 % a step either way, 24.224 / 24.204 / 24.140 / 24.087)
  const flat = perCell(await family(gates, "W19-record", [16, 32, 64, 128]));
  for (const rise of rises(flat)) assert.ok(Math.abs(rise) < 0.01, JSON.stringify(flat));
  for (const cost of flat) assert.ok(cost < QUESTION_UNITS_PER_CELL, JSON.stringify(flat));
  for (const [module, shape] of [
    [gates, "W24-varied"],
    [
      "tests/families/copies/copy-projections/layered-field-store-and-reader-matrix.mjs",
      "r3-root-copies",
    ],
    [gates, "W32-own-test"],
  ] as const) {
    const series = perCell(await family(module, shape, [16, 32, 64, 128]));
    const steps = rises(series);
    // (each step's rise below the one before: no polynomial re-walk, #1941's binary searches over a key's definitions)
    for (const [index, step] of steps.entries())
      if (index > 0) assert.ok(step < steps[index - 1]!, `${shape}: ${JSON.stringify(series)}`);
    // (within K at every size)
    for (const cost of series)
      assert.ok(cost < QUESTION_UNITS_PER_CELL, `${shape}: ${JSON.stringify(series)}`);
  }
});

/** No globals: the list-field copies read none. */
const NO_GLOBALS: readonly string[] = [];

/**
 * #1948: a binding's admitted type, asked of each binding, reads its copied value at its own field, never every copied
 * object there: on r3-root-copies (`r_i = a.f_i` over k whole copies of one-field objects into `a`, the oracle's
 * `["element"]` question) and with the fields lists (the backend's own `[]` question, which reads their elements), the
 * bindings' questions grow with the program in every mode (3.7 a doubling at 16 → 32 before #1948: the contract's fold
 * of every copied object at the field, admission's copies of `a` tried for every field). #2065: so does the backend's
 * `["element"]` question of each list binding, whose decision reads the copy holding the field alone (3.7 a doubling
 * before #2065: admission's scan of every copy of `a` before it, `holdersOf`).
 */
test("a binding's admitted type reads its copied value at its own field: the bindings' questions grow linearly (#1948)", async () => {
  const rows = (k: number, row: (i: number) => string) =>
    Array.from({ length: k }, (_, i) => row(i)).join("\n");
  const lists = (k: number) => [
    {
      files: main(
        [
          "let t:integer=1",
          rows(k, (i) => `let root${i}={f${i}:[t]}`),
          "let a=root0",
          rows(k - 1, (i) => `a=root${i + 1}`),
          rows(k, (i) => `let r${i}=a.f${i}`),
          "exit",
        ].join("\n"),
      ),
      globals: NO_GLOBALS,
    },
  ];
  const series = [
    {
      name: "r3-root-copies [element]",
      path: ["element"],
      sources: await family(
        "tests/families/copies/copy-projections/layered-field-store-and-reader-matrix.mjs",
        "r3-root-copies",
        [16, 32],
      ),
    },
    { name: "list fields []", path: [], sources: [...lists(16), ...lists(32)] },
    { name: "list fields [element]", path: ["element"], sources: [...lists(16), ...lists(32)] },
  ];
  const steep: string[] = [];
  for (const { name, path, sources } of series)
    for (const [index, mode] of MODES.entries()) {
      const [small, large] = sources.map(({ files, globals }) => {
        const request = coreRequest(files, globals);
        assert.ok(request !== null);
        return inMode(mode, () => {
          const answers = analyseCore(request);
          assert.equal(answers.budget.exhausted, null);
          const bindings = new CoreProgram(request).places
            .filter(({ kind }) => kind.kind === "binding" && /^r\d+$/.test(kind.name))
            .map(({ id }) => id);
          answers.apart(() => undefined);
          const before = answers.budget.finishing;
          answers.apart(() => bindings.map((binding) => answers.place(binding, path)));
          return answers.budget.finishing - before;
        });
      });
      if (large! > DOUBLING * small!) steep.push(`${name}, mode ${index}: ${small} → ${large}`);
    }
  assert.deepEqual(steep, []);
});
