import assert from "node:assert/strict";
import test from "node:test";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { validateInstructionPlan } from "../../../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import { executeInstruction, run } from "../../../src/runtime/engine.js";
import { completeAction } from "../../../src/runtime/operations/complete-action.js";
import type { RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";
import { createXorShift32State, nextXorShift32 } from "../../../src/runtime/random/random.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../../helpers/runtime-equivalence.js";
import { validateRuntimeSnapshot } from "../../../src/runtime/snapshot/snapshot-validation.js";
import { project, outputs, said, compiled } from "../../helpers/runtime/file-transfers-host.js";

test("goto naming a file starts it afresh from its top", () => {
  assert.deepEqual(
    said(
      project('let mood = "main"\ngoto "rooms/hall.tease"', {
        "rooms/hall.tease": 'let mood = "hall"\nsay mood\ngoto "rooms/yard.tease"\n',
        "rooms/yard.tease": 'let mood = "yard"\nsay mood\nexit',
      }),
    ),
    ["hall", "yard", "exit"],
  );
});

test("call runs a file and continues after it when the file ends, in loops and functions too", () => {
  assert.deepEqual(
    said(
      project(
        [
          "let rounds = 0",
          "function visit(name) {",
          "    repeat 2 {",
          '        call "corner.tease"',
          "        rounds += 1",
          "    }",
          '    return "${name} ${rounds}"',
          "}",
          'say visit("first")',
          'say "after"',
          "exit",
        ].join("\n"),
        {
          // The called file has its own variables, fresh on every call; end in its function ends the file.
          "corner.tease": [
            "let count = 1",
            "function leave { end }",
            'say "corner ${count}"',
            "count += 1",
            "leave()",
            'say "never"',
            "end",
          ].join("\n"),
        },
      ),
    ),
    ["corner 1", "corner 1", "first 2", "after", "exit"],
  );
});

test("a goto back in a called file sets that file's variables anew", () => {
  assert.deepEqual(
    said(
      project('let n = 10\ncall "count.tease"\nsay "main ${n}"\nexit', {
        "count.tease": [
          "let n = 0",
          "label again",
          "let next = n + 1",
          "n = next",
          "if n < 3 { goto again }",
          'say "count ${n}"',
          "end",
        ].join("\n"),
      }),
    ),
    ["count 3", "main 10", "exit"],
  );
});

test("a goto in a called file replaces it, and the call still returns", () => {
  assert.deepEqual(
    said(
      project('call "a.tease"\nsay "back in main"\nexit', {
        "a.tease": 'say "a"\ngoto "b.tease"',
        "b.tease": 'say "b"\nend',
      }),
    ),
    ["a", "b", "back in main", "exit"],
  );
});

test("a block of a file the session left sees that file's variables, and its goto brings that file back", () => {
  assert.deepEqual(
    said(
      project(
        [
          'let owner = "main"',
          'let beat = timer(duration: 1 s, async: true, display: "hidden", persist: true) {',
          '    say "beat for ${owner}"',
          "    goto resumed",
          "}",
          'goto "wait.tease"',
          "label resumed",
          'say "main again with ${owner}"',
          "exit",
        ].join("\n"),
        { "wait.tease": 'let owner = "wait"\nwait 5 s\nsay "never"\nexit' },
      ),
    ),
    ["beat for main", "main again with main", "exit"],
  );
});

test("a block's goto abandons the file its activation called and keeps that activation's callers", () => {
  assert.deepEqual(
    outputs(
      assertRuntimeResumeEquivalent(
        project('call "middle.tease"\nsay "main continues"\nexit', {
          "middle.tease": [
            "let step = 7",
            'let alarm = timer(duration: 1 s, async: true, display: "hidden", persist: true) {',
            "    goto interrupted",
            "}",
            'call "slow.tease"',
            'say "never"',
            "end",
            "label interrupted",
            'say "interrupted at ${step}"',
            "end",
          ].join("\n"),
          "slow.tease": 'wait 5 s\nsay "never slow"\nend',
        }),
        // The persistent timer could fire after middle.tease returned, and then its end would have no call to return to.
        { warnings: ["TSV071"] },
      ).events,
    ),
    ["interrupted at 7", "main continues", "exit"],
  );
});

test("a block's goto that leaves a called file keeps the caller's finished timers' waiting blocks", () => {
  // The caller's one-shot timer finishes at 1 s while middle.tease's block waits, so its block waits too; the goto then
  // leaves only middle.tease, whose own finished timer's block goes.
  assert.deepEqual(
    said(
      project(
        [
          'timer(duration: 1 s, async: true, display: "hidden") { say "main a" }',
          'call "middle.tease"',
          'say "back in main"',
          "wait 5 s",
          "exit",
        ].join("\n"),
        {
          "middle.tease": [
            'timer(duration: 500 ms, async: true, display: "hidden") {',
            "    wait 2 s",
            "    goto there",
            "}",
            'timer(duration: 1 s, async: true, display: "hidden") { say "middle a" }',
            "wait 10 s",
            "end",
            "label there",
            'say "middle there"',
            "wait 5 s",
            "end",
          ].join("\n"),
        },
      ),
    ),
    ["main a", "middle there", "back in main", "exit"],
  );
});

test("a timer of a file that called another fires during the call, and its goto continues that file", () => {
  // The owner's example on #570: main's timer ends the corner time and continues main with its own variables.
  assert.deepEqual(
    said(
      project(
        [
          "let score = 3",
          "timer async 60 s { goto timeUp }",
          'call "corner.tease"',
          'say "corner done"',
          "exit",
          "label timeUp",
          'say "time is up with ${score}"',
          "exit",
        ].join("\n"),
        { "corner.tease": 'say "corner"\nwait 120 s\nsay "never"\nend' },
      ),
    ),
    ["corner", "time is up with 3", "exit"],
  );
});

test("a non-persistent timer goes when the file entry that started it is left; a call leaves nothing", () => {
  assert.deepEqual(
    said(
      project(
        [
          'timer async 3 s { say "main timer" }',
          'let kept = timer(duration: 4 s, async: true, display: "hidden", persist: true) { say "kept" }',
          'call "short.tease"',
          "wait 5 s",
          'goto "last.tease"',
        ].join("\n"),
        {
          // The called file's own timers go when it ends or goes elsewhere.
          "short.tease": 'timer async 2 s { say "short timer" }\nwait 1 s\ngoto "shorter.tease"',
          "shorter.tease": 'timer async 1 s { say "shorter timer" }\nend',
          "last.tease": 'timer async 1 s { say "last timer" }\nwait 2 s\nexit',
        },
      ),
    ),
    ["main timer", "kept", "last timer", "exit"],
  );
});

test("calling files without end is bounded by the call depth", () => {
  const plan = compiled(
    project('call "a.tease"\nexit', {
      "a.tease": 'call "b.tease"\nend',
      "b.tease": 'call "a.tease"\nend',
    }),
  );
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { maxCallDepth: 8 }));
  assert.deepEqual(outputs(result.events), ["failure TSR047"]);
});

