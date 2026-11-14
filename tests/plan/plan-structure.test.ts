import assert from "node:assert/strict";
import test from "node:test";

import type { Instruction, InstructionPlan, PlanSourceLocation } from "../../src/plan/model.js";
import { planStructure, structureRefusal, type Construct } from "../../src/plan/structure.js";
import { validateInstructionPlan } from "../../src/plan/validation.js";
import { compileValidPlan } from "../helpers/compile-valid-plan.js";

/** Every construct of a tree, outermost first, with the instruction ranges each sequence covers. */
function constructs(tree: readonly Construct[]): Construct[] {
  const all: Construct[] = [];
  const pending: (readonly Construct[])[] = [tree];
  while (pending.length > 0) {
    for (const construct of pending.pop()!) {
      all.push(construct);
      if (construct.kind === "if") {
        pending.push(construct.whenTrue);
        if (construct.whenFalse !== null) pending.push(construct.whenFalse);
      } else if (construct.kind === "loop") pending.push(construct.head, construct.body);
      else if (construct.kind !== "run") pending.push(construct.body);
    }
  }
  return all;
}

/** Each sequence covers its range in order, without a gap; returns the instructions it covers. */
function covered(sequence: readonly Construct[], from: number, to: number): void {
  let at = from;
  for (const construct of sequence) {
    assert.equal(construct.from, at);
    at = construct.to;
  }
  assert.equal(at, to);
}

function regions(plan: InstructionPlan): { start: number; end: number }[] {
  return [
    ...plan.files.map((file) => ({ start: file.startInstruction, end: file.rootEndInstruction })),
    ...plan.functions.map((definition) => ({
      start: definition.entryInstruction,
      end: definition.endInstruction,
    })),
  ];
}

const SOURCE = [
  "let a = true",
  "let n = 0",
  "function pick(x: integer, y: integer = 2): integer {",
  "  if x > y { return x } else if x == y { return 0 } else { return y }",
  "}",
  "function count { n += 1\n return n }",
  "switch n {",
  "  case 0 { n = 1 }",
  "  case 1, 2 { n = 2 }",
  "  default { n = 3 }",
  "}",
  "while count() < 3 and a { if n == 2 { continue }\n n += 0 }",
  "repeat 2 { for i in 0..3 { if i == 1 { break } } }",
  "let b = (a or count() > 0) and n > 0",
  "let c = pick(1)",
  'say "${b} ${c}", instant',
  "exit",
].join("\n");

test("a lowered plan reads back as its source's constructs, each sequence covering its range in order", () => {
  const plan = compileValidPlan(SOURCE);
  const all: Construct[] = [];
  for (const region of regions(plan)) {
    const tree = planStructure(plan.instructions, region);
    covered(tree, region.start, region.end);
    for (const construct of constructs(tree)) {
      all.push(construct);
      if (construct.kind === "if") {
        covered(construct.whenTrue, construct.at + 1, construct.elseJump ?? construct.to);
        if (construct.whenFalse !== null) covered(construct.whenFalse, construct.elseJump! + 1, construct.to);
      } else if (construct.kind === "loop") {
        covered(construct.head, construct.from, construct.at);
        covered(construct.body, construct.at + 1, construct.to);
      } else if (construct.kind === "default")
        covered(construct.body, construct.at + 1, construct.to);
      else if (construct.kind === "scope")
        covered(construct.body, construct.from + 1, construct.to - 1);
    }
  }
  const count = (predicate: (construct: Construct) => boolean): number =>
    all.filter(predicate).length;
  // pick's if, else if, else: two ifs with a false way; the switch's two cases with a false way; `or`'s right side.
  assert.equal(
    count((c) => c.kind === "if" && c.whenFalse !== null),
    5,
  );
  // The while, the repeat and the for.
  assert.equal(
    count((c) => c.kind === "loop"),
    3,
  );
  // Only the while runs instructions in its condition, again each round.
  assert.equal(
    count((c) => c.kind === "loop" && c.head.length > 0),
    1,
  );
  // One for each of pick's parameters; only y's default runs instructions.
  assert.equal(
    count((c) => c.kind === "default"),
    2,
  );
  assert.equal(
    count((c) => c.kind === "default" && c.body.length > 0),
    1,
  );
  assert.ok(count((c) => c.kind === "scope") > 0);
});

test("plan validation accepts a lowered plan and refuses one whose jumps do not nest, naming the instruction", () => {
  const plan = compileValidPlan("let a = true\nif a { if a { a = false } }\nexit");
  assert.deepEqual(validateInstructionPlan(plan).errors, []);
  const [outer, inner] = plan.instructions.flatMap((instruction, index) =>
    instruction.kind === "jumpIfFalse" ? [{ index, target: instruction.target }] : [],
  );
  assert.ok(outer !== undefined && inner !== undefined && inner.target < outer.target);
  // The inner if's false way now goes past the outer if's end, still inside the region.
  const instructions = plan.instructions.map((instruction, index): Instruction =>
    index === inner.index && instruction.kind === "jumpIfFalse"
      ? { ...instruction, target: outer.target + 1 }
      : instruction,
  );
  assert.deepEqual(
    validateInstructionPlan({ ...plan, instructions }).errors.map(({ code, message, path }) => ({
      code,
      message,
      path,
    })),
    [
      {
        code: "TSC002",
        message: "Jumps must nest: this jumpIfFalse's target lies outside the construct around it.",
        path: `$.instructions[${inner.index}]`,
      },
    ],
  );
});

