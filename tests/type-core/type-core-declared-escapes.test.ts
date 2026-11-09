import assert from "node:assert/strict";
import test from "node:test";
import { compileProjectWithBackend } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import {
  planDigest,
  type RunResult,
  runsDigest,
} from "../helpers/type-core/type-core-declared-escapes.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { hostValues } from "../helpers/type-core-stop-oracle.js";

// #2116's declared difference under #2080: the owner's decision (B), the O4 lead's rulings 6 to 10 on #2065's design
// round. This file pins known escapes and declared differences, not accepted behaviour. At a forced demand allowance the
// decision index's charges can move a stop. Inside each recorded window of a source and held mode, the head:
// - stops unsettled in admission where main settles (`adverse`): #2080's fail-open path, a store's check lost;
// - settles where main stops unsettled in admission (`favourable`): the check restored;
// - settles with a stop main does not make (`settled`): the plan identical once object types' properties are in name
//   order, and the runs identical but for the property a TSR058 message names (`planDigest`, `runsDigest`).
// At each window's edges outside it, the head's stop state and plan are main's. #2080's unsettled side closes the adverse
// windows; the settled class stays declared while the index is charged. The windows are measured over every integer
// allowance on both trees (#2116's sweep); this file reads their edges.
// `MAIN` is main's side: recorded at efbd7fdee by lane 2b's recorder (`probe24.mjs` in #2116's evidence), per source and
// mode, the natural plan's digest and, at each edge, main's stop state, its `typeCheck` count, its plan's digest and, in a
// settled window, its runs' digest over the stop oracle's host values. A change that moves a recorded value re-records it
// with its ground here: the source, mode and allowance that moved, how, and the change that moved it (docs/TESTING.md,
// "Pinned work").

/**
 * Codex round 7's reachable sources and Sol round 10's two-copy form (#2116): a place holding `count` settled whole
 * stores, reads under a host condition that is false when the script runs, which pay for the decision index, then a store
 * of the host value that main's plan checks; the copied forms store `count` whole places (or the place twice) into `a`.
 */
const settled = (count: number, last: string) =>
  [
    "let value:integer=1",
    "let u={f1:{n:value}}",
    'u={g:"s"}',
    "let root={f0:{n:value}}",
    ...Array.from({ length: count - 1 }, (_, i) => `root={f${i + 1}:{n:value}}`),
    "if hostOther is integer {",
    ...Array.from({ length: 2 * count }, (_, i) => `let r${i}=root.f${i % count}.n`),
    "}",
    last,
    'say "accepted"',
    "exit",
  ].join("\n");
const copied = (count: number) =>
  [
    "let value:integer=1",
    "let u={f1:{n:value}}",
    'u={g:"s"}',
    ...Array.from({ length: count }, (_, i) => `let root${i}={p:{n:value},q${i}:value}`),
    "let a=root0",
    ...Array.from({ length: count - 1 }, (_, i) => `a=root${i + 1}`),
    "if hostOther is integer {",
    ...Array.from({ length: 2 * count }, (_, i) => `let r${i}=a.p.m${i}`),
    "}",
    "a=hostValue",
    'say "accepted"',
    "exit",
  ].join("\n");
const copiedTwice = (count: number) =>
  [
    "let value:integer=1",
    "let u={f1:{n:value}}",
    'u={g:"s"}',
    "let root={f0:{n:value}}",
    ...Array.from({ length: count - 1 }, (_, i) => `root={f${i + 1}:{n:value}}`),
    "let a=root",
    "a=root",
    "if hostOther is integer {",
    ...Array.from({ length: 2 * count }, (_, i) => `let r${i}=a.f${i % count}.n`),
    "}",
    "a=hostValue",
    'say "accepted"',
    "exit",
  ].join("\n");

