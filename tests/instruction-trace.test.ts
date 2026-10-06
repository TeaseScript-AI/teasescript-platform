import assert from "node:assert/strict";
import test from "node:test";

import {
  compileProject,
  completeAction,
  createCheckpoint,
  deserializeCheckpoint,
  executeInstruction,
  observeTime,
  pressPermanentButton,
  reportMediaLoad,
  run,
  serializeCheckpoint,
  stepToEvent,
  type InstructionPlan,
  type RuntimeInstructionTrace,
  type RuntimeOperationResult,
  type RuntimeSnapshot,
} from "../src/index.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

/*
 * The opt-in instruction trace (docs/RUNTIME.md#instruction-trace) reports what a call executed. Every scenario runs from
 * source through the public operations with and without it, which must give the same results, events, snapshots, and
 * checkpoints; and every traced call must report exactly what single-stepping the same call observes.
 */

type HostInput = (plan: InstructionPlan, snapshot: RuntimeSnapshot) => RuntimeOperationResult;

interface Played {
  /** The trace of each `run`: the first, then the one after each input. */
  readonly traces: readonly RuntimeInstructionTrace[];
  readonly results: readonly RuntimeOperationResult[];
  readonly checkpoints: readonly string[];
}

const DECISIONS = new Set(["jumpIfFalse", "loopStart", "transfer", "end"]);

function compile(main: string, others: Readonly<Record<string, string>> = {}): InstructionPlan {
  const files = [
    { path: "main.tease", source: main },
    ...Object.entries(others).map(([path, source]) => ({ path, source })),
  ];
  const compiled = compileProject(files, { images: [] });
  assert.deepEqual(compiled.diagnostics, []);
  return compiled.plan!;
}

function fresh(plan: InstructionPlan): RuntimeSnapshot {
  return createImmediatePacingRuntimeSnapshot(plan, { seed: 0x1357_9bdf });
}

/** Runs, then applies each input and runs again, with or without the trace. */
function play(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  inputs: readonly HostInput[],
  traced: boolean,
): Played {
  const traces: RuntimeInstructionTrace[] = [];
  const results: RuntimeOperationResult[] = [];
  const checkpoints: string[] = [];
  let current = snapshot;
  const take = (result: RuntimeOperationResult) => {
    current = result.snapshot;
    results.push(result);
    checkpoints.push(serializeCheckpoint(createCheckpoint(plan, current)));
  };
  const advance = () => {
    const ran = run(plan, current, {}, traced ? { instructionTrace: true } : {});
    if (traced) {
      const { instructionTrace, ...untraced } = ran;
      const observed = stepped(plan, current);
      assert.deepEqual(instructionTrace, observed.trace);
      assert.deepEqual(ran.snapshot, observed.snapshot);
      traces.push(instructionTrace!);
      take(untraced);
    } else {
      assert.equal(Object.hasOwn(ran, "instructionTrace"), false);
      take(ran);
    }
  };
  advance();
  for (const input of inputs) {
    const result = input(plan, current);
    assert.equal(Object.hasOwn(result, "instructionTrace"), false);
    take(result);
    advance();
  }
  return { traces, results, checkpoints };
}

/** Plays traced and untraced: the trace must change no result, event, snapshot, or checkpoint. */
function traced(
  plan: InstructionPlan,
  inputs: readonly HostInput[] = [],
  from: RuntimeSnapshot = fresh(plan),
): readonly RuntimeInstructionTrace[] {
  const withTrace = play(plan, from, inputs, true);
  const withoutTrace = play(plan, from, inputs, false);
  assert.deepEqual(withTrace.results, withoutTrace.results);
  assert.deepEqual(withTrace.checkpoints, withoutTrace.checkpoints);
  return withTrace.traces;
}

/**
 * What single-stepping the same call observes: the instruction at each step that ran one, rather than starting a timer,
 * media, or button block, and the successor of each that chooses its successor.
 */
function stepped(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): { readonly trace: RuntimeInstructionTrace; readonly snapshot: RuntimeSnapshot } {
  const instructions = new Set<number>();
  const branches = new Map<string, readonly [number, number]>();
  let current = snapshot;
  for (;;) {
    const before = current.nextInstruction;
    const blocks = interruptions(current);
    const step = executeInstruction(plan, current);
    if (step.instructionsExecuted === 0) break;
    current = step.snapshot;
    if (interruptions(current) > blocks) continue;
    instructions.add(before);
    if (current.status !== "failed" && DECISIONS.has(plan.instructions[before]!.kind))
      branches.set(`${before} ${current.nextInstruction}`, [before, current.nextInstruction]);
  }
  return {
    trace: {
      instructions: [...instructions].sort((left, right) => left - right),
      branches: [...branches.values()].sort(
        (left, right) => left[0] - right[0] || left[1] - right[1],
      ),
    },
    snapshot: current,
  };
}

