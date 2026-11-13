// Durations, unit expressions and angles on the candidate route (#2657, step 2d of #2488): a literal the plan stores
// publishes, any other is refused at the literal; a unit's or an angle's amount publishes where it holds only numbers and
// today's checker knows no value of it that it refuses, and is refused at the unit or the angle otherwise.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../../src/compiler.js";
import {
  CandidateOutsideSlice,
  CORE_BACKEND,
  UNIT_AMOUNT,
} from "../../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../../src/type-inference/core/budget.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";
import {
  checkKey,
  type DifferentialRecord,
  errorsOf,
  outcome,
  records,
  script,
} from "../../helpers/type-core/row-guard-records.js";

/*
 * Each source is compiled by today's checker and by the route in the four held modes (`differential.mjs`, with the host
 * global at every value of the derived domain and the host values below) and judged alike: where today's checker plans,
 * the route plans in every mode with today's checks and today's runs, but at a source `UNDER_OFFERS` names, which it
 * refuses there; where today's checker gives no plan, the route gives none either, refusing at the text the source
 * names or answering with today's errors. Every refusal is one text in all four modes.
 */

/** The host values a source runs with beside the domain: a duration, a calendar duration, an angle, a huge number. */
const HOSTS = [
  { kind: "duration", milliseconds: 2000 },
  { kind: "calendarDuration", months: 1, days: 0, milliseconds: 0 },
  { kind: "angle", degrees: 90 },
  1e308,
];

/** A source and the refusal the route makes where today's checker gives no plan (`null`: today's errors). */
interface Case {
  readonly source: string;
  readonly refusal: string | null;
}

const UNIT = "this unit expression";
const ANGLE = "this angle expression";
const LITERAL = "this duration literal";

/** The units after an amount: exact, calendar of days and of months, an angle in degrees and in radians. */
const UNITS: readonly (readonly [string, string])[] = [
  ["s", UNIT],
  ["calendar days", UNIT],
  ["calendar months", UNIT],
  ["deg", ANGLE],
  ["rad", ANGLE],
];

/**
 * The amounts before a unit (prelude, amount): numbers written in place, known through a variable or not, the host
 * global, typed ingresses, and values of other kinds, by each origin the slice holds.
 */
const AMOUNTS: readonly (readonly [string, string])[] = [
  ["", "(2)"],
  ["", "(1.5)"],
  ["", "(1e300)"],
  ["", "hostValue"],
  ["let n = 2\n", "n"],
  ["let n = 1.5\n", "n"],
  ["let n = 1e300\n", "n"],
  ["let n = 2\nn = 1.5\n", "n"],
  ['let n = "a"\n', "n"],
  ["let n = true\n", "n"],
  ["let n = null\n", "n"],
  ["let n = 2 s\n", "n"],
  ["let n = [1]\n", "n"],
  ["let n: integer = hostValue\n", "n"],
  ["let n: number = hostValue\n", "n"],
  ["let n: string = hostValue\n", "n"],
  ["let n: integer? = hostValue\n", "n"],
  ["let n: duration = hostValue\n", "n"],
  ["let n = hostValue\n", "n"],
  ["let x: integer? = hostValue\n", "(x otherwise 1)"],
  ["let xs = [2]\n", "xs[0]"],
  ['let xs = ["a"]\n', "xs[0]"],
  ["let o = {v: 2}\n", "o.v"],
  ["", "[2].get(0, default: 1)"],
  ["", "[1][4]"],
  ["let m: integer = hostValue\n", "[m][0]"],
  ["let m: string = hostValue\n", "[m][0]"],
  ['let v = fromJson(hostValue, default: "a")\n', "v"],
  ['let o = {v: hostValue}\no.v = "a"\n', "o.v"],
];

/** A unit or an angle after each amount, stored and then passed over. */
const AMOUNT_CASES: readonly Case[] = AMOUNTS.flatMap(([prelude, amount]) =>
  UNITS.map(([unit, refusal]) => ({
    source: `${prelude}let d = ${amount} ${unit}\nsay "AFTER"`,
    refusal,
  })),
);

