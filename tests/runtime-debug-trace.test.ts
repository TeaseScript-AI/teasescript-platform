import assert from "node:assert/strict";
import test from "node:test";

import {
  applyExternalStorageEdit,
  compileProject,
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSession,
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
  type RuntimePlayerProfileInput,
  type RuntimeDebugRecord,
  type RuntimeScriptStorageEntrySnapshot,
  type RuntimeSession,
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
import { TraceStore } from "../src/runtime/debug/debug-trace.js";
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
  /** The person fields of the player's profile. */
  readonly playerProfile?: RuntimePlayerProfileInput;
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
      ...(options.playerProfile === undefined ? {} : { playerProfile: options.playerProfile }),
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

test("record views find each instruction's file once per plan", () => {
  // The trace sees each plan's file table through a counter: finding the file of an instruction reads it.
  let fileReads = 0;
  const counted = new WeakMap<InstructionPlan, InstructionPlan>();
  const open = TraceStore.prototype.open;
  TraceStore.prototype.open = function (plan, snapshot) {
    let seen = counted.get(plan);
    if (seen === undefined) {
      seen = {
        ...plan,
        get files() {
          fileReads += 1;
          return plan.files;
        },
      };
      counted.set(plan, seen);
    }
    return open.call(this, seen, snapshot);
  };
  const trace = new RuntimeDebugContext();
  const locations = () => records(trace).map((view) => view.location);
  try {
    play(
      compile([
        { path: "main.tease", source: ['call "rooms/bonus.tease"', "exit"].join("\n") },
        {
          path: "rooms/bonus.tease",
          source: ["let bonus = 4", "bonus += 1", "bonus += 2", "end"].join("\n"),
        },
      ]),
      { trace },
    );
    const first = locations();
    assert.ok(first.some((location) => location?.path === "rooms/bonus.tease"));
    fileReads = 0;
    assert.deepEqual(locations(), first);
    assert.equal(fileReads, 0, "views of the same instructions again find no file");
    // Another plan begins another epoch, whose records are in its own files.
    play(
      compile(
        [...Array.from({ length: 12 }, (_, line) => `let value${line} = ${line}`), "exit"].join(
          "\n",
        ),
      ),
      { trace },
    );
    assert.deepEqual([...new Set(locations().map((location) => location?.path))], ["main.tease"]);
  } finally {
    TraceStore.prototype.open = open;
  }
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

test("a receiver kept for the rest of its statement is explained by the value it selects", () => {
  const played = traced(
    [
      "function pick(value) {",
      "    return value",
      "}",
      "function scores {",
      "    return [10, 20, 30]",
      "}",
      "let best = scores()[pick(1)]",
      "let rows = [[0], [5]]",
      "let i = 1",
      "rows[i].add(pick(7))",
      "let s = set[[1]]",
      "let first = s.first[pick(0)]",
      'say "${best} ${first} ${rows.length}"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  // How the engine keeps such a receiver is no value of the script.
  assert.deepEqual(
    records(played.trace).filter((candidate) => candidate.preview?.includes("preparedReference")),
    [],
  );
  const declaration = (name: string) =>
    records(played.trace).find(
      (candidate) => candidate.kind === "declaration" && candidate.target === name,
    )!;
  // `scores()` only copies the call's result, so the result explains `best` directly.
  assert.deepEqual(
    causes(played.trace, declaration("best")).map((cause) => [cause.kind, cause.preview]),
    [
      ["return", "[10, 20, 30]"],
      ["return", "1"],
    ],
  );
  // `s.first` selects a member: an intermediate value shows it, explained by the set.
  const selected = causes(played.trace, declaration("first")).find(
    (cause) => cause.kind === "temporary",
  )!;
  assert.deepEqual([selected.preview, selected.location?.line], ["[1]", 12]);
  assert.deepEqual(
    causes(played.trace, selected).map((cause) => [cause.kind, cause.target]),
    [["declaration", "s"]],
  );
  // `rows[i]` shows the element it changes.
  assert.ok(
    records(played.trace).some(
      (candidate) =>
        candidate.kind === "temporary" &&
        candidate.preview === "[5]" &&
        candidate.location?.line === 10,
    ),
  );
  // A property step that a change during the preparation makes a list's `random` draws once, while the receiver is
  // prepared, not again for Debug: the traced run equals the untraced one (`traced` compares them).
  const drawn = traced(
    [
      "let rows: (object | integer[][][])[] = [{ random: [[0]] }, [[[2]], [[3]]]]",
      "function pick(value) {",
      "    return value",
      "}",
      "rows[0].random[rows.removeFirst().random.removeFirst().removeFirst()].add(pick(7))",
      "say rows, instant",
      "exit",
    ].join("\n"),
  );
  assert.equal(drawn.snapshot.failure, null);
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

test("reverse gives the list a new version, which the elements read after it come from", () => {
  const played = traced(
    ['let deck = ["ace", "king"]', "deck.reverse()", 'say "${deck.first}"', "exit"].join("\n"),
  );
  assertComplete(played);
  const [card] = causes(played.trace, outputOf(played, "king"));
  const reversed = causes(played.trace, card!)[0]!;
  assert.deepEqual(
    [reversed.kind, reversed.target, reversed.location?.line],
    ["mutation", "deck", 2],
  );
});

test("a repeating timer's random rounds and a block's shared variable stay traceable", () => {
  const played = traced(
    [
      "function count {",
      "    let beats = 0",
      "    let t = timer(duration: (1..=3) s, async: true, repeat: true) {",
      "        beats += 1",
      "    }",
      "    wait 10 s",
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
    'timer async 1 s { wait 5 s }\nlet elapsed = showButton "Go", timeout: 3 s\nsay "After ${elapsed}."\nexit',
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
      "wait 3 s",
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
    [
      'let music = playAudio async "loop.mp3"',
      "stopAudio",
      'say "${music.state}", instant',
      "exit",
    ].join("\n"),
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
      'say "${guide.firstName} ${speaker.firstName} ${speaker.firstName.uppercase()} ${t.remaining} ${t.repeatDuration}"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const [byName, contextual, receiver, remaining, repeat] = causes(
    played.trace,
    outputOf(played, "Bea Bea BEA 2 seconds 5 seconds"),
  );
  for (const interpolation of [byName!, contextual!, receiver!]) {
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

test("a term that a speaker's gender gives, a title read through the other one, or a derived displayName comes from those properties", () => {
  const played = traced(
    [
      "speaker guide {",
      '    gender: "female"',
      '    shortTitle: "Miss"',
      '    hisHer: "their"',
      "}",
      'let changed = "male"',
      "guide.gender = changed",
      'let short = "Ms"',
      "guide.shortTitle = short",
      'let family = "Gray"',
      "guide.lastName = family",
      'say "${guide.heShe} ${guide.title} ${guide.hisHer} ${guide.displayName}"',
      "exit",
    ].join("\n"),
  );
  assertComplete(played);
  const [term, title, explicit, name] = causes(
    played.trace,
    outputOf(played, "he Ms their Ms Gray"),
  );
  assert.ok(lineage(played.trace, term!.id).some((step) => step.target === "changed"));
  assert.ok(lineage(played.trace, title!.id).some((step) => step.target === "short"));
  const named = lineage(played.trace, name!.id);
  assert.ok(
    named.some((step) => step.target === "short") && named.some((step) => step.target === "family"),
  );
  // A term set explicitly keeps its own origin.
  assert.ok(!lineage(played.trace, explicit!.id).some((step) => step.target === "changed"));
  // A `null` title shows nothing, so the name reads `shortTitle` and comes from it.
  const untitled = traced(
    [
      "speaker guide {",
      "    title: null",
      '    shortTitle: "Miss"',
      '    firstName: "Vera"',
      "}",
      'let chosen = "Dr"',
      "guide.shortTitle = chosen",
      "say guide.displayName",
      "exit",
    ].join("\n"),
  );
  assertComplete(untitled);
  assert.ok(
    lineage(untitled.trace, outputOf(untitled, "Dr Vera").id).some(
      (step) => step.target === "chosen",
    ),
  );
});

test("a field the player copied from the player profile comes from the player profile's field, which the host gave", () => {
  const played = traced(
    [
      'let mine = "Sam"',
      "player.firstName = mine",
      "player.copyFrom(playerProfile)",
      'say "${player.firstName} ${playerProfile.lastName}"',
      "exit",
    ].join("\n"),
    { playerProfile: { firstName: "Alex", lastName: "Morgan" } },
  );
  const [copied, read] = causes(played.trace, outputOf(played, "Alex Morgan"));
  const steps = lineage(played.trace, copied!.id);
  assert.ok(steps.some((step) => step.kind === "assignment" && step.target === "player.firstName"));
  assert.ok(
    steps.some((step) => step.kind === "unrecorded" && step.target === "playerProfile.firstName"),
  );
  // The value the copy replaced is no cause.
  assert.ok(!steps.some((step) => step.target === "mine"));
  assert.ok(
    lineage(played.trace, read!.id).some(
      (step) => step.kind === "unrecorded" && step.target === "playerProfile.lastName",
    ),
  );
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
      "    let t = timer(duration: 1 s, async: true, repeat: true) {",
      "        beats += 1",
      "    }",
      "    wait 3 s",
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

test("an otherwise value is explained by the sides it read, and a fallback that asks decides", () => {
  const played = traced(
    [
      "function hide(value) {",
      "    return value",
      "}",
      "let nickname: string? = hide(null)",
      'let saved: string? = hide("Al")',
      "let first = saved otherwise nickname",
      "let second = nickname otherwise saved",
      'let asked = nickname otherwise askText "Name?"',
      'say "${first} ${second} ${asked}"',
      "exit",
    ].join("\n"),
    { answers: [() => ({ kind: "submittedText", submittedText: "Bo" })] },
  );
  assertComplete(played);
  const declared = (name: string) =>
    records(played.trace).find(
      (candidate) => candidate.kind === "declaration" && candidate.target === name,
    )!;
  // A value that is not null is the only cause; a null value is a cause beside the fallback that replaced it.
  const shown = (name: string) =>
    causes(played.trace, declared(name)).map((cause) => `${cause.target} ${cause.preview}`);
  assert.deepEqual(shown("first"), ['saved "Al"']);
  assert.deepEqual(shown("second"), ["nickname null", 'saved "Al"']);
  // The question of a fallback that ran names the decision that the value was null.
  assert.deepEqual(
    controlled(played.trace).filter((line) => line.startsWith("output")),
    ['output  "Name?" <- 8:true'],
  );
});

test("a long chain of unmatched cases keeps only the newest decisions it can name", () => {
  const cases = 600;
  const played = traced(
    [
      "switch 0 {",
      ...Array.from({ length: cases }, (_, index) => `    case ${index + 1} { }`),
      "    default {",
      "        wait 1 s",
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
    [
      "function dynamic(value) {\n    return value\n}",
      "let pace = dynamic(-1 s)",
      "if pace < 0 s {",
      '    say "${["a", "b"]}", pace',
      "}",
      "exit",
    ].join("\n"),
  );
  assert.equal(played.snapshot.status, "failed");
  assert.deepEqual(
    records(played.trace).filter((candidate) => candidate.kind === "decision"),
    [],
  );
});

test("a rejected say leaves no output, draw, or link behind", () => {
  const played = traced(
    [
      "function dynamic(value) {\n    return value\n}",
      "let pace = dynamic(-1 s)",
      'say "${["a", "b"]}", pace',
      "exit",
    ].join("\n"),
  );
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
      'let pick = askChoice a: "Apple", b: "Pear"',
      'let name = askText "Name?"',
      'save name as "who"',
      'showPermanentButton "Bonus" {',
      '    say "bonus"',
      "}",
      'let music = playAudio async "x.mp3"',
      "wait 2 s",
      'let saved: string? = load "who", default: null',
      'say "${pick} ${name} ${saved} ${["x", "y"]}"',
      "wait 1 s",
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
      "function dynamic(value) {\n    return value\n}",
      "let pace = dynamic(-1 s)",
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

  // Uncapped, a record keeps every distinct cause, also one read again past the first 32.
  const repeated = compile(
    [
      ...names.map((name, index) => `let ${name} = ${index}`),
      `let total = ${names.join(" + ")} + v40 + v3`,
      "exit",
    ].join("\n"),
  );
  const complete = new RuntimeDebugContext({ maxDependencies: Infinity });
  const completed = play(repeated, { trace: complete });
  const scope = completed.snapshot.frames[0]!.id;
  const all = record(complete, complete.variableRecord(scope, "total"));
  assert.deepEqual(
    all.dependencies.map((dependency) => dependency.id),
    names.map((name) => complete.variableRecord(scope, name)),
  );
  assert.equal(all.omittedDependencies, 0);
});

test("uncapped causes merge in work proportional to them on whichever side an expression nests", () => {
  // Sums of operands drawn from fewer variables, so a variable comes again on either side of a merge.
  const shapes: Record<string, (operands: readonly string[]) => string> = {
    left: (operands) => operands.join(" + "),
    right: (operands) => operands.reduceRight((inner, operand) => `${operand} + (${inner})`),
    // Groups of one, two, and three operands, nested on alternating sides.
    mixed: (operands) => {
      const groups: string[] = [];
      for (let start = 0, size = 1; start < operands.length; start += size, size = (size % 3) + 1)
        groups.push(`(${operands.slice(start, start + size).join(" + ")})`);
      return groups.reduceRight((inner, group, index) =>
        index % 2 === 0 ? `${group} + (${inner})` : `(${inner}) + ${group}`,
      );
    },
  };
  const has = Set.prototype.has;
  const add = Set.prototype.add;
  const includes = Array.prototype.includes;
  /** Dependency lookups during a traced run of `total = shape`, and the variables `total` depends on. */
  const traced = (shape: string, count: number) => {
    const pool = (count * 3) / 4;
    const operands = Array.from({ length: count }, (_, index) => `v${(index * 7) % pool}`);
    const expression = shapes[shape]!(operands);
    const plan = compile(
      [
        ...Array.from({ length: pool }, (_, index) => `let v${index} = ${index}`),
        `let total = ${expression}`,
        "exit",
      ].join("\n"),
    );
    const session = createFreshRuntimeSession(plan, { seed: SEED });
    const trace = new RuntimeDebugContext({ maxDependencies: Infinity });
    let lookups = 0;
    // Merging causes deduplicates them by a scan or a set: count those lookups while the traced run evaluates.
    Set.prototype.has = function (this: Set<unknown>, value: unknown) {
      lookups += 1;
      return has.call(this, value);
    };
    Set.prototype.add = function (this: Set<unknown>, value: unknown) {
      lookups += 1;
      return add.call(this, value);
    };
    // EVIDENCE: invariant: the wrapper forwards every call unchanged to the original includes, so it has its type.
    Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) {
      lookups += 1;
      return includes.apply(this, args);
    } as typeof includes;
    try {
      session.run({ debugTrace: trace });
    } finally {
      Set.prototype.has = has;
      Set.prototype.add = add;
      Array.prototype.includes = includes;
    }
    const scope = session.exportTrustedSnapshot().frames[0]!.id;
    const sum = record(trace, trace.variableRecord(scope, "total"));
    assert.equal(sum.omittedDependencies, 0);
    // Evaluation reads the operands from left to right: each variable counts where it is first read.
    const variables = [...new Set(expression.match(/v\d+/gu) ?? [])];
    assert.deepEqual(
      sum.dependencies.map((dependency) => dependency.id),
      variables.map((name) => trace.variableRecord(scope, name)),
    );
    return lookups;
  };
  for (const shape of Object.keys(shapes)) {
    const small = traced(shape, 256);
    const large = traced(shape, 1024);
    // Four times the operands: linear work grows about fourfold, a merge copying the longer side sixteenfold.
    assert.ok(large < 6 * small, `${shape}: ${small} lookups for 256 operands, ${large} for 1024`);
  }
});

/** A record as data that does not change while the trace keeps it: dependencies and `control` by ID. */
function recordData(entry: RuntimeDebugRecord) {
  return {
    ...entry,
    dependencies: entry.dependencies.map((dependency) => dependency.id),
    control: entry.control?.id ?? null,
  };
}

const RELEASED = [
  "let base = 5",
  "function addUp(n) {",
  "    if n == 0 {",
  "        return 0",
  "    }",
  "    return n + addUp(n - 1)",
  "}",
  // The block reads and changes a variable of a call that ended, which its scope keeps.
  "function arm(n) {",
  "    let note = n * 2",
  "    timer async 2 s {",
  "        note += base",
  '        say "note ${note}", instant',
  "    }",
  "}",
  "arm(3)",
  // Its own variables stay read while the calls it makes end.
  "function countUp(from) {",
  "    let running = from",
  "    for j in 1..=40 {",
  "        running += addUp(j % 4)",
  "    }",
  "    return running",
  "}",
  "let total = 0",
  "for i in 1..=40 {",
  "    total += addUp(i % 4)",
  "}",
  "wait 1 s",
  "let counted = countUp(base)",
  "let later = base + total",
  "for pass in 1..=3 {",
  "    let inner = pass + later",
  '    say "${inner}", instant',
  "    wait 1 s",
  "}",
  'say "${later} ${base}", instant',
  "exit",
].join("\n");

/**
 * Plays `plan` through a session, a second at a time, calling `between` after each operation and, when given, after each
 * instruction from an observer.
 */
function playSession(
  plan: InstructionPlan,
  debugTrace: RuntimeDebugContext,
  between: () => void,
  everyInstruction = false,
  pauseAtDraws = false,
): RuntimeSession {
  const session = createFreshRuntimeSession(
    plan,
    { seed: SEED, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 },
    pauseAtDraws ? { randomControl: {} } : {},
  );
  const observed = everyInstruction ? { instructionObserver: { after: between } } : {};
  for (let guard = 0; ; guard += 1) {
    assert.ok(guard < 100, "the scenario must end");
    session.run({ debugTrace, ...observed });
    between();
    // A paused draw takes its natural outcome.
    for (let draw = session.view().randomDraw; draw !== null; draw = session.view().randomDraw) {
      session.resumeRandomDraw(
        { drawId: draw.drawId, outcome: "natural" },
        { debugTrace, ...observed },
      );
      between();
    }
    const view = session.view();
    if (view.status !== "waiting") return session;
    session.observeTime(view.currentSessionTimeMs + 1_000, [], { debugTrace });
    between();
  }
}

/** The current version of each variable the session holds, by the trace's version index. */
function currentVersions(session: RuntimeSession, trace: RuntimeDebugContext) {
  const snapshot = session.exportTrustedSnapshot();
  return [
    ...snapshot.globals.map((binding) => trace.variableRecord("global", binding.name)),
    ...[...snapshot.frames, ...snapshot.retainedScopes].flatMap((scope) =>
      scope.bindings.map((binding) => trace.variableRecord(scope.id, binding.name)),
    ),
  ];
}

test("released records leave the trace, while later records and the version index keep naming them", () => {
  const plan = compile(RELEASED);
  const kept = new RuntimeDebugContext();
  const keptSession = playSession(plan, kept, () => {});
  const expected = records(kept).map(recordData);
  assert.ok(expected.length > 300);

  for (const everyInstruction of [false, true]) {
    const released = new RuntimeDebugContext();
    const read = new Map<number, ReturnType<typeof recordData>>();
    const session = playSession(
      plan,
      released,
      () => {
        for (const entry of records(released)) read.set(entry.id, recordData(entry));
        released.release(released.status().lastRecord ?? 0);
        // Between operations, and between instructions in an observer, nothing stays retained.
        assert.equal(released.status().records, 0);
      },
      everyInstruction,
    );
    // Each record, read before it was released, is the record of a trace that releases nothing.
    assert.deepEqual([...read.values()], expected);
    assert.deepEqual(currentVersions(session, released), currentVersions(keptSession, kept));
    const status = released.status();
    assert.deepEqual([status.records, status.firstRecord, status.lastRecord], [0, null, null]);
    assert.equal(status.truncated, false);
    assert.ok(status.accountedBytes < kept.status().accountedBytes);
    assert.equal(released.record(expected.at(-1)!.id), null);
    assert.deepEqual([released.outputs(), released.recentMessages()], [[], []]);
    assert.equal(released.outputRecord(1), null);
    // The releases dropped the index entries of calls that ended, and never pointed one at another version.
    const ended = [
      ...new Set(
        expected.flatMap((entry) => (entry.variable?.name === "n" ? [entry.variable.scope] : [])),
      ),
    ];
    const versions = ended.map((scope) => [
      kept.variableRecord(scope, "n"),
      released.variableRecord(scope, "n"),
    ]);
    assert.ok(versions.every(([was, now]) => was !== null && (now === null || now === was)));
    assert.ok(versions.filter(([, now]) => now === null).length > ended.length / 2);
  }

  // A later record names a released cause, which reads as no longer retained.
  const partly = new RuntimeDebugContext();
  let first = true;
  const partlySession = playSession(plan, partly, () => {
    if (first) partly.release(partly.status().lastRecord ?? 0);
    first = false;
  });
  const root = partlySession.exportTrustedSnapshot().frames[0]!.id;
  const base = partly.variableRecord(root, "base")!;
  assert.equal(partly.record(base), null);
  assert.deepEqual(
    record(partly, partly.variableRecord(root, "later")).dependencies.find(
      (dependency) => dependency.id === base,
    ),
    { id: base, retained: false },
  );
});

test("releases drop the ended aliases of one record in work proportional to them", () => {
  /** Index lookups of every release, which runs after each instruction when `everyInstruction`, then once at the end. */
  const lookups = (source: string, everyInstruction: boolean, observe?: number) => {
    const trace = new RuntimeDebugContext({ maxRecords: 100_000 });
    const session = createFreshRuntimeSession(compile(source), {
      seed: SEED,
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    });
    const get = Map.prototype.get;
    let releasing = false;
    let count = 0;
    Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
      if (releasing) count += 1;
      return get.call(this, key);
    };
    const release = () => {
      releasing = true;
      try {
        trace.release(Infinity);
      } finally {
        releasing = false;
      }
    };
    const observed = everyInstruction ? { instructionObserver: { after: release } } : {};
    try {
      session.run({ debugTrace: trace, ...observed });
      if (observe !== undefined) {
        session.observeTime(observe, [], { debugTrace: trace });
        session.run({ debugTrace: trace, ...observed });
      }
      release();
    } finally {
      Map.prototype.get = get;
    }
    assert.equal(session.view().status, "halted");
    return count;
  };
  // Each round of the block keeps `value` across a call in a temporary of that round's call, an alias of the same
  // record, and the last release drops all of them.
  const ended = (rounds: number) =>
    lookups(
      [
        "function zero {",
        "    return 0",
        "}",
        "function arm {",
        "    let value = 1",
        "    return timer(duration: 1 ms, async: true, repeat: true) {",
        "        let copy = value + zero()",
        "        say copy, instant",
        "    }",
        "}",
        "let clock = arm()",
        `wait ${rounds} ms`,
        "clock.stop()",
        "exit",
      ].join("\n"),
      false,
      rounds,
    );
  // Each round lists the root call's temporary as an alias of `none` again, and calls that also keep `none` across a
  // call end: many releases each look at the record while that one alias still names it.
  const listedAgain = (rounds: number) =>
    lookups(
      [
        "let none: number? = null",
        "function zero {",
        "    return 0",
        "}",
        "function peek {",
        "    let copy = [none, zero()]",
        "    return 0",
        "}",
        "function touch {",
        "    let copy = [none, zero()]",
        "    peek()",
        "    peek()",
        "    return 0",
        "}",
        `repeat ${rounds} {`,
        "    let out = none otherwise touch()",
        "}",
        "exit",
      ].join("\n"),
      true,
    );
  for (const [name, scenario] of [
    ["ended", ended],
    ["listed again", listedAgain],
  ] as const) {
    const small = scenario(64);
    const large = scenario(256);
    // Four times the rounds: linear work grows about fourfold, looking at the same aliases again sixteenfold.
    assert.ok(large < 6 * small, `${name}: ${small} index lookups for 64 rounds, ${large} for 256`);
  }
});

test("release does nothing while an instruction runs, as a builtin it calls sees", () => {
  const compiled = compileSource(
    [
      "let original = 1",
      "let ignored = releaseNow()",
      'say "${releaseNow()} said", instant',
      "let later = original + 1",
      "exit",
    ].join("\n"),
    { builtins: ["releaseNow"] },
  );
  assert.deepEqual(compiled.diagnostics, []);
  const plan = compiled.plan!;
  const play = (release: boolean) => {
    const trace = new RuntimeDebugContext();
    const session = createFreshRuntimeSession(
      plan,
      { seed: SEED, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 },
      {
        capabilities: {
          builtins: {
            releaseNow: () => {
              if (release) trace.release(Infinity);
              return 0;
            },
          },
        },
      },
    );
    session.run({ debugTrace: trace });
    assert.equal(session.view().status, "halted");
    return { trace, records: records(trace) };
  };
  const released = play(true);
  // The second call runs inside a staged message, the first in an ordinary statement: neither releases anything.
  assert.deepEqual(released.records, play(false).records);
  assert.equal(released.records[0]!.target, "original");
  // Between operations, it releases.
  released.trace.release(Infinity);
  assert.equal(released.trace.status().records, 0);
});

test("release works once an operation that threw has unwound, and does nothing in its host callbacks", () => {
  const started = (
    source: string,
    options: Parameters<typeof createFreshRuntimeSession>[2] = {},
  ) => {
    const compiled = compileSource(`let original = 1\n${source}\nexit`);
    assert.deepEqual(compiled.diagnostics, []);
    const session = createFreshRuntimeSession(
      compiled.plan!,
      { seed: SEED, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 },
      options,
    );
    return { session, trace: new RuntimeDebugContext() };
  };
  /** Releases from inside a host callback, which must change nothing. */
  const refused = (trace: RuntimeDebugContext) => {
    const before = trace.status();
    assert.ok(before.records > 0);
    trace.release(Infinity);
    assert.deepEqual(trace.status(), before);
  };
  const releasable = (trace: RuntimeDebugContext) => {
    assert.ok(trace.status().records > 0);
    trace.release(Infinity);
    assert.equal(trace.status().records, 0);
  };
  const failure = new Error("host callback failed");
  const fail = () => {
    throw failure;
  };

  // An instruction observer that throws.
  const observed = started("let later = original + 1");
  assert.throws(
    () =>
      observed.session.run({ debugTrace: observed.trace, instructionObserver: { after: fail } }),
    failure,
  );
  releasable(observed.trace);

  // A random decision callback, which runs inside an instruction.
  let decisions = 0;
  const decided = started("let rolled = randomInteger(1..=6)", {
    randomControl: {
      decide: () => {
        decisions += 1;
        refused(decided.trace);
        return { kind: "natural" };
      },
    },
  });
  decided.session.run({ debugTrace: decided.trace });
  assert.equal(decisions, 1);
  releasable(decided.trace);
  const throwing = started("let rolled = randomInteger(1..=6)", {
    randomControl: { decide: fail },
  });
  assert.throws(() => throwing.session.run({ debugTrace: throwing.trace }));
  releasable(throwing.trace);

  // A captured-media admission, which runs inside a host operation.
  for (const source of ["let photo = takePhoto()", "let photo = askImage()"]) {
    for (const holds of [
      (trace: RuntimeDebugContext) => {
        refused(trace);
        return true;
      },
      fail,
    ]) {
      const { session, trace } = started(source);
      session.run({ debugTrace: trace });
      const action = session.view().foregroundAction!;
      const media = { kind: "image", reference: "captured-media:test" };
      const request =
        action.kind === "capture"
          ? {
              actionId: action.actionId,
              actionKind: "capture",
              payload: { kind: "captured", media },
            }
          : {
              actionId: action.actionId,
              actionKind: "interaction",
              interactionKind: "image",
              payload: { kind: "image", reference: media.reference },
            };
      const complete = () =>
        session.completeAction(request, {
          debugTrace: trace,
          capturedMedia: { holds: () => holds(trace) },
        });
      if (holds === fail) assert.throws(complete, failure);
      else assert.equal(complete().outcome.kind, "completed");
      releasable(trace);
    }
  }
});

test("release works in an observer's dispatch, before the block starts", () => {
  const plan = compile(
    "let original = 1\ntimer async 0 s {\n    let inner = original\n}\nwait 1 s\nexit",
  );
  const trace = new RuntimeDebugContext();
  const session = createFreshRuntimeSession(plan, {
    seed: SEED,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  const retained: number[] = [];
  session.run({
    debugTrace: trace,
    instructionObserver: {
      dispatch: () => {
        retained.push(trace.status().records);
        trace.release(Infinity);
        retained.push(trace.status().records);
      },
    },
  });
  assert.equal(retained.length, 2);
  assert.ok(retained[0]! > 0);
  assert.equal(retained[1], 0);
});

test("status names the retained records and the next record ID, before any record and after a release", () => {
  const plan = compile("let total = 0\nrepeat 3 {\n    total += 1\n}\nexit");
  const trace = new RuntimeDebugContext();
  const range = () => {
    const { records, firstRecord, lastRecord, nextRecord } = trace.status();
    return { records, firstRecord, lastRecord, nextRecord };
  };
  assert.deepEqual(range(), { records: 0, firstRecord: null, lastRecord: null, nextRecord: 1 });
  const session = createFreshRuntimeSession(plan, {
    seed: SEED,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  // What each instruction made, as the next record ID before and after it; the records must be exactly those.
  const made: number[][] = [];
  let next = 0;
  session.run({
    debugTrace: trace,
    instructionObserver: {
      before: () => {
        next = trace.status().nextRecord;
      },
      after: () => {
        const status = range();
        made.push(Array.from({ length: status.nextRecord - next }, (_, index) => next + index));
        if (status.records === 0) return;
        // Release the oldest record, then all of them: the next ID stays.
        trace.release(status.firstRecord!);
        assert.deepEqual(range(), {
          records: status.records - 1,
          firstRecord: status.records === 1 ? null : status.firstRecord! + 1,
          lastRecord: status.records === 1 ? null : status.lastRecord,
          nextRecord: status.nextRecord,
        });
        trace.release(status.lastRecord!);
        assert.deepEqual(range(), {
          records: 0,
          firstRecord: null,
          lastRecord: null,
          nextRecord: status.nextRecord,
        });
      },
    },
  });
  const kept = new RuntimeDebugContext();
  createFreshRuntimeSession(plan, {
    seed: SEED,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  }).run({ debugTrace: kept });
  assert.deepEqual(
    made.flat(),
    records(kept).map((entry) => entry.id),
  );
  assert.deepEqual(range(), {
    records: 0,
    firstRecord: null,
    lastRecord: null,
    nextRecord: kept.status().nextRecord,
  });
});

test("paused and resumed draws name the released versions that a trace releasing nothing names", () => {
  const plan = compile(
    [
      "let x = 1",
      "wait 1 s",
      "repeat 3 {",
      "    x = x + randomInteger(1..=6)",
      "}",
      'say "${x}", instant',
      "exit",
    ].join("\n"),
  );
  const collect = (release: boolean) => {
    const trace = new RuntimeDebugContext();
    const read = new Map<number, ReturnType<typeof recordData>>();
    const between = () => {
      for (const entry of records(trace)) read.set(entry.id, recordData(entry));
      if (release) trace.release(trace.status().lastRecord ?? 0);
    };
    const session = playSession(plan, trace, between, false, true);
    return { read: [...read.values()], versions: currentVersions(session, trace) };
  };
  const kept = collect(false);
  assert.deepEqual(collect(true), kept);
  assert.equal(kept.read.filter((entry) => entry.kind === "random").length, 3);
  assert.deepEqual(
    kept.read.filter((entry) => entry.kind === "unrecorded"),
    [],
  );
});

test("a released record keeps its place in the bounds, which drop it like any other", () => {
  const plan = compile(RELEASED);
  const collect = (trace: RuntimeDebugContext, release: boolean) => {
    const read = new Map<number, ReturnType<typeof recordData>>();
    const session = playSession(plan, trace, () => {
      for (const entry of records(trace)) read.set(entry.id, recordData(entry));
      if (release) trace.release(trace.status().lastRecord ?? 0);
    });
    return { read, versions: currentVersions(session, trace), truncated: trace.status().truncated };
  };
  const kept = collect(new RuntimeDebugContext({ maxRecords: 64 }), false);
  const released = collect(new RuntimeDebugContext({ maxRecords: 64 }), true);
  assert.equal(kept.truncated, true);
  assert.deepEqual(released, kept);
  assert.ok(
    [...kept.read.values()].some(
      (entry) => entry.detail?.kind === "unrecorded" && entry.detail.reason === "unavailable",
    ),
    "the bounds dropped versions that were read again",
  );
});

test("a trace without previews records the same history without value text", () => {
  const plan = compile(RELEASED);
  const withPreviews = new RuntimeDebugContext();
  const withoutPreviews = new RuntimeDebugContext({ previews: false });
  play(plan, { trace: withPreviews });
  play(plan, { trace: withoutPreviews });
  assert.deepEqual(
    records(withoutPreviews),
    records(withPreviews).map((entry) => ({ ...entry, preview: null, previewTruncated: false })),
  );
  assert.ok(withoutPreviews.status().accountedBytes < withPreviews.status().accountedBytes);
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