function interruptions(snapshot: RuntimeSnapshot): number {
  return snapshot.callFrames.filter(
    (frame) => frame.kind === "function" && frame.timerInterruption !== null,
  ).length;
}

/** The documented mapping: the file a global or speaker names, otherwise the file whose block holds the instruction. */
function fileOf(plan: InstructionPlan, index: number): string {
  const instruction = plan.instructions[index]!;
  return (
    instruction.kind === "declareGlobal" || instruction.kind === "declareSpeaker"
      ? plan.files[instruction.file]!
      : plan.files.find((file) => file.startInstruction <= index && index < file.endInstruction)!
  ).path;
}

function location(plan: InstructionPlan, index: number): string {
  return `${fileOf(plan, index)}:${plan.instructions[index]!.span.sl + 1}`;
}

function lines(plan: InstructionPlan, trace: RuntimeInstructionTrace): Set<string> {
  return new Set(trace.instructions.map((index) => location(plan, index)));
}

/** Each branch as its source location and outcome. */
function outcomes(plan: InstructionPlan, trace: RuntimeInstructionTrace): string[] {
  return trace.branches.map(([index, next]) => {
    const instruction = plan.instructions[index]!;
    const at = location(plan, index);
    if (instruction.kind === "jumpIfFalse") return `${at} ${next === index + 1}`;
    if (instruction.kind === "loopStart") return `${at} ${next === index + 1 ? "round" : "exit"}`;
    return `${at} -> ${location(plan, next)}`;
  });
}

function answer(optionIndex: number): HostInput {
  return (plan, snapshot) => {
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction");
    const completed = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: action.interactionKind,
      payload: { kind: "selectedOption", optionIndex },
    });
    assert.equal(completed.outcome.kind, "completed");
    return completed;
  };
}

const CONTROL_FLOW = [
  "function grade(score) {",
  "    if score >= 90 {",
  '        return "A"',
  "    } else if score >= 50 {",
  '        return "B"',
  "    }",
  '    return "C"',
  "}",
  "let total = 0",
  "for n in [95, 60] {",
  "    if n == 60 {",
  "        continue",
  "    }",
  "    total += 1",
  "}",
  "let rounds = 0",
  "while true {",
  "    rounds += 1",
  "    if rounds == 3 {",
  "        break",
  "    }",
  "}",
  "repeat 2 {",
  "    total += 1",
  "}",
  "switch grade(60) {",
  '    case "A" { say "top" }',
  '    case "B" { say "middle" }',
  '    default { say "bottom" }',
  "}",
  "exit",
].join("\n");

test("a traced run reports every instruction and each branch outcome it took", () => {
  const plan = compile(CONTROL_FLOW);
  const [trace] = traced(plan);
  assert.deepEqual(outcomes(plan, trace!).sort(), [
    "main.tease:10 exit",
    "main.tease:10 round",
    "main.tease:11 false",
    "main.tease:11 true",
    "main.tease:17 round",
    "main.tease:19 false",
    "main.tease:19 true",
    "main.tease:2 false",
    "main.tease:23 exit",
    "main.tease:23 round",
    "main.tease:27 false",
    "main.tease:28 true",
    "main.tease:4 true",
  ]);
  const executed = lines(plan, trace!);
  for (const line of [5, 12, 14, 20, 24, 28, 31]) assert.ok(executed.has(`main.tease:${line}`));
  for (const line of [3, 7, 29]) assert.ok(!executed.has(`main.tease:${line}`), `line ${line}`);
});

test("stepToEvent and executeInstruction return the trace of what each call executed", () => {
  const plan = compile(CONTROL_FLOW);
  const [whole] = traced(plan);
  for (const step of [stepToEvent, executeInstruction]) {
    const instructions = new Set<number>();
    const branches = new Set<string>();
    let snapshot = fresh(plan);
    while (snapshot.status !== "halted") {
      const { instructionTrace, ...result } = step(plan, snapshot, {}, { instructionTrace: true });
      assert.deepEqual(result, step(plan, snapshot));
      for (const index of instructionTrace!.instructions) instructions.add(index);
      for (const branch of instructionTrace!.branches) branches.add(branch.join(" "));
      snapshot = result.snapshot;
    }
    assert.deepEqual(
      [...instructions].sort((left, right) => left - right),
      whole!.instructions,
    );
    assert.deepEqual(
      [...branches].sort(),
      whole!.branches.map((branch) => branch.join(" ")).sort(),
    );
  }
});

