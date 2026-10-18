import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PackageFolder } from "../playground/package-folder.js";
import { compileProject, type CompileOptions, type ProjectSourceFile } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { compareBackwardAnalyses } from "./helpers/backward-analyses-oracle.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot-construction.js";

/*
 * The backward analyses on the plan's control flow give what their own walks of the plan gave before (see the oracle):
 * at every root instruction what its code needs, and for every continuation, in each loop context it may come with,
 * the temporaries it needs. Over the repository's example and fixture scripts, and scripts with each construct that
 * shapes the flow: loops with `break` and `continue`, gotos and labels, function and file calls, defaults left out and
 * supplied, blocks, asks, and waits in defaults.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

const projects: readonly { readonly name: string; readonly files: Record<string, string> }[] = [
  {
    name: "loops",
    files: {
      "main.tease": [
        "let total = 0",
        "for value in 1..=4 {",
        "    if value == 2 { continue }",
        "    repeat 2 {",
        "        if total > 5 { break }",
        "        total += value",
        "    }",
        "    while total < value * 3 {",
        "        total += 1",
        "        if total == 7 { continue }",
        "    }",
        "}",
        "let pairs = dict{ a: 1, b: 2 }",
        "for key, count in pairs {",
        '    say "${key} ${count}"',
        "    while false {}",
        "}",
        'say "${total}"',
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "labels and gotos",
    files: {
      "main.tease": [
        "let count = 0",
        "label again",
        "let pass = count + 1",
        "count = pass",
        "if count < 3 { goto again }",
        "function leave {",
        "    repeat 3 {",
        "        while true { goto done }",
        "    }",
        "}",
        "leave()",
        "label done",
        'let answer = askChoice "Again?", yes: "Yes", no: "No"',
        'if answer == "yes" { goto again }',
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "functions and defaults",
    files: {
      "main.tease": [
        "function slow(value) {",
        "    wait 1 s",
        "    return value",
        "}",
        'function greet(who = "you", times = slow(2), title = "pet") {',
        "    repeat times {",
        '        say "Hello ${title} ${who}"',
        "    }",
        "    return who",
        "}",
        "function count(n) {",
        "    if n <= 0 { return 0 }",
        "    return count(n - 1) + slow(1)",
        "}",
        'let names = ["a"]',
        "let ages = dict{ sam: 3 }",
        'let name = names.get(1, default: askText "Your name?")',
        "let age = ages.get(name, default: slow(4))",
        "say greet()",
        'say greet("Ann", 1)',
        'say greet(times: count(2), title: askText "Title?")',
        'say "${age}"',
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "file calls and gotos",
    files: {
      "main.tease": [
        "let rounds = 0",
        "function visit(name) {",
        "    repeat 2 {",
        '        call "corner.tease"',
        "        rounds += 1",
        "    }",
        '    return "${name} ${rounds}"',
        "}",
        'say visit("first")',
        'goto "rooms/hall.tease"',
      ].join("\n"),
      "corner.tease": 'say "corner"\nlet choice = askChoice "Stay?", yes: "Yes"\nend',
      "rooms/hall.tease": 'say "hall"\ngoto "rooms/yard.tease" back',
      "rooms/yard.tease": 'say "skipped"\nlabel back\nsay "yard"\nexit',
    },
  },
  {
    name: "blocks",
    files: {
      "main.tease": [
        "let pulses = 0",
        "let pulse = timer async 2 s {",
        "    pulses += 1",
        "    repeat pulses { wait 1 s }",
        "}",
        'showPermanentButton "Stop" {',
        "    pulse.stop()",
        '    say "stopped", instant',
        "}",
        'playAudio async "a.mp3" {',
        "    at 1 s {",
        '        for step in 1..=2 { say "cue ${step}", instant }',
        "    }",
        "    finish {",
        '        say "finished", instant',
        "    }",
        "}",
        'let name = askText "Name?"',
        'say "${name} ${pulses}"',
        "exit",
      ].join("\n"),
    },
  },
];

async function fixturePlans(): Promise<
  { readonly name: string; readonly plan: InstructionPlan }[]
> {
  const plans: { name: string; plan: InstructionPlan }[] = [];
  const add = (name: string, files: readonly ProjectSourceFile[], options: CompileOptions = {}) => {
    const plan = compileProject(files, options).plan;
    if (plan !== null) plans.push({ name, plan });
  };
  const packages = join(root, "tests/fixtures/packages");
  for (const entry of (await readdir(packages, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const scan = await new PackageFolder(join(packages, entry.name)).scan();
    add(`package ${entry.name}`, scan.sources, { images: scan.images });
  }
  for (const directory of ["tests/fixtures/timers", "examples/playground", "examples/demo"]) {
    for (const file of (await readdir(join(root, directory))).sort()) {
      if (!file.endsWith(".tease")) continue;
      const source = await readFile(join(root, directory, file), "utf8");
      add(`${directory}/${file}`, [{ path: "main.tease", source }]);
    }
  }
  return plans;
}

test("the backward analyses on the plan graph give what the walks they replace gave", async () => {
  const plans = await fixturePlans();
  for (const { name, files } of projects) {
    const result = compileProject(
      Object.entries(files).map(([path, source]) => ({ path, source })),
    );
    assert.notEqual(result.plan, null, `${name}: ${JSON.stringify(result.diagnostics)}`);
    plans.push({ name, plan: result.plan! });
  }
  for (const { name, plan } of plans) {
    const comparison = compareBackwardAnalyses(plan);
    assert.deepEqual(comparison.differences, [], name);
    // Each root instruction, and a continuation at every instruction in at least one loop context.
    assert.ok(comparison.rootInstructions > 0, name);
    assert.ok(comparison.continuationQueries >= plan.instructions.length, name);
  }
  // Every fixture and example that compiles takes part.
  assert.ok(plans.length > projects.length + 10);
});

/*
 * A checkpoint is external data: its plan is validated before either analysis builds a graph of it, and a plan that
 * fails validation reaches neither. The label check runs only on a plan that is otherwise valid.
 */
