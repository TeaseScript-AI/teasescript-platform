import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { GenerationRefused } from "../../src/compiler/javascript/refusal.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import type { ActionCompletedEvent } from "../../src/runtime/events.js";
import { createFreshRuntimeSession } from "../../src/runtime/session.js";
import type { RuntimeSnapshot } from "../../src/runtime/snapshot/state.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { compileValidPlan } from "../helpers/compile-valid-plan.js";
import {
  compareGenerated,
  compareSessions,
  type ComparisonInput,
  type ComparisonVerdict,
} from "../helpers/generated-comparison/compare.js";
import {
  type ComparedSession,
  type OperationResult,
  todaySide,
} from "../helpers/generated-comparison/generated-side.js";
import { PlayHost } from "../helpers/generated-comparison/fixtures.js";
import { completesForegroundAction, Play } from "../helpers/generated-comparison/play.js";
import { projectRecord, type SideRecord } from "../helpers/generated-comparison/record.js";

// Stand-ins for generated code: today's engine with one planted change each. Each test names the comparison clause
// whose mutant it kills.

const FRESH = { seed: 7 };

interface Planted {
  /** The state a side gives after its `count`th operation. */
  readonly state?: (
    state: ReturnType<ComparedSession["state"]>,
    count: number,
  ) => ReturnType<ComparedSession["state"]>;
  /** The result of an operation, by its kind and the request or arguments it got. */
  readonly result?: (kind: string, input: unknown, result: OperationResult) => OperationResult;
}

function standIn(plan: InstructionPlan, planted: Planted = {}): ComparedSession {
  const side = todaySide(createFreshRuntimeSession(plan, FRESH));
  let count = 0;
  const wrap =
    <A extends unknown[]>(kind: string, operate: (...args: A) => OperationResult) =>
    (...args: A): OperationResult => {
      count += 1;
      const result = operate(...args);
      return planted.result?.(kind, args[0], result) ?? result;
    };
  return {
    run: wrap("run", () => side.run()),
    observeTime: wrap("observeTime", (nowMs: number, reports) => side.observeTime(nowMs, reports)),
    completeAction: wrap("completeAction", (request: unknown, options) =>
      side.completeAction(request, options),
    ),
    updateInteraction: wrap("updateInteraction", (request: unknown) =>
      side.updateInteraction(request),
    ),
    reportMediaLoad: wrap("reportMediaLoad", (mediaId: number, report) =>
      side.reportMediaLoad(mediaId, report),
    ),
    pressPermanentButton: wrap("pressPermanentButton", (buttonId: number) =>
      side.pressPermanentButton(buttonId),
    ),
    state: () => planted.state?.(side.state(), count) ?? side.state(),
  };
}

function compare(
  source: string,
  planted: Planted = {},
  input: Omit<ComparisonInput, "plan" | "fresh"> = {},
): ComparisonVerdict {
  const plan = compileValidPlan(source);
  return compareSessions({ plan, fresh: FRESH, ...input }, standIn(plan, planted));
}

type SideState = ReturnType<ComparedSession["state"]>;

/** The state with its snapshot replaced by `change`'s. */
function edited(
  state: SideState,
  change: (snapshot: RuntimeSnapshot) => RuntimeSnapshot,
): SideState {
  return { ...state, snapshot: change(state.snapshot) };
}

/** The texts of the `say` events among `events`. */
function said(events: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const event of events)
    if (
      typeof event === "object" &&
      event !== null &&
      "kind" in event &&
      event.kind === "say" &&
      "text" in event &&
      typeof event.text === "string"
    )
      texts.push(event.text);
  return texts;
}

/** Today's side, with the texts every `run` says gathered into `into`. */
function sayingSide(plan: InstructionPlan, into: string[]): ComparedSession {
  const today = todaySide(createFreshRuntimeSession(plan, FRESH));
  return {
    ...today,
    run: () => {
      const result = today.run();
      into.push(...said(result.events));
      return result;
    },
  };
}

/** The option a completion request selects, if it selects one. */
function selectedOption(request: unknown): number | undefined {
  if (typeof request !== "object" || request === null || !("payload" in request)) return undefined;
  const payload = request.payload;
  return typeof payload === "object" &&
    payload !== null &&
    "optionIndex" in payload &&
    typeof payload.optionIndex === "number"
    ? payload.optionIndex
    : undefined;
}