const ASK = [
  'let pick = choose a: "Apple", b: "Pear"',
  'if pick == "b" {',
  '    say "pear"',
  "} else {",
  '    say "apple"',
  "}",
  "exit",
].join("\n");

test("an answered ask continues in the next run, whose trace has the branch on the answer", () => {
  const plan = compile(ASK);
  const [asked, answered] = traced(plan, [answer(1)]);
  assert.deepEqual([...lines(plan, asked!)], ["main.tease:1"]);
  assert.deepEqual(outcomes(plan, answered!), ["main.tease:2 true"]);
  assert.ok(lines(plan, answered!).has("main.tease:3"));
  assert.ok(!lines(plan, answered!).has("main.tease:5"));
});

test("timer, media, and permanent button blocks are traced in the run that executes them", () => {
  const plan = compile(
    [
      "timer async 1 {",
      '    say "tick"',
      "}",
      'showPermanentButton "Stop" {',
      '    say "stopped"',
      "}",
      'let music = playAudio async "loop.mp3" {',
      "    at 1 s {",
      '        say "cue"',
      "    }",
      "}",
      "wait 5",
      "exit",
    ].join("\n"),
  );
  const media = (snapshot: RuntimeSnapshot) => {
    const action = snapshot.backgroundActions.find((candidate) => candidate.kind === "media");
    assert.ok(action?.kind === "media");
    return action.media;
  };
  const traces = traced(plan, [
    (plan, snapshot) =>
      reportMediaLoad(plan, snapshot, media(snapshot).mediaId, {
        kind: "loaded",
        durationMs: 10_000,
      }),
    (plan, snapshot) => {
      const { mediaId, segment } = media(snapshot);
      return observeTime(plan, snapshot, 1_000, [{ mediaId, segment, progressMs: 1_000 }]);
    },
    (plan, snapshot) => pressPermanentButton(plan, snapshot, 1),
    (plan, snapshot) => observeTime(plan, snapshot, 5_000, []),
  ]);
  const [, , atOneSecond, pressed, ended] = traces.map((trace) => lines(plan, trace));
  assert.ok(atOneSecond!.has("main.tease:2") && atOneSecond!.has("main.tease:9"));
  assert.ok(!atOneSecond!.has("main.tease:5"));
  assert.ok(pressed!.has("main.tease:5"));
  assert.deepEqual([...ended!], ["main.tease:13"]);
});

test("transfers report where each goto, call, and end went, also across files", () => {
  const room = (name: string) => `say "${name}"\nvisits += 1\nif visits >= 6 { exit }\nend`;
  const plan = compile(
    [
      "global visits = 0",
      'fallback "rooms/*.tease"',
      'call "rooms/a.tease"',
      "goto later",
      'say "skipped"',
      "label later",
      "end",
    ].join("\n"),
    { "rooms/a.tease": room("a"), "rooms/b.tease": room("b") },
  );
  const from = fresh(plan);
  const [trace] = traced(plan, [], from);
  const said = run(plan, from)
    .events.flatMap((event) => (event.kind === "say" ? [event.text] : []))
    .slice(1);
  const transfers = outcomes(plan, trace!).filter((outcome) => outcome.includes("->"));
  assert.ok(transfers.includes("main.tease:3 -> rooms/a.tease:1"), "the call");
  assert.ok(transfers.includes("rooms/a.tease:4 -> main.tease:4"), "the end that returns");
  // Every other end continues at a room the fallback drew, as the messages of the rooms show.
  const drawn = trace!.branches.flatMap(([index, next]) =>
    plan.instructions[index]!.kind === "end" && fileOf(plan, next).startsWith("rooms/")
      ? [fileOf(plan, next).slice("rooms/".length, -".tease".length)]
      : [],
  );
  assert.deepEqual([...new Set(drawn)].sort(), [...new Set(said)].sort());
  assert.ok(!lines(plan, trace!).has("main.tease:5"));
});

test("a failing instruction is in the trace of the run that fails", () => {
  const plan = compile('let xs = [1]\nlet v = xs[5]\nsay "after"\nexit');
  const [trace] = traced(plan);
  assert.deepEqual([...lines(plan, trace!)], ["main.tease:1", "main.tease:2"]);
});

test("execution after a checkpoint restore is traced as without the restore", () => {
  const plan = compile(ASK);
  const waiting = run(plan, fresh(plan)).snapshot;
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, waiting)));
  const [, direct] = traced(plan, [answer(0)], waiting);
  const [, afterRestore] = traced(restored.plan, [answer(0)], restored.snapshot);
  assert.deepEqual(afterRestore, direct);
  assert.deepEqual(outcomes(restored.plan, afterRestore!), ["main.tease:2 false"]);
  assert.ok(lines(restored.plan, afterRestore!).has("main.tease:5"));
});