test("restore validation checks activations, file calls, and retained roots", () => {
  const files = project(
    [
      'let t = timer(duration: 9 s, async: true, display: "hidden", persist: true) { say "t" }',
      'call "inner.tease"',
      "exit",
    ].join("\n"),
    { "inner.tease": "function pause { wait 5 s }\npause()\nend" },
  );
  const plan = compiled(files);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(
    waiting.callFrames.map((frame) => frame.kind),
    ["file", "function"],
  );
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  const broken = (change: (snapshot: Mutable<RuntimeSnapshot>) => void): readonly string[] => {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while each fixture breaks one field.
    const snapshot = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
    change(snapshot);
    return validateRuntimeSnapshot(snapshot, plan).errors;
  };
  // The called file's root names the file its call names, and starts at its top.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.frames[1]!.file = 0;
    }),
    [],
  );
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.frames[1]!.entry = plan.files[1]!.entryInstruction + 1;
    }),
    [],
  );
  // A function sees the root of the activation that called it.
  assert.notDeepEqual(
    broken((snapshot) => {
      const frame = snapshot.callFrames[1]!;
      if (frame.kind === "function") frame.rootScopeId = snapshot.frames[0]!.id;
    }),
    [],
  );
  // Only activation roots stand where a file call starts.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.frames[2]!.file = 1;
    }),
    [],
  );
  // A timer's block belongs to the activation that started it.
  assert.notDeepEqual(
    broken((snapshot) => {
      for (const action of snapshot.backgroundActions) {
        if (action.kind === "timer") action.timer.rootScopeId = snapshot.frames[1]!.id;
      }
    }),
    [],
  );
  // A retained root is a root of a file.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.retainedScopes.push({
        id: snapshot.nextScopeId,
        file: null,
        entry: null,
        bindings: [],
      });
      snapshot.nextScopeId += 1;
    }),
    [],
  );
});

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

