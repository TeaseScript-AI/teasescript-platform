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
    '    say "${count}", instant',
    "}",
    "offer(1)",
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
];

test("every name read in a played session is the variable or global planNames names", () => {
  for (const files of PROGRAMS) {
    const plan = compiled(files);
    const result = checkNamesAgainstEngine(plan);
    assert.deepEqual(result.mismatches, [], Object.keys(files).join(" "));
    assert.equal(result.ended, "halted", Object.keys(files).join(" "));
    assert.ok(result.scoped > 10, `${result.scoped} scoped reads`);
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
  const total = plan.instructions.findIndex(
    (instruction) => instruction.kind === "declareBinding" && instruction.name === "total",
  );
  const totalVariable = names.declaredAt(total)[0]!;
  const other = names.variables.find((variable) => variable.name === "i")!;
  const swapped: PlanNames = {
    ...names,
    readsAt: (index) =>
      new Map(
        [...names.readsAt(index)].map(([name, target]): [string, NameTarget] =>
          target.kind === "variable" && target.variable === totalVariable
            ? [name, { kind: "variable", variable: other }]
            : [name, target],
        ),
      ),
  };
  const result = checkNamesAgainstEngine(plan, swapped);
  assert.ok(result.mismatches.length > 0);
  assert.match(result.mismatches[0]!, /'total' is v\d+, not v\d+/u);
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
  assert.match(checkNamesAgainstEngine(plan, asGlobal).mismatches[0]!, /not a global/u);
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
  assert.deepEqual(checkNamesAgainstEngine(plan, merged).mismatches, [
    `v${firstA.id} 'a' is declared by instructions ${first}, ${second}`,
  ]);
});
