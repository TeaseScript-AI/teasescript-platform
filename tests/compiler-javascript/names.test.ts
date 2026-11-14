import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../../src/compiler.js";
import { planNames, type NameTarget, type PlanNames } from "../../src/compiler/javascript/names.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { checkNamesAgainstEngine } from "../helpers/plan-names-engine.js";

// `planNames` decides, for every name the plan reads, which variable generated code reads; the engine's lookup is the
// oracle (`checkNamesAgainstEngine`). Each program covers a way the engine finds a name.

function compiled(files: Readonly<Record<string, string>>): InstructionPlan {
  const result = compileProject(Object.entries(files).map(([path, source]) => ({ path, source })));
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  assert.notEqual(result.plan, null);
  return result.plan!;
}

const main = (lines: readonly string[]): Record<string, string> => ({
  "main.tease": lines.join("\n"),
});

/** The target of `name` where the instruction of file `path` whose source holds `text` reads it. */
function readOf(
  plan: InstructionPlan,
  files: Readonly<Record<string, string>>,
  path: string,
  text: string,
  name: string,
): NameTarget {
  const offset = files[path]!.indexOf(text);
  const file = plan.files.find((candidate) => candidate.path === path)!;
  const names = planNames(plan);
  for (let index = file.startInstruction; index < file.endInstruction; index += 1) {
    const span = plan.instructions[index]!.span;
    const target = names.readsAt(index).get(name);
    if (span.so <= offset && offset < span.eo && target !== undefined) return target;
  }
  assert.fail(`no instruction at "${text}" reads ${name}`);
}

const PROGRAMS: readonly Readonly<Record<string, string>>[] = [
  // Parameters, defaults, a function's scopes, its file's top level, a global function, a global and a speaker.
  main([
    "global level = 1",
    "speaker guide {",
    '    firstName: "Ann"',
    "}",
    "for k in [1] {",
    "    let q = k",
    "}",
    "let base = 10",
    "function add(a: integer, b: integer = base): integer {",
    "    let c = a + b + level",
    "    if c > 5 {",
    "        let d = c * 2",
    "        return d",
    "    }",
    "    return c",
    "}",
    "global function twice(n: integer): integer {",
    "    let m = n * 2 + level",
    "    return m",
    "}",
    "let x = add(1)",
    "let y = add(1, 2)",
    "let z = twice(x)",
    "speaker guide",
    "let biggest = max(x, y)",
    'say as guide "${x} ${y} ${z} ${biggest}", instant',
    "exit",
  ]),
  // Loops: each round's own variables, `for key, value`, `break` and `continue`, and sibling scopes of one name.
  main([
    "let total = 0",
    "let toys = dict {}",
    'toys["a"] = 1',
    'toys["b"] = 2',
    "for n in [1, 2, 3] {",
    "    let d = n * 2",
    "    if d > 4 {",
    "        break",
    "    }",
    "    total += d",
    "}",
    "for k, v in toys {",
    '    say "${k} ${v}", instant',
    "}",
    "repeat 2 {",
    "    let r = total",
    "    total = r + 1",
    "}",
    "let i = 0",
    "while i < 3 {",
    "    i += 1",
    "    if i == 2 {",
    "        continue",
    "    }",
    "    let w = i",
    "    total += w",
    "}",
    "if total > 0 {",
    "    let a = 1",
    '    say "${a}", instant',
    "} else {",
    "    let a = 2",
    '    say "${a}", instant',
    "}",
    "let a = 3",
    'say "${a}", instant',
    "exit",
  ]),
  // Blocks: the variables they share with the code that creates them, a block in a block, and their own `let`.
  main([
    "function offer(n: integer) {",
    "    let count = 0",
    '    showPermanentButton "Add" {',
    "        count += 1",
    "        n += 1",
    "        let inner = count + n",
    '        say "${inner}", instant',
    "    }",
    "    wait 1 s",
    "    wait 1 s",
    "    wait 1 s",
    '    say "${count}", instant',
    "}",
    "function tally {",
    "    let count = 2",
    '    say "${count}", instant',
    "}",
    "offer(1)",
    "tally()",
    'for name in ["a", "b"] {',
    "    let t = timer async hidden 1 s {",
    "        say name, instant",
    "        let again = timer async hidden 1 s {",
    "            say name, instant",
    "        }",
    "    }",
    "}",
    'let music = playAudio async "music.mp3" {',
    "    finish {",
    "        let same = music",
    '        say "done", instant',
    "    }",
    "}",
    "if true {",
    "    let local = 1",
    "    let tock = timer async hidden 1 s {",
    '        say "${local}", instant',
    "    }",
    "}",
    "wait 30 s",
    "exit",
  ]),
  // A `goto` back to a label runs a top-level `let` again; file calls and a `goto` to a file start activations.
  {
    "main.tease": [
      "let a = 1",
      "label again",
      "let b = a + 1",
      "a = b",
      "if a < 4 {",
      "    goto again",
      "}",
      'call "rooms/side.tease"',
      'call "rooms/side.tease"',
      'goto "rooms/last.tease"',
    ].join("\n"),
    "rooms/side.tease": [
      "let s = 5",
      "function local: integer {",
      "    return s",
      "}",
      "let t = local()",
      'say "${t}", instant',
      "end",
    ].join("\n"),
    "rooms/last.tease": ["let e = 1", 'say "${e}", instant', "exit"].join("\n"),
  },
  // A function reads a top-level variable its file sets only later, on ways that do not run; another file has its own.
  {
    "main.tease": [
      "function f: integer {",
      "    return 7 otherwise x",
      "}",
      "function g: boolean {",
      "    return true or x > 0",
      "}",
      "let result = f()",
      "let other = g()",
      "let x = 1",
      'say "${result} ${other} ${x}", instant',
      'call "rooms/other.tease"',
      "exit",
    ].join("\n"),
    "rooms/other.tease": ["let x = 5", 'say "${x}", instant', "end"].join("\n"),
  },
];

