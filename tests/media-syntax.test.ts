import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { Instruction, InstructionPlan, PlayMediaInstruction } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

function diagnostics(source: string): string[] {
  const result = compileSource(source);
  assert.equal(result.plan, null, `${JSON.stringify(source)} must not compile`);
  return result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`);
}

function assertRejected(source: string, code: string, fragment: string): void {
  const found = diagnostics(source);
  assert.ok(
    found.some((entry) => entry.startsWith(code) && entry.includes(fragment)),
    `${JSON.stringify(source)} should report ${code} containing ${JSON.stringify(fragment)}; got ${JSON.stringify(found)}`,
  );
}

function kinds(instructions: readonly Instruction[]): string[] {
  return instructions.map((instruction) => instruction.kind);
}

function playInstructions(source: string): PlayMediaInstruction[] {
  return plan(source).instructions.filter(
    (instruction): instruction is PlayMediaInstruction => instruction.kind === "playMedia",
  );
}

test("accepted media forms compile, each behind a pacing barrier", () => {
  const compiled = plan(
    [
      'showImage "images/room.jpg"',
      "hideImage",
      "showImage null",
      'playAudio "sounds/bell.mp3"',
      'playAudio async "music/beat.mp3"',
      'playAudio async repeat "music/beat.mp3"',
      'playVideo "videos/instructions.mp4"',
      'let fire = playVideo async repeat "videos/fireplace.mp4"',
      'let music = playAudio(file: "music/track.mp3", async: true, repeat: true, startAt: 2 min, endAt: 8 min, volume: 0.5)',
      'playAudio(file: "a.mp3", repeat: 3 times)',
      'playAudio(file: "a.mp3", repeat: 60 s)',
      'playAudio(file: "a.mp3", repeat: false)',
    ].join("\n"),
  );
  const shown = kinds(compiled.instructions).filter((kind) =>
    ["pacingBarrier", "showImage", "playMedia"].includes(kind),
  );
  assert.deepEqual(shown, [
    ...Array<string>(3).fill("pacingBarrier,showImage").join(",").split(","),
    ...Array<string>(9).fill("pacingBarrier,playMedia").join(",").split(","),
  ]);
  const plays = compiled.instructions.filter(
    (instruction): instruction is PlayMediaInstruction => instruction.kind === "playMedia",
  );
  assert.deepEqual(
    plays.map((play) => [
      play.media,
      play.async,
      play.repeat.kind,
      play.destinationTemporary !== null,
    ]),
    [
      ["audio", false, "once", false],
      ["audio", true, "once", false],
      ["audio", true, "indefinite", false],
      ["video", false, "once", false],
      ["video", true, "indefinite", true],
      ["audio", true, "value", true],
      ["audio", false, "times", false],
      ["audio", false, "value", false],
      ["audio", false, "value", false],
    ],
  );
  assert.deepEqual(
    compiled.instructions
      .filter((instruction) => instruction.kind === "showImage")
      .map((instruction) => instruction.kind === "showImage" && instruction.image === null),
    [false, true, false],
  );
});

test("a compact block becomes a per-pass end cue; structured cues keep source order", () => {
  const [compact] = playInstructions('playAudio async repeat "beat.mp3" {\n  say "again"\n}');
  assert.equal(compact!.cues.length, 1);
  assert.equal(compact!.cues[0]!.kind, "beforeEnd");
  assert.deepEqual(
    compact!.cues[0]!.offset.kind === "duration" && compact!.cues[0]!.offset.milliseconds,
    0,
  );
  assert.equal(compact!.finishFunctionId, null);

  const compiled = plan(
    [
      'let music = playAudio async "music.mp3" {',
      "  at 30 s {",
      '    say "Thirty seconds."',
      "  }",
      "  beforeEnd 10 s {",
      '    say "Ten seconds left."',
      "  }",
      "  finish {",
      '    say "Finished."',
      "  }",
      "}",
    ].join("\n"),
  );
  const play = compiled.instructions.find(
    (instruction): instruction is PlayMediaInstruction => instruction.kind === "playMedia",
  )!;
  assert.deepEqual(
    play.cues.map((cue) => cue.kind),
    ["at", "beforeEnd"],
  );
  assert.notEqual(play.finishFunctionId, null);
  const handlers = compiled.functions.filter((definition) => definition.handler === "media");
  assert.equal(handlers.length, 3);
  assert.ok(handlers.every((definition) => definition.selfHandle === "music"));
});

test("a media block may use its own handle, also inside a function, but not other locals", () => {
  plan(
    [
      "function scene {",
      '  let music = playAudio async "music.mp3" {',
      "    at 3 s {",
      "      music.volume = 0.2",
      "      music.pause()",
      "    }",
      "  }",
      "}",
      "scene()",
    ].join("\n"),
  );
  assertRejected(
    [
      "function scene {",
      "  let level = 0.2",
      '  let music = playAudio async "music.mp3" {',
      "    at 3 s {",
      "      music.volume = level",
      "    }",
      "  }",
      "}",
      "scene()",
    ].join("\n"),
    "TSV002",
    "Unknown variable 'level'",
  );
  // Without a let declaration there is no self-handle.
  assertRejected(
    'function scene {\n  playAudio async "a.mp3" {\n    music.stop()\n  }\n}\nscene()',
    "TSV002",
    "Unknown variable 'music'",
  );
});

test("cue words stay ordinary identifiers outside cue positions", () => {
  plan(
    [
      "let at = 1",
      "let beforeEnd = 2",
      "function finish {",
      '  say "done"',
      "}",
      'playAudio async "a.mp3" {',
      "  at = 3",
      "  finish()",
      "}",
      "let async = 5",
      "playAudio (async)",
    ].join("\n"),
  );
});

test("invalid media forms are rejected with focused diagnostics", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['let s = playAudio "bell.mp3"', "TSV036", "Blocking media returns no handle"],
    ['playAudio repeat "beat.mp3"', "TSV036", "cannot repeat indefinitely"],
    ['playVideo(file: "a.mp4", repeat: true)', "TSV036", "cannot repeat indefinitely"],
    ['playAudio(file: "a.mp3", repeat: 3)', "TSV036", "'times'"],
    ['playAudio(file: "a.mp3", repeat: 0 times)', "TSV036", "at least 1"],
    ['playAudio(file: "a.mp3", repeat: 1.5 times)', "TSV036", "at least 1"],
    ['playAudio(file: "a.mp3", repeat: 0 s)', "TSV036", "greater than zero"],
    ['playAudio(file: "a.mp3", repeat: "often")', "TSV036", "Repeat must be"],
    ['playAudio(file: "a.mp3", startAt: -1 s)', "TSV036", "startAt must not be negative"],
    ['playAudio(file: "a.mp3", startAt: 10 s, endAt: 5 s)', "TSV036", "endAt must be later"],
    ['playAudio(file: "a.mp3", startAt: "x")', "TSV036", "startAt must be a duration"],
    ['playAudio(file: "a.mp3", volume: 2)', "TSV036", "Volume must be"],
    [
      'playAudio async "a.mp3" {\n  finish {\n  }\n  finish {\n  }\n}',
      "TSV036",
      "'finish' only once",
    ],
    ['playAudio async repeat "a.mp3" {\n  finish {\n  }\n}', "TSV036", "'finish' never runs"],
    ['playAudio async "a.mp3" {\n  at -1 s {\n  }\n}', "TSV036", "at must not be negative"],
    [
      'playAudio async "a.mp3" {\n  say "x"\n  at 1 s {\n  }\n}',
      "TSP035",
      "either cue declarations",
    ],
    ['playAudio(file: "a.mp3", loop: true)', "TSP035", "Unknown playAudio argument 'loop'"],
    ['playAudio(file: "a.mp3", file: "b.mp3")', "TSP035", "Duplicate playAudio argument"],
    ['let yes = true\nplayAudio(file: "a.mp3", async: yes)', "TSP035", "literal true or false"],
    ['playAudio("a.mp3")', "TSP035", "uses named arguments"],
    ["playAudio(async: true)", "TSP035", "requires a 'file' argument"],
    ["hideImage()", "TSP035", "hideImage takes no arguments"],
    ['showImage("a.jpg")', "TSP035", "showImage uses command syntax"],
    ["showImage 3", "TSV036", "image file reference or null"],
    ['let m = playAudio async "a.mp3"\nm.loop = true', "TSV037", "cannot be assigned"],
    ['let m = playAudio async "a.mp3"\nsay "${m.played}"', "TSV037", "no property 'played'"],
    ['let m = playAudio async "a.mp3"\nm.rewind()', "TSV037", "no method 'rewind'"],
    ['let m = playAudio async "a.mp3"\nm.stop(1)', "TSV037", "takes no arguments"],
    ['let m = playAudio async "a.mp3"\nm.volume = 1.5', "TSV037", "from 0 through 1"],
    [
      'let m = playAudio async "a.mp3"\nm.position = "start"',
      "TSV037",
      "must be assigned a duration",
    ],
    ['let m = playAudio async "a.mp3"\nm.remaining = 10', "TSV037", "must be assigned a duration"],
    ['playAudio async "a.mp3" {\n  return 1\n}', "TSV033", "only without a value"],
  ];
  for (const [source, code, fragment] of cases) assertRejected(source, code, fragment);
});

test("statement-level media handle operations get a receiver barrier; reads do not", () => {
  const compiled = plan(
    [
      'let music = playAudio async "a.mp3"',
      "music.pause()",
      "music.position = 10 s",
      "music.remaining -= 5 s",
      'say "${music.position}"',
    ].join("\n"),
  );
  const barriers = compiled.instructions.filter(
    (instruction) => instruction.kind === "pacingBarrier",
  );
  assert.deepEqual(
    barriers.map((barrier) => barrier.kind === "pacingBarrier" && barrier.receiver?.kind),
    [undefined, "identifier", "preparedReference", "preparedReference"],
  );
});

test("cue detection needs a complete position and block; indexed and called uses stay ordinary", () => {
  plan(["let at = [0]", 'playAudio async "a.mp3" {', "  at[0] = 1", "}"].join("\n"));
  assertRejected('playAudio async "a.mp3" {\n  at 1 s\n}', "TSP018", "cue block");
});

test("media parse errors recover at the end of the line and keep enclosing blocks", () => {
  const result = compileSource(
    'if true { hideImage() }\nsay "next"\nshowImage("a.jpg")\nsay "last"',
  );
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP035", "TSP035"],
  );
  assertRejected('playAudio(file: "a.mp3",)', "TSP012", "Expected an argument after ','");
});

test("media playback is rejected in function parameter defaults", () => {
  assertRejected(
    'function f(m = playAudio async "a.mp3") {\n  m.stop()\n}',
    "TSV032",
    "Media playback is not supported in function parameter defaults",
  );
});

test("deeply nested media operands compile without native recursion", () => {
  const depth = 2_500;
  const source = [
    "function name(value) {",
    '  return "a.mp3"',
    "}",
    `let m = ${"playAudio async name(".repeat(depth)}"a.mp3"${")".repeat(depth)}`,
  ].join("\n");
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});

test("media nested in cue positions parses each position once", () => {
  let play = 'playAudio async "a"';
  for (let level = 0; level < 40; level += 1) {
    play = `playAudio async "a" { at point(${play}) { } }`;
  }
  const started = performance.now();
  const result = compileSource(`function point(x) {\n  return 1 s\n}\nlet m = ${play}`);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(
    performance.now() - started < 5_000,
    "nested cue positions must not reparse exponentially",
  );
});

test("statically evident invalid media values are compile errors", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["playAudio 3", "TSV036", "media file reference"],
    ["showImage -1", "TSV036", "image file reference"],
    ['playAudio(file: "a", endAt: 0 s)', "TSV036", "endAt must be later"],
    ['let m = playAudio async "a"\nm.position += "x"', "TSV037", "duration"],
    ['let m = playAudio async "a"\nm.remaining -= true', "TSV037", "duration"],
    ['let m = playAudio async "a"\nm.position += 3', "TSV037", "duration"],
    ['let m = playAudio async "a"\nm.volume += 1 s', "TSV037", "volume"],
    ['playAudio(file: "a", repeat: 9007199254740992 times)', "TSV036", "at least 1"],
  ];
  for (const [source, code, fragment] of cases) assertRejected(source, code, fragment);
  plan('let m = playAudio async "a"\nm.volume += 0.5\nm.volume -= 2');
});

/** A mutable JSON copy of a compiled plan for corruption tests. */
function mutablePlan(compiled: InstructionPlan): { instructions: Record<string, unknown>[] } {
  // EVIDENCE: JSON serialization preserves the compiled plan's plain-data shape; callers apply documented invalid mutations.
  return JSON.parse(JSON.stringify(compiled)) as { instructions: Record<string, unknown>[] };
}

test("plan validation accepts only compiler-shaped barrier receivers and no finish on indefinite media", () => {
  const compiled = plan('let m = playAudio async "a"\nm.stop()');
  const barrierIndex = compiled.instructions.findIndex(
    (instruction) => instruction.kind === "pacingBarrier" && instruction.receiver !== null,
  );
  const corrupted = mutablePlan(compiled);
  const span = compiled.instructions[barrierIndex]!.span;
  corrupted.instructions[barrierIndex]!.receiver = {
    kind: "call",
    callee: { kind: "identifier", name: "m", span },
    arguments: [],
    span,
  };
  assert.equal(validateInstructionPlan(corrupted).valid, false);

  const repeating = plan('playAudio async repeat "a" {\n  at 1 s {\n  }\n}');
  const play = repeating.instructions.find(
    (instruction): instruction is PlayMediaInstruction => instruction.kind === "playMedia",
  )!;
  const withFinish = mutablePlan(repeating);
  withFinish.instructions[repeating.instructions.indexOf(play)]!.finishFunctionId =
    play.cues[0]!.functionId;
  assert.equal(validateInstructionPlan(withFinish).valid, false);
});