test("each glob target that runs draws its file once; restore never draws again", () => {
  const files = project(
    ["repeat 8 {", '    call "rooms/*.tease"', "}", 'goto "ends/*.tease"'].join("\n"),
    {
      "rooms/a.tease": 'say "a"\nend',
      "rooms/b.tease": 'say "b"\nend',
      "rooms/c.tease": 'say "c"\nend',
      "ends/calm.tease": 'say "calm end"\nexit',
      "ends/strict.tease": 'say "strict end"\nexit',
    },
  );
  // Every draw happens at a run of a glob target, the same way stepwise and after each restore.
  const seed = 12345;
  const result = assertRuntimeResumeEquivalent(files, { seed });
  const texts = outputs(result.events);
  assert.equal(texts.length, 10);
  assert.ok(texts.slice(0, 8).every((text) => ["a", "b", "c"].includes(text)));
  assert.ok(["calm end", "strict end"].includes(texts[8]!));
  assert.equal(texts[9], "exit");
  // Eight calls and the goto draw once each.
  const expected = createXorShift32State(seed);
  for (let draw = 0; draw < 9; draw += 1) nextXorShift32(expected);
  assert.equal(result.finalSnapshot.rng.state, expected.state);
});

test("a block changes the variables of a file the session left, also across a file call", () => {
  assert.deepEqual(
    said(
      project(
        [
          "let data = [7]",
          "let scores = { first: 7 }",
          "function later {",
          '    call "pause.tease"',
          "    return 9",
          "}",
          'let t = timer(duration: 1 s, async: true, display: "hidden", persist: true) {',
          "    data[0] = 9",
          "    scores.first = later()",
          '    say "${data[0]} ${scores.first}"',
          "}",
          'goto "wait.tease"',
        ].join("\n"),
        { "wait.tease": "wait 5 s\nexit", "pause.tease": "wait 1 s\nend" },
      ),
      // The timer runs `later`, whose call of pause.tease would fail if the timer fired while pause.tease runs.
      { warnings: ["TSV073"] },
    ),
    ["9 9", "exit"],
  );
});

