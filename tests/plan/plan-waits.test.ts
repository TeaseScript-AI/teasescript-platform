import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../../src/compiler.js";
import type { Instruction, InstructionPlan } from "../../src/plan/model.js";
import { planWaits, type PlanWaits } from "../../src/plan/waits.js";
import { checkWaitsAgainstEngine } from "../helpers/plan-waits-engine.js";

/** A compiled project with its waits, and its functions and blocks by name (a block by its creator's kind). */
function analysed(files: Readonly<Record<string, string>>): {
  readonly plan: InstructionPlan;
  readonly waits: PlanWaits;
  readonly marked: (name: string) => boolean;
} {
  const compiled = compileProject(
    Object.entries(files).map(([path, source]) => ({ path, source })),
    { images: [] },
  );
  assert.deepEqual(
    compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  const plan = compiled.plan!;
  const waits = planWaits(plan);
  return {
    plan,
    waits,
    marked: (name) => {
      const found = plan.functions.filter((definition) => definition.name === name);
      assert.equal(found.length, 1, `one function named ${name}`);
      return waits.functionMayWait(found[0]!.id);
    },
  };
}

const main = (source: string): Record<string, string> => ({ "main.tease": source });

/** The indexes of the instructions of `kind` inside the function named `name`. */
function inFunction(plan: InstructionPlan, name: string, kind: Instruction["kind"]): number[] {
  const definition = plan.functions.find((candidate) => candidate.name === name)!;
  const found: number[] = [];
  for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1)
    if (plan.instructions[index]!.kind === kind) found.push(index);
  return found;
}

test("each instruction that can leave the session waiting marks its function; the others do not", () => {
  const cases: readonly (readonly [string, Instruction["kind"], boolean])[] = [
    ["wait 1 s", "wait", true],
    ['let name = askText "Your name?"', "interaction", true],
    ['showButton "Go"', "interaction", true],
    ["let photo = takePhoto()", "capture", true],
    ['let file = fileFromBase64("SGVsbG8=", default: null)', "fileStore", true],
    [
      'let locked = encryptText("x", password: "p", publicKey: false, timeLock: false)',
      "lock",
      true,
    ],
    ['save 4 as "level"', "storageWrite", true],
    ['playAudio "sounds/bell.mp3"', "playMedia", true],
    ['say "Read this.", 1.5 s', "say", true],
    ['say "At the reading speed."', "say", true],
    ['say "No pause.", instant', "say", false],
    ['showImage "images/room.jpg"', "showImage", false],
    ["let beat = timer async hidden 1 s { }", "startTimer", false],
  ];
  for (const [statement, kind, waits] of cases) {
    const {
      plan,
      waits: analysis,
      marked,
    } = analysed(main(`function f {\n  ${statement}\n}\nf()\nexit`));
    const sites = inFunction(plan, "f", kind);
    assert.notEqual(sites.length, 0, `${statement} lowers to ${kind}`);
    assert.deepEqual(
      sites.map((index) => analysis.waitsAt(index)),
      sites.map(() => waits),
      statement,
    );
    assert.equal(marked("f"), waits, statement);
  }
});

test("a call marks its caller exactly when what it calls may wait, through any depth and recursion", () => {
  const { plan, waits, marked } = analysed(
    main(
      [
        "function pause { wait 1 s }",
        "function middle { pause() }",
        "function outer { middle() }",
        "function addUp(n: integer): integer { if n == 0 { return 0 }\n return n + addUp(n - 1) }",
        "function ping(n: integer) { if n > 0 { pong(n - 1) } }",
        "function pong(n: integer) { if n > 0 { ping(n - 1) } else { wait 1 s } }",
        'function quiet { let total = addUp(3)\n say "${total}", instant }',
        "outer()",
        "quiet()",
        "ping(2)",
        "exit",
      ].join("\n"),
    ),
  );
  assert.deepEqual(
    ["pause", "middle", "outer", "addUp", "ping", "pong", "quiet"].map((name) => [
      name,
      marked(name),
    ]),
    [
      ["pause", true],
      ["middle", true],
      ["outer", true],
      ["addUp", false],
      ["ping", true],
      ["pong", true],
      ["quiet", false],
    ],
  );
  assert.deepEqual(
    inFunction(plan, "middle", "callFunction").map((index) => waits.mayWaitAt(index)),
    [true],
  );
  assert.deepEqual(
    inFunction(plan, "quiet", "callFunction").map((index) => waits.mayWaitAt(index)),
    [false],
  );
});

