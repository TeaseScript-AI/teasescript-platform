import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../../src/compiler.js";
import { ProgramTable } from "../../src/compiler/javascript/places.js";
import type { InstructionPlan } from "../../src/plan/model.js";

// The table tells the runtime and Debug where each part of a generated program comes from in the plan.

const FILES: Readonly<Record<string, string>> = {
  "main.tease": [
    "global level = 1",
    "speaker guide {",
    '    firstName: "Ann"',
    "}",
    'let stored: integer = load("stored", default: 0)',
    "function wait2 {",
    "    wait 2 s",
    "}",
    "function quick: integer {",
    "    return 1",
    "}",
    "label top",
    'let tick = timer async hidden 1 s { say "tick", instant }',
    'showPermanentButton "Stop" {',
    "    wait2()",
    "}",
    'let music = playAudio async "music.mp3" {',
    "    at 1 s {",
    '        say "one", instant',
    "    }",
    "    finish {",
    '        say "done", instant',
    "    }",
    "}",
    'call "rooms/side.tease"',
    "exit",
  ].join("\n"),
  "rooms/side.tease": [
    "global function shout {",
    '    say "!", instant',
    "}",
    "global speed = 2",
    "label start",
    "shout()",
    "end",
  ].join("\n"),
};

function compiled(): InstructionPlan {
  const result = compileProject(Object.entries(FILES).map(([path, source]) => ({ path, source })));
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  return result.plan!;
}

test("the table names each file, function, block, speaker and global at its place in the plan", () => {
  const plan = compiled();
  const table = new ProgramTable(plan, "0".repeat(64)).table();
  const at = (place: number) => table.places[place]!.instruction;
  assert.equal(table.format, "teasescript-generated-table");
  assert.equal(table.planSha256, "0".repeat(64));
  assert.deepEqual(table.storageTypes, plan.storageTypes);
  assert.deepEqual(
    table.storageTypes.map((entry) => entry.key),
    ["stored"],
  );

  assert.deepEqual(
    table.files.map((file) => [
      file.path,
      at(file.start),
      at(file.entry),
      file.labels.map((label) => [label.name, at(label.place)]),
    ]),
    plan.files.map((file) => [
      file.path,
      file.startInstruction,
      file.entryInstruction,
      file.labels.map((label) => [label.name, label.instruction]),
    ]),
  );
  assert.deepEqual(
    table.files.map((file) => file.labels.map((label) => label.name)),
    [["top"], ["start"]],
  );

  assert.deepEqual(
    table.functions.map((entry) => [entry.name, entry.file, entry.global, entry.mayWait]),
    [
      ["wait2", 0, false, true],
      ["quick", 0, false, false],
      ["shout", 1, true, false],
    ],
  );
  for (const entry of table.functions)
    assert.equal(at(entry.entry), plan.functions[entry.id - 1]!.entryInstruction);

  assert.deepEqual(
    table.blocks.map((block) => [
      block.handler,
      block.file,
      block.mayWait,
      block.createdBy.map((place) => plan.instructions[at(place)]!.kind),
    ]),
    [
      ["timer", 0, false, ["startTimer"]],
      ["button", 0, true, ["showPermanentButton"]],
      ["media", 0, false, ["playMedia"]],
      ["media", 0, false, ["playMedia"]],
    ],
  );
  for (const block of table.blocks)
    assert.equal(at(block.entry), plan.functions[block.id - 1]!.entryInstruction);

  assert.deepEqual(
    table.speakers.map((entry) => [
      entry.name,
      entry.file,
      plan.instructions[at(entry.place)]!.kind,
    ]),
    [["guide", 0, "declareSpeaker"]],
  );
  assert.deepEqual(
    table.globals.map((entry) => [
      entry.name,
      entry.file,
      plan.instructions[at(entry.place)]!.kind,
    ]),
    [
      ["level", 0, "declareGlobal"],
      ["speed", 1, "declareGlobal"],
    ],
  );
  for (const place of table.places)
    assert.equal(place.span, plan.instructions[place.instruction]!.span);
});

test("a place is registered once per instruction and span, after the table's own places", () => {
  const plan = compiled();
  const table = new ProgramTable(plan, "0".repeat(64));
  const before = table.table().places.length;
  const say = plan.instructions.findIndex((instruction) => instruction.kind === "say");
  const first = table.place(say);
  assert.equal(first, before);
  assert.equal(table.place(say), first);
  const span = { ...plan.instructions[say]!.span, so: plan.instructions[say]!.span.so + 1 };
  assert.equal(table.place(say, span), before + 1);
  assert.deepEqual(table.table().places.slice(before), [
    { instruction: say, file: 0, span: plan.instructions[say]!.span },
    { instruction: say, file: 0, span },
  ]);
});