/** The plays each program gets: first answers, and one that also presses permanent buttons. */
const PLAYS = ["first", { seed: 1 }] as const;

test("every name read in a played session is the variable or global planNames names", () => {
  for (const files of PROGRAMS) {
    const plan = compiled(files);
    const entered = new Set<number>();
    for (const play of PLAYS) {
      const result = checkNamesAgainstEngine(plan, { play });
      const label = `${Object.keys(files).join(" ")} ${JSON.stringify(play)}`;
      assert.deepEqual(result.mismatches, [], label);
      assert.equal(result.ended, "halted", label);
      assert.ok(result.scoped > 0, label);
      for (const id of result.entered) entered.add(id);
    }
    // Every function and block was entered in some play.
    assert.deepEqual(
      plan.functions.filter((definition) => !entered.has(definition.id)).map(({ name }) => name),
      [],
    );
  }
});

test("a block reads the variables it shares as its creator's, and a function its file's top level", () => {
  const blocks = compiled(PROGRAMS[2]!);
  const declared = blocks.instructions.findIndex(
    (instruction) => instruction.kind === "declareBinding" && instruction.name === "count",
  );
  assert.deepEqual(readOf(blocks, PROGRAMS[2]!, "main.tease", "count += 1", "count"), {
    kind: "variable",
    variable: planNames(blocks).declaredAt(declared)[0],
  });
  const outer = readOf(
    blocks,
    PROGRAMS[2]!,
    "main.tease",
    "say name, instant\n        let",
    "name",
  );
  const inner = readOf(blocks, PROGRAMS[2]!, "main.tease", "say name, instant\n        }", "name");
  assert.deepEqual(inner, outer);
  assert.equal(outer.kind === "variable" && outer.variable.kind, "loop");
  const music = readOf(blocks, PROGRAMS[2]!, "main.tease", "let same = music", "music");
  assert.equal(music.kind === "variable" && music.variable.kind, "self");

  const files = compiled(PROGRAMS[3]!);
  const s = readOf(files, PROGRAMS[3]!, "rooms/side.tease", "return s", "s");
  assert.equal(s.kind === "variable" && s.variable.kind, "root");
  const functions = compiled(PROGRAMS[0]!);
  assert.deepEqual(readOf(functions, PROGRAMS[0]!, "main.tease", "n * 2 + level", "level"), {
    kind: "global",
    name: "level",
  });
});