test("a file call marks its caller exactly when the called activation may wait, also through its gotos", () => {
  const { plan, waits, marked } = analysed({
    "main.tease": [
      'function toWaiting { call "rooms/waits.tease" }',
      'function toQuiet { call "rooms/quiet.tease" }',
      'function toPassing { call "rooms/passes.tease" }',
      'function toAny { call "rooms/q*.tease" }',
      "toWaiting()",
      "toQuiet()",
      "toPassing()",
      "toAny()",
      "exit",
    ].join("\n"),
    "rooms/waits.tease": "wait 1 s\nend",
    "rooms/quiet.tease": 'say "Quiet.", instant\nend',
    "rooms/quick.tease": 'say "Quick.", instant\nend',
    // A goto in a function replaces the running activation, so the call stands below the wait it reaches.
    "rooms/passes.tease": 'function leave { goto "rooms/waits.tease" }\nleave()\nend',
  });
  assert.deepEqual(
    ["toWaiting", "toQuiet", "toPassing", "toAny", "leave"].map((name) => [name, marked(name)]),
    [
      ["toWaiting", true],
      ["toQuiet", false],
      ["toPassing", true],
      ["toAny", false],
      // It leaves; it does not wait.
      ["leave", false],
    ],
  );
  const file = (path: string): number =>
    plan.files.findIndex((candidate) => candidate.path === path);
  assert.deepEqual(
    ["rooms/waits.tease", "rooms/quiet.tease", "rooms/passes.tease"].map((path) =>
      waits.fileMayWait(file(path)),
    ),
    [true, false, true],
  );
});

test("a computed file call may reach every file", () => {
  const { marked } = analysed({
    "main.tease": [
      'function toComputed { let next = script("rooms/quiet.tease")\n call (next) }',
      "toComputed()",
      "exit",
    ].join("\n"),
    "rooms/quiet.tease": 'say "Quiet.", instant\nend',
    "rooms/waits.tease": "wait 1 s\nend",
  });
  assert.equal(marked("toComputed"), true);
});

test("a block's waits are its own, and a goto in a block reaching a waiting file marks every activation", () => {
  const { plan, waits, marked } = analysed({
    "main.tease": [
      "function start { let beat = timer async hidden 1 s { wait 1 s } }",
      'function quietStart { let beat = timer async hidden 1 s { say "Beat.", instant } }',
      "start()",
      "quietStart()",
      'call "rooms/quiet.tease"',
      "wait 2 s",
      "exit",
    ].join("\n"),
    "rooms/quiet.tease": [
      'let beat = timer async hidden 1 s { goto "rooms/waits.tease" }',
      'say "Quiet.", instant',
      "end",
    ].join("\n"),
    "rooms/waits.tease": "wait 1 s\nexit",
  });
  assert.deepEqual(
    ["start", "quietStart"].map((name) => [name, marked(name)]),
    [
      ["start", false],
      ["quietStart", false],
    ],
  );
  const blocks = plan.functions.filter((definition) => definition.handler === "timer");
  assert.deepEqual(
    blocks.map((block) => waits.functionMayWait(block.id)),
    [true, false, false],
  );
  const quiet = plan.files.findIndex((file) => file.path === "rooms/quiet.tease");
  assert.equal(waits.fileMayWait(quiet), true);
});