/** Each literal form: exact units with whole, fractional and zero amounts, calendar units of each size, angles. */
const LITERAL_CASES: readonly Case[] = [
  ...["ms", "s", "min", "h", "d", "w", "seconds", "minutes"].flatMap((unit) =>
    ["2", "1.5", "0"].map((amount) => `${amount} ${unit}`),
  ),
  ...["days", "weeks", "months", "years"].flatMap((unit) =>
    ["1", "0.5", "1.5", "0.1", "1e300", "9007199254740993"].map(
      (amount) => `${amount} calendar ${unit}`,
    ),
  ),
  "1e308 w",
  "90 deg",
  "1.5 rad",
  "1e308 rad",
].map((literal) => ({
  source: `let d = ${literal}\nsay "AFTER"`,
  refusal: literal.endsWith("deg") || literal.endsWith("rad") ? ANGLE : LITERAL,
}));

/** An `integer?` read under each form of null test that leaves it a number, as the amount of a unit. */
const NARROWED: readonly string[] = [
  "let n: integer? = hostValue\nif n != null {\n  let d = n s\n  wait d\n}",
  "let n: integer? = hostValue\nif null != n {\n  let d = n s\n  wait d\n}",
  "let n: integer? = hostValue\nif n == null {\n  exit\n}\nlet d = n s",
  'let n: integer? = hostValue\nif n == null {\n  say "none"\n} else {\n  let d = n s\n}',
];

/** A duration or an angle where the slice uses one: a command's operand, a typed store, a collection, a default. */
const PLACE_CASES: readonly Case[] = [
  "wait 2 s",
  "let n = 2\nwait n s",
  'showButton "Go", timeout: 2 s',
  'say "a", 2 s',
  'let n = 2\nsay "a", n ms',
  "let d: duration = 2 s\nwait d",
  "let d: duration = 1 calendar month",
  "let c: calendarDuration = 2 s",
  "let a: angle = 90 deg",
  "let n: integer = 2 s",
  "let xs = [1 s, 2 s]\nfor x in xs {\n  wait x\n}",
  "let o = {t: 2 s}\nwait o.t",
  "let d: duration? = hostValue\nwait d otherwise 2 s",
  'let d: duration = load "k", default: 2 s\nwait d',
  "let t = toJson(2 s)",
  "let d = 1 s\nd = 2 s\nwait d",
  "let n = 2\nif hostValue == null {\n  n = 1.5\n}\nlet c = n calendar months",
  ...NARROWED,
  // (no duration, unit or angle: the refusal's own walk of known values leaves the checks' work as it was)
  'let a = ("x".repeat(9999995))\nlet b = "abcdefghij".substring(50)',
  'let a = ("x".repeat(9999995))\nlet b = ["abcdefghij"].get(0, default: "").substring(50)',
].map((source) => ({ source: `${source}\nsay "AFTER"`, refusal: null }));

/**
 * The sources today's checker plans and the route refuses (an under-offer), sampled by class: an amount whose item is
 * the outside value a typed ingress's check stands for, where only what carries it shows a number to today's checker
 * (an element read, `otherwise`), or only a narrowing does (an `integer?` or `number?` read under a null test), which
 * the core gives no read (`amountAdmitted`); and an amount the core knows
 * may hold a value of no number where today's checker reads it as unknown (a `fromJson` with a default of no number, a
 * property stored such a value later).
 */
const UNDER_OFFERS: ReadonlySet<string> = new Set([
  ...UNITS.flatMap(([unit]) =>
    [
      `let m: integer = hostValue\nlet d = [m][0] ${unit}`,
      `let x: integer? = hostValue\nlet d = (x otherwise 1) ${unit}`,
      `let v = fromJson(hostValue, default: "a")\nlet d = v ${unit}`,
      `let o = {v: hostValue}\no.v = "a"\nlet d = o.v ${unit}`,
    ].map((source) => `${source}\nsay "AFTER"`),
  ),
  ...NARROWED.map((source) => `${source}\nsay "AFTER"`),
]);