test("an instruction reads an assignment's target, a speaker and what its block shares, not a builtin's name", () => {
  const loops = compiled(PROGRAMS[1]!);
  assert.equal(
    readOf(loops, PROGRAMS[1]!, "main.tease", "total = r + 1", "total").kind,
    "variable",
  );
  const functions = compiled(PROGRAMS[0]!);
  assert.deepEqual(readOf(functions, PROGRAMS[0]!, "main.tease", 'say as guide "', "guide"), {
    kind: "global",
    name: "guide",
  });
  const names = planNames(functions);
  const call = functions.instructions.findIndex(
    (instruction) => instruction.kind === "declareBinding" && instruction.name === "biggest",
  );
  assert.deepEqual([...names.readsAt(call).keys()].sort(), ["x", "y"]);
  const blocks = compiled(PROGRAMS[2]!);
  const button = blocks.instructions.findIndex(
    (instruction) => instruction.kind === "showPermanentButton",
  );
  assert.deepEqual([...planNames(blocks).readsAt(button).keys()].sort(), ["count", "n"]);
});

test("the engine check reports a name planNames gives the wrong variable", () => {
  const plan = compiled(PROGRAMS[1]!);
  const names = planNames(plan);
  // The top-level `a` read as the `a` of the `if` before it: the same name, another variable.
  const lets = plan.instructions.flatMap((instruction, index) =>
    instruction.kind === "declareBinding" && instruction.name === "a" ? [index] : [],
  );
  const [thenA, topA] = [names.declaredAt(lets[0]!)[0]!, names.declaredAt(lets[2]!)[0]!];
  const swapped: PlanNames = {
    ...names,
    readsAt: (index) =>
      new Map(
        [...names.readsAt(index)].map(([name, target]): [string, NameTarget] =>
          target.kind === "variable" && target.variable === topA
            ? [name, { kind: "variable", variable: thenA }]
            : [name, target],
        ),
      ),
  };
  const result = checkNamesAgainstEngine(plan, { names: swapped });
  assert.ok(result.mismatches.length > 0);
  for (const mismatch of result.mismatches)
    assert.match(mismatch, new RegExp(`'a' is v${topA.id}, not v${thenA.id}$`, "u"));
  const asGlobal: PlanNames = {
    ...names,
    readsAt: (index) =>
      new Map(
        [...names.readsAt(index)].map(([name, target]): [string, NameTarget] => [
          name,
          name === "total" ? { kind: "global", name } : target,
        ]),
      ),
  };
  assert.match(checkNamesAgainstEngine(plan, { names: asGlobal }).mismatches[0]!, /not a global/u);
  // The two sibling `let a` merged into one variable: every read still finds it, so only the declarations tell.
  const [first, second] = plan.instructions.flatMap((instruction, index) =>
    instruction.kind === "declareBinding" && instruction.name === "a" ? [index] : [],
  );
  const firstA = names.declaredAt(first!)[0]!;
  const secondA = names.declaredAt(second!)[0]!;
  const merge = (target: NameTarget): NameTarget =>
    target.kind === "variable" && target.variable === secondA
      ? { kind: "variable", variable: firstA }
      : target;
  const merged: PlanNames = {
    ...names,
    readsAt: (index) =>
      new Map([...names.readsAt(index)].map(([name, target]) => [name, merge(target)])),
    declaredAt: (index) => (index === second ? [firstA] : names.declaredAt(index)),
  };
  assert.deepEqual(checkNamesAgainstEngine(plan, { names: merged }).mismatches, [
    `v${firstA.id} 'a' is declared by instructions ${first}, ${second}`,
  ]);
});