test("an instruction that can make a block due while the script runs marks its function when that block may wait", () => {
  const timerWaits = "let beat = timer async hidden 10 s { wait 1 s }";
  const mediaWaits = 'let music = playAudio async "music.mp3" { finish { wait 1 s } }';
  const cases: readonly (readonly [string, string, Instruction["kind"], boolean])[] = [
    // An async timer whose round may be 0 starts its own block right after it.
    [
      "function f { let t = timer async hidden 0 s { wait 1 s } }\nf()",
      "zero round",
      "startTimer",
      true,
    ],
    [
      "function f(d) { let t = timer(duration: d, async: true) { wait 1 s } }\nf(2 s)",
      "computed round",
      "startTimer",
      true,
    ],
    [
      'function f { let t = timer async hidden 0 s { say "Beat.", instant } }\nf()',
      "block that cannot wait",
      "startTimer",
      false,
    ],
    // A store into `remaining` or `position` may start any timer or media block.
    [
      `${timerWaits}\nfunction f(h) { h.remaining = 0 s }\nf(beat)`,
      "remaining, timer block",
      "assign",
      true,
    ],
    [
      `${mediaWaits}\nfunction f(h) { h.position = 10 s }\nf(music)`,
      "position, media block",
      "assign",
      true,
    ],
    [
      "let beat = timer async hidden 10 s { }\nfunction f(h) { h.remaining = 0 s }\nf(beat)",
      "remaining, no block waits",
      "assign",
      false,
    ],
    // `pause()` or `resume()` may start any timer block, never a media block.
    [`${timerWaits}\nfunction f(h) { h.pause() }\nf(beat)`, "pause, timer block", "evaluate", true],
    [
      `${mediaWaits}\nfunction f(h) { h.resume() }\nf(music)`,
      "resume, only a media block",
      "evaluate",
      false,
    ],
  ];
  for (const [source, name, kind, expected] of cases) {
    const { plan, waits, marked } = analysed(main(`${source}\nwait 2 s\nexit`));
    const sites = inFunction(plan, "f", kind);
    assert.notEqual(sites.length, 0, name);
    assert.deepEqual(
      sites.map((index) => waits.mayWaitAt(index)),
      sites.map(() => expected),
      name,
    );
    assert.equal(marked("f"), expected, name);
  }
});

test("a block made due in a call's arguments marks the function the call enters, where the block waits", () => {
  // At 2 s the main path's delay ends first; then b's round is due, and h.pause() ends it while quiet's arguments are
  // evaluated, so the block starts after quiet's frame is pushed, before quiet runs anything (final review, #2769).
  const { plan, waits, marked } = analysed(
    main(
      [
        "let b = timer async hidden 100 s { }",
        "let a = timer async hidden 1 s { b = timer async hidden 1 s { wait 1 s } }",
        'function quiet(value) { say "quiet", instant }',
        "function f(h) { quiet(h.pause()) }",
        "wait 2 s",
        "f(b)",
        "exit",
      ].join("\n"),
    ),
  );
  assert.equal(marked("quiet"), true);
  assert.equal(marked("f"), true);
  const quiet = plan.functions.find((definition) => definition.name === "quiet")!;
  const result = checkWaitsAgainstEngine(plan);
  assert.deepEqual(result.unmarked, []);
  assert.ok(result.live.has(quiet.id), "quiet is live at the block's wait");
  // The check sees quiet live although it ran nothing: with quiet alone unmarked, it reports quiet and nothing else.
  const missed = checkWaitsAgainstEngine(plan, 200, {
    ...waits,
    functionMayWait: (id) => id !== quiet.id && waits.functionMayWait(id),
  }).unmarked;
  assert.notDeepEqual(missed, []);
  assert.deepEqual(
    missed.filter((line) => !line.endsWith(`function or block ${quiet.id} is live unmarked`)),
    [],
  );
});

