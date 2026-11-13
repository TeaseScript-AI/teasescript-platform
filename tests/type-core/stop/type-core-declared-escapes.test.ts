import assert from "node:assert/strict";
import test from "node:test";
import { compileProjectWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { run } from "../../../src/runtime/engine.js";
import {
  createSerializableList,
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withTestDemandAllowance } from "../../../src/type-inference/core/budget.js";
import type { Item } from "../../../src/type-inference/core/items.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import {
  planDigest,
  type RunResult,
  runsDigest,
  textDigest,
} from "../../helpers/type-core/stop/type-core-declared-escapes.js";
import {
  FIRST_ASKER_MAIN,
  MAIN,
} from "../../helpers/type-core/stop/type-core-declared-escapes-main.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";
import { everyAnswer } from "../../helpers/type-core-oracles.js";
import { hostValues } from "../../helpers/type-core-stop-runs.js";

// #2116's declared difference under #2080: the O4 lead's rulings 6 to 21 on #2065's design round. Decision (B) is moot,
// #2080 part 2 (#2227) having landed first; the owner's answer on the one-sided refusal is pending. This file pins known
// escapes and declared differences, not accepted behaviour. At a forced demand allowance the decision index's charges
// can move a stop. Inside each recorded window of a source and held mode, the head:
// - stops unsettled in admission where main settles (`adverse`), and refuses the program for its limit where main
//   publishes (#2080 part 2);
// - settles where main stops unsettled in admission (`favourable`), and publishes where main refuses for its limit;
// - settles stopping every decision main stops and one more (`settled`): the plan and the runs raw-identical
//   (`planDigest`, `runsDigest`), and an occurrence answer surer than main's only where it is the head's natural one.
// At each window's edges outside it, the head's stop state, stopped decisions and plan or refusal are main's. The
// settled class stays declared while the index is charged. The windows are measured over every integer allowance on
// both trees (#2116's sweep); this file reads their edges.
// Inside a window a stopped compile of either tree may differ from the other's in anything two stopped compiles of main
// differ in between two allowances (ruling 18): a check's order and form, and whether the gate refuses the program. For
// two pairs of first-asker sources (#2218's class) the second test holds the head to what holds there on both trees:
// each tree publishes or refuses for its limit, and a published plan runs as the natural plan does, in outcome, code,
// span and output, whether the other tree publishes or refuses. `FIRST_ASKER_MAIN` is main's side for it, recorded at
// 8c8d25853 (`probe42.mjs`, `probe43.mjs`).

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