const ASKS =
  'let a = askText "name?"\nsay "hi ${a}"\nlet b = askChoice "x", "y"\nsay "${b}"\nwait 2 s\nsay "end"\nexit';

test("an unchanged side matches to the end of the play", () => {
  const verdict = compare(ASKS);
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
});

test("the stub refuses every plan, and only a refusal becomes refused (clause 5)", async () => {
  const plan = compileValidPlan('say "x"\nexit');
  const verdict = await compareGenerated({ plan });
  assert.equal(verdict.kind, "refused");
  assert.equal(verdict.kind === "refused" && verdict.instruction, 0);
  const refusal = await compareGenerated({
    plan,
    generate: () => {
      throw new GenerationRefused("expression:call:named", 1);
    },
  });
  assert.equal(refusal.kind === "refused" && refusal.form, "expression:call:named");
  await assert.rejects(
    compareGenerated({
      plan,
      generate: () => {
        throw new TypeError("a defect of the generator");
      },
    }),
    TypeError,
  );
});

test("a state difference that is gone before the end differs where it appears (clause 2)", () => {
  const verdict = compare(ASKS, {
    state: (state, count) =>
      count === 3 ? edited(state, (snapshot) => ({ ...snapshot, nextEventSequence: -1 })) : state,
  });
  assert.equal(verdict.kind === "differs" && verdict.operation, 3);
});

test("a field nobody listed is compared (clause 3)", () => {
  const verdict = compare(ASKS, {
    state: (state) =>
      edited(state, (snapshot) => {
        const extended = { ...snapshot, unlisted: 1 };
        return extended;
      }),
  });
  assert.equal(verdict.kind, "differs");
});

test("the random state is compared (clause 4)", () => {
  const verdict = compare(ASKS, {
    state: (state) =>
      edited(state, (snapshot) => ({
        ...snapshot,
        rng: { ...snapshot.rng, state: snapshot.rng.state + 1 },
      })),
  });
  assert.deepEqual(verdict.kind === "differs" && verdict.mismatches[0]!.path.slice(0, 2), [
    "state",
    "rng",
  ]);
});

test("a difference after the 200th answer is found within a bound of 300 (clause 6)", () => {
  let answers = 0;
  const verdict = compare(
    'let i = 0\nwhile i < 300 {\n  let a = askText "go"\n  i = i + 1\n}\nexit',
    {
      result: (kind, _input, result) => {
        if (kind !== "completeAction") return result;
        answers += 1;
        return answers === 201 ? { ...result, events: [] } : result;
      },
    },
    { end: { answers: 300 } },
  );
  assert.equal(verdict.kind, "differs");
});

test("each policy answers its own way: only the last option's branch differs (clause 7)", () => {
  const source = 'let c = askChoice "a", "b"\nsay "${c}"\nexit';
  const planted: Planted = {
    result: (kind, input, result) =>
      kind === "completeAction" && selectedOption(input) === 1 ? { ...result, events: [] } : result,
  };
  assert.equal(compare(source, planted, { play: "first" }).kind, "matched");
  assert.equal(compare(source, planted, { play: "last" }).kind, "differs");
});

test("today's run reaching the step budget is outside; a fault only the generated side reaches differs (clause 8)", () => {
  const loop = "let stop = false\nwhile true {\n  if stop { exit }\n}";
  assert.deepEqual(compare(loop), { kind: "outside", limit: "TSR037", operation: 1 });
  const verdict = compare('say "x"\nexit', {
    state: (state) => edited(state, (snapshot) => ({ ...snapshot, status: "failed" })),
  });
  assert.equal(verdict.kind, "differs");
});

test("an interpreter slot is not compared, a block's plan ID is (clause 9)", () => {
  const ask = 'let a = askText "?"\nsay "${a}"\nexit';
  const slot = compare(ask, {
    state: (state) =>
      edited(state, (snapshot) => {
        const action = snapshot.foregroundAction;
        return action?.kind === "interaction"
          ? {
              ...snapshot,
              foregroundAction: {
                ...action,
                destinationTemporary: (action.destinationTemporary ?? 0) + 100,
              },
            }
          : snapshot;
      }),
  });
  assert.equal(slot.kind, "matched");
  // Two blocks with the same body: routing to the other one shows only in the timer's block ID.
  const timers =
    'let t = timer async 1 s {\n  say "tick"\n}\nlet u = timer async 100 s {\n  say "tick"\n}\nwait 5 s\nexit';
  const routed = compare(timers, {
    state: (state) =>
      edited(state, (snapshot) => ({
        ...snapshot,
        backgroundActions: snapshot.backgroundActions.map((action) =>
          action.kind === "timer"
            ? {
                ...action,
                timer: {
                  ...action.timer,
                  handlerFunctionId: (action.timer.handlerFunctionId ?? 0) + 1,
                },
              }
            : action,
        ),
      })),
  });
  assert.equal(routed.kind, "differs");
});