test("a block made due in a file call's destination marks the activation the call enters, where the block waits", () => {
  // The destination is evaluated, then the called file's frame is pushed, then the block starts above it (runtime
  // review, #2769).
  const { plan, waits } = analysed({
    "main.tease": [
      "let target = timer async hidden 100 s { }",
      "let setup = timer async hidden 500 ms {",
      "  let next = timer async hidden 500 ms { wait 1 s }",
      "  target = next",
      "}",
      'function site { call (target.pause() otherwise script("quiet.tease")) }',
      "wait 1 s",
      "site()",
      "exit",
    ].join("\n"),
    "quiet.tease": 'say "quiet", instant\nend',
  });
  const quiet = plan.files.findIndex((file) => file.path === "quiet.tease");
  assert.equal(waits.fileMayWait(quiet), true);
  const result = checkWaitsAgainstEngine(plan);
  assert.deepEqual(result.unmarked, []);
  const site = plan.functions.find((definition) => definition.name === "site")!;
  assert.ok(result.live.has(site.id), "site is live at the block's wait");
  // The file call's frame is checked at its call: with that call unmarked, the check reports it.
  const call = plan.instructions.findIndex((instruction) => instruction.kind === "transfer");
  const missed = checkWaitsAgainstEngine(plan, 200, {
    ...waits,
    mayWaitAt: (index) => index !== call && waits.mayWaitAt(index),
  }).unmarked;
  assert.ok(
    missed.some((line) => line.endsWith(`the file call at ${call} is live unmarked`)),
    missed.join("\n"),
  );
  // So is the entered file alone, as before this case was repaired: the call stays marked, since its destination
  // starts the block, and the file's own flag is what the check reads.
  const fileMissed = checkWaitsAgainstEngine(plan, 200, {
    ...waits,
    fileMayWait: (file) => file !== quiet && waits.fileMayWait(file),
  }).unmarked;
  assert.ok(
    fileMissed.some((line) => line.endsWith(`the file ${quiet} it entered is live unmarked`)),
    fileMissed.join("\n"),
  );
  assert.ok(!fileMissed.some((line) => line.includes("the file call at")), fileMissed.join("\n"));
});

test("a computed file call whose destination may start a block marks every activation it may enter", () => {
  const files = {
    "main.tease": [
      "let b = timer async hidden 10 s { wait 1 s }",
      'function go { call (script("rooms/quiet.tease")) }',
      "go()",
      "exit",
    ].join("\n"),
    "rooms/quiet.tease": 'say "Quiet.", instant\nend',
  };
  const { plan, waits } = analysed(files);
  const quiet = plan.files.findIndex((file) => file.path === "rooms/quiet.tease");
  assert.equal(waits.fileMayWait(quiet), false);
  // The same plan with a `pause()` in the destination: a block it starts waits above the activation the call enters.
  const instructions = plan.instructions.map((instruction): Instruction => {
    if (instruction.kind !== "transfer" || !("value" in instruction.destination))
      return instruction;
    const span = instruction.destination.value.span;
    const pause = {
      kind: "call",
      callee: {
        kind: "property",
        object: { kind: "identifier", name: "b", span },
        name: "pause",
        span,
      },
      arguments: [],
      span,
    } as const;
    return { ...instruction, destination: { ...instruction.destination, value: pause } };
  });
  assert.equal(planWaits({ ...plan, instructions }).fileMayWait(quiet), true);
});