test("a loop of a calling file stays with its call while the called file runs", () => {
  // The same loop of a recursive call is another loop, so the call depth limit ends the recursion.
  const recursive = compiled(
    project('call "a.tease"\nexit', {
      "a.tease": 'repeat 1 { call "b.tease" }\nend',
      "b.tease": 'repeat 1 { call "a.tease" }\nend',
    }),
  );
  const result = run(
    recursive,
    createImmediatePacingRuntimeSnapshot(recursive, { maxCallDepth: 4 }),
  );
  assert.deepEqual(outputs(result.events), ["failure TSR047"]);

  const plan = compiled(
    project('repeat 2 {\n    call "child.tease"\n    say "returned"\n}\nexit', {
      "child.tease": "wait 1 s\nend",
    }),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  const broken = (change: (snapshot: Mutable<RuntimeSnapshot>) => void): boolean => {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while each fixture breaks one field.
    const snapshot = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
    change(snapshot);
    return validateRuntimeSnapshot(snapshot, plan).valid;
  };
  // The caller's loop belongs to the caller, below the file call.
  assert.equal(
    broken((snapshot) => {
      const call = snapshot.callFrames[0]!;
      if (call.kind === "file") call.loopBaseDepth = 0;
    }),
    false,
  );
  // Its iteration scope lies in the caller's scopes.
  assert.equal(
    broken((snapshot) => {
      snapshot.loopFrames[0]!.scopeDepth = 2;
    }),
    false,
  );
  // And the caller stands inside the loop, so the loop must be there.
  assert.equal(
    broken((snapshot) => {
      snapshot.loopFrames.length = 0;
      const call = snapshot.callFrames[0]!;
      if (call.kind === "file") call.loopBaseDepth = 0;
    }),
    false,
  );
});

test("a timer block may change a loop condition while a called file runs", () => {
  assert.deepEqual(
    said(
      project(
        [
          "let x: integer? = 1",
          "timer async 1 s { x = null }",
          "x = 1",
          'while x != null { call "delay.tease" }',
          'say "stopped"',
          "exit",
        ].join("\n"),
        { "delay.tease": "wait 1 s\nend" },
      ),
    ),
    ["stopped", "exit"],
  );
});

test("a timer names an issued activation, also after that activation is gone", () => {
  const plan = compiled(
    project(
      [
        'let kept = timer(duration: 10 s, async: true, display: "hidden", persist: true)',
        "timer async 10 s",
        'goto "child.tease"',
      ].join("\n"),
      { "child.tease": "wait 1 s\nexit" },
    ),
  );
  // The persistent timer outlives main's activation, which nothing retains.
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture breaks one owner.
  const unissued = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
  for (const action of unissued.backgroundActions) {
    if (action.kind === "timer") action.timer.rootScopeId = unissued.nextScopeId + 10;
  }
  assert.equal(validateRuntimeSnapshot(unissued, plan).valid, false);
});

test("restore checks a timer's activation against its file and walks only real loop partitions", () => {
  const plan = compiled(
    project('timer async 10 s\ncall "child.tease"\nexit', {
      "child.tease": 'wait 1 s\ngoto "last.tease"',
      "last.tease": "wait 1 s\nend",
    }),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  // The timer started in main: the called file's activation cannot own it.
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture changes one owner.
  const wrongFile = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
  for (const action of wrongFile.backgroundActions) {
    if (action.kind === "timer") action.timer.rootScopeId = wrongFile.frames[1]!.id;
  }
  assert.equal(validateRuntimeSnapshot(wrongFile, plan).valid, false);

  const loops = compiled(
    project('repeat 2 { call "child.tease" }\nexit', { "child.tease": "wait 1 s\nend" }),
  );
  const inLoop = run(loops, createImmediatePacingRuntimeSnapshot(loops)).snapshot;
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture breaks one loop base.
  const huge = structuredClone(inLoop) as Mutable<RuntimeSnapshot>;
  const call = huge.callFrames[0]!;
  if (call.kind === "file") call.loopBaseDepth = Number.MAX_SAFE_INTEGER;
  assert.equal(validateRuntimeSnapshot(huge, loops).valid, false);
});

test("entering main.tease again skips the start values, which run once", () => {
  assert.deepEqual(
    said(
      project(
        [
          "global count = 0",
          "count += 1",
          'say "round ${count}"',
          'if count < 3 { goto "main.tease" }',
          "exit",
        ].join("\n"),
      ),
    ),
    ["round 1", "round 2", "round 3", "exit"],
  );
});

test("a root retained for a block cannot bind the name of a global", () => {
  const plan = compiled(
    project(
      [
        "global score = 7",
        "let x = 1",
        'let t = timer(duration: 1 s, async: true, display: "hidden", persist: true) { say score }',
        'goto "slow.tease"',
      ].join("\n"),
      { "slow.tease": "wait 2 s\nexit" },
    ),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.retainedScopes.length, 1);
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture adds one binding.
  const shadowing = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
  shadowing.retainedScopes[0]!.bindings.push({ name: "score", value: 999 });
  assert.equal(validateRuntimeSnapshot(shadowing, plan).valid, false);
});

test("a photo taken in a called file or a global function of another file survives a checkpoint", () => {
  const plan = compiled(
    project(
      'call "booth.tease"\nsay "first ${shot}"\nlet second = snap()\nsay "second ${second}"\nexit',
      {
        "booth.tease":
          "global shot: string? = null\nglobal function snap {\n  return takePhoto()\n}\nshot = takePhoto()\nend\n",
      },
    ),
  );
  const photo = "captured-media:photo:1";
  const admission = { holds: (reference: string) => reference === photo };
  const answer = (snapshot: RuntimeSnapshot) => {
    const action = snapshot.foregroundAction;
    assert.equal(action?.kind, "capture");
    const completed = completeAction(
      plan,
      snapshot,
      {
        actionId: action.actionId,
        actionKind: "capture",
        payload: { kind: "captured", media: { kind: "image", reference: photo } },
      },
      { capturedMedia: admission },
    );
    assert.equal(completed.outcome.kind, "completed");
    return run(plan, completed.snapshot);
  };
  const restored = (snapshot: RuntimeSnapshot) =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot))).snapshot;

  // Waiting inside the called file, then inside the global function called from main.tease.
  const inFile = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(inFile.callFrames.at(-1)?.kind, "file");
  const inFunction = answer(inFile);
  assert.equal(inFunction.snapshot.callFrames.at(-1)?.kind, "function");
  for (const waiting of [inFile, inFunction.snapshot]) {
    assert.equal(validateRuntimeSnapshot(waiting, plan).valid, true);
    assert.deepEqual(restored(waiting), waiting);
  }
  const finished = answer(answer(restored(inFile)).snapshot);
  assert.deepEqual(answer(restored(inFunction.snapshot)).snapshot, finished.snapshot);
  assert.deepEqual(outputs([...inFunction.events, ...finished.events]), [
    `first ${photo}`,
    `second ${photo}`,
    "exit",
  ]);
});

test("destinations compare by their values, and a pick holds plain destinations only", () => {
  const plan = compiled(
    project('goto "ends/*.tease"', { "ends/a.tease": "exit", "ends/b.tease": "exit" }),
  );
  // The same destinations written with their keys in another order.
  const reordered: InstructionPlan = {
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "transfer" && "pick" in instruction.destination
        ? {
            ...instruction,
            destination: {
              pick: instruction.destination.pick.map(({ file, target }) => ({ target, file })),
            },
          }
        : instruction,
    ),
  };
  assert.deepEqual(validateInstructionPlan(reordered).errors, []);
  const entered = executeInstruction(reordered, createImmediatePacingRuntimeSnapshot(reordered));
  assert.deepEqual(validateRuntimeSnapshot(entered.snapshot, reordered).errors, []);

  // A pick nested in a pick is malformed, however deep.
  type Nested = { readonly file: number; readonly target: number } | { readonly pick: Nested[] };
  let nested: Nested = { file: 0, target: 0 };
  for (let depth = 0; depth < 12_000; depth += 1) nested = { pick: [nested] };
  const deep = {
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "transfer" ? { ...instruction, destination: nested } : instruction,
    ),
  };
  assert.equal(validateInstructionPlan(deep).valid, false);
});
