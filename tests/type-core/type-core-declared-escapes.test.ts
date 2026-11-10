import assert from "node:assert/strict";
import test from "node:test";
import { compileProjectWithBackend } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import {
  createSerializableList,
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import type { Item } from "../../src/type-inference/core/items.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import {
  planDigest,
  type RunResult,
  runsDigest,
  textDigest,
} from "../helpers/type-core/type-core-declared-escapes.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { everyAnswer } from "../helpers/type-core-oracles.js";
import { hostValues } from "../helpers/type-core-stop-oracle.js";

// #2116's declared difference under #2080: the owner's decision (B), the O4 lead's rulings 6 to 10 on #2065's design
// round. This file pins known escapes and declared differences, not accepted behaviour. At a forced demand allowance the
// decision index's charges can move a stop. Inside each recorded window of a source and held mode, the head:
// - stops unsettled in admission where main settles (`adverse`): #2080's fail-open path, a store's check lost;
// - settles where main stops unsettled in admission (`favourable`): the check restored;
// - settles stopping every decision main stops and one more (`settled`): the plan and the runs raw-identical
//   (`planDigest`, `runsDigest`), and an occurrence answer surer than main's only where it is the head's natural one.
// At each window's edges outside it, the head's stop state, stopped decisions and plan are main's. #2080's unsettled side
// closes the adverse windows; the settled class stays declared while the index is charged. The windows are measured over
// every integer allowance on both trees (#2116's sweep); this file reads their edges.
// `MAIN` is main's side: recorded at 664f1183f by lane 2b's recorder (`probe33.mjs` in #2116's evidence), per source and
// mode, the natural plan's and answers' digests and, at each edge, main's stop state, its `typeCheck` count, its plan's
// digest, its stopped decisions (a digest outside a window, the list inside a settled one) and, in a settled window, its
// runs' digest over the stop oracle's host values and its answers that differ from the natural ones. A change that
// moves a recorded value re-records it with its ground here: the source, mode and allowance that moved, how, and the
// change that moved it (docs/TESTING.md, "Pinned work").
// - 664f1183f, every value re-recorded: #2216 lists a completion's check by its store's own records, so the plan and
//   runs digests are raw, no longer with properties sorted and the named property masked (ruling 12 (5)). Every edge's
//   stop state, `typeCheck` count, stopped decisions and answers, every window and the natural answers equal the record
//   at efbd7fdee, made before #2203's gate.
// Inside a window a stopped compile of either tree may differ from the other's in anything two stopped compiles of main
// differ in between two allowances (ruling 18): a check's order and form, and whether the gate refuses the program. For
// two pairs of first-asker sources (#2218's class) the second test holds the head to what holds there on both trees:
// each tree publishes or refuses for its limit, a published plan passes nothing the natural run rejects, and where both
// publish the runs agree in outcome, code and span. `FIRST_ASKER_MAIN` is main's side for it, recorded at 5a1461a1c
// (`probe42.mjs`, `probe43.mjs`).

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
 * Main's side per source and held mode: the natural plan's digest and the natural answers' digest; the measured windows,
 * `[kind, lo, hi)`; and at each window's edges (`lo - 1`, `lo`, `hi - 1`, `hi`) main's stop state, `typeCheck` count and
 * plan digest; outside a window, the digest of its stopped decisions (`place|path`, sorted); in a settled window, its runs
 * digest, its stopped decisions and each occurrence answer that differs from the natural one (`index=tag:cert:reasons`).
 */
const MAIN: Readonly<
  Record<
    string,
    readonly {
      readonly natural: string;
      readonly naturalAnswers: string;
      readonly windows: readonly (readonly [
        "adverse" | "favourable" | "settled",
        number,
        number,
      ])[];
      readonly at: Readonly<
        Record<
          number,
          readonly [
            MainState,
            number,
            string,
            string | null,
            string | readonly string[] | null,
            string | null,
          ]
        >
      >;
    }[]
  >