test("the action a running block suspended is compared (clause 10)", () => {
  const verdict = compare(ASKS, {
    state: (state, count) =>
      count === 2 ? { ...state, interrupt: { action: { kind: "delay" }, atMs: 0 } } : state,
  });
  assert.equal(verdict.kind === "differs" && verdict.mismatches[0]!.path[0], "interrupt");
});

test("a required field is edited, and the submitted form's answer reaches the script (clause 11)", () => {
  const plan = compileValidPlan(
    'let answers = askForm fields: { n: { type: "integer" } }\nsay "${answers.n}"\nexit',
  );
  const texts: string[] = [];
  const verdict = compareSessions({ plan, fresh: FRESH }, sayingSide(plan, texts));
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
  assert.deepEqual(texts, ["1"]);
});

test("two tagged photos both succeed (clause 12)", () => {
  const plan = compileValidPlan(
    'let first = takePhoto(tags: ["a"])\nlet second = takePhoto(tags: ["b"])\nexit',
  );
  const generated = standIn(plan);
  const verdict = compareSessions({ plan, fresh: FRESH }, generated);
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
  assert.equal(generated.state().snapshot.capturedImages.length, 2);
});

test("a block that becomes due during a wait runs while the wait goes on (clause 13)", () => {
  const plan = compileValidPlan(
    'let t = timer async 1 s {\n  say "tick"\n}\nwait 5 s\nsay "done"\nexit',
  );
  const order: string[] = [];
  const verdict = compareSessions({ plan, fresh: FRESH }, sayingSide(plan, order));
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
  assert.deepEqual(order, ["tick", "done"]);
});

test("no observation passes the scene-time bound (clause 14)", () => {
  const observed: number[] = [];
  const planted: Planted = {
    result: (kind, input, result) => {
      if (kind === "observeTime" && typeof input === "number") observed.push(input);
      return result;
    },
  };
  const delay = compare('wait 3600 s\nsay "late"\nexit', planted, { end: { sceneTimeMs: 60_000 } });
  assert.equal(delay.kind === "matched" && delay.ended, "bound");
  assert.deepEqual(observed, [60_000]);
  observed.length = 0;
  // A blocking play longer than the bound (the play reports 10 s loaded); blocking media cannot repeat endlessly.
  const media = compare('playAudio "long.mp3"\nsay "after"\nexit', planted, {
    end: { sceneTimeMs: 5_000 },
  });
  assert.equal(media.kind === "matched" && media.ended, "bound");
  assert.ok(observed.length > 0 && observed.every((time) => time <= 5_000));
});

test("an own key the projection does not list is compared, whatever its name; a value outside plain data is no match", () => {
  const extra = compare("exit", {
    state: (state) =>
      edited(state, (snapshot) => ({ ...snapshot, ...JSON.parse('{"__proto__":1}') })),
  });
  assert.equal(extra.kind, "differs");
  assert.throws(
    () =>
      compare("exit", {
        result: (kind, _input, result) =>
          kind === "run" ? { ...result, outcome: undefined } : result,
      }),
    TypeError,
  );
});

test("a wait a block interrupts counts as an answer once it settles", () => {
  const source =
    'let t = timer async 1 s {\n  say "tick", instant\n}\nwait 2 s\nlet a = askText "later"\nexit';
  const verdict = compare(source, {}, { end: { answers: 1 } });
  assert.deepEqual(verdict.kind === "matched" && [verdict.ended, verdict.answers], ["bound", 1]);
});

test("every foreground action a run or a load report settles counts against the answer bound", () => {
  const nested =
    'let t = timer async 1 s {\n  say "tick", instant\n  wait 500 ms\n}\nplayAudio "long.mp3"\nlet a = askText "later"\nexit';
  const settled = compare(nested, {}, { end: { answers: 2 } });
  assert.deepEqual(settled.kind === "matched" && [settled.ended, settled.answers], ["bound", 2]);
  const loaded = compare(
    'let m = playAudio async "long.mp3"\nlet a = askText "later"\nexit',
    {},
    { end: { answers: 1 } },
  );
  assert.deepEqual(loaded.kind === "matched" && [loaded.ended, loaded.answers], ["bound", 1]);
});