/** The judge's failures for one case's record. */
function judge(sample: Case, record: DifferentialRecord, refusals: Set<string>): string[] {
  const failures: string[] = [];
  const { checker } = record;
  for (const mode of record.candidate.modes) {
    const at = `${JSON.stringify(sample.source)} [${mode.mode}]`;
    if (mode.threw !== undefined) {
      failures.push(`${at}: the route throws ${mode.threw}`);
      continue;
    }
    if (mode.outside !== undefined) refusals.add(`${sample.source}\n${mode.outside}`);
    if (UNDER_OFFERS.has(sample.source)) {
      if (mode.outside !== UNIT && mode.outside !== ANGLE)
        failures.push(
          `${at}: an under-offer ${mode.outside ?? "publishes"}, not refused at its unit`,
        );
      continue;
    }
    if (checker.plan) {
      if (!mode.plan) {
        failures.push(`${at}: today a plan, the route ${mode.outside ?? errorsOf(mode).join(" ")}`);
        continue;
      }
      const carried = new Set(mode.plan.checks.map(checkKey));
      for (const check of checker.plan.checks.map(checkKey))
        if (!carried.has(check)) failures.push(`${at}: today's check missing: ${check}`);
      const [runs, todays] = [(mode.runs ?? []).map(outcome), (checker.runs ?? []).map(outcome)];
      if (JSON.stringify(runs) !== JSON.stringify(todays))
        failures.push(`${at}: runs ${runs.join(", ")}, today ${todays.join(", ")}`);
      continue;
    }
    if (mode.plan) failures.push(`${at}: the route plans where today gives no plan`);
    else if (mode.outside !== undefined) {
      if (mode.outside !== sample.refusal)
        failures.push(`${at}: refused "${mode.outside}", not "${sample.refusal}"`);
    } else if (JSON.stringify(errorsOf(mode)) !== JSON.stringify(errorsOf(checker)))
      failures.push(
        `${at}: errors ${errorsOf(mode).join(" ")}, today ${errorsOf(checker).join(" ")}`,
      );
  }
  return failures;
}

test("each duration literal, unit and angle publishes as today's where today plans, and is refused or answered as today's where today gives no plan", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "durations-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const cases = [...LITERAL_CASES, ...AMOUNT_CASES, ...PLACE_CASES];
  const found = records(
    cases.map((sample, at) => ({ name: `${at}`, source: script(sample.source), hosts: HOSTS })),
    folder,
  );
  const refusals = new Set<string>();
  const failures = cases.flatMap((sample, at) => judge(sample, found[at]!, refusals));
  assert.deepEqual(failures, []);
  // each under-offer occurs, with today's plan beside it
  for (const source of UNDER_OFFERS) {
    const at = cases.findIndex((sample) => sample.source === source);
    assert.ok(at >= 0 && found[at]!.checker.plan, source);
    assert.ok(refusals.has(`${source}\n${UNIT}`) || refusals.has(`${source}\n${ANGLE}`), source);
  }
  // the family reaches each refusal, and the published forms (not a family that only refuses)
  for (const text of [UNIT, ANGLE, LITERAL])
    assert.ok(
      [...refusals].some((refusal) => refusal.endsWith(`\n${text}`)),
      text,
    );
  assert.ok(
    found.filter((record) => record.candidate.modes.every((mode) => mode.plan)).length > 40,
  );
});

/** The analysis without a stop, stopped by the program's allowance, and stopped by a demand's. */
const STOPS: Readonly<Record<string, <T>(make: () => T) => T>> = {
  none: (make) => make(),
  program: (make) => withTestAllowance(1, make),
  demand: (make) => withTestDemandAllowance(1, make),
};

test("under a stop as without one, an amount of no number never publishes, nor a number's where today's checker gives no plan", () => {
  const amounts = [
    ['let n = "a"\n', "n", false],
    ["let n = 2\n", "n", true],
    ["let n = 1.5\n", "n", true],
    ["", "hostValue", true],
  ] as const;
  for (const [prelude, amount, number] of amounts)
    for (const [unit] of UNITS) {
      const files = [
        { path: "main.tease", source: script(`${prelude}let d = ${amount} ${unit}\nsay "AFTER"`) },
      ];
      const today = compileProject(files, { globals: ["hostValue"] });
      for (const mode of HELD_MODES)
        for (const [stop, within] of Object.entries(STOPS)) {
          const at = `${files[0]!.source} [${mode.name}, ${stop}]`;
          let plan: boolean;
          try {
            plan = mode.run(() =>
              within(
                () =>
                  compileProjectWithBackend(files, { globals: ["hostValue"] }, CORE_BACKEND)
                    .plan !== null,
              ),
            );
          } catch (error) {
            if (!(error instanceof CandidateOutsideSlice)) throw error;
            plan = false;
          }
          if (today.plan === null || !number) assert.equal(plan, false, at);
        }
    }
});

test("the amount's cited check names a function of the evaluator, whose file holds the unit's run-time codes", () => {
  assert.deepEqual(UNIT_AMOUNT.takes, ["integer", "number"]);
  const text = readFileSync(UNIT_AMOUNT.check.file, "utf8");
  assert.match(text, new RegExp(`\\b${UNIT_AMOUNT.check.function}\\(`, "u"));
  for (const code of ["TSR027", "TSR009", "TSR036"]) assert.ok(text.includes(`"${code}"`), code);
});