test("at every wait of a played session, each live function, block and file call is marked", () => {
  const sources: readonly Readonly<Record<string, string>>[] = [
    main(
      [
        'function pause(n: integer) { wait 1 s\n say "pause ${n}", instant }',
        "function rounds(n: integer): integer {",
        "  let total = 0",
        '  for i in 0..n { total += askInteger "How many?"\n pause(i) }',
        "  return total",
        "}",
        "let beats = 0",
        "let beat = timer async hidden 2 s { beats += 1\n pause(beats) }",
        'repeat 2 { let got = rounds(2)\n say "${got}" }',
        "exit",
      ].join("\n"),
    ),
    {
      "main.tease": 'function visit { call "rooms/hall.tease" }\nrepeat 2 { visit() }\nexit',
      "rooms/hall.tease": 'wait 1 s\nfunction onward { goto "rooms/side.tease" }\nonward()\nend',
      "rooms/side.tease": 'say "Which?", instant\nlet choice = askChoice "left", "right"\nend',
    },
  ];
  for (const files of sources) {
    const { plan } = analysed(files);
    const result = checkWaitsAgainstEngine(plan);
    assert.deepEqual(result.unmarked, []);
    assert.equal(result.status, "halted");
    assert.ok(result.waits > 3, `${result.waits} waits`);
  }
  // A block the script makes due starts inside the function and waits there, above its frame, which the play sees.
  for (const source of [
    "function site { let t = timer async hidden 0 s { wait 1 s } }\nsite()",
    "let beat = timer async hidden 10 s { wait 1 s }\nfunction site(h) { h.remaining = 0 s }\nsite(beat)",
    'let music = playAudio async "music.mp3" { finish { wait 1 s } }\nfunction site(h) { h.position = 10 s }\nsite(music)',
  ]) {
    const { plan } = analysed(main(`${source}\nwait 2 s\nexit`));
    const result = checkWaitsAgainstEngine(plan);
    assert.deepEqual(result.unmarked, []);
    assert.equal(result.status, "halted");
    const site = plan.functions.find((definition) => definition.name === "site")!;
    assert.ok(result.live.has(site.id), source);
  }
});

test("a list with more elements than a call takes arguments is walked", () => {
  // The width a source can write is bounded by no rule; this plan widens one compiled list literal past it.
  const { plan } = analysed(main("function f { let xs = [0] }\nf()\nexit"));
  const instructions = plan.instructions.map((instruction): Instruction => {
    if (instruction.kind !== "declareBinding" || instruction.value.kind !== "list")
      return instruction;
    const element = instruction.value.elements[0]!;
    const elements = Array.from({ length: 300_000 }, () => element);
    return { ...instruction, value: { ...instruction.value, elements } };
  });
  const wide = planWaits({ ...plan, instructions });
  assert.equal(wide.functionMayWait(plan.functions[0]!.id), false);
});

test("the engine check reports every unmarked live part, also at a wait settled inside one operation", () => {
  const none: PlanWaits = {
    waitsAt: () => false,
    mayWaitAt: () => false,
    functionMayWait: () => false,
    fileMayWait: () => false,
  };
  // The block's goto replaces the activation; the inner block waits and its wait is settled by the same catch-up.
  const settled = analysed({
    "main.tease": 'let beat = timer async hidden 1 s { goto "room.tease" }\nwait 10 s\nexit',
    "room.tease": "function f { let inner = timer async hidden 0 s { wait 1 s } }\nf()\nexit",
  }).plan;
  const f = settled.functions.find((definition) => definition.name === "f")!;
  const missed = checkWaitsAgainstEngine(settled, 200, none).unmarked;
  assert.ok(
    missed.some((line) => line.endsWith(`function or block ${f.id} is live unmarked`)),
    missed.join("\n"),
  );
  assert.ok(
    missed.some((line) => line.includes("waits unmarked")),
    missed.join("\n"),
  );
  assert.deepEqual(checkWaitsAgainstEngine(settled).unmarked, []);
  const called = analysed({
    "main.tease": 'call "rooms/hall.tease"\nexit',
    "rooms/hall.tease": "wait 1 s\nend",
  }).plan;
  const missedCall = checkWaitsAgainstEngine(called, 200, none).unmarked;
  const hall = called.files.findIndex((file) => file.path === "rooms/hall.tease");
  assert.ok(
    missedCall.some((line) => line.includes("the file call at")),
    missedCall.join("\n"),
  );
  assert.ok(
    missedCall.some((line) => line.endsWith(`the file ${hall} it entered is live unmarked`)),
    missedCall.join("\n"),
  );
  // The entered file is checked by its own flag, also when its call is marked.
  const waits = planWaits(called);
  assert.deepEqual(
    checkWaitsAgainstEngine(called, 200, {
      ...waits,
      fileMayWait: (file) => file !== hall && waits.fileMayWait(file),
    }).unmarked,
    [`wait 1: the file ${hall} it entered is live unmarked`],
  );
});
