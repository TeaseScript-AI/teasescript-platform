import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { compileProject } from "../../src/compiler.js";
import { generateJavaScript, programModule } from "../../src/compiler/javascript/generate.js";
import { writeJson } from "../../src/compiler/javascript/json.js";
import { planNames } from "../../src/compiler/javascript/names.js";
import { ProgramTable } from "../../src/compiler/javascript/places.js";
import { GenerationRefused } from "../../src/compiler/javascript/refusal.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { validatedPlanSha256 } from "../../src/runtime/debug/source-sidecar.js";
import { compareGenerated } from "../helpers/generated-comparison/compare.js";

// The stage admits no plan form yet: every plan is refused by the name of the first instruction it reaches. Its table
// and its module's frame are checked through their own entries.

function compiled(
  files: Readonly<Record<string, string>>,
  globals: readonly string[] = [],
): InstructionPlan {
  const result = compileProject(
    Object.entries(files).map(([path, source]) => ({ path, source })),
    { globals },
  );
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  return result.plan!;
}

const PROGRAMS: readonly Readonly<Record<string, string>>[] = [
  { "main.tease": 'say "x", instant\nexit' },
  { "main.tease": "global level = 2\nlet x = level\nexit" },
  {
    "main.tease": 'function visit { call "rooms/hall.tease" }\nvisit()\nexit',
    "rooms/hall.tease": "wait 1 s\nend",
  },
];

/**
 * The plan of `guards/30000` of the families' builtin-value spreads, whose 30,000-term `and` chain nests 30,008 deep
 * in the plan: deeper than native `JSON.stringify` reaches.
 */
async function deepPlan(): Promise<InstructionPlan> {
  const load = async (path: string): Promise<unknown> =>
    import(pathToFileURL(resolve(process.cwd(), path)).href);
  // EVIDENCE: `tests/families/sources.mjs` exports `sourcesOf` (the families' source identity).
  const { sourcesOf } = (await load("tests/families/sources.mjs")) as {
    sourcesOf(
      generator: unknown,
    ): {
      readonly name: string;
      readonly files: readonly { readonly path: string; readonly source: string }[];
      readonly globals: readonly string[];
    }[];
  };
  const source = sourcesOf(
    await load(
      "tests/families/copies/builtin-values/wide-builtin-value-and-spread-source-forms.mjs",
    ),
  ).find((candidate) => candidate.name === "guards/30000")!;
  return compiled(
    Object.fromEntries(source.files.map((file) => [file.path, file.source])),
    source.globals,
  );
}

test("every plan is refused by its first instruction's kind, also through the comparison", async () => {
  for (const files of PROGRAMS) {
    const plan = compiled(files);
    const form = `instruction:${plan.instructions[0]!.kind}`;
    assert.throws(
      () => generateJavaScript(plan),
      (error) =>
        error instanceof GenerationRefused && error.form === form && error.instruction === 0,
    );
    assert.deepEqual(await compareGenerated({ plan, generate: generateJavaScript }), {
      kind: "refused",
      form,
      instruction: 0,
      span: plan.instructions[0]!.span,
    });
  }
});

test("a plan nested deeper than native JSON reaches is refused, and its table and module are written", async () => {
  const plan = await deepPlan();
  assert.throws(() => JSON.stringify(plan), RangeError);
  assert.throws(() => generateJavaScript(plan), GenerationRefused);
  // The plan's digest is of its JSON text, the bytes `writeJson` gives too.
  const digest = validatedPlanSha256(plan);
  assert.equal(digest, createHash("sha256").update(writeJson(plan)).digest("hex"));
  const table = new ProgramTable(plan, digest).table();
  assert.equal(table.planSha256, digest);
  // The deepest instruction as a constant, which the module's code reads from its pool.
  const deepest = plan.instructions.reduce((longest, instruction) =>
    writeJson(instruction).length > writeJson(longest).length ? instruction : longest,
  );
  const module = programModule(table, [deepest], "const file0 = () => K[0];");
  const loaded = (await import(`data:text/javascript,${encodeURIComponent(module)}`)) as {
    default(rt: unknown): { files: (() => unknown)[] };
  };
  assert.equal(writeJson(loaded.default({}).files[0]!()), writeJson(deepest));
});

test("the same plan gives the same table, names and module, also after its JSON round trip", () => {
  for (const files of PROGRAMS) {
    const plan = compiled(files);
    const again = JSON.parse(writeJson(plan)) as InstructionPlan;
    const output = (from: InstructionPlan) => {
      const table = new ProgramTable(from, validatedPlanSha256(from));
      table.place(from.instructions.length - 1);
      const tableNow = table.table();
      return [
        writeJson(tableNow),
        writeJson(planNames(from).variables),
        programModule(tableNow, [from.instructions[0]], "  const file0 = null;"),
      ];
    };
    assert.deepEqual(output(again), output(plan));
    assert.deepEqual(output(plan), output(plan));
  }
});

test("the module's frame returns the program's files, functions and blocks from one call of program(rt)", async () => {
  const plan = compiled({
    "main.tease": [
      "function a {",
      '    say "a", instant',
      "}",
      'showPermanentButton "B" {',
      "    a()",
      "}",
      'call "rooms/two.tease"',
      "exit",
    ].join("\n"),
    "rooms/two.tease": "end",
  });
  const table = new ProgramTable(plan, validatedPlanSha256(plan)).table();
  const functionIds = table.functions.map(({ id }) => id);
  const blockIds = table.blocks.map(({ id }) => id);
  assert.equal(functionIds.length, 1);
  assert.equal(blockIds.length, 1);
  const body = [
    "  const marks = [];",
    "  const file0 = () => marks;",
    "  const file1 = () => rt;",
    `  const f${functionIds[0]} = () => ${functionIds[0]};`,
    `  const b${blockIds[0]} = () => ${blockIds[0]};`,
  ].join("\n");
  const module = programModule(table, [], body);
  assert.ok(
    module.startsWith(`// TeaseScript program. Generator 1. Plan sha256 ${table.planSha256}.\n`),
  );
  const loaded = (await import(`data:text/javascript,${encodeURIComponent(module)}`)) as {
    default(rt: unknown): {
      files: (() => unknown)[];
      functions: Record<number, () => number>;
      blocks: Record<number, () => number>;
    };
  };
  const rt = {};
  const first = loaded.default(rt);
  const second = loaded.default(rt);
  assert.equal(first.files.length, 2);
  assert.equal(first.files[1]!(), rt);
  assert.equal(first.functions[functionIds[0]!]!(), functionIds[0]);
  assert.equal(first.blocks[blockIds[0]!]!(), blockIds[0]);
  // Two calls share no state.
  assert.notEqual(first.files[0]!(), second.files[0]!());
});