test("the host opens only text it locked itself", () => {
  const foreign = compare(
    'let opened = decryptText("bG9ja2VkOmhlbGxv", password: "p", default: "no")\nsay opened, instant\nexit',
  );
  assert.equal(foreign.kind === "matched" && foreign.ended, "unanswered: lock");
  const texts: string[] = [];
  const plan = compileValidPlan(
    'let locked = encryptText("hello", password: "p", publicKey: false, timeLock: false)\nlet opened = decryptText(locked, password: "p", default: "no")\nsay opened, instant\nexit',
  );
  const verdict = compareSessions({ plan, fresh: FRESH }, sayingSide(plan, texts));
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
  assert.deepEqual(texts, ["hello"]);
});

test("an input refused for pending work again after the work drained ends the play", () => {
  const session = createFreshRuntimeSession(compileValidPlan('let a = askText "?"\nexit'), FRESH);
  session.run();
  const play = new Play(session, new PlayHost(), "first", { answers: 10, sceneTimeMs: 60_000 });
  const answer = {
    kind: "completeAction",
    request: { actionId: 1, actionKind: "interaction", interactionKind: "text" },
  } as const;
  const pending = { kind: "executionPending" };
  assert.notEqual(typeof play.next(answer, pending, []), "string");
  assert.notEqual(typeof play.next({ kind: "run" }, null, []), "string");
  assert.equal(play.next(answer, pending, []), "unanswered: text");
});

test("the entry sets up the generated side with its own host call", async () => {
  let calls = 0;
  await assert.rejects(
    compareGenerated({
      plan: compileValidPlan("exit"),
      host: () => {
        calls += 1;
        return {};
      },
      generate: () => ({ module: "", table: null }),
    }),
    /no runtime entries/u,
  );
  assert.equal(calls, 1);
});

test("a failure that is not the instruction budget is compared, also one with a code a registered limit shares", () => {
  const source =
    'let name = askText "file?"\nlet lock = encryptFile(name, password: "p", publicKey: false, timeLock: false)\nexit';
  const alike = compare(source);
  assert.equal(alike.kind === "matched" && alike.ended, "failed");
  const different = compare(source, {
    state: (state) =>
      state.snapshot.status === "failed"
        ? edited(state, (snapshot) => ({ ...snapshot, nextEventSequence: -1 }))
        : state,
  });
  assert.equal(different.kind, "differs");
});

test("only plain data is compared: each descriptor, key and prototype shape against its plain control", () => {
  const descriptors = [true, false].flatMap((enumerable) => [
    {
      name: `${enumerable ? "" : "hidden "}data`,
      plain: enumerable,
      of: { value: 1, enumerable, writable: true, configurable: true },
    },
    {
      name: `${enumerable ? "" : "hidden "}read-only data`,
      plain: enumerable,
      of: { value: 1, enumerable, configurable: true },
    },
    {
      name: `${enumerable ? "" : "hidden "}accessor`,
      plain: false,
      of: { get: () => 1, enumerable, configurable: true },
    },
  ]);
  const prototypes = {
    array: [
      { name: "Array.prototype", plain: true, value: Array.prototype },
      { name: "null", plain: true, value: null },
    ],
    object: [
      { name: "Object.prototype", plain: true, value: Object.prototype },
      { name: "null", plain: true, value: null },
      { name: "a null-rooted chain", plain: false, value: Object.create(null) },
      { name: "an object", plain: false, value: {} },
      { name: "a class", plain: false, value: class {}.prototype },
      {
        name: "another realm's Object.prototype",
        plain: false,
        value: runInNewContext("Object.prototype"),
      },
    ],
  };
  interface Shape {
    readonly container: "array" | "object";
    readonly prototype: {
      readonly name: string;
      readonly plain: boolean;
      readonly value: object | null;
    };
    readonly key: "text" | "symbol";
    readonly descriptor: (typeof descriptors)[number];
  }
  const build = (shape: Shape): unknown[] | Record<string, unknown> => {
    const value: unknown[] | Record<string, unknown> = shape.container === "array" ? [] : {};
    Reflect.setPrototypeOf(value, shape.prototype.value);
    const key =
      shape.key === "symbol" ? Symbol("extra") : shape.container === "array" ? "0" : "field";
    return Object.defineProperty(value, key, shape.descriptor.of);
  };
  const withEvent = (event: unknown): ComparisonVerdict =>
    compare("exit", {
      result: (kind, _input, result) =>
        kind === "run" ? { ...result, events: [...result.events, event] } : result,
    });
  let shapes = 0;
  for (const container of ["array", "object"] as const)
    for (const prototype of prototypes[container])
      for (const key of ["text", "symbol"] as const)
        for (const descriptor of descriptors) {
          shapes += 1;
          const shape: Shape = { container, prototype, key, descriptor };
          const name = `${container} of ${prototype.name}, ${key} key, ${descriptor.name}`;
          // The same container made plain where it is not: it is compared, so a refusal of the shape is its own.
          const control: Shape = {
            container,
            prototype: prototype.plain ? prototype : prototypes[container][0]!,
            key: "text",
            descriptor: descriptors[0]!,
          };
          assert.equal(withEvent(build(control)).kind, "differs", `control of ${name}`);
          if (prototype.plain && key === "text" && descriptor.plain)
            assert.equal(withEvent(build(shape)).kind, "differs", name);
          else assert.throws(() => withEvent(build(shape)), TypeError, name);
        }
  assert.equal(shapes, 96);
});