> = {
  "direct-distinct-whole-8": [
    {
      natural: "800ba00b6c777d1d",
      naturalAnswers: "a3549cf84d6f2af8",
      windows: [
        ["adverse", 74, 91],
        ["adverse", 94, 106],
        ["adverse", 109, 121],
        ["adverse", 124, 136],
        ["adverse", 139, 151],
        ["adverse", 154, 166],
      ],
      at: {
        73: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        74: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        90: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        91: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        93: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        94: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        105: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        106: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        108: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        109: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        120: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        121: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        123: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        124: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        135: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        136: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        138: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        139: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        150: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        151: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        153: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        154: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        165: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        166: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
      },
    },
    { natural: "800ba00b6c777d1d", naturalAnswers: "a3549cf84d6f2af8", windows: [], at: {} },
    {
      natural: "800ba00b6c777d1d",
      naturalAnswers: "a3549cf84d6f2af8",
      windows: [
        ["adverse", 74, 91],
        ["adverse", 94, 106],
        ["adverse", 109, 121],
        ["adverse", 201, 276],
      ],
      at: {
        73: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        74: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        90: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        91: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        93: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        94: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        105: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        106: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        108: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        109: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        120: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        121: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        200: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        201: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        275: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        276: ["settled", 1, "800ba00b6c777d1d", null, "e3b0c44298fc1c14", null],
      },
    },
    { natural: "800ba00b6c777d1d", naturalAnswers: "a3549cf84d6f2af8", windows: [], at: {} },
  ],
  "copy-every-whole-4": [
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [["adverse", 379, 408]],
      at: {
        378: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
        379: ["settled", 1, "56020da3a9c542ae", null, null, null],
        407: ["settled", 1, "56020da3a9c542ae", null, null, null],
        408: ["settled", 1, "56020da3a9c542ae", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [["favourable", 449, 450]],
      at: {
        448: ["settled", 1, "56020da3a9c542ae", null, "0171c85b4d4cad86", null],
        449: ["admission", 0, "52ca0a26c47a4735", null, null, null],
        450: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [
        ["adverse", 303, 337],
        ["settled", 337, 338],
        ["adverse", 338, 369],
      ],
      at: {
        302: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
        303: ["settled", 1, "56020da3a9c542ae", null, null, null],
        336: ["settled", 1, "56020da3a9c542ae", null, null, null],
        337: ["settled", 1, "56020da3a9c542ae", "1bbef63e9f21c6c0", [], ""],
        338: ["settled", 1, "56020da3a9c542ae", null, null, null],
        368: ["settled", 1, "56020da3a9c542ae", null, null, null],
        369: ["settled", 1, "56020da3a9c542ae", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [
        ["adverse", 335, 369],
        ["favourable", 379, 380],
      ],
      at: {
        334: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
        335: ["settled", 1, "56020da3a9c542ae", null, null, null],
        368: ["settled", 1, "56020da3a9c542ae", null, null, null],
        369: ["settled", 1, "56020da3a9c542ae", null, "0171c85b4d4cad86", null],
        378: ["settled", 1, "56020da3a9c542ae", null, "0171c85b4d4cad86", null],
        379: ["admission", 0, "52ca0a26c47a4735", null, null, null],
        380: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
      },
    },
  ],
  "direct-distinct-field-4": [
    {
      natural: "012be07dc9275048",
      naturalAnswers: "7427e01266df74fe",
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
        62: ["settled", 1, "012be07dc9275048", null, "b16928a7c7325332", null],
        63: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "39|",
            "47|",
            "51|",
            "63|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        64: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "47|",
            "51|",
            "63|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        65: ["settled", 1, "012be07dc9275048", null, null, null],
        66: ["settled", 1, "012be07dc9275048", null, null, null],
        67: ["settled", 1, "012be07dc9275048", null, "dc977104d4c2cbc5", null],
        71: ["settled", 1, "012be07dc9275048", null, "dc977104d4c2cbc5", null],
        72: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "47|",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        73: ["settled", 1, "012be07dc9275048", null, "05eccc36100636d6", null],
        74: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        75: ["settled", 1, "012be07dc9275048", null, "a5520c5577baef31", null],
        76: ["settled", 1, "012be07dc9275048", null, "a5520c5577baef31", null],
        77: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        78: ["settled", 1, "012be07dc9275048", null, "5108870af1245c70", null],
        79: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          ["18|f1", "18|f1.n", "18|f2", "18|f2.n", "18|f3", "18|f3.n", "9|f1", "9|f1.n", "9|g"],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        80: ["settled", 1, "012be07dc9275048", null, "eb16d6079f46fb9f", null],
        83: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        84: ["settled", 1, "012be07dc9275048", null, null, null],
        85: ["settled", 1, "012be07dc9275048", null, null, null],
        86: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        91: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        92: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        93: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        94: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        95: ["settled", 1, "012be07dc9275048", null, null, null],
        108: ["settled", 1, "012be07dc9275048", null, null, null],
        109: ["settled", 1, "012be07dc9275048", null, "a2c2a4307be628df", null],
      },
    },
    { natural: "012be07dc9275048", naturalAnswers: "7427e01266df74fe", windows: [], at: {} },
    {
      natural: "012be07dc9275048",
      naturalAnswers: "7427e01266df74fe",
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
        43: ["settled", 1, "012be07dc9275048", null, "7324ffe6f219521c", null],
        44: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "47|",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        45: ["settled", 1, "012be07dc9275048", null, "8d48a2d1794dd883", null],
        46: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        47: ["settled", 1, "012be07dc9275048", null, "5c93115f87996d1d", null],
        48: ["settled", 1, "012be07dc9275048", null, "5c93115f87996d1d", null],
        49: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        50: ["settled", 1, "012be07dc9275048", null, "d2c9db517c57f840", null],
        51: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        52: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        58: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        59: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        62: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        63: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        64: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        65: ["settled", 1, "012be07dc9275048", null, null, null],
        66: ["settled", 1, "012be07dc9275048", null, null, null],
        67: ["settled", 1, "012be07dc9275048", null, "eb16d6079f46fb9f", null],
        83: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        84: ["settled", 1, "012be07dc9275048", null, null, null],
        85: ["settled", 1, "012be07dc9275048", null, null, null],
        86: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        91: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        92: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        93: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        94: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        95: ["settled", 1, "012be07dc9275048", null, null, null],
        108: ["settled", 1, "012be07dc9275048", null, null, null],
        109: ["settled", 1, "012be07dc9275048", null, "a2c2a4307be628df", null],
      },
    },
    {
      natural: "012be07dc9275048",
      naturalAnswers: "7427e01266df74fe",
      windows: [["settled", 44, 53]],
      at: {
        43: ["settled", 1, "012be07dc9275048", null, "7324ffe6f219521c", null],
        44: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "63|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        52: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        53: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
      },
    },
  ],
  "two-whole-copies-five-settled": [
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [["favourable", 48, 49]],
      at: {
        47: ["settled", 1, "656e979f7285fa0e", null, "4cb63cdff2f4eda3", null],
        48: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        49: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [["adverse", 44, 54]],
      at: {
        43: ["settled", 1, "656e979f7285fa0e", null, "4cb63cdff2f4eda3", null],
        44: ["settled", 1, "656e979f7285fa0e", null, null, null],
        53: ["settled", 1, "656e979f7285fa0e", null, null, null],
        54: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [
        ["favourable", 68, 70],
        ["adverse", 71, 73],
        ["favourable", 76, 77],
        ["adverse", 334, 341],
      ],
      at: {
        67: ["settled", 1, "656e979f7285fa0e", null, "4cb63cdff2f4eda3", null],
        68: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        69: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        70: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        71: ["settled", 1, "656e979f7285fa0e", null, null, null],
        72: ["settled", 1, "656e979f7285fa0e", null, null, null],
        73: ["settled", 1, "656e979f7285fa0e", null, "d746ce95202cf0a7", null],
        75: ["settled", 1, "656e979f7285fa0e", null, "d746ce95202cf0a7", null],
        76: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        77: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        333: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        334: ["settled", 1, "656e979f7285fa0e", null, null, null],
        340: ["settled", 1, "656e979f7285fa0e", null, null, null],
        341: ["settled", 1, "656e979f7285fa0e", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [
        ["adverse", 43, 53],
        ["adverse", 336, 337],
      ],
      at: {
        42: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        43: ["settled", 1, "656e979f7285fa0e", null, null, null],
        52: ["settled", 1, "656e979f7285fa0e", null, null, null],
        53: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        335: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        336: ["settled", 1, "656e979f7285fa0e", null, null, null],
        337: ["settled", 1, "656e979f7285fa0e", null, "e3b0c44298fc1c14", null],
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

/** An analysis's stopped decisions, each as `place|path`, sorted. */
const stoppedDecisions = (answers: Answers): string[] =>
  [
    ...new Set(
      answers.budget.decisions
        .filter((d) => d.stopped)
        .map((d) => `${d.place}|${d.path.join(".")}`),
    ),
  ].sort();

/** Each occurrence's answer items in their order, as `tag:cert:reasons` joined by commas (`everyAnswer`'s). */
function answerItems(answers: Answers): string[] {
  // (`allAnswers` in `tests/helpers/type-core-oracles.ts` writes `{ outcome, diagnostics, checks, occurrences }`)
  // EVIDENCE: `everyAnswer`'s each occurrence is `[offset, route, place, obligations, items]` (`allAnswers`).
  const { occurrences } = JSON.parse(everyAnswer(answers)) as {
    occurrences: [unknown, unknown, unknown, unknown, Item[]][];
  };
  return occurrences.map((occurrence) =>
    occurrence[4].map((item) => `${item.tag}:${item.cert}:${item.reasons}`).join(","),
  );
}

/**
 * Whether `head`'s items at an occurrence say no more than `main`'s: an unknown for the budget (the stop's own answer), or
 * every kind main gives with no surer certainty.
 */
function noStronger(head: string, main: string): boolean {
  if (head === "unknown:pos:16") return true;
  const parse = (text: string) =>
    text === ""
      ? []
      : text.split(",").map((item) => {
          const [tag = "", cert = ""] = item.split(":");
          return { tag, cert };
        });
  const theirs = parse(head);
  return parse(main).every(({ tag, cert }) =>
    theirs.some((item) => item.tag === tag && (item.cert === "pos" || cert === "def")),
  );
}

test("#2116's declared difference under #2080: at every recorded window's edges the head's stop moves only as declared, and outside them its stop state, stopped decisions and plan are main's (the owner's decision (B))", () => {
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
      const analysed = (demand: number | null) =>
        held.run(() =>
          demand === null
            ? analyseCore(coreRequest(files, GLOBALS)!)
            : withTestDemandAllowance(demand, () => analyseCore(coreRequest(files, GLOBALS)!)),
        );
      assert.equal(
        planDigest(compiled(null).plan),
        main.natural,
        `${label} ${held.name}: the natural plan`,
      );
      const natural = answerItems(analysed(null));
      assert.equal(
        textDigest(JSON.stringify(natural)),
        main.naturalAnswers,
        `${label} ${held.name}: the natural answers`,
      );
      for (const [
        at,
        [mainState, mainChecks, mainPlan, mainRuns, mainStops, mainAnswers],
      ] of Object.entries(main.at)) {
        const demand = Number(at);
        const name = `${label} ${held.name} at ${demand}`;
        const kind = main.windows.find(([, lo, hi]) => demand >= lo && demand < hi)?.[0] ?? "same";
        const answers = analysed(demand);
        const { budget } = answers;
        const { plan } = compiled(demand);
        const state = budget.settled ? "settled" : budget.stoppedIn;
        const stops = stoppedDecisions(answers);
        if (kind === "same") {
          assert.deepEqual(
            [state, planDigest(plan), textDigest(stops.join("\n"))],
            [mainState, mainPlan, mainStops],
            name,
          );
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
          // (the head stops every decision main stops and one more: a settled head-only stop)
          assert.ok(Array.isArray(mainStops), `${name}: main's recorded stopped decisions`);
          const recorded: readonly string[] = mainStops;
          assert.ok(
            recorded.every((key) => stops.includes(key)) && stops.length > recorded.length,
            `${name}: the head's stopped decisions ${stops.join(" ")} hold main's ${recorded.join(" ")} and more`,
          );
          // (an answer surer than main's at an occurrence is the head's natural one)
          const mains = [...natural];
          for (const entry of (mainAnswers ?? "").split(" ").filter((e) => e !== "")) {
            const sign = entry.indexOf("=");
            mains[Number(entry.slice(0, sign))] = entry.slice(sign + 1);
          }
          answerItems(answers).forEach((head, index) => {
            if (head === mains[index] || noStronger(head, mains[index]!)) return;
            assert.equal(head, natural[index], `${name}: occurrence ${index}, surer than main's`);
          });
        }
      }
    });
  }
});

/**
 * Sol re-check 3's first-asker source on #2116 (#2218's class), `root`'s whole stores in `order`, and a variant whose last
 * store holds the host value one level down. Between them they show inside a window what two stopped compiles of main
 * show between two of its allowances: another order and form of a store's check, and a program refused on one tree and
 * compiled on the other. With `f1` stored last, `root` holds `f1` at the last store, so a value that fits succeeds.
 */
const firstAsker = (last: string, order: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8]) =>
  [
    "let value:integer=1",
    "let u={f1:{n:value}}",
    'u={g:"s"}',
    "let root={f0:{n:{a:value,b:value}}}",
    ...order.map((i) => `root={f${i}:{n:{a:value,b:value}}}`),
    "if hostOther is integer {",
    ...Array.from({ length: 18 }, (_, i) => `let r${i}=root.f${i % 9}.n.a`),
    "root.f1={n:{a:hostValue,b:hostValue}}",
    "}",
    last,
    'say "accepted"',
    "exit",
  ].join("\n");
const F1_LAST = [2, 3, 4, 5, 6, 7, 8, 1];
const FIRST_ASKER_SOURCES: Readonly<Record<string, string>> = {
  "first-asker-field-9": firstAsker("root.f1={n:{b:hostValue,a:hostValue}}"),
  "first-asker-field-9-n-host": firstAsker("root.f1={n:hostValue}"),
  "first-asker-field-9-f1-last": firstAsker("root.f1={n:{b:hostValue,a:hostValue}}", F1_LAST),
  "first-asker-field-9-f1-last-n-host": firstAsker("root.f1={n:hostValue}", F1_LAST),
};

/** A host value as JSON writes it. */
type Json = number | string | null | readonly Json[] | { readonly [name: string]: Json };

/** The host values the first-asker sources run with: a non-object at each level of `root.f1`, and leaves that do not fit. */
const FIRST_ASKER_HOSTS: readonly Json[] = [
  1,
  "s",
  null,
  [1],
  {},
  { n: 1 },
  { n: null },
  { n: [1] },
  { n: {} },
  { n: { a: "s", b: 1 } },
  { n: { a: 1, b: "s" } },
  { n: { a: 1, b: 1 } },
  { a: 1, b: 1 },
  { a: "s", b: 1 },
  "bad",
];

/**
 * The reason a settled stop's compile is refused for, its limit (#2203's gate), by its text: main marks no refusal as a
 * limit's yet, and #2227 is the marker's issue.
 */
const LIMIT = "a store whose check was lost at the budget";

/**
 * Main's side of the first-asker sources, each in its held mode: the natural plan's runs and, at each allowance of its
 * window (298 to 303 in mode 2, 243 to 250 with `f1` last, in mode 3) where both trees settle, whether main publishes,
 * with its runs, or refuses, with its reason. Each run is its outcome, code and span (`status code start:end`), over
 * `FIRST_ASKER_HOSTS`. Recorded at 5a1461a1c by lane 2b's recorders (`probe42.mjs`, `probe43.mjs` in #2116's evidence);
 * it is re-recorded as the file header says. Every natural run of the first two fails (a value that fits meets TSR017:
 * `root` holds no `f1` at the last store), so only the `f1`-last pair can show a published plan passing what the natural
 * run rejects.
 */
const FIRST_ASKER_MAIN: Readonly<
  Record<
    string,
    {
      readonly mode: number;
      readonly natural: string;
      readonly at: Readonly<Record<number, readonly ["published" | "refused", string]>>;
    }
  >
> = {
  "first-asker-field-9": {
    mode: 2,
    natural:
      "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
    at: {
      299: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      300: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      301: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      302: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      303: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
    },
  },
  "first-asker-field-9-n-host": {
    mode: 2,
    natural:
      "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
    at: {
      299: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      300: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      301: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      302: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      303: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
    },
  },
  "first-asker-field-9-f1-last": {
    mode: 3,
    natural:
      "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
    at: {
      244: [
        "published",
        "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      245: [
        "published",
        "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      246: [
        "published",
        "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      247: [
        "published",
        "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      248: [
        "published",
        "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      249: [
        "published",
        "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      250: [
        "published",
        "halted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
    },
  },
  "first-asker-field-9-f1-last-n-host": {
    mode: 3,
    natural:
      "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; halted; halted; halted; halted; halted; halted; halted; halted; halted; failed TSR058 767:780; failed TSR058 767:780",
    at: {
      244: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      245: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      246: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      247: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      248: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      249: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      250: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; halted; halted; halted; halted; halted; halted; halted; halted; halted; failed TSR058 767:780; failed TSR058 767:780",
      ],
    },
  },
};

/** A host value as the runtime holds it. */
function serial(value: Json): SerializableRuntimeValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return createSerializableList(value.map(serial));
  return createSerializableObject(
    Object.entries(value).map(([name, field]) => ({ name, value: serial(field) })),
  );
}

/** A plan's runs over `FIRST_ASKER_HOSTS`, each as its outcome, code and span. */
const firstAskerRuns = (plan: InstructionPlan): string[] =>
  FIRST_ASKER_HOSTS.map((hostValue) => {
    const globals = { hostValue: serial(hostValue), hostOther: false };
    const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
    const failure = result.events.find((event) => event.kind === "runtimeFailure");
    return failure?.kind === "runtimeFailure"
      ? `${result.snapshot.status} ${failure.code} ${failure.span.start.offset}:${failure.span.end.offset}`
      : result.snapshot.status;
  });

test("#2116's declared difference inside a window, first-asker sources: each tree publishes or refuses for its limit, and where both publish the runs agree in outcome, code and span and pass nothing the natural run rejects (rulings 18 and 19)", () => {
  assert.deepEqual(Object.keys(FIRST_ASKER_MAIN).sort(), Object.keys(FIRST_ASKER_SOURCES).sort());
  for (const [label, source] of Object.entries(FIRST_ASKER_SOURCES)) {
    const files = [{ path: "main.tease", source }];
    const main = FIRST_ASKER_MAIN[label]!;
    const held = HELD_MODES[main.mode]!;
    const compiled = (demand: number | null): InstructionPlan | string => {
      try {
        const { plan } = held.run(() =>
          demand === null
            ? compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND)
            : withTestDemandAllowance(demand, () =>
                compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND),
              ),
        );
        assert.ok(plan !== null, `${label} at ${demand}: a plan`);
        return plan;
      } catch (error) {
        if (!(error instanceof CandidateOutsideSlice)) throw error;
        return error.message;
      }
    };
    const natural = compiled(null);
    assert.ok(typeof natural !== "string", `${label}: the natural compile publishes`);
    const naturalRuns = firstAskerRuns(natural);
    assert.equal(naturalRuns.join("; "), main.natural, `${label}: the natural runs`);
    for (const [at, [mainState, mainSide]] of Object.entries(main.at)) {
      const demand = Number(at);
      const name = `${label} ${held.name} at ${demand}`;
      assert.equal(
        held.run(() =>
          withTestDemandAllowance(demand, () => analyseCore(coreRequest(files, GLOBALS)!)),
        ).budget.settled,
        true,
        `${name}: settled`,
      );
      const head = compiled(demand);
      // (each tree publishes, or refuses for its limit)
      if (mainState === "refused")
        assert.ok(mainSide.includes(LIMIT), `${name}: main refused for another reason`);
      if (typeof head === "string") {
        assert.ok(head.includes(LIMIT), `${name}: the head refused for another reason`);
        continue;
      }
      const runs = firstAskerRuns(head);
      // (a published plan passes nothing the natural run rejects)
      runs.forEach((ran, host) => {
        if (naturalRuns[host]!.startsWith("failed"))
          assert.ok(
            ran.startsWith("failed"),
            `${name}: host ${host} passes a value the natural run rejects`,
          );
      });
      if (mainState === "published")
        assert.equal(runs.join("; "), mainSide, `${name}: the runs' outcome, code and span`);
    }
  }
});