test("#2116's declared difference under #2080: at every recorded window's edges the head's stop moves only as declared, and outside them its stop state, stopped decisions and plan or refusal are main's (ruling 21)", () => {
  assert.deepEqual(Object.keys(MAIN).sort(), Object.keys(SOURCES).sort());
  for (const [label, source] of Object.entries(SOURCES)) {
    const files = [{ path: "main.tease", source }];
    MAIN[label]!.forEach((main, mode) => {
      const held = HELD_MODES[mode]!;
      // (a plan, or `refused` where the compile is refused for its limit)
      const compiled = (demand: number | null): InstructionPlan | "refused" => {
        try {
          const { plan } = held.run(() =>
            demand === null
              ? compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND)
              : withTestDemandAllowance(demand, () =>
                  compileProjectWithBackend(files, { globals: GLOBALS }, CORE_BACKEND),
                ),
          );
          assert.ok(plan !== null, `${label} ${held.name} at ${demand}: a plan`);
          return plan;
        } catch (error) {
          if (!(error instanceof CandidateOutsideSlice)) throw error;
          assert.ok(
            error.limit,
            `${label} ${held.name} at ${demand}: refused, not for its limit: ${error.what}`,
          );
          return "refused";
        }
      };
      const digestOf = (plan: InstructionPlan | "refused") =>
        plan === "refused" ? plan : planDigest(plan);
      const analysed = (demand: number | null) =>
        held.run(() =>
          demand === null
            ? analyseCore(coreRequest(files, GLOBALS)!)
            : withTestDemandAllowance(demand, () => analyseCore(coreRequest(files, GLOBALS)!)),
        );
      assert.equal(
        digestOf(compiled(null)),
        main.natural,
        `${label} ${held.name}: the natural plan`,
      );
      const natural = answerItems(analysed(null));
      assert.equal(
        textDigest(JSON.stringify(natural)),
        main.naturalAnswers,
        `${label} ${held.name}: the natural answers`,
      );
      for (const [at, [mainState, mainPlan, mainRuns, mainStops, mainAnswers]] of Object.entries(
        main.at,
      )) {
        const demand = Number(at);
        const name = `${label} ${held.name} at ${demand}`;
        const kind = main.windows.find(([, lo, hi]) => demand >= lo && demand < hi)?.[0] ?? "same";
        const answers = analysed(demand);
        const { budget } = answers;
        const plan = compiled(demand);
        const state = budget.settled ? "settled" : budget.stoppedIn;
        const stops = stoppedDecisions(answers);
        if (kind === "same") {
          assert.deepEqual(
            [state, digestOf(plan), textDigest(stops.join("\n"))],
            [mainState, mainPlan, mainStops],
            name,
          );
        } else if (kind === "adverse") {
          assert.deepEqual(
            [mainState, mainPlan === "refused", state, plan],
            ["settled", false, "admission", "refused"],
            `${name}: main settles and publishes, the head stops in admission and refuses for its limit`,
          );
        } else if (kind === "favourable") {
          assert.deepEqual(
            [mainState, mainPlan, state, plan === "refused"],
            ["admission", "refused", "settled", false],
            `${name}: main stops in admission and refuses for its limit, the head settles and publishes`,
          );
        } else {
          assert.deepEqual([mainState, state], ["settled", "settled"], name);
          assert.ok(plan !== "refused", name);
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

/** A host value as the runtime holds it. */
function serial(value: Json): SerializableRuntimeValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return createSerializableList(value.map(serial));
  return createSerializableObject(
    Object.entries(value).map(([name, field]) => ({ name, value: serial(field) })),
  );
}

/** A plan's runs over `FIRST_ASKER_HOSTS`, each as its outcome, code and span, and what it said. */
const firstAskerRuns = (plan: InstructionPlan): string[] =>
  FIRST_ASKER_HOSTS.map((hostValue) => {
    const globals = { hostValue: serial(hostValue), hostOther: false };
    const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
    const failure = result.events.find((event) => event.kind === "runtimeFailure");
    const said = result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
    const ended =
      failure?.kind === "runtimeFailure"
        ? `${result.snapshot.status} ${failure.code} ${failure.span.start.offset}:${failure.span.end.offset}`
        : result.snapshot.status;
    return said.length === 0 ? ended : `${ended} said ${said.join("|")}`;
  });

test("#2116's declared difference inside a window, first-asker sources: each tree publishes or refuses for its limit, and a published plan runs as the natural plan does, in outcome, code, span and output (rulings 18 to 20)", () => {
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
        return error.limit ? "limit" : error.message;
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
        assert.equal(mainSide, "limit", `${name}: main refused for another reason`);
      if (typeof head === "string") {
        assert.equal(head, "limit", `${name}: the head refused for another reason`);
        continue;
      }
      const runs = firstAskerRuns(head);
      // (a published plan passes nothing the natural run rejects, and fails where and as it fails: a check moved to a
      // later instruction fails elsewhere, and a check that halts the script says less, which ruling 20 asks of it
      // whether main publishes here or refuses)
      runs.forEach((ran, host) => {
        const natural = naturalRuns[host]!;
        if (natural.startsWith("failed"))
          assert.ok(
            ran.startsWith("failed"),
            `${name}: host ${host} passes a value the natural run rejects`,
          );
        assert.equal(ran, natural, `${name}: host ${host} runs other than the natural run`);
      });
      if (mainState === "published")
        assert.equal(
          runs.join("; "),
          mainSide,
          `${name}: the runs' outcome, code, span and output`,
        );
    }
  }
});