test("an answer is a foreground action completing: every settled action kind is classified", () => {
  const answers: Record<ActionCompletedEvent["settlement"]["actionKind"], boolean> = {
    delay: true,
    interaction: true,
    chatPacingGate: true,
    mediaPlayback: true,
    storageWrite: true,
    capture: true,
    fileStore: true,
    lock: true,
    timer: false,
    media: false,
    permanentButton: false,
  };
  const session = createFreshRuntimeSession(compileValidPlan('say "x"\nwait 2 s\nexit'), FRESH);
  const ran = session.run().events;
  assert.ok(ran.length > 0);
  assert.ok(!ran.some(completesForegroundAction));
  const waited = session
    .observeTime(2_000, [])
    .events.find((event) => event.kind === "actionCompleted");
  assert.ok(waited !== undefined && completesForegroundAction(waited));
  for (const [actionKind, answer] of Object.entries(answers)) {
    // EVIDENCE: fixture: a delay's completion with another kind; the classifier reads only that kind.
    const event = {
      ...waited,
      settlement: { ...waited.settlement, actionKind },
    } as ActionCompletedEvent;
    assert.equal(completesForegroundAction(event), answer, actionKind);
  }
});

test("a record outside plain data is no match: holes, extra array keys, class instances, maps, dates", () => {
  class Event {
    public readonly kind = "say";
  }
  const sparse: unknown[] = [];
  sparse.length = 1;
  const keyed: unknown[] = Object.assign([], { extra: 1 });
  for (const event of [sparse, keyed, new Event(), new Map(), new Date(0)])
    assert.throws(
      () =>
        compare("exit", {
          result: (kind, _input, result) =>
            kind === "run" ? { ...result, events: [...result.events, event] } : result,
        }),
      TypeError,
    );
});

test("a 10,000-level value is projected without exhausting the call stack", () => {
  let deep: SerializableRuntimeValue = 0;
  for (let level = 0; level < 10_000; level += 1) deep = { kind: "list", items: [deep] };
  const record: SideRecord = {
    outcome: null,
    events: [deep],
    snapshot: createFreshRuntimeSession(compileValidPlan("exit"), FRESH).exportSnapshot(),
    interrupt: { action: null, atMs: null },
  };
  assert.doesNotThrow(() => projectRecord(record));
});

test("the command compares each program in a worker of its own and counts the verdicts", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "generated-comparison-"));
  const program = path.join(folder, "main.tease");
  writeFileSync(program, 'say "x"\nexit');
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../../tools/generated-comparison/run.mjs", import.meta.url)),
      program,
      folder,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.equal(output.length, 3);
  for (const line of output.slice(0, 2)) assert.match(line, /"verdict":\{"kind":"refused"/u);
  assert.deepEqual(JSON.parse(output[2]!), { counts: { refused: 2 } });
  rmSync(folder, { recursive: true });
});

test("the command refuses a timeout setTimeout cannot hold as a usage error that says the range", () => {
  for (const timeout of ["2147483648", "Infinity"]) {
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../../tools/generated-comparison/run.mjs", import.meta.url)),
        "--timeout-ms",
        timeout,
        "missing.tease",
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 2, timeout);
    assert.match(run.stderr, /--timeout-ms takes an integer from 1 to 2147483647/u, timeout);
  }
});
