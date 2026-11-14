import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GenerationRefused } from "../../src/compiler/javascript/refusal.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { createFreshRuntimeSession } from "../../src/runtime/session.js";
import type { RuntimeSnapshot } from "../../src/runtime/snapshot/state.js";
import { compileValidPlan } from "../helpers/compile-valid-plan.js";
import {
  compareGenerated,
  compareSessions,
  type ComparisonInput,
  type ComparisonVerdict,
  RESOURCE_LIMIT_CODES,
} from "../helpers/generated-comparison/compare.js";
import {
  type ComparedSession,
  type OperationResult,
  todaySide,
} from "../helpers/generated-comparison/generated-side.js";
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

/** A copy of the snapshot changed by `edit`. */
function edited(
  state: ReturnType<ComparedSession["state"]>,
  edit: (snapshot: Record<string, unknown>) => void,
): ReturnType<ComparedSession["state"]> {
  const snapshot = structuredClone(state.snapshot) as unknown as Record<string, unknown>;
  edit(snapshot);
  return { ...state, snapshot: snapshot as unknown as RuntimeSnapshot };
}

const ASKS =
  'let a = askText "name?"\nsay "hi ${a}"\nlet b = askChoice "x", "y"\nsay "${b}"\nwait 2 s\nsay "end"\nexit';

test("an unchanged side matches to the end of the play", () => {
  const verdict = compare(ASKS);
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
});

test("the stub refuses every plan until S1, and only a refusal becomes refused (clause 5)", async () => {
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
      count === 3 ? edited(state, (snapshot) => (snapshot.nextEventSequence = -1)) : state,
  });
  assert.equal(verdict.kind === "differs" && verdict.operation, 3);
});

test("a field nobody listed is compared (clause 3)", () => {
  const verdict = compare(ASKS, {
    state: (state) => edited(state, (snapshot) => (snapshot.unlisted = 1)),
  });
  assert.equal(verdict.kind, "differs");
});

test("the random state is compared (clause 4)", () => {
  const verdict = compare(ASKS, {
    state: (state) => edited(state, (snapshot) => ((snapshot.rng as { state: number }).state += 1)),
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
      kind === "completeAction" &&
      (input as { payload: { optionIndex?: number } }).payload.optionIndex === 1
        ? { ...result, events: [] }
        : result,
  };
  assert.equal(compare(source, planted, { play: "first" }).kind, "matched");
  assert.equal(compare(source, planted, { play: "last" }).kind, "differs");
});

test("today's run reaching the step budget is outside; a fault only the generated side reaches differs (clause 8)", () => {
  const loop = "let stop = false\nwhile true {\n  if stop { exit }\n}";
  assert.deepEqual(compare(loop), { kind: "outside", limit: "TSR037", operation: 1 });
  const verdict = compare('say "x"\nexit', {
    state: (state) =>
      edited(state, (snapshot) => {
        snapshot.status = "failed";
        snapshot.failure = { code: "TSR037", message: "", path: "main.tease", span: null };
      }),
  });
  assert.equal(verdict.kind, "differs");
});

test("an interpreter slot is not compared, a block's plan ID is (clause 9)", () => {
  const ask = 'let a = askText "?"\nsay "${a}"\nexit';
  const slot = compare(ask, {
    state: (state) =>
      edited(state, (snapshot) => {
        const action = snapshot.foregroundAction as { destinationTemporary?: number } | null;
        if (action !== null && action.destinationTemporary !== undefined)
          action.destinationTemporary += 100;
      }),
  });
  assert.equal(slot.kind, "matched");
  // Two blocks with the same body: routing to the other one shows only in the timer's block ID.
  const timers =
    'let t = timer async 1 s {\n  say "tick"\n}\nlet u = timer async 100 s {\n  say "tick"\n}\nwait 5 s\nexit';
  const routed = compare(timers, {
    state: (state) =>
      edited(state, (snapshot) => {
        for (const action of snapshot.backgroundActions as Array<{
          kind: string;
          timer?: { handlerFunctionId: number };
        }>)
          if (action.kind === "timer" && action.timer !== undefined)
            action.timer.handlerFunctionId += 1;
      }),
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
  const session = createFreshRuntimeSession(plan, FRESH);
  const said: string[] = [];
  const today = todaySide(session);
  const watching: ComparedSession = {
    ...today,
    run: () => {
      const result = today.run();
      for (const event of result.events as Array<{ kind: string; text?: string }>)
        if (event.kind === "say" && event.text !== undefined) said.push(event.text);
      return result;
    },
  };
  const verdict = compareSessions({ plan, fresh: FRESH }, watching);
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
  assert.deepEqual(said, ["1"]);
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
  const today = todaySide(createFreshRuntimeSession(plan, FRESH));
  const watching: ComparedSession = {
    ...today,
    run: () => {
      const result = today.run();
      for (const event of result.events as Array<{ kind: string; text?: string }>)
        if (event.kind === "say" && event.text !== undefined) order.push(event.text);
      return result;
    },
  };
  const verdict = compareSessions({ plan, fresh: FRESH }, watching);
  assert.equal(verdict.kind === "matched" && verdict.ended, "halted");
  assert.deepEqual(order, ["tick", "done"]);
});

test("no observation passes the scene-time bound (clause 14)", () => {
  const observed: number[] = [];
  const planted: Planted = {
    result: (kind, input, result) => {
      if (kind === "observeTime") observed.push(input as number);
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

test("the resource-limit codes are the runtime codes the registry lists", () => {
  const registry = readFileSync(
    new URL("../../../docs/RESOURCE-LIMITS.md", import.meta.url),
    "utf8",
  );
  assert.deepEqual([...new Set(registry.match(/TSR\d{3}/gu))].sort(), [...RESOURCE_LIMIT_CODES]);
});

test("a 10,000-level value is projected without exhausting the call stack", () => {
  let deep: unknown = 0;
  for (let level = 0; level < 10_000; level += 1) deep = { kind: "list", items: [deep] };
  const record: SideRecord = {
    outcome: null,
    events: [deep],
    snapshot: {} as RuntimeSnapshot,
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
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    output.map((line) => (line.verdict as { kind?: string } | undefined)?.kind ?? line.counts),
    ["refused", "refused", { refused: 2 }],
  );
  rmSync(folder, { recursive: true });
});