const SOURCES: Readonly<Record<string, string>> = {
  "direct-distinct-whole-8": settled(8, "root=hostValue"),
  "copy-every-whole-4": copied(4),
  "direct-distinct-field-4": settled(4, "root.f1=hostValue"),
  "two-whole-copies-five-settled": copiedTwice(5),
};

/** Main's stop state at an allowance: settled, or stopped unsettled in admission. */
type MainState = "settled" | "admission";

/**
 * Main's side per source and held mode: the natural plan's digest; the measured windows, `[kind, lo, hi)`; and at each
 * window's edges (`lo - 1`, `lo`, `hi - 1`, `hi`) main's stop state, `typeCheck` count, plan digest and, in a settled
 * window, runs digest.
 */
const MAIN: Readonly<
  Record<
    string,
    readonly {
      readonly natural: string;
      readonly windows: readonly (readonly [
        "adverse" | "favourable" | "settled",
        number,
        number,
      ])[];
      readonly at: Readonly<Record<number, readonly [MainState, number, string, string | null]>>;
    }[]
  >
> = {
  "direct-distinct-whole-8": [
    {
      natural: "b05268124090db9e",
      windows: [
        ["adverse", 74, 91],
        ["adverse", 94, 106],
        ["adverse", 109, 121],
        ["adverse", 124, 136],
        ["adverse", 139, 151],
        ["adverse", 154, 166],
      ],
      at: {
        73: ["admission", 0, "1cba611a9289e04b", null],
        74: ["settled", 1, "b05268124090db9e", null],
        90: ["settled", 1, "b05268124090db9e", null],
        91: ["admission", 0, "1cba611a9289e04b", null],
        93: ["admission", 0, "1cba611a9289e04b", null],
        94: ["settled", 1, "b05268124090db9e", null],
        105: ["settled", 1, "b05268124090db9e", null],
        106: ["admission", 0, "1cba611a9289e04b", null],
        108: ["admission", 0, "1cba611a9289e04b", null],
        109: ["settled", 1, "b05268124090db9e", null],
        120: ["settled", 1, "b05268124090db9e", null],
        121: ["admission", 0, "1cba611a9289e04b", null],
        123: ["admission", 0, "1cba611a9289e04b", null],
        124: ["settled", 1, "b05268124090db9e", null],
        135: ["settled", 1, "b05268124090db9e", null],
        136: ["admission", 0, "1cba611a9289e04b", null],
        138: ["admission", 0, "1cba611a9289e04b", null],
        139: ["settled", 1, "b05268124090db9e", null],
        150: ["settled", 1, "b05268124090db9e", null],
        151: ["admission", 0, "1cba611a9289e04b", null],
        153: ["admission", 0, "1cba611a9289e04b", null],
        154: ["settled", 1, "b05268124090db9e", null],
        165: ["settled", 1, "b05268124090db9e", null],
        166: ["admission", 0, "1cba611a9289e04b", null],
      },
    },
    { natural: "b05268124090db9e", windows: [], at: {} },
    {
      natural: "b05268124090db9e",
      windows: [
        ["adverse", 74, 91],
        ["adverse", 94, 106],
        ["adverse", 109, 121],
        ["adverse", 201, 276],
      ],
      at: {
        73: ["admission", 0, "1cba611a9289e04b", null],
        74: ["settled", 1, "b05268124090db9e", null],
        90: ["settled", 1, "b05268124090db9e", null],
        91: ["admission", 0, "1cba611a9289e04b", null],
        93: ["admission", 0, "1cba611a9289e04b", null],
        94: ["settled", 1, "b05268124090db9e", null],
        105: ["settled", 1, "b05268124090db9e", null],
        106: ["admission", 0, "1cba611a9289e04b", null],
        108: ["admission", 0, "1cba611a9289e04b", null],
        109: ["settled", 1, "b05268124090db9e", null],
        120: ["settled", 1, "b05268124090db9e", null],
        121: ["admission", 0, "1cba611a9289e04b", null],
        200: ["admission", 0, "1cba611a9289e04b", null],
        201: ["settled", 1, "b05268124090db9e", null],
        275: ["settled", 1, "b05268124090db9e", null],
        276: ["settled", 1, "b05268124090db9e", null],
      },
    },
    { natural: "b05268124090db9e", windows: [], at: {} },
  ],
  "copy-every-whole-4": [
    {
      natural: "56020da3a9c542ae",
      windows: [["adverse", 379, 408]],
      at: {
        378: ["admission", 0, "52ca0a26c47a4735", null],
        379: ["settled", 1, "56020da3a9c542ae", null],
        407: ["settled", 1, "56020da3a9c542ae", null],
        408: ["settled", 1, "56020da3a9c542ae", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      windows: [["favourable", 449, 450]],
      at: {
        448: ["settled", 1, "56020da3a9c542ae", null],
        449: ["admission", 0, "52ca0a26c47a4735", null],
        450: ["admission", 0, "52ca0a26c47a4735", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      windows: [
        ["adverse", 303, 337],
        ["settled", 337, 338],
        ["adverse", 338, 369],
      ],
      at: {
        302: ["admission", 0, "52ca0a26c47a4735", null],
        303: ["settled", 1, "56020da3a9c542ae", null],
        336: ["settled", 1, "56020da3a9c542ae", null],
        337: ["settled", 1, "56020da3a9c542ae", "2cffa010e13585df"],
        338: ["settled", 1, "56020da3a9c542ae", null],
        368: ["settled", 1, "56020da3a9c542ae", null],
        369: ["settled", 1, "56020da3a9c542ae", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      windows: [
        ["adverse", 335, 369],
        ["favourable", 379, 380],
      ],
      at: {
        334: ["admission", 0, "52ca0a26c47a4735", null],
        335: ["settled", 1, "56020da3a9c542ae", null],
        368: ["settled", 1, "56020da3a9c542ae", null],
        369: ["settled", 1, "56020da3a9c542ae", null],
        378: ["settled", 1, "56020da3a9c542ae", null],
        379: ["admission", 0, "52ca0a26c47a4735", null],
        380: ["admission", 0, "52ca0a26c47a4735", null],
      },
    },
  ],
  "direct-distinct-field-4": [
    {
      natural: "012be07dc9275048",
      windows: [
        ["settled", 63, 65],
        ["adverse", 65, 67],
        ["settled", 72, 73],
        ["settled", 74, 75],
        ["settled", 77, 78],
        ["settled", 79, 80],
        ["adverse", 84, 86],
        ["favourable", 92, 94],
        ["adverse", 95, 109],
      ],
      at: {
        62: ["settled", 1, "012be07dc9275048", null],
        63: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        64: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        65: ["settled", 1, "012be07dc9275048", null],
        66: ["settled", 1, "012be07dc9275048", null],
        67: ["settled", 1, "012be07dc9275048", null],
        71: ["settled", 1, "012be07dc9275048", null],
        72: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        73: ["settled", 1, "012be07dc9275048", null],
        74: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        75: ["settled", 1, "012be07dc9275048", null],
        76: ["settled", 1, "012be07dc9275048", null],
        77: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        78: ["settled", 1, "012be07dc9275048", null],
        79: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        80: ["settled", 1, "012be07dc9275048", null],
        83: ["admission", 0, "831851b9fa2b83fa", null],
        84: ["settled", 1, "012be07dc9275048", null],
        85: ["settled", 1, "012be07dc9275048", null],
        86: ["settled", 1, "012be07dc9275048", null],
        91: ["settled", 1, "012be07dc9275048", null],
        92: ["admission", 0, "831851b9fa2b83fa", null],
        93: ["admission", 0, "831851b9fa2b83fa", null],
        94: ["admission", 0, "831851b9fa2b83fa", null],
        95: ["settled", 1, "012be07dc9275048", null],
        108: ["settled", 1, "012be07dc9275048", null],
        109: ["settled", 1, "012be07dc9275048", null],
      },
    },
    { natural: "012be07dc9275048", windows: [], at: {} },
    {
      natural: "012be07dc9275048",
      windows: [
        ["settled", 44, 45],
        ["settled", 46, 47],
        ["settled", 49, 50],
        ["settled", 51, 52],
        ["settled", 59, 63],
        ["adverse", 65, 67],
        ["adverse", 84, 86],
        ["favourable", 92, 94],
        ["adverse", 95, 109],
      ],
      at: {
        43: ["settled", 1, "012be07dc9275048", null],
        44: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        45: ["settled", 1, "012be07dc9275048", null],
        46: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        47: ["settled", 1, "012be07dc9275048", null],
        48: ["settled", 1, "012be07dc9275048", null],
        49: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        50: ["settled", 1, "012be07dc9275048", null],
        51: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        52: ["settled", 1, "012be07dc9275048", null],
        58: ["settled", 1, "012be07dc9275048", null],
        59: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        62: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        63: ["settled", 1, "012be07dc9275048", null],
        64: ["settled", 1, "012be07dc9275048", null],
        65: ["settled", 1, "012be07dc9275048", null],
        66: ["settled", 1, "012be07dc9275048", null],
        67: ["settled", 1, "012be07dc9275048", null],
        83: ["admission", 0, "831851b9fa2b83fa", null],
        84: ["settled", 1, "012be07dc9275048", null],
        85: ["settled", 1, "012be07dc9275048", null],
        86: ["settled", 1, "012be07dc9275048", null],
        91: ["settled", 1, "012be07dc9275048", null],
        92: ["admission", 0, "831851b9fa2b83fa", null],
        93: ["admission", 0, "831851b9fa2b83fa", null],
        94: ["admission", 0, "831851b9fa2b83fa", null],
        95: ["settled", 1, "012be07dc9275048", null],
        108: ["settled", 1, "012be07dc9275048", null],
        109: ["settled", 1, "012be07dc9275048", null],
      },
    },
    {
      natural: "012be07dc9275048",
      windows: [["settled", 44, 53]],
      at: {
        43: ["settled", 1, "012be07dc9275048", null],
        44: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        52: ["settled", 1, "012be07dc9275048", "5f3db1b9a5ebbb15"],
        53: ["admission", 0, "831851b9fa2b83fa", null],
      },
    },
  ],
  "two-whole-copies-five-settled": [
    {
      natural: "e3b7e6883d646348",
      windows: [["favourable", 48, 49]],
      at: {
        47: ["settled", 1, "e3b7e6883d646348", null],
        48: ["admission", 0, "9f0fb9063726c25e", null],
        49: ["admission", 0, "9f0fb9063726c25e", null],
      },
    },
    {
      natural: "e3b7e6883d646348",
      windows: [["adverse", 44, 54]],
      at: {
        43: ["settled", 1, "e3b7e6883d646348", null],
        44: ["settled", 1, "e3b7e6883d646348", null],
        53: ["settled", 1, "e3b7e6883d646348", null],
        54: ["admission", 0, "9f0fb9063726c25e", null],
      },
    },
    {
      natural: "e3b7e6883d646348",
      windows: [
        ["favourable", 68, 70],
        ["adverse", 71, 73],
        ["favourable", 76, 77],
        ["adverse", 334, 341],
      ],
      at: {
        67: ["settled", 1, "e3b7e6883d646348", null],
        68: ["admission", 0, "9f0fb9063726c25e", null],
        69: ["admission", 0, "9f0fb9063726c25e", null],
        70: ["admission", 0, "9f0fb9063726c25e", null],
        71: ["settled", 1, "e3b7e6883d646348", null],
        72: ["settled", 1, "e3b7e6883d646348", null],
        73: ["settled", 1, "e3b7e6883d646348", null],
        75: ["settled", 1, "e3b7e6883d646348", null],
        76: ["admission", 0, "9f0fb9063726c25e", null],
        77: ["admission", 0, "9f0fb9063726c25e", null],
        333: ["admission", 0, "9f0fb9063726c25e", null],
        334: ["settled", 1, "e3b7e6883d646348", null],
        340: ["settled", 1, "e3b7e6883d646348", null],
        341: ["settled", 1, "e3b7e6883d646348", null],
      },
    },
    {
      natural: "e3b7e6883d646348",
      windows: [
        ["adverse", 43, 53],
        ["adverse", 336, 337],
      ],
      at: {
        42: ["admission", 0, "9f0fb9063726c25e", null],
        43: ["settled", 1, "e3b7e6883d646348", null],
        52: ["settled", 1, "e3b7e6883d646348", null],
        53: ["admission", 0, "9f0fb9063726c25e", null],
        335: ["admission", 0, "9f0fb9063726c25e", null],
        336: ["settled", 1, "e3b7e6883d646348", null],
        337: ["settled", 1, "e3b7e6883d646348", null],
      },
    },
  ],
};

const GLOBALS = ["hostValue", "hostOther"];

/** The plan's runs over the stop oracle's host values: what each said, and its runtime failure. */
function runsOf(files: readonly SourceFile[], plan: InstructionPlan): RunResult[] {
  return hostValues(files, GLOBALS).map((globals) => {
    const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
    const failure = result.events.find((event) => event.kind === "runtimeFailure");
    return {
      said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      code: failure?.kind === "runtimeFailure" ? failure.code : null,
      span:
        failure?.kind === "runtimeFailure"
          ? [failure.span.start.offset, failure.span.end.offset]
          : null,
      message: failure?.kind === "runtimeFailure" ? failure.message : null,
    };
  });
}

test("#2116's declared difference under #2080: at every recorded window's edges the head's stop moves only as declared, and outside them its stop state and plan are main's (the owner's decision (B))", () => {
  assert.deepEqual(Object.keys(MAIN).sort(), Object.keys(SOURCES).sort());
  for (const [label, source] of Object.entries(SOURCES)) {
    const files = [{ path: "main.tease", source }];
    MAIN[label]!.forEach((main, mode) => {
      const held = HELD_MODES[mode]!;
      const compiled = (demand: number | null) =>
        held.run(() =>
          demand === null
            ? compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND)
            : withTestDemandAllowance(demand, () =>
                compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND),
              ),
        );
      assert.equal(
        planDigest(compiled(null).plan),
        main.natural,
        `${label} ${held.name}: the natural plan`,
      );
      for (const [at, [mainState, mainChecks, mainPlan, mainRuns]] of Object.entries(main.at)) {
        const demand = Number(at);
        const name = `${label} ${held.name} at ${demand}`;
        const kind = main.windows.find(([, lo, hi]) => demand >= lo && demand < hi)?.[0] ?? "same";
        const { budget } = held.run(() =>
          withTestDemandAllowance(demand, () => analyseCore(coreRequest(files, GLOBALS)!)),
        );
        const { plan } = compiled(demand);
        const state = budget.settled ? "settled" : budget.stoppedIn;
        if (kind === "same") {
          assert.deepEqual([state, planDigest(plan)], [mainState, mainPlan], name);
        } else if (kind === "adverse") {
          assert.equal(mainState, "settled", name);
          assert.equal(state, "admission", name);
          assert.ok(plan !== null, name);
          assert.ok(
            plan.instructions.filter((i) => "typeCheck" in i && i.typeCheck !== undefined).length <
              mainChecks,
            name,
          );
        } else if (kind === "favourable") {
          assert.deepEqual([mainState, state], ["admission", "settled"], name);
        } else {
          assert.deepEqual([mainState, state], ["settled", "settled"], name);
          assert.ok(plan !== null, name);
          assert.deepEqual(
            [planDigest(plan), runsDigest(runsOf(files, plan))],
            [mainPlan, mainRuns],
            name,
          );
        }
      }
    });
  }
});