test("a plan that fails an earlier check gets no nesting error on top", () => {
  const plan = compileValidPlan("let a = true\nif a { a = false }\nexit");
  const at = plan.instructions.findIndex((instruction) => instruction.kind === "jumpIfFalse");
  const instructions = plan.instructions.map(
    (instruction, index): Instruction =>
      index === at && instruction.kind === "jumpIfFalse"
        ? { ...instruction, target: plan.instructions.length + 5 }
        : instruction,
  );
  const messages = validateInstructionPlan({ ...plan, instructions }).errors.map((error) => error.message);
  assert.notDeepEqual(messages, []);
  assert.deepEqual(
    messages.filter((message) => message.startsWith("Jumps must nest")),
    [],
  );
});

// Fixtures over a small list of instructions, one for each way jumps can fail to nest. Every target lies inside the
// region, as the other plan checks require.
const SPAN: PlanSourceLocation = { so: 0, sl: 0, sc: 0, eo: 0, el: 0, ec: 0 };
const TRUE = { kind: "literal", value: true, span: SPAN } as const;
const step: Instruction = { kind: "evaluate", expression: TRUE, span: SPAN };
const ifFalse = (target: number): Instruction => ({
  kind: "jumpIfFalse",
  condition: TRUE,
  target,
  span: SPAN,
});
const jump = (target: number): Instruction => ({ kind: "jump", target, span: SPAN });
const loop = (continueTarget: number, target: number): Instruction => ({
  kind: "loopStart",
  loopKind: "while",
  loopId: 1,
  expression: TRUE,
  continueTarget,
  target,
  span: SPAN,
});
const skipDefault = (target: number): Instruction => ({
  kind: "prepareParameterDefault",
  functionId: 1,
  parameterIndex: 0,
  target,
  span: SPAN,
});
const enter: Instruction = { kind: "enterScope", span: SPAN };
const leave: Instruction = { kind: "leaveScope", span: SPAN };

test("each way jumps can fail to nest is refused at the instruction that breaks it", () => {
  const cases: readonly (readonly [string, readonly Instruction[], number, string])[] = [
    [
      "an if's false way leaves the if around it",
      [ifFalse(3), ifFalse(4), step, step, step],
      1,
      "this jumpIfFalse's target lies outside the construct around it",
    ],
    [
      "an if's false way goes back",
      [step, ifFalse(0), step],
      1,
      "this jumpIfFalse's target lies outside the construct around it",
    ],
    [
      "a jump that ends no true way",
      [step, jump(3), step, step],
      1,
      "this jump does not end an if's true way",
    ],
    [
      "a jump inside a true way, not at its end",
      [ifFalse(4), jump(4), step, step, step],
      1,
      "this jump does not end an if's true way",
    ],
    [
      "a jump past a false way that leaves the if around it",
      [ifFalse(5), ifFalse(3), jump(6), step, step, step, step],
      2,
      "this jump past an if's false way lands outside the construct around it",
    ],
    [
      "a loop that ends outside the if around it",
      [ifFalse(3), loop(1, 4), step, step, step],
      1,
      "this loopStart's target lies outside the construct around it",
    ],
    [
      "a loop whose rounds start before the if around it",
      [step, ifFalse(4), loop(0, 4), step, step],
      2,
      "this loop's rounds start outside its sequence or inside another construct",
    ],
    [
      "a loop whose rounds start inside another construct",
      [ifFalse(2), step, step, loop(1, 5), step, step],
      3,
      "this loop's rounds start outside its sequence or inside another construct",
    ],
    [
      "a loop whose rounds start after it",
      [step, loop(3, 4), step, step, step],
      1,
      "this loop's rounds start outside its sequence or inside another construct",
    ],
    [
      "a parameter default that ends outside the if around it",
      [ifFalse(3), skipDefault(4), step, step, step],
      1,
      "this parameter default's target lies outside the construct around it",
    ],
    [
      "a block that ends after the if around it",
      [ifFalse(3), enter, step, leave, step],
      1,
      "this enterScope's block ends outside the construct around it",
    ],
    [
      "a block that is not left",
      [enter, step, step],
      0,
      "this enterScope's block ends outside the construct around it",
    ],
    [
      "a block left inside an if it was not entered in",
      [enter, ifFalse(3), leave, step],
      2,
      "this leaveScope closes no enterScope inside the construct around it",
    ],
  ];
  for (const [name, instructions, instruction, message] of cases)
    assert.deepEqual(
      structureRefusal(instructions, { start: 0, end: instructions.length }),
      { instruction, message },
      name,
    );
  // The same shapes, nested correctly, are accepted.
  const nested: readonly (readonly Instruction[])[] = [
    [ifFalse(3), ifFalse(3), step, step],
    [ifFalse(3), step, jump(5), step, step, step],
    [step, step, loop(1, 5), step, step, step],
    [enter, ifFalse(3), step, leave, step],
    [skipDefault(2), step, step],
  ];
  for (const instructions of nested)
    assert.equal(structureRefusal(instructions, { start: 0, end: instructions.length }), null);
});

test("a region nested deeper than the call stack reaches is read", () => {
  // 100,000 nested blocks, each with an if: no recursion on depth.
  const depth = 100_000;
  const instructions: Instruction[] = [];
  for (let level = 0; level < depth; level += 1) instructions.push(enter);
  instructions.push(step);
  for (let level = 0; level < depth; level += 1) instructions.push(leave);
  const tree = planStructure(instructions, { start: 0, end: instructions.length });
  assert.equal(constructs(tree).filter((construct) => construct.kind === "scope").length, depth);
});
