import assert from "node:assert/strict";
import test from "node:test";

import {
  applyExternalStorageEdit,
  compileProject,
  compileSource,
  completeAction,
  createCheckpoint,
  deserializeCheckpoint,
  observeTime,
  pressPermanentButton,
  RUNTIME_DEBUG_TRACE_LIMITS,
  run,
  RuntimeDebugContext,
  serializeCheckpoint,
  type InstructionPlan,
  type InterpreterEvent,
  type ProjectSourceFile,
  type RuntimeDebugRecord,
  type RuntimeScriptStorageEntrySnapshot,
  type RuntimeSnapshot,
} from "../src/index.js";
import {
  advancePlayerRuntimeTime,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  nextPlayerRuntimeEventMs,
  observePlayerRuntimeTime,
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  applyPlayerRuntimeStorageEdit,
  completePlayerRuntimeStorageWrite,
  continuePlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimePermanentButtons,
  pressPlayerRuntimePermanentButton,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
  withPlayerRuntimeDebugTrace,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import { TraceStore } from "../src/runtime/debug-trace.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { playerStateOf } from "./helpers/player-state.js";

/*
 * The opt-in debug trace (docs/RUNTIME.md#debug-trace) explains values with what execution actually computed. Every
 * scenario runs from source through the public operations; each traced run is checked against the same run without a
 * trace, and a trace from Start must give every value it explains a recorded origin and see every random draw.
 */

const SEED = 0x2468_ace1;

type Answer = (
  action: Extract<RuntimeSnapshot["foregroundAction"], { kind: "interaction" }>,
) => Record<string, unknown> | "refuse";

interface PlayOptions {
  readonly trace?: RuntimeDebugContext;
  /** Answers for the interactions in order: a payload, or `"refuse"` to send an invalid one first. */
  readonly answers?: readonly Answer[];
  readonly scriptStorage?: readonly RuntimeScriptStorageEntrySnapshot[];
  /** Whether storage is persistent, and then whether the host stores each write. */
  readonly persistentStores?: readonly boolean[];
  /** Permanent buttons to press once the session first waits at or after each scene time. */
  readonly presses?: readonly { readonly atMs: number; readonly buttonId: number }[];
  /** Leave every interaction unanswered, so that buttons time out. */
  readonly unanswered?: boolean;
  readonly from?: RuntimeSnapshot;
}

interface Played {
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  /** The checkpoint after every operation, which a trace must leave unchanged. */
  readonly checkpoints: readonly string[];
}

function compile(source: string | readonly ProjectSourceFile[]): InstructionPlan {
  const compiled =
    typeof source === "string" ? compileSource(source) : compileProject(source, { images: [] });
  assert.deepEqual(compiled.diagnostics, []);
  return compiled.plan!;
}

/** A simulated host: runs, answers interactions, stores writes, presses buttons, and otherwise lets time pass. */
function play(plan: InstructionPlan, options: PlayOptions = {}): Played {
  const debug = options.trace === undefined ? {} : { debugTrace: options.trace };
  const answers = [...(options.answers ?? [])];
  const stores = [...(options.persistentStores ?? [])];
  const presses = [...(options.presses ?? [])];
  const events: InterpreterEvent[] = [];
  const checkpoints: string[] = [];
  let snapshot =
    options.from ??
    createImmediatePacingRuntimeSnapshot(plan, {
      seed: SEED,
      persistentScriptStorage: options.persistentStores !== undefined,
      ...(options.scriptStorage === undefined ? {} : { scriptStorage: options.scriptStorage }),
    });
  const apply = (result: { snapshot: RuntimeSnapshot; events: readonly InterpreterEvent[] }) => {
    snapshot = result.snapshot;
    events.push(...result.events);
    checkpoints.push(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  };
  apply(run(plan, snapshot, {}, debug));
  for (let guard = 0; snapshot.status === "waiting"; guard += 1) {
    assert.ok(guard < 500, "the scenario must end");
    const action = snapshot.foregroundAction;
    if (presses[0] !== undefined && snapshot.currentSessionTimeMs >= presses[0].atMs) {
      apply(pressPermanentButton(plan, snapshot, presses.shift()!.buttonId, debug));
    } else if (action?.kind === "interaction" && options.unanswered !== true) {
      const answer = answers.shift();
      assert.ok(answer !== undefined, "an answer for every interaction");
      const request = (payload: Record<string, unknown>) => ({
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: action.interactionKind,
        payload,
      });
      const payload = answer(action);
      if (payload === "refuse") {
        const refused = completeAction(plan, snapshot, request({ kind: "bogus" }), debug);
        assert.equal(refused.outcome.kind, "invalidPayload");
        apply(refused);
        continue;
      }
      const completed = completeAction(plan, snapshot, request(payload), debug);
      assert.equal(completed.outcome.kind, "completed");
      apply(completed);
      // A repeated report of the same answer changes nothing.
      const repeated = completeAction(plan, snapshot, request(payload), debug);
      assert.equal(repeated.outcome.kind, "alreadySettled");
      apply(repeated);
    } else if (action?.kind === "storageWrite") {
      const stored = stores.shift() ?? true;
      apply(
        completeAction(
          plan,
          snapshot,
          {
            actionId: action.actionId,
            actionKind: "storageWrite",
            payload: { kind: stored ? "stored" : "failed" },
          },
          debug,
        ),
      );
    } else {
      const next = nextPlayerRuntimeEventMs(playerStateOf(plan, snapshot));
      assert.notEqual(next, null, "a waiting scenario without input must have a next event");
      apply(observeTime(plan, snapshot, next, [], debug));
    }
    apply(run(plan, snapshot, {}, debug));
  }
  return { snapshot, events, checkpoints };
}

/** Plays traced and untraced; the trace must not change any state, event, or checkpoint. */
function traced(
  source: string | readonly ProjectSourceFile[],
  options: Omit<PlayOptions, "trace"> = {},
): Played & { readonly trace: RuntimeDebugContext; readonly plan: InstructionPlan } {
  const plan = compile(source);
  const trace = new RuntimeDebugContext();
  const withTrace = play(plan, { ...options, trace });
  const withoutTrace = play(plan, options);
  assert.deepEqual(withTrace.checkpoints, withoutTrace.checkpoints);
  assert.deepEqual(withTrace.events, withoutTrace.events);
  assert.deepEqual(withTrace.snapshot, withoutTrace.snapshot);
  assert.equal(trace.status().recording, true, trace.status().failure ?? "");
  return { ...withTrace, trace, plan };
}

function records(trace: RuntimeDebugContext): RuntimeDebugRecord[] {
  const { firstRecord, lastRecord } = trace.status();
  const all: RuntimeDebugRecord[] = [];
  if (firstRecord === null || lastRecord === null) return all;
  for (let id = firstRecord; id <= lastRecord; id += 1) all.push(trace.record(id)!);
  return all;
}

function record(trace: RuntimeDebugContext, id: number | null): RuntimeDebugRecord {
  assert.notEqual(id, null);
  const found = trace.record(id!);
  assert.ok(found !== null, `record ${id} is retained`);
  return found;
}

function causes(trace: RuntimeDebugContext, of: RuntimeDebugRecord): RuntimeDebugRecord[] {
  return of.dependencies.map((dependency) => record(trace, dependency.id));
}

/** Every record reachable from `id`, breadth first. */
function lineage(trace: RuntimeDebugContext, id: number | null): RuntimeDebugRecord[] {
  const seen = new Set<number>();
  const found: RuntimeDebugRecord[] = [];
  const queue = [id!];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const current = record(trace, next);
    found.push(current);
    queue.push(...current.dependencies.map((dependency) => dependency.id));
  }
  return found;
}

function outputOf(
  played: Played & { trace: RuntimeDebugContext },
  text: string,
): RuntimeDebugRecord {
  const event = played.events.find(
    (candidate) => candidate.kind === "say" && candidate.text === text,
  );
  assert.ok(event !== undefined, `said ${JSON.stringify(text)}`);
  return record(played.trace, played.trace.outputRecord(event.sequence));
}

/**
 * A trace from Start records an origin for every value it explains, and sees every draw: the generator states of its
 * random records follow each other from the seed to the final state.
 */
function assertComplete(played: Played & { trace: RuntimeDebugContext }): void {
  const all = records(played.trace);
  assert.equal(played.trace.status().origin, "start");
  assert.equal(played.trace.status().truncated, false);
  assert.deepEqual(
    all.filter((candidate) => candidate.kind === "unrecorded"),
    [],
    "every explained value has a recorded origin",
  );
  let state = played.trace.status().rngAnchorState;
  assert.equal(state, SEED);
  for (const draw of all) {
    if (draw.detail?.kind !== "random") continue;
    assert.equal(draw.detail.stateBefore, state, `draw ${draw.id} follows the previous one`);
    state = draw.detail.stateAfter;
  }
  assert.equal(state, played.snapshot.rng.state, "every draw is recorded");
}

test("a message explains its interpolated value through a call, its parameters, and a random draw", () => {
  const played = traced(
    [
      "let low = 10",
      "let factor = 2",
      "function spanksFor(base, times = factor) {",
      "    return base * times",
      "}",
      "let drawn = randomInteger(low..=30)",
      "let spanks = spanksFor(drawn)",
      'say "You get ${spanks} spanks"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const said = played.events.find((event) => event.kind === "say")!;
  assert.equal(said.kind, "say");
  const spanks = Number(/You get (\d+) spanks/u.exec(said.text)![1]);

  const output = outputOf(played, said.text);
  assert.deepEqual(output.detail, { kind: "output", eventSequence: said.sequence });
  const [interpolation] = causes(played.trace, output);
  assert.equal(interpolation!.kind, "interpolation");
  assert.equal(interpolation!.preview, `"${spanks}"`);
  assert.equal(interpolation!.location?.line, 8);

  const [declaration] = causes(played.trace, interpolation!);
  assert.deepEqual(
    [declaration!.kind, declaration!.target, declaration!.preview, declaration!.location?.line],
    ["declaration", "spanks", String(spanks), 7],
  );
  const [returned] = causes(played.trace, declaration!);
  assert.equal(returned!.kind, "return");
  assert.deepEqual(returned!.detail, {
    kind: "call",
    functionName: "spanksFor",
    parameter: null,
    defaulted: false,
  });
  const parameters = causes(played.trace, returned!);
  assert.deepEqual(
    parameters.map((parameter) => [parameter.target, parameter.detail]),
    [
      ["base", { kind: "call", functionName: "spanksFor", parameter: "base", defaulted: false }],
      ["times", { kind: "call", functionName: "spanksFor", parameter: "times", defaulted: true }],
    ],
  );
  assert.deepEqual(
    causes(played.trace, parameters[1]!).map((cause) => [cause.target, cause.preview]),
    [["factor", "2"]],
  );
  const [argument] = causes(played.trace, parameters[0]!);
  assert.equal(argument!.kind, "argument");
  const [drawn] = causes(played.trace, argument!);
  assert.deepEqual([drawn!.target, Number(drawn!.preview) * 2], ["drawn", spanks]);
  const drawCauses = causes(played.trace, drawn!);
  assert.deepEqual(
    drawCauses.map((cause) => [cause.kind, cause.target]),
    [
      ["declaration", "low"],
      ["random", null],
    ],
  );
  assert.deepEqual(drawCauses[1]!.detail, {
    kind: "random",
    operation: "randomInteger",
    choices: 21,
    range: { start: 10, end: 30, inclusive: true },
    firstDraw: 1,
    draws: 1,
    stateBefore: SEED,
    stateAfter: played.snapshot.rng.state,
    forced: false,
  });
  assert.equal(drawCauses[1]!.preview, drawn!.preview);
});

test("recursion and same-named variables keep each call's and each block's own variables apart", () => {
  const played = traced(
    [
      "function addUp(n) {",
      "    if n == 0 {",
      "        return 0",
      "    }",
      "    let rest = addUp(n - 1)",
      "    return n + rest",
      "}",
      "function title {",
      '    let n = "three"',
      "    return n",
      "}",
      "let total = addUp(3)",
      "let name = title()",
      "for pass in 1..=2 {",
      "    let step = pass * 10",
      '    say "${total} ${name} ${step}"',
      "}",
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const [total, name] = causes(played.trace, outputOf(played, "6 three 10")).map(
    (interpolation) => causes(played.trace, interpolation)[0]!,
  );
  assert.deepEqual([total!.target, total!.preview], ["total", "6"]);
  // Another function's `n` is not any call of addUp's parameter.
  assert.deepEqual(
    lineage(played.trace, name!.id).map((step) => [step.kind, step.target, step.preview]),
    [
      ["declaration", "name", '"three"'],
      ["return", null, '"three"'],
      ["declaration", "n", '"three"'],
    ],
  );
  // Each round's `step` is its own variable, from its own round's loop value.
  const steps = ["6 three 10", "6 three 20"].map(
    (text) => causes(played.trace, causes(played.trace, outputOf(played, text))[2]!)[0]!,
  );
  assert.deepEqual(
    steps.map((step) => causes(played.trace, step).map((cause) => [cause.kind, cause.preview])),
    [[["loopValue", "1"]], [["loopValue", "2"]]],
  );
  // Each call's `n` comes from its own argument: 3, 2, 1, 0 down the recursion.
  const parameters = lineage(played.trace, total!.id).filter(
    (candidate) => candidate.kind === "parameter",
  );
  // addUp(0) returns a literal 0, which depends on no parameter.
  assert.deepEqual(parameters.map((parameter) => parameter.preview).sort(), ["1", "2", "3"]);
  for (const parameter of parameters) {
    const [argument] = causes(played.trace, parameter);
    assert.equal(argument!.kind, "argument");
    assert.equal(argument!.preview, parameter.preview);
  }
});

test("a global assigned in another file explains a message in main.tease", () => {
  const played = traced([
    {
      path: "main.tease",
      source: ["global score = 1", 'call "rooms/bonus.tease"', 'say "Score ${score}"', "exit"].join(
        "\n",
      ),
    },
    { path: "rooms/bonus.tease", source: ["let bonus = 4", "score += bonus", "end"].join("\n") },
  ]);
  assertComplete(played);
  const [interpolation] = causes(played.trace, outputOf(played, "Score 5"));
  const [assignment] = causes(played.trace, interpolation!);
  assert.deepEqual(
    [assignment!.kind, assignment!.target, assignment!.location?.path, assignment!.location?.line],
    ["assignment", "score", "rooms/bonus.tease", 2],
  );
  assert.deepEqual(
    causes(played.trace, assignment!).map((cause) => [cause.target, cause.location?.path]),
    [
      ["score", "main.tease"],
      ["bonus", "rooms/bonus.tease"],
    ],
  );
  assert.equal(played.trace.variableRecord("global", "score"), assignment!.id);
});

test("compound, property, index, and collection changes give the whole variable a new version", () => {
  const played = traced(
    [
      'let pet = { name: "Bo", tricks: ["sit"] }',
      'let extra = "roll"',
      "pet.tricks.add(extra)",
      'pet.tricks[0] = "beg"',
      "let count = 1",
      "count += pet.tricks.length",
      'say "${pet.tricks.first} ${count}"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const [first, count] = causes(played.trace, outputOf(played, "beg 3")).map(
    (interpolation) => causes(played.trace, interpolation)[0]!,
  );
  assert.deepEqual([first!.kind, first!.target, first!.location?.line], ["assignment", "pet", 4]);
  assert.equal(first!.preview, '{ name: "Bo", tricks: ["beg", "roll"] }');
  const mutation = causes(played.trace, first!).find((cause) => cause.kind === "mutation")!;
  assert.deepEqual([mutation.target, mutation.location?.line], ["pet", 3]);
  assert.deepEqual(
    causes(played.trace, mutation).map((cause) => [cause.kind, cause.target]),
    [
      ["declaration", "pet"],
      ["declaration", "extra"],
    ],
  );
  // `count += ...` reads the earlier count and the list's length at that time.
  assert.deepEqual(
    causes(played.trace, count!).map((cause) => [cause.target, cause.location?.line]),
    [
      ["count", 5],
      ["pet", 4],
    ],
  );
});

test("interpolation selection and shuffle record the draws that chose the text", () => {
  const played = traced(
    [
      'let deck = ["ace", "king", "queen", "jack"]',
      "deck.shuffle()",
      'let tools = ["paddle", "cane"]',
      'say "${deck.first} with the ${tools}"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const said = played.events.find((event) => event.kind === "say")!;
  assert.equal(said.kind, "say");
  const [card, tool] = causes(played.trace, outputOf(played, said.text));
  const shuffled = causes(played.trace, card!)[0]!;
  assert.deepEqual([shuffled.kind, shuffled.target], ["mutation", "deck"]);
  const shuffle = causes(played.trace, shuffled).find((cause) => cause.kind === "random")!;
  assert.deepEqual(
    shuffle.detail?.kind === "random" && [shuffle.detail.operation, shuffle.detail.draws],
    ["shuffle", 3],
  );
  const selection = causes(played.trace, tool!).find((cause) => cause.kind === "random")!;
  assert.deepEqual(
    selection.detail?.kind === "random" && [selection.detail.operation, selection.detail.choices],
    ["interpolation", 2],
  );
  assert.equal(selection.preview, tool!.preview);
  assert.ok(said.text.endsWith(`with the ${JSON.parse(tool!.preview!)}`));
});

test("a repeating timer's random rounds and a block's shared variable stay traceable", () => {
  const played = traced(
    [
      "function count {",
      "    let beats = 0",
      "    let t = timer(duration: 1..=3, async: true, repeat: true) {",
      "        beats += 1",
      "    }",
      "    wait 10",
      "    t.stop()",
      '    say "beats ${beats}"',
      "}",
      "count()",
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const said = played.events.find((event) => event.kind === "say")!;
  assert.equal(said.kind, "say");
  const [interpolation] = causes(played.trace, outputOf(played, said.text));
  const latest = causes(played.trace, interpolation!)[0]!;
  // The block's assignment reaches the function's own `beats`, version after version, back to its `let`.
  assert.deepEqual([latest.kind, latest.target, latest.location?.line], ["assignment", "beats", 4]);
  const versions = lineage(played.trace, latest.id).filter((step) => step.target === "beats");
  assert.equal(versions.at(-1)!.kind, "declaration");
  assert.equal(versions.length, Number(said.text.split(" ")[1]) + 1);
  const rounds = records(played.trace).filter(
    (candidate) =>
      candidate.detail?.kind === "random" && candidate.detail.operation === "timerRepeat",
  );
  assert.ok(rounds.length >= 2, "repeat rounds draw their durations");
  for (const round of rounds) assert.equal(round.location?.line, 3);
});

test("permanent button blocks assign the variables they share with their function", () => {
  const played = traced(
    [
      "function challenge {",
      "    let stop = false",
      "    let rounds = 0",
      '    showPermanentButton "Stop" {',
      "        stop = true",
      "    }",
      "    while not stop {",
      "        rounds += 1",
      "        wait 5 s",
      "    }",
      '    say "stopped after ${rounds} rounds, ${stop}"',
      "}",
      "challenge()",
      "exit",
    ].join("\n"),
    { presses: [{ atMs: 5_000, buttonId: 1 }] },
  );
  assertComplete(played);
  const said = played.events.find((event) => event.kind === "say")!;
  assert.equal(said.kind, "say");
  const stop = causes(played.trace, causes(played.trace, outputOf(played, said.text))[1]!)[0]!;
  assert.deepEqual(
    [stop.kind, stop.target, stop.preview, stop.location?.line],
    ["assignment", "stop", "true", 5],
  );
});

test("a button that times out while a timer block runs records its timeout as the answer", () => {
  const played = traced(
    'timer async 1 { wait 5 }\nlet elapsed = showButton "Go", timeout: 3\nsay "After ${elapsed}."\nexit',
    { unanswered: true },
  );
  assertComplete(played);
  const said = played.events.find((event) => event.kind === "say")!;
  assert.equal(said.kind, "say");
  const input = lineage(played.trace, outputOf(played, said.text).id).find(
    (step) => step.kind === "input",
  )!;
  assert.deepEqual(input.detail?.kind === "input" && input.detail.outcome, "timedOut");
  assert.equal(input.preview, "3 seconds");
});

test("a media block's own handle is its first variable", () => {
  const trace = new RuntimeDebugContext();
  const debug = { debugTrace: trace };
  let session = createPlayerRuntimeSession(
    [
      'let music = playAudio async "loop.mp3" {',
      "    at 1 s {",
      '        say "cue at ${music.position}"',
      "    }",
      "}",
      "wait 3",
      "exit",
    ].join("\n"),
    debug,
  );
  const media = playerRuntimeMedia(session.state).media[0]!;
  session = reportPlayerRuntimeMediaLoad(session, media.mediaId, {
    kind: "loaded",
    durationMs: 10_000,
  }).session;
  session = advancePlayerRuntimeTime(session, 60_000);
  assert.equal(session.state.status, "halted");
  const said = session.events.find((event) => event.kind === "say")!;
  const steps = lineage(trace, trace.outputRecord(said.sequence));
  assert.deepEqual(
    steps.filter((step) => step.target === "music").map((step) => [step.kind, step.preview]),
    [["declaration", "<media>"]],
  );
  assert.equal(trace.status().epoch, 1);
  assert.deepEqual(
    records(trace).filter((candidate) => candidate.kind === "unrecorded"),
    [],
  );
});

test("stopAudio explains the state of each sound it stops, like stop() on its handle", () => {
  const trace = new RuntimeDebugContext();
  let session = createPlayerRuntimeSession(
    ['let music = playAudio async "loop.mp3"', "stopAudio", 'say "${music.state}"', "exit"].join(
      "\n",
    ),
    { debugTrace: trace },
  );
  session = reportPlayerRuntimeMediaLoad(session, 1, {
    kind: "loaded",
    durationMs: 10_000,
  }).session;
  assert.equal(session.state.status, "halted");
  const said = session.events.find((event) => event.kind === "say")!;
  assert.equal(said.kind === "say" && said.text, "stopped");
  const stopped = lineage(trace, trace.outputRecord(said.sequence)).find(
    (step) => step.kind === "mutation",
  );
  assert.deepEqual([stopped?.target, stopped?.location?.line], ["media.stop()", 2]);
});

test("speaker and handle properties are state that every name for them reads", () => {
  const played = traced(
    [
      'global author = "Ada"',
      "speaker guide {",
      "    firstName: author",
      "}",
      "let alias = guide",
      'let renamed = "Bea"',
      "alias.firstName = renamed",
      'let family = "Jones"',
      "guide.lastName = family",
      "let t = timer async 10 s",
      "let changed = 2 s",
      "t.remaining = changed",
      "let beat = 5 s",
      "t.repeatDuration = beat",
      "let same = t",
      "same.pause()",
      "speaker guide",
      'say "${guide.firstName} ${speaker.firstName} ${t.remaining} ${t.repeatDuration}"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const [byName, contextual, remaining, repeat] = causes(
    played.trace,
    outputOf(played, "Bea Bea 2 seconds 5 seconds"),
  );
  for (const interpolation of [byName!, contextual!]) {
    const steps = lineage(played.trace, interpolation.id);
    assert.ok(
      steps.some((step) => step.kind === "assignment" && step.target === "guide.firstName"),
      "the alias's assignment explains the speaker's name",
    );
    assert.ok(steps.some((step) => step.target === "renamed"));
    // Another property's later change is no cause of this one.
    assert.ok(!steps.some((step) => step.target === "guide.lastName" || step.target === "family"));
  }
  // pause() through an alias set the timer's timed properties last; it does not touch repeatDuration.
  const timed = lineage(played.trace, remaining!.id);
  assert.ok(timed.some((step) => step.kind === "mutation" && step.target === "timer.pause()"));
  const repeated = lineage(played.trace, repeat!.id);
  assert.ok(repeated.some((step) => step.target === "timer.repeatDuration"));
  assert.ok(repeated.some((step) => step.target === "beat"));
  assert.ok(!repeated.some((step) => step.target === "timer.pause()"));
});

test("an overwritten property value is no cause of the value that replaced it", () => {
  for (const viaAlias of [false, true]) {
    const writer = viaAlias ? "other" : "guide";
    const timer = viaAlias ? "otherTimer" : "t";
    const played = traced(
      [
        "speaker guide {",
        '    firstName: "Original"',
        "}",
        "let other = guide",
        'let discarded = "Discarded"',
        `${writer}.firstName = discarded`,
        'let current = "Current"',
        `${writer}.firstName = current`,
        "let t = timer async 10 s",
        "let otherTimer = t",
        "let lost = 3 s",
        `${timer}.remaining = lost`,
        "let kept = 2 s",
        `${timer}.remaining = kept`,
        'say "${guide.firstName} ${t.remaining}"',
        "exit",
      ].join("\n"),
    );
    assertComplete(played);
    const steps = lineage(played.trace, outputOf(played, "Current 2 seconds").id);
    const values = steps.map((step) => step.preview);
    assert.ok(steps.some((step) => step.target === "current"));
    assert.ok(steps.some((step) => step.target === "kept"));
    for (const overwritten of ['"Discarded"', '"Original"', "3 seconds"])
      assert.ok(!values.includes(overwritten), `${overwritten} is no cause (alias: ${viaAlias})`);
    assert.ok(!steps.some((step) => step.target === "discarded" || step.target === "lost"));
  }
});

test("answers, loads, and saves explain values, and refused or repeated reports record nothing", () => {
  const played = traced(
    [
      'let name = askText "Name?"',
      'let visits = load "visits", default: 0',
      'save visits + 1 as "visits"',
      'save name as "lost"',
      'let again: integer? = load "visits", default: null',
      'let kept = load "lost", default: "none"',
      'say "${name} ${again} ${kept}"',
      "exit",
    ].join("\n"),
    {
      answers: [() => "refuse", () => ({ kind: "submittedText", submittedText: "Bo" })],
      scriptStorage: [{ key: "visits", value: 4 }],
      persistentStores: [true, false],
    },
  );
  assertComplete(played);
  const all = records(played.trace);
  const inputs = all.filter((candidate) => candidate.kind === "input");
  const asked = played.events.find(
    (event) => event.kind === "actionRequested" && event.action.kind === "interaction",
  );
  assert.equal(asked?.kind, "actionRequested");
  assert.deepEqual(
    inputs.map((input) => [input.preview, input.detail]),
    [
      [
        '"Bo"',
        {
          kind: "input",
          actionId: asked.action.actionId,
          actionKind: "interaction",
          interactionKind: "text",
          outcome: "completed",
        },
      ],
    ],
  );
  const [name, again, kept] = causes(played.trace, outputOf(played, "Bo 5 none")).map(
    (interpolation) => causes(played.trace, interpolation)[0]!,
  );
  assert.deepEqual(
    causes(played.trace, name!).map((cause) => cause.kind),
    ["input"],
  );
  // The second load reads the stored save, which the first load's host value explains.
  const load = causes(played.trace, again!)[0]!;
  assert.deepEqual(load.detail, {
    kind: "load",
    key: "visits",
    found: true,
    defaultEvaluated: false,
  });
  const [save] = causes(played.trace, load);
  assert.deepEqual([save!.kind, save!.preview, save!.location?.line], ["storage", "5", 3]);
  const earlier = lineage(played.trace, save!.id).find((step) => step.kind === "load")!;
  assert.deepEqual(earlier.detail, {
    kind: "load",
    key: "visits",
    found: true,
    defaultEvaluated: false,
  });
  assert.deepEqual(
    earlier.dependencies,
    [],
    "a value stored before the session has no recorded cause",
  );
  // The host failed to store `lost`, so no save explains it and its default ran.
  assert.deepEqual(causes(played.trace, kept!)[0]!.detail, {
    kind: "load",
    key: "lost",
    found: false,
    defaultEvaluated: true,
  });
  assert.equal(played.trace.storageRecord("lost"), null);
});

test("a debugging tool's storage edit explains the next load instead of the script's save", () => {
  const plan = compile(
    [
      'save 1 as "level"',
      'let first = askText "Edit now?"',
      'let level: integer? = load "level", default: null',
      'say "${level}"',
      "exit",
    ].join("\n"),
  );
  const trace = new RuntimeDebugContext();
  const debug = { debugTrace: trace };
  let snapshot = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { seed: SEED }),
    {},
    debug,
  ).snapshot;
  const save = record(trace, trace.storageRecord("level"));
  assert.deepEqual(save.detail, { kind: "storage", key: "level", deleted: false, edited: false });
  const edited = applyExternalStorageEdit(plan, snapshot, { key: "level", value: 7 }, debug);
  assert.equal(edited.outcome.kind, "applied");
  const action = edited.snapshot.foregroundAction!;
  assert.equal(action.kind, "interaction");
  snapshot = completeAction(
    plan,
    edited.snapshot,
    {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: "yes" },
    },
    debug,
  ).snapshot;
  const ran = run(plan, snapshot, {}, debug);
  const said = ran.events.find((event) => event.kind === "say")!;
  assert.equal(said.kind === "say" && said.text, "7");
  const load = lineage(trace, trace.outputRecord(said.sequence)).find(
    (step) => step.kind === "load",
  )!;
  assert.deepEqual(
    causes(trace, load).map((cause) => [cause.preview, cause.detail]),
    [["7", { kind: "storage", key: "level", deleted: false, edited: true }]],
  );
  assert.equal(trace.status().epoch, 1);
});

test("Stage image changes record where they were set", () => {
  const played = traced(
    ['let room = "rooms/hall"', 'showImage "${room}.jpg"', "hideImage", "exit"].join("\n"),
  );
  assertComplete(played);
  const hidden = record(played.trace, played.trace.stageImageRecord());
  assert.deepEqual([hidden.kind, hidden.preview, hidden.location?.line], ["image", "null", 3]);
  const shown = records(played.trace).find((candidate) => candidate.kind === "image")!;
  assert.equal(shown.preview, '"rooms/hall.jpg"');
  assert.deepEqual(
    lineage(played.trace, shown.id).map((step) => step.target ?? step.kind),
    ["Stage image", "interpolation", "room"],
  );
});

/** Each record that names a decision, with the decisions around it as `line:value`, innermost first. */
function controlled(trace: RuntimeDebugContext): string[] {
  return records(trace)
    .filter((candidate) => candidate.control !== null && candidate.kind !== "decision")
    .map((candidate) => {
      const chain: string[] = [];
      for (let decision = candidate.control; decision !== null;) {
        const found = record(trace, decision.id);
        assert.equal(found.kind, "decision");
        chain.push(`${found.location?.line}:${found.preview}`);
        decision = found.control;
      }
      return `${candidate.kind} ${candidate.target ?? ""} ${candidate.preview} <- ${chain.join(" <- ")}`;
    });
}

test("a write names the innermost branch decision on whose taken side it ran", () => {
  const played = traced(
    [
      "let a = 3",
      "let x = 0",
      "if a > 2 {",
      "    x = 1",
      "    if a > 5 {",
      "        x = 2",
      "    } else {",
      "        x = 3",
      "    }",
      "}",
      "x = 4",
      "if a == 1 { x = 5 } else if a == 3 { x = 6 } else { x = 7 }",
      "switch a {",
      "    case 1 { x = 8 }",
      "    case 2, 3 { x = 9 }",
      "    default { x = 10 }",
      "}",
      "let n = 0",
      "while n < 5 {",
      "    n += 1",
      "    if n == 2 { break }",
      "}",
      "function twice(v) {",
      "    if v > 1 { return v * 2 }",
      "    let z = 1",
      "    return z",
      "}",
      "if a > 0 { x = twice(a) }",
      "x = twice(0)",
      'say "${x} ${n}"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  // Writes after a construct, and a callee's writes, name no decision of the caller.
  assert.deepEqual(controlled(played.trace), [
    "assignment x 1 <- 3:true",
    "assignment x 3 <- 5:false <- 3:true",
    "assignment x 6 <- 12:true <- 12:false",
    "assignment x 9 <- 15:true <- 14:false",
    "assignment n 1 <- 19:true",
    "assignment n 2 <- 19:true",
    "return  6 <- 24:true",
    "assignment x 6 <- 28:true",
  ]);
  // Each round of a loop is a decision of its own, and a decision's causes are its condition's.
  const rounds = records(played.trace).filter(
    (candidate) => candidate.kind === "decision" && candidate.location?.line === 19,
  );
  assert.equal(rounds.length, 2);
  assert.deepEqual(
    causes(played.trace, rounds[1]!).map((cause) => [cause.target, cause.preview]),
    [["n", "1"]],
  );
  // A decision that governs no write is not recorded.
  assert.equal(
    records(played.trace).some(
      (candidate) => candidate.kind === "decision" && candidate.location?.line === 21,
    ),
    false,
  );
});

test("and, or, and load defaults decide too, and blocks keep their own decisions", () => {
  const played = traced(
    [
      "let flag = true",
      'let sure = flag and (askText "Really?") == "y"',
      'let other = flag or (askText "Never?") == "y"',
      "let off = false",
      'let either = off or (askText "Other?") == "n"',
      "let beats = 0",
      "if flag {",
      "    let t = timer(duration: 1, async: true, repeat: true) {",
      "        beats += 1",
      "    }",
      "    wait 3",
      "    t.stop()",
      "}",
      'say "${sure} ${other} ${either} ${beats}"',
      "exit",
    ].join("\n"),
    {
      answers: [
        () => ({ kind: "submittedText", submittedText: "y" }),
        () => ({ kind: "submittedText", submittedText: "n" }),
      ],
    },
  );
  assertComplete(played);
  const lines = controlled(played.trace);
  // The question of a right side that ran names the left side's decision; the timer block's writes name none.
  assert.deepEqual(
    lines.filter((line) => line.startsWith("output")),
    ['output  "Really?" <- 2:true', 'output  "Other?" <- 5:false'],
  );
  assert.ok(lines.some((line) => line.startsWith("declaration t ") && line.endsWith(" <- 7:true")));
  assert.deepEqual(
    lines.filter((line) => line.includes(" beats ")),
    [],
  );
  const said = played.events.find((event) => event.kind === "say" && event.text.startsWith("true"));
  assert.ok(said?.kind === "say" && !said.text.endsWith(" 0"), "the timer block ran");
});

test("a long chain of unmatched cases keeps only the newest decisions it can name", () => {
  const cases = 600;
  const played = traced(
    [
      "switch 0 {",
      ...Array.from({ length: cases }, (_, index) => `    case ${index + 1} { }`),
      "    default {",
      "        wait 1",
      '        say "done", instant',
      "    }",
      "}",
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  // The message, shown after a pause in the default, names the last case; the oldest cases were dropped while the
  // session waited and are neither kept nor recorded.
  const output = outputOf(played, "done");
  const chain: RuntimeDebugRecord[] = [];
  for (let decision = output.control; decision !== null;) {
    const found = record(played.trace, decision.id);
    chain.push(found);
    decision = found.control;
  }
  assert.equal(chain[0]!.location?.line, cases + 1);
  assert.ok(chain.every((decision) => decision.preview === "false"));
  assert.ok(chain.length <= 256, `${chain.length} decisions recorded`);
  assert.equal(
    records(played.trace).filter((candidate) => candidate.kind === "decision").length,
    chain.length,
  );
});

test("a rejected say inside a branch leaves no decision behind", () => {
  const played = traced(
    ["let pace = -1", "if pace < 0 {", '    say "${["a", "b"]}", pace', "}", "exit"].join("\n"),
  );
  assert.equal(played.snapshot.status, "failed");
  assert.deepEqual(
    records(played.trace).filter((candidate) => candidate.kind === "decision"),
    [],
  );
});

test("a rejected say leaves no output, draw, or link behind", () => {
  const played = traced(["let pace = -1", 'say "${["a", "b"]}", pace', "exit"].join("\n"));
  assert.equal(played.snapshot.status, "failed");
  const all = records(played.trace);
  assert.deepEqual(
    all.filter((candidate) => ["output", "random", "interpolation"].includes(candidate.kind)),
    [],
  );
  assert.equal(played.snapshot.rng.state, SEED, "the failed say drew nothing either");
});

test("a message held behind pacing keeps its causes until it is shown", () => {
  const trace = new RuntimeDebugContext();
  const debug = { debugTrace: trace };
  let session = createPlayerRuntimeSession(
    ['let first = "One"', 'say "${first}"', 'let second = "Two"', 'say "${second}"', "exit"].join(
      "\n",
    ),
    debug,
  );
  session = advancePlayerRuntimeTime(session, 60_000);
  assert.equal(session.state.status, "halted");
  const outputs = trace.outputs().map((id) => record(trace, id));
  assert.deepEqual(
    outputs.map((output) => lineage(trace, output.id).map((step) => step.target ?? step.kind)),
    [
      ["output", "interpolation", "second"],
      ["output", "interpolation", "first"],
    ],
  );
  assert.equal(trace.status().epoch, 1, "one session is one epoch");
});

test("restore and attaching mid-run start a new epoch that names unrecorded history honestly", () => {
  const source = [
    'let base = "fixed"',
    'let pick = ["a", "b", "c"].random',
    'let answer = askText "Ready?"',
    'say "${base} ${pick} ${answer}"',
    "exit",
  ].join("\n");
  const trace = new RuntimeDebugContext();
  const waiting = createPlayerRuntimeSession(source, { debugTrace: trace });
  assert.equal(trace.status().epoch, 1);
  const restorePoint = createPlayerRuntimeRestorePoint(waiting);

  const restored = restorePlayerRuntimeSession(restorePoint, null, trace);
  assert.deepEqual(
    [trace.status().epoch, trace.status().origin, trace.status().records],
    [2, "restore", 0],
  );
  const answered = submitPlayerRuntimeComposer(restored, "Yes")!;
  const said = answered.session.events.findLast((event) => event.kind === "say")!;
  const restoredCauses = lineage(trace, trace.outputRecord(said.sequence)).filter(
    (step) => step.kind === "unrecorded",
  );
  assert.deepEqual(restoredCauses.map((step) => [step.target, step.detail]).sort(), [
    ["base", { kind: "unrecorded", reason: "restored" }],
    ["pick", { kind: "unrecorded", reason: "restored" }],
  ]);

  // Debug turned on in a running session attaches to it.
  const attached = new RuntimeDebugContext();
  const late = submitPlayerRuntimeComposer(
    withPlayerRuntimeDebugTrace(restorePlayerRuntimeSession(restorePoint), attached),
    "Yes",
  )!;
  assert.equal(attached.status().origin, "attach");
  const lateSaid = late.session.events.findLast((event) => event.kind === "say")!;
  assert.ok(
    lineage(attached, attached.outputRecord(lateSaid.sequence)).some(
      (step) => step.detail?.kind === "unrecorded" && step.detail.reason === "beforeDebug",
    ),
  );

  // An operation on a session that is not the last traced one cannot continue earlier links.
  const epoch = attached.status().epoch;
  observePlayerRuntimeTime(withPlayerRuntimeDebugTrace(answered.session, attached), 0);
  assert.equal(attached.status().epoch, epoch + 1);
});

/** Drives a Player session through every adapter operation kind the script reaches, the same way each time. */
function drivePlayer(debugTrace: RuntimeDebugContext | null): PlayerRuntimeSession {
  let session = createPlayerRuntimeSession(
    [
      'let pick = choose a: "Apple", b: "Pear"',
      'let name = askText "Name?"',
      'save name as "who"',
      'showPermanentButton "Bonus" {',
      '    say "bonus"',
      "}",
      'let music = playAudio async "x.mp3"',
      "wait 2",
      'let saved: string? = load "who", default: null',
      'say "${pick} ${name} ${saved} ${["x", "y"]}"',
      "wait 1",
      "exit",
    ].join("\n"),
    {
      persistentScriptStorage: true,
      wallClockMs: 1_790_942_400_000,
      ...(debugTrace === null ? {} : { debugTrace }),
    },
  );
  let edited = false;
  let pressed = false;
  let restored = false;
  for (let guard = 0; session.state.status === "waiting"; guard += 1) {
    assert.ok(guard < 100, "the Player scenario must end");
    const foreground = playerRuntimeForeground(session);
    const write = pendingPlayerRuntimeStorageWrite(session.state);
    const unloaded = playerRuntimeMedia(session.state).media.find((media) => !media.loaded);
    if (foreground?.kind === "choose") {
      session = selectPlayerRuntimeChoice(session, foreground.options[0]!.id)!.session;
    } else if (foreground?.kind === "ask-text") {
      session = submitPlayerRuntimeComposer(session, "Bo")!.session;
    } else if (write !== null) {
      session = completePlayerRuntimeStorageWrite(session, write.actionId, true).session;
    } else if (!edited) {
      edited = true;
      session = applyPlayerRuntimeStorageEdit(session, { key: "who", value: "Cy" }).session;
    } else if (unloaded !== undefined) {
      session = reportPlayerRuntimeMediaLoad(session, unloaded.mediaId, {
        kind: "loaded",
        durationMs: 10_000,
      }).session;
    } else if (!pressed && playerRuntimePermanentButtons(session.state).length > 0) {
      pressed = true;
      const [button] = playerRuntimePermanentButtons(session.state);
      session = pressPlayerRuntimePermanentButton(session, button!.buttonId).session;
    } else if (!restored) {
      restored = true;
      session = restorePlayerRuntimeSession(
        createPlayerRuntimeRestorePoint(session),
        null,
        debugTrace,
      );
      session = continuePlayerRuntimeSession(session, {
        wallClockMs: 1_790_942_460_000,
        temporalContext: playerRuntimeSnapshot(session).temporalCaptures[0]!.context,
      }).session;
    } else {
      const next = nextPlayerRuntimeEventMs(session.state);
      assert.notEqual(next, null);
      session = observePlayerRuntimeTime(session, next!).session;
    }
  }
  assert.ok(edited && pressed && restored, "the scenario reaches every adapter operation");
  return session;
}

test("Debug off leaves every Player adapter path unchanged and does no trace work", () => {
  const calls: string[] = [];
  // Every method of the trace's recorder is counted while Debug is off.
  const originals = new Map<string, PropertyDescriptor>();
  for (const name of Object.getOwnPropertyNames(TraceStore.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(TraceStore.prototype, name)!;
    const method: unknown = descriptor.value;
    if (name === "constructor" || typeof method !== "function") continue;
    originals.set(name, descriptor);
    Object.defineProperty(TraceStore.prototype, name, {
      ...descriptor,
      value(this: TraceStore, ...args: unknown[]) {
        calls.push(name);
        return method.apply(this, args);
      },
    });
  }
  let off: PlayerRuntimeSession;
  try {
    off = drivePlayer(null);
    assert.deepEqual(calls, [], "no trace method runs while Debug is off");
  } finally {
    for (const [name, descriptor] of originals)
      Object.defineProperty(TraceStore.prototype, name, descriptor);
  }
  const trace = new RuntimeDebugContext();
  const on = drivePlayer(trace);
  assert.equal(off.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(on), playerRuntimeSnapshot(off));
  assert.deepEqual(on.events, off.events);
  assert.deepEqual(on.transcriptEntries, off.transcriptEntries);
  assert.equal(
    createPlayerRuntimeRestorePoint(on).checkpointJson,
    createPlayerRuntimeRestorePoint(off).checkpointJson,
  );
  assert.equal(on.debugTrace, trace);
  assert.equal(off.debugTrace, null);
  // The trace stays out of the checkpoint and the session's restore point.
  assert.ok(!createPlayerRuntimeRestorePoint(on).checkpointJson.includes("debugTrace"));
  assert.equal(trace.status().origin, "restore");
  assert.ok(trace.status().records > 0);
  assert.equal(withPlayerRuntimeDebugTrace(on, null).debugTrace, null);
});

test("bounded history drops the oldest records and says so", () => {
  const plan = compile(
    [
      "let total = 0",
      "let big = []",
      "for i in 1..=3000 {",
      "    total += i",
      '    big.add("item ${i} of a long list that makes the preview long")',
      "}",
      'say "${total}"',
      "exit",
    ].join("\n"),
  );
  const trace = new RuntimeDebugContext();
  const played = play(plan, { trace });
  const status = trace.status();
  assert.equal(status.recording, true);
  assert.ok(status.truncated);
  assert.ok(status.records <= RUNTIME_DEBUG_TRACE_LIMITS.maxRecords);
  assert.ok(status.accountedBytes <= RUNTIME_DEBUG_TRACE_LIMITS.maxAccountedBytes);
  const said = played.events.find((event) => event.kind === "say")!;
  const [interpolation] = causes(trace, record(trace, trace.outputRecord(said.sequence)));
  const latest = causes(trace, interpolation!)[0]!;
  assert.equal(latest.target, "total");
  // Somewhere back the history is gone, and says so instead of inventing a cause.
  let step: RuntimeDebugRecord | null = latest;
  let expired = false;
  for (let guard = 0; step !== null && guard < 10_000; guard += 1) {
    const earlier: { id: number; retained: boolean } | undefined = step.dependencies.find(
      (dependency) => !dependency.retained || record(trace, dependency.id).target === "total",
    );
    if (earlier === undefined) break;
    if (!earlier.retained) {
      expired = true;
      break;
    }
    step = record(trace, earlier.id);
  }
  assert.ok(expired, "an expired dependency marks dropped history");
  // Previews stop at the limit while they are captured.
  const bigVersion = record(trace, trace.variableRecord(played.snapshot.frames[0]!.id, "big"));
  assert.equal(bigVersion.previewTruncated, true);
  assert.equal(bigVersion.preview!.length, RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters);
});

test("oversized values, wide staged messages, and rollbacks stay within the bounds", () => {
  const budget = 64 * 1024;
  const longKey = compile(
    [
      'let key = "xxxxxxxx"',
      "for i in 1..=18 {",
      "    key += key",
      "}",
      "save 1 as key",
      "exit",
    ].join("\n"),
  );
  const oversized = new RuntimeDebugContext({ maxAccountedBytes: budget });
  play(longKey, { trace: oversized });
  assert.ok(oversized.status().accountedBytes <= budget);

  // A host function inside the staged message reports the trace's size while the say is still staged.
  const placeholders = 3000;
  const compiled = compileSource(
    [
      `let s = "${"x".repeat(1024)}"`,
      `say "${"${s}${probe()}".repeat(placeholders)}", instant`,
      "exit",
    ].join("\n"),
    { builtins: ["probe"] },
  );
  assert.deepEqual(compiled.diagnostics, []);
  const staged = new RuntimeDebugContext({ maxAccountedBytes: budget });
  const sizes: number[] = [];
  const probe = () => {
    sizes.push(staged.status().accountedBytes);
    return "";
  };
  const wide = run(
    compiled.plan!,
    createImmediatePacingRuntimeSnapshot(compiled.plan!, { seed: SEED }),
    { builtins: { probe } },
    { debugTrace: staged },
  );
  assert.equal(wide.snapshot.status, "halted");
  assert.equal(sizes.length, placeholders);
  assert.ok(Math.max(...sizes) <= budget, "staged records count toward the bounds");

  // A wide say that fails after its placeholders rolls back what the bounds kept of it.
  const failing = compile(
    [
      `let s = "${"x".repeat(1024)}"`,
      "let pace = -1",
      `say "${"${s}".repeat(placeholders)}", pace`,
      "exit",
    ].join("\n"),
  );
  const rolledBack = new RuntimeDebugContext({ maxAccountedBytes: budget });
  assert.equal(play(failing, { trace: rolledBack }).snapshot.status, "failed");
  assert.ok(rolledBack.status().accountedBytes <= budget);
  assert.deepEqual(
    records(rolledBack).filter((candidate) => candidate.kind === "interpolation"),
    [],
  );

  // A staged message reading many distinct variables keeps its rollback bookkeeping within the bounds too.
  const names = Array.from({ length: 3000 }, (_, index) => `v${index}`);
  const manyCompiled = compileSource(
    [
      ...names.map((name, index) => `let ${name} = ${index}`),
      `say "${names.map((name) => `\${${name}}`).join(" ")}\${probe()}", instant`,
      "exit",
    ].join("\n"),
    { builtins: ["probe"] },
  );
  assert.deepEqual(manyCompiled.diagnostics, []);
  const many = new RuntimeDebugContext({ maxAccountedBytes: 4096 });
  const manySizes: number[] = [];
  run(
    manyCompiled.plan!,
    createImmediatePacingRuntimeSnapshot(manyCompiled.plan!, { seed: SEED }),
    {
      builtins: {
        probe: () => {
          manySizes.push(many.status().accountedBytes);
          return "";
        },
      },
    },
    { debugTrace: many },
  );
  assert.equal(manySizes.length, 1);
  assert.ok(manySizes[0]! <= 4096, "staged bookkeeping counts toward the bounds");

  // Outputs larger than the budget are dropped at once, and no index entry outlives them.
  const loud = compile(
    ["for i in 1..=50 {", `    say "${"x".repeat(1024)}", instant`, "}", "exit"].join("\n"),
  );
  const small = new RuntimeDebugContext({ maxAccountedBytes: 1024 });
  const loudPlayed = play(loud, { trace: small });
  for (const event of loudPlayed.events)
    if (event.kind === "say") assert.equal(small.outputRecord(event.sequence), null);

  const draw = compile("let r = random()\nexit");
  const tiny = new RuntimeDebugContext({ maxAccountedBytes: 180 });
  play(draw, { trace: tiny });
  assert.ok(tiny.status().accountedBytes <= 180);
});

test("previews cut long property names before writing them", () => {
  const plan = compile(['let row: object? = load "row", default: null', "exit"].join("\n"));
  const longest = { length: 0 };
  const join = Array.prototype.join;
  // Observe the longest text notation assembles while the traced run writes its preview.
  Array.prototype.join = function (this: unknown[], separator?: string) {
    const joined = join.call(this, separator);
    longest.length = Math.max(longest.length, joined.length);
    return joined;
  };
  try {
    const trace = new RuntimeDebugContext();
    play(plan, {
      trace,
      scriptStorage: [
        {
          key: "row",
          value: { kind: "object", properties: [{ name: "a".repeat(100_000), value: 1 }] },
        },
      ],
    });
  } finally {
    Array.prototype.join = join;
  }
  assert.ok(longest.length <= 4 * RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters);
});

test("previews cut long keys and labels before writing them", () => {
  const plan = compile(
    ['let key = load "key", default: ""', "let table = dict{ [key]: 1 }", "exit"].join("\n"),
  );
  const longest = { length: 0 };
  const replace = String.prototype.replace;
  // Observe how much text escaping handles while the traced run writes its previews.
  // EVIDENCE: invariant: the wrapper forwards every call unchanged to the original replace, so it has its type.
  String.prototype.replace = function (this: string, ...args: Parameters<typeof replace>) {
    longest.length = Math.max(longest.length, this.length);
    return replace.apply(this, args);
  } as typeof replace;
  try {
    const trace = new RuntimeDebugContext();
    const played = play(plan, {
      trace,
      scriptStorage: [{ key: "key", value: "\n".repeat(100_000) }],
    });
    const table = record(trace, trace.variableRecord(played.snapshot.frames[0]!.id, "table"));
    assert.equal(table.previewTruncated, true);
  } finally {
    String.prototype.replace = replace;
  }
  assert.ok(longest.length <= RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters);
});

test("a small byte budget evicts by size, and wide expressions keep at most the dependency limit", () => {
  const names = Array.from({ length: 50 }, (_, index) => `v${index}`);
  const plan = compile(
    [
      ...names.map((name, index) => `let ${name} = ${index}`),
      `let total = ${names.join(" + ")}`,
      'say "${total}"',
      "exit",
    ].join("\n"),
  );
  const wide = new RuntimeDebugContext();
  const played = play(plan, { trace: wide });
  const sum = record(wide, wide.variableRecord(played.snapshot.frames[0]!.id, "total"));
  assert.equal(sum.dependencies.length, RUNTIME_DEBUG_TRACE_LIMITS.maxDependencies);
  assert.equal(sum.omittedDependencies, 50 - RUNTIME_DEBUG_TRACE_LIMITS.maxDependencies);

  const small = new RuntimeDebugContext({ maxAccountedBytes: 4096 });
  play(plan, { trace: small });
  assert.ok(small.status().truncated);
  assert.ok(small.status().accountedBytes <= 4096);
  assert.ok(small.status().records < 53);
});

test("a deserialized checkpoint traced from its restore matches the untraced continuation", () => {
  const plan = compile(
    [
      "let n = randomInteger(1..=6)",
      'let a = askText "Go?"',
      "let rolls = [n, randomInteger(1..=6)]",
      'say "${rolls} ${a}"',
      "exit",
    ].join("\n"),
  );
  const answers: Answer[] = [() => ({ kind: "submittedText", submittedText: "now" })];
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan, { seed: SEED })).snapshot;
  const restored = () =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, waiting))).snapshot;
  const trace = new RuntimeDebugContext();
  trace.reset("restore");
  const withTrace = play(plan, { from: restored(), trace, answers });
  const withoutTrace = play(plan, { from: restored(), answers });
  assert.deepEqual(withTrace.checkpoints, withoutTrace.checkpoints);
  assert.deepEqual(withTrace.events, withoutTrace.events);
  assert.equal(trace.status().origin, "restore");
  assert.equal(trace.status().rngAnchorState, waiting.rng.state);
});

test("a message's text is state of its message: aliases share it, an append builds on it, a replacement does not", () => {
  const played = traced(
    [
      'let line = say "Waiting", instant',
      "let alias = line",
      'let first = "!"',
      "alias.text += first",
      'let second = "?"',
      "line.text += second",
      'let fresh = "Ready"',
      "alias.text = fresh",
      "say line.text, instant",
      "exit",
    ].join("\n"),
  );
  const updates = played.events.filter((event) => event.kind === "messageUpdated");
  const [appended, again, replaced] = updates.map((event) =>
    record(played.trace, played.trace.outputRecord(event.sequence)),
  );
  assert.deepEqual(
    [appended, again, replaced].map((update) => [update!.kind, update!.target, update!.preview]),
    [
      ["assignment", "message.text", '"Waiting!"'],
      ["assignment", "message.text", '"Waiting!?"'],
      ["assignment", "message.text", '"Ready"'],
    ],
  );
  const named = (update: RuntimeDebugRecord) =>
    lineage(played.trace, update.id).map((cause) => cause.target);
  // The second append reads the text the first one wrote, through the other name for the message.
  assert.ok(lineage(played.trace, again!.id).some((cause) => cause.id === appended!.id));
  assert.ok(named(again!).includes("second"));
  // A replacement depends on its value only.
  assert.ok(named(replaced!).includes("fresh"));
  assert.ok(!lineage(played.trace, replaced!.id).some((cause) => cause.id === again!.id));
  // Reading the text later finds its latest change.
  const shown = outputOf(played, "Ready");
  assert.ok(lineage(played.trace, shown.id).some((cause) => cause.id === replaced!.id));
  // A change is no message of its own.
  assert.deepEqual(
    played.trace.outputs().map((id) => record(played.trace, id).kind),
    ["output", "output"],
  );
});