test("the engine check reports a wrong variable in a block a press runs, and a variable taken for a global", () => {
  const blocks = compiled(PROGRAMS[2]!);
  const names = planNames(blocks);
  const button = blocks.functions.find((definition) => definition.handler === "button")!;
  // The button's `count` read as `tally`'s, whose name it shares.
  const tally = names.variables.filter((variable) => variable.name === "count")[1]!;
  const inButton: PlanNames = {
    ...names,
    readsAt: (index) =>
      index < button.entryInstruction || index >= button.endInstruction
        ? names.readsAt(index)
        : new Map(
            [...names.readsAt(index)].map(([name, target]): [string, NameTarget] => [
              name,
              name === "count" ? { kind: "variable", variable: tally } : target,
            ]),
          ),
  };
  const pressed = checkNamesAgainstEngine(blocks, { names: inButton, play: PLAYS[1] });
  assert.ok(pressed.entered.has(button.id));
  assert.match(pressed.mismatches[0]!, /'count' is v\d+, not v\d+/u);

  // `x` is read only on ways that do not run, where the engine finds no variable: only `main.tease`'s own `x` passes.
  const lazy = compiled(PROGRAMS[4]!);
  const lazyNames = planNames(lazy);
  const xs = lazyNames.variables.filter((variable) => variable.name === "x");
  const result = lazyNames.variables.find((variable) => variable.name === "result")!;
  assert.equal(xs.length, 2);
  const remapped = (target: NameTarget): void => {
    const names: PlanNames = {
      ...lazyNames,
      readsAt: (index) =>
        new Map(
          [...lazyNames.readsAt(index)].map(([name, read]): [string, NameTarget] => [
            name,
            name === "x" && read.kind === "variable" && read.variable === xs[0] ? target : read,
          ]),
        ),
    };
    const mismatches = checkNamesAgainstEngine(lazy, { names }).mismatches;
    assert.ok(mismatches.length > 0, JSON.stringify(target));
    for (const mismatch of mismatches) assert.match(mismatch, /'x' is /u);
  };
  remapped({ kind: "global", name: "x" });
  remapped({ kind: "variable", variable: xs[1]! });
  remapped({ kind: "variable", variable: result });

  // A global read as another global's name.
  const functions = compiled(PROGRAMS[0]!);
  const functionNames = planNames(functions);
  const renamed: PlanNames = {
    ...functionNames,
    readsAt: (index) =>
      new Map(
        [...functionNames.readsAt(index)].map(([name, read]): [string, NameTarget] => [
          name,
          name === "level" ? { kind: "global", name: "wrongGlobal" } : read,
        ]),
      ),
  };
  assert.match(
    checkNamesAgainstEngine(functions, { names: renamed }).mismatches[0]!,
    /'level' is read as another name/u,
  );
});

test("a read of a top-level variable before its file sets it fails in the engine, and names that variable", () => {
  const plan = compiled(
    main([
      "let y = 7",
      "function f: integer {",
      "    return x",
      "}",
      "let result = f()",
      "let x = 1",
      "say result, instant",
      "exit",
    ]),
  );
  const names = planNames(plan);
  const correct = checkNamesAgainstEngine(plan);
  assert.deepEqual(correct.mismatches, []);
  assert.equal(correct.ended, "failed");
  const y = names.variables.find((variable) => variable.name === "y")!;
  const wrong: PlanNames = {
    ...names,
    readsAt: (index) =>
      new Map(
        [...names.readsAt(index)].map(([name, read]): [string, NameTarget] => [
          name,
          name === "x" ? { kind: "variable", variable: y } : read,
        ]),
      ),
  };
  assert.ok(checkNamesAgainstEngine(plan, { names: wrong }).mismatches.length > 0);
});
