import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { run } from "../src/runtime/engine.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

const SPEAKERS = 'speaker vera { title: "Mistress" }\nspeaker anna { title: "Miss" }';

test("a variable, global, parameter, or loop variable that holds a speaker takes another speaker or null", () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["let current = vera\ncurrent = anna\nsay current.title\nsay vera.title", ["Miss", "Mistress"]],
    ["let current: speaker? = vera\ncurrent = null\nsay current == null", ["true"]],
    ["let current = null\ncurrent = vera\ncurrent = null\nsay current == null", ["true"]],
    ["global current = vera\ncurrent = anna\nsay current.title", ["Miss"]],
    [
      "function greet(who: speaker?) {\n    who = anna\n    say who.title\n    who = null\n    say who == null\n}\ngreet(vera)\nsay vera.title",
      ["Miss", "true", "Mistress"],
    ],
    ["for who in [vera, anna] {\n    who = anna\n    say who.title\n}", ["Miss", "Miss"]],
    [
      "function pick: speaker {\n    return vera\n}\nlet current = pick()\ncurrent = anna\nsay current.title",
      ["Miss"],
    ],
  ];
  for (const [body, said] of cases) {
    const result = runValidSource(`${SPEAKERS}\n${body}\nexit`);
    assert.equal(result.snapshot.status, "halted", body);
    assert.deepEqual(sayTexts(result), said, body);
  }
});

test("a store through a variable changes the speaker it holds at that moment", () => {
  const result = runValidSource(
    [
      SPEAKERS,
      "let current = vera",
      'current.title = "Lady"',
      "current = anna",
      'current.title = "Ms"',
      "say vera.title",
      "say anna.title",
      "say current == anna",
      "exit",
    ].join("\n"),
  );

  assert.deepEqual(sayTexts(result), ["Lady", "Ms", "true"]);
});

test("a declared speaker's own name cannot be given another speaker", () => {
  const compiled = compileSource(`${SPEAKERS}\nvera = anna\nexit`);
  assert.deepEqual(
    compiled.semanticDiagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
    [["TSV004", "Cannot replace speaker 'vera'."]],
  );

  // The runtime keeps the speaker's global even for a plan that assigns to it, which the compiler never produces.
  const plan = speakerAssignmentPlan();
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR034");
  assert.equal(
    result.snapshot.failure?.message,
    "The plan assigns to speaker 'vera', whose name always refers to that speaker. This is a fault in the Playroom, not in the script. Report it with a debug export.",
  );
  assert.deepEqual(result.snapshot.globals.find((binding) => binding.name === "vera")?.value, {
    kind: "speakerReference",
    speakerId: 1,
    identifier: "vera",
  });
});

function speakerAssignmentPlan(): InstructionPlan {
  const compiled = compileValidPlan(`${SPEAKERS}\nlet current = vera\ncurrent = anna\nexit`);
  // EVIDENCE: fixture: clone a compiler-produced plan before deliberately changing its assignment target.
  const plan = JSON.parse(JSON.stringify(compiled)) as InstructionPlan;
  const assignment = plan.instructions.find((instruction) => instruction.kind === "assign");
  if (assignment?.kind !== "assign" || assignment.target.kind !== "identifier")
    throw new Error("Expected an assignment to a variable.");
  // EVIDENCE: fixture: expose the readonly target name to aim the assignment at the speaker's global.
  (assignment.target as { name: string }).name = "vera";
  return plan;
}