test("malformed plans and checkpoints are refused before either analysis builds a graph", () => {
  const plan = compileValidPlan(
    [
      "function pause {",
      "    wait 1 s",
      "    return 1",
      "}",
      "let total = 0",
      "repeat 2 {",
      '    say "${total} ${pause()}"',
      "    total += 1",
      "}",
      "label done",
      'say "${total}"',
      "exit",
    ].join("\n"),
  );
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.callFrames.length, 1);
  const checkpoint = JSON.parse(serializeCheckpoint(createCheckpoint(plan, waiting)));
  const index = (kind: string) =>
    plan.instructions.findIndex((instruction) => instruction.kind === kind);
  const loopStart = index("loopStart");
  const call = index("callFunction");
  const corruptions: readonly {
    readonly expected: string;
    readonly graphs: number;
    readonly corrupt: (copy: typeof checkpoint) => void;
  }[] = [
    {
      expected: "Loop-control target does not match its loop.",
      graphs: 0,
      corrupt: (copy) => (copy.plan.instructions[index("loopControl")].target = loopStart + 1),
    },
    {
      expected: "Loop exit target must follow its start.",
      graphs: 0,
      corrupt: (copy) => (copy.plan.instructions[loopStart].target = loopStart),
    },
    {
      expected: "Control-flow target leaves the instruction's execution region.",
      graphs: 0,
      corrupt: (copy) =>
        (copy.plan.instructions[loopStart].target = plan.functions[0]!.bodyEntryInstruction),
    },
    {
      expected: "Function return target must be the instruction after the call.",
      graphs: 0,
      corrupt: (copy) =>
        (copy.plan.instructions[call].returnInstruction = plan.functions[0]!.bodyEntryInstruction),
    },
    {
      expected: "Instruction must be an object with a kind.",
      graphs: 0,
      corrupt: (copy) => (copy.plan.instructions[index("assign")] = 5),
    },
    // An otherwise valid plan is checked along its graph, and its label inside the loop is refused.
    {
      expected: "A label must stand between statements of its file's outer scope.",
      graphs: 1,
      corrupt: (copy) => (copy.plan.files[0].labels[0].instruction = call),
    },
  ];
  for (const { expected, graphs, corrupt } of corruptions) {
    const copy = structuredClone(checkpoint);
    corrupt(copy);
    const counts = withValidationTestStatistics((finish) => {
      assert.equal(validateInstructionPlan(copy.plan).errors[0]?.message, expected);
      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(copy)),
        (error: unknown) =>
          error instanceof CheckpointError &&
          error.info.code === "TSK002" &&
          error.message === expected &&
          error.info.path.startsWith("$.plan"),
      );
      return finish().counts;
    });
    // One label check by each of the two validations, and no snapshot analysis.
    assert.equal(counts.labelPositionAnalyses ?? 0, graphs * 2, expected);
    assert.equal(counts.snapshotValidationAnalyses ?? 0, 0, expected);
  }

  // A snapshot is checked against its validated plan's graph: the call's continuation reads what the caller set.
  const missing = structuredClone(checkpoint);
  missing.snapshot.callFrames[0].callerTemporaries = [];
  assert.throws(
    () => deserializeCheckpoint(JSON.stringify(missing)),
    (error: unknown) =>
      error instanceof CheckpointError &&
      error.message === "Runtime caller temporaries cannot resume the suspended continuation.",
  );
  assert.deepEqual(deserializeCheckpoint(JSON.stringify(checkpoint)).snapshot, waiting);
});
