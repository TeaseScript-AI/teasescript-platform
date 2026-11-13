// `while`, `switch`, `break` and `continue` on the candidate route (#2658, #2488's step 2b): each source compiled by
// today's checker and by the route in the four held modes, and each plan run over the host domain, through the
// differential record (`tests/families/differential.mjs`).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileProjectWithBackend } from "../../../src/compiler.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { DECLARED_WAY_ERRORS } from "../../helpers/type-core/declared-samples.js";
import {
  diagnosed,
  type DifferentialRecord,
  type Entry,
  outcome,
  records,
  type RecordCase,
} from "../../helpers/type-core/row-guard-records.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";

/*
 * What each row expects of the route, in every held mode:
 * - `equal`: today's answer. A plan where today has one, with each of today's diagnostics and no other, and each run
 *   ending as today's (status and failure, with its site); apart from the two inherited warning classes 1a's ledger
 *   names (#2544's body, "R5, diagnostics"): the core's TSV041 on a host value stored into a typed place, where today
 *   gives none, and today's TSV046 on a test its types decide, where the route gives none.
 * - `refused`: the route declines with this text, so today's checker answers.
 * - `way`: today plans; the route gives TSV052 and no plan (#2660).
 * - `unreached`: as `equal`, but where today warns TSV065 that a statement after a `switch` never runs, the route does
 *   not (#2660, the same cause: its ways do not read the values a subject's type holds).
 */
type Expect = "equal" | { readonly refused: string } | "way" | "unreached";

interface Row {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly source: string }[];
  readonly expect: Expect;
}

const one = (name: string, source: string, expect: Expect = "equal"): Row => ({
  name,
  files: [{ path: "main.tease", source }],
  expect,
});

/** A diagnostic the inherited classes allow on one side only: the route's TSV041 warning, today's TSV046 warning. */
const ROUTE_ONLY = "warning TSV041";
const TODAY_ONLY = "warning TSV046";

/** The failures of one row's record. */
function judge(row: Row, record: DifferentialRecord): string[] {
  const { checker } = record;
  const failures: string[] = [];
  const modes = record.candidate.modes.map((mode) => mode.mode);
  if (JSON.stringify(modes) !== JSON.stringify(HELD_MODES.map((mode) => mode.name)))
    return [`${row.name}: the record's modes are ${modes.join(", ")}`];
  for (const mode of record.candidate.modes) {
    const at = `${row.name} [${mode.mode}]`;
    if (mode.threw !== undefined) {
      failures.push(`${at}: threw ${mode.threw}`);
      continue;
    }
    if (typeof row.expect === "object") {
      if (mode.outside !== row.expect.refused)
        failures.push(
          `${at}: not refused as "${row.expect.refused}": ${mode.outside ?? "published"}`,
        );
      continue;
    }
    if (mode.outside !== undefined) {
      failures.push(`${at}: refused: ${mode.outside}`);
      continue;
    }
    if (row.expect === "way") {
      const errors = diagnosed(mode).filter((each) => each.startsWith("error "));
      if (
        !checker.plan ||
        mode.plan ||
        errors.length !== 1 ||
        !errors[0]!.startsWith("error TSV052 ")
      )
        failures.push(
          `${at}: not the way class: today ${checker.plan ? "plans" : "no plan"}, route ${JSON.stringify(diagnosed(mode))}`,
        );
      continue;
    }
    const [today, route] = [
      kept(checker, row.expect === "unreached" ? [TODAY_ONLY, "warning TSV065"] : [TODAY_ONLY]),
      kept(mode, [ROUTE_ONLY]),
    ];
    if (JSON.stringify(today) !== JSON.stringify(route))
      failures.push(
        `${at}: diagnostics: today ${JSON.stringify(today)}, route ${JSON.stringify(route)}`,
      );
    if (!checker.plan !== !mode.plan) failures.push(`${at}: a plan on one side only`);
    (checker.runs ?? []).forEach((run, index) => {
      if (outcome(run) !== outcome(mode.runs?.[index]))
        failures.push(
          `${at}: run ${index}: today ${outcome(run)}, route ${outcome(mode.runs?.[index])}`,
        );
    });
  }
  return failures;
}

/** An entry's diagnostics, sorted, without those of the one-sided classes `dropped`. */
const kept = (entry: Entry, dropped: readonly string[]): string[] =>
  diagnosed(entry)
    .filter((each) => !dropped.some((one) => each.startsWith(`${one} `)))
    .sort();

/** Runs every row through the differential and judges it. */
function check(rows: readonly Row[], context: { after: (fn: () => void) => void }): void {
  const folder = mkdtempSync(join(tmpdir(), "loops-"));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  const cases: RecordCase[] = rows.map((row) => ({ name: row.name, files: row.files }));
  const found = records(cases, folder);
  assert.deepEqual(
    rows.flatMap((row, index) => judge(row, found[index]!)),
    [],
  );
}

test("`while`, `break` and `continue` answer as today's compiler, the false TSV052 on `while true` gone", (t) => {
  check(
    [
      // (the ways: a literal condition runs its body never, or until a `break`; `while true` without one never ends)
      one("while true, exit", "while true {\n  exit\n}\n"),
      one(
        "while true, a let in the body",
        "while true {\n  let y = hostValue\n  say y\n  exit\n}\n",
      ),
      one("while (true)", "while (true) {\n  exit\n}\n"),
      one("while true, a statement after", 'while true {\n  exit\n}\nsay "unreached"\n'),
      one("while false", 'while false {\n  say "never"\n}\nexit\n'),
      one("while true, break", 'while true {\n  break\n}\nsay "after"\nexit\n'),
      one("a host condition", 'while hostValue != null {\n  exit\n}\nsay "after"\nexit\n'),
      one("a decided condition", 'let n = 1\nwhile n == null {\n  say "never"\n}\nexit\n'),
      one(
        "nested, break in the inner loop",
        "while true {\n  for x in [1] {\n    break\n  }\n  exit\n}\n",
      ),
      // (R7 and its control: a body that breaks the guard, and one that keeps it)
      one(
        "R7",
        "let n: integer? = 1\nwhile n != null {\n  let w: integer = n\n  n = null\n}\nexit\n",
      ),
      one(
        "R7's control",
        "let n: integer? = 1\nwhile n != null {\n  let w: integer = n\n  n = 2\n  exit\n}\nexit\n",
      ),
      // (a typed store in a body, left by `break`, in each loop; `continue` in each loop)
      one(
        "while, break after a store",
        "let i: integer = 0\nwhile true {\n  i = hostValue\n  break\n}\nsay i\nexit\n",
      ),
      one(
        "for, break after a store",
        "let w: integer = 0\nfor x in [1, 2] {\n  w = hostValue\n  break\n}\nexit\n",
      ),
      one(
        "repeat, break after a store",
        "let w: integer = 0\nrepeat 2 {\n  w = hostValue\n  break\n}\nexit\n",
      ),
      one(
        "while, break on a null test",
        "let n: integer? = hostValue\nwhile true {\n  if n == null {\n    break\n  }\n  let w: integer = n\n  exit\n}\nexit\n",
      ),
      one(
        "while, continue",
        "let n: integer? = 1\nwhile n != null {\n  n = null\n  continue\n}\nexit\n",
      ),
      one(
        "for, continue",
        "for x in [1, 2] {\n  if hostValue == null {\n    continue\n  }\n  say x\n}\nexit\n",
      ),
      one(
        "repeat, continue",
        "let n: integer = 0\nrepeat 3 {\n  n = hostValue\n  continue\n}\nexit\n",
      ),
      one(
        "a typed let in the body",
        "while hostValue != null {\n  let y: integer = hostValue\n  exit\n}\nexit\n",
      ),
    ],
    t,
  );
});

test("`switch` answers as today's compiler: each literal kind, a range, a type test, `null`, a default, every case exiting", (t) => {
  check(
    [
      one(
        "literal values and a default",
        'switch hostValue {\n  case 1 {\n    say "one"\n  }\n  case "a", "b" {\n    say "ab"\n  }\n  default {\n    say "d"\n  }\n}\nexit\n',
      ),
      one(
        "the other literal kinds",
        'switch hostValue {\n  case 2.5 {\n    say "n"\n  }\n  case true {\n    say "t"\n  }\n  case null {\n    say "null"\n  }\n}\nexit\n',
      ),
      one(
        "a range",
        'let n = toInteger(hostValue, default: 0)\nswitch n {\n  case 1..3 {\n    say "low"\n  }\n  case 3..=5 {\n    say "mid"\n  }\n  default {\n    say "hi"\n  }\n}\nexit\n',
      ),
      one(
        "type tests",
        "switch hostValue {\n  case is integer {\n    let w: integer = hostValue\n  }\n  case is not string {\n    let v: string? = hostValue\n  }\n}\nexit\n",
      ),
      one(
        "a type test of a list type",
        "switch hostValue {\n  case is integer[] {\n    exit\n  }\n}\nexit\n",
      ),
      one(
        "case null narrows",
        "let n: integer? = hostValue\nswitch n {\n  case null {\n    exit\n  }\n  default {\n    let w: integer = n\n  }\n}\nexit\n",
      ),
      one(
        "every case exits",
        "switch hostValue {\n  case 1 {\n    exit\n  }\n  default {\n    exit\n  }\n}\n",
      ),
      one(
        "every case exits, a statement after",
        'switch hostValue {\n  case 1 {\n    exit\n  }\n  case "a" {\n    exit\n  }\n  default {\n    exit\n  }\n}\nsay "unreached"\n',
      ),
      one(
        "a literal subject",
        'switch 1 {\n  case 1 {\n    say "one"\n  }\n  case 2 {\n    say "two"\n  }\n  default {\n    say "d"\n  }\n}\nexit\n',
      ),
      one(
        "a literal subject, every case exiting",
        'switch 1 {\n  case 1 {\n    exit\n  }\n}\nsay "after"\nexit\n',
      ),
      one(
        "a literal boolean subject",
        'switch true {\n  case true {\n    exit\n  }\n  case false {\n    say "f"\n  }\n}\nsay "after"\n',
      ),
      one(
        "both booleans, a statement after that ends the file",
        'let b = hostValue == null\nswitch b {\n  case true {\n    exit\n  }\n  case false {\n    exit\n  }\n}\nsay "after"\nexit\n',
        "unreached",
      ),
      // (R8 and its control: a join of the cases' stores)
      one(
        "R8",
        "let n: integer? = 1\nswitch hostValue {\n  case 1 {\n    n = null\n  }\n  default {\n    n = 2\n  }\n}\nlet w: integer = n\nexit\n",
      ),
      one(
        "R8's control",
        "let n: integer? = 1\nswitch hostValue {\n  case 1 {\n    n = null\n  }\n  default {\n    n = 2\n  }\n}\nif n != null {\n  let w: integer = n\n}\nexit\n",
      ),
      // (a `let` in a case's body and the default's, read there; a typed store in a case)
      one(
        "a let in a case",
        "switch hostValue {\n  case 1 {\n    let y: integer = hostValue\n    say y\n  }\n}\nexit\n",
      ),
      one(
        "a let in the default",
        "switch hostValue {\n  default {\n    let y = hostValue\n    say y\n  }\n}\nexit\n",
      ),
      one(
        "a store in a case",
        "let w: integer = 0\nswitch hostValue {\n  case 1 {\n    w = hostValue\n  }\n}\nexit\n",
      ),
      one(
        "a switch in a loop, break in a case",
        'while true {\n  switch hostValue {\n    case 1 {\n      break\n    }\n    default {\n      exit\n    }\n  }\n  say "x"\n}\nexit\n',
      ),
      {
        name: "every case exits, in a file a transfer starts",
        files: [
          { path: "main.tease", source: 'goto "part.tease"\n' },
          {
            path: "part.tease",
            source:
              "switch hostValue {\n  case 1 {\n    exit\n  }\n  default {\n    exit\n  }\n}\n",
          },
        ],
        expect: "equal",
      },
      // (today's name pass on a case value: no literal, and an overlap)
      one("TSV047", "let a = 1\nswitch hostValue {\n  case a {\n    exit\n  }\n}\nexit\n"),
      one(
        "TSV048",
        "switch hostValue {\n  case 1 {\n    exit\n  }\n  case 1 {\n    exit\n  }\n}\nexit\n",
      ),
      // (a case's written type as a `let`'s: a union and one only `null` fills refused, an optional admitted)
      one(
        "a union in a type test",
        "switch hostValue {\n  case is integer | string {\n    exit\n  }\n}\nexit\n",
        { refused: "this written type" },
      ),
      one(
        "a null-only type test",
        "switch hostValue {\n  case is null {\n    exit\n  }\n}\nexit\n",
        { refused: "this written type" },
      ),
      one(
        "an optional type test",
        "switch hostValue {\n  case is integer? {\n    exit\n  }\n}\nexit\n",
      ),
      // (a signed case value waits for the unary row, #2488's step 2c)
      one("a negative case value", "switch hostValue {\n  case -1 {\n    exit\n  }\n}\nexit\n", {
        refused: "this unary expression",
      }),
    ],
    t,
  );
});

/** The subjects of the never-matching case's family: where each origin stands, then the subject. */
const SUBJECTS: Readonly<Record<string, readonly [string, string]>> = {
  "an integer literal": ["", "1"],
  "a number literal": ["", "2.5"],
  "a text literal": ["", '"a"'],
  "a boolean literal": ["", "true"],
  null: ["", "null"],
  "a parenthesised literal": ["", "(1)"],
  "an inferred integer": ["let s = 1\n", "s"],
  "an inferred text": ['let s = "a"\n', "s"],
  "an inferred list": ["let s = [1]\n", "s"],
  "an inferred object": ["let s = {v: 1}\n", "s"],
  "a branch-joined integer": ["let s = 1\nif hostValue == null {\n  s = 2\n}\n", "s"],
  "a written integer": ["let s: integer = toInteger(hostValue, default: 0)\n", "s"],
  "a written integer?, from the host": ["let s: integer? = hostValue\n", "s"],
  "a written text?, from the host": ["let s: string? = hostValue\n", "s"],
  "the host": ["", "hostValue"],
  "a load": ['let s = load "k", default: 1\n', "s"],
  "a conversion": ["", "toInteger(hostValue, default: 0)"],
  "an element": ["let s = [1, 2]\n", "s[0]"],
  "a get": ["let s = [1, 2]\n", "s.get(0, default: 0)"],
  "a property": ["let s = {v: 1}\n", "s.v"],
  "a parse": ["", "fromJson(hostValue, default: 1)"],
  "a for loop's variable": ["for s in [1, 2] {\n", "s"],
};

/**
 * The family's rows the route declines where today's checker plans: the facts type a parse by its default's kind, which
 * today's checker leaves unknown, so today's predicate on the facts' type finds these cases may never match. Each is
 * refused, never published, and today's checker answers.
 */
const UNDER_OFFERED: ReadonlySet<string> = new Set([
  'a parse, case "a"',
  "a parse, case true",
  "a parse, case null",
]);

/** The case values of the family: each literal kind, a range, a parenthesised literal. */
const VALUES: readonly string[] = ["1", "2.5", '"a"', "true", "null", "1..3", "(1)"];

test("a case value that may never match is refused where today's checker gives TSV049, and admitted alike elsewhere", (t) => {
  const rows: Row[] = [];
  for (const [name, [before, subject]] of Object.entries(SUBJECTS))
    for (const value of VALUES) {
      const inLoop = before.startsWith("for ");
      const body = `${before}switch ${subject} {\n  case ${value} {\n    say "in"\n  }\n}\n${inLoop ? "}\n" : ""}`;
      rows.push(one(`${name}, case ${value}`, `${body}say "after"\nexit\n`));
    }
  // a value beside one that may match, in a later case, and after a type case
  rows.push(
    one(
      "beside a matching value",
      'let s = 1\nswitch s {\n  case "a", 1 {\n    say "in"\n  }\n}\nexit\n',
    ),
    one(
      "in a later case",
      'let s = 1\nswitch s {\n  case 1 {\n    say "one"\n  }\n  case "a" {\n    say "a"\n  }\n}\nexit\n',
    ),
    one(
      "narrowed by a type test",
      'let s = hostValue\nif s is integer {\n  switch s {\n    case "a" {\n      say "a"\n    }\n  }\n}\nexit\n',
    ),
    one(
      "narrowed by a null test",
      'let s: integer? = hostValue\nif s != null {\n  switch s {\n    case "a" {\n      say "a"\n    }\n  }\n}\nexit\n',
    ),
  );
  const folder = mkdtempSync(join(tmpdir(), "loops-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const found = records(
    rows.map((row) => ({ name: row.name, files: row.files })),
    folder,
  );
  // where today's checker gives TSV049 the route refuses the case, and where it declines one today plans
  // (`UNDER_OFFERED`); everywhere else the row answers as today
  const failures = rows.flatMap((row, index) => {
    const record = found[index]!;
    const never = (record.checker.diagnostics ?? []).some((each) => each.code === "TSV049");
    const refused = never || UNDER_OFFERED.has(row.name);
    return judge({ ...row, expect: refused ? { refused: "this case" } : row.expect }, record);
  });
  assert.deepEqual(failures, []);
  // the family reaches both sides
  const refusedRows = found.filter((record) =>
    (record.checker.diagnostics ?? []).some((each) => each.code === "TSV049"),
  ).length;
  assert.ok(refusedRows > 0 && refusedRows < rows.length, String(refusedRows));
});

test("a case value that may never match stays refused where the analysis's budget stops it before its subject's kind", () => {
  // (a stop leaves the subject an unknown of the budget's reason, which today's checker types: refused, never published,
  // R33's form; never a throw of another kind)
  for (const source of [
    'let s = 1\nswitch s {\n  case "a" {\n    say "a"\n  }\n}\nexit\n',
    'let s = "a"\nlet t = s\nswitch t {\n  case 1..3 {\n    say "r"\n  }\n}\nexit\n',
  ]) {
    const files = [{ path: "main.tease", source }];
    const request = coreRequest(files);
    assert.ok(request !== null, source);
    const total = analyseCore(request).budget.total;
    for (let allowance = 1; allowance < total; allowance += 1)
      assert.throws(
        () =>
          withTestAllowance(allowance, () =>
            compileProjectWithBackend(files, { globals: ["hostValue"] }, CORE_BACKEND),
          ),
        CandidateOutsideSlice,
        `${source} at ${allowance} of ${total}`,
      );
  }
});

test("a `switch` whose subject's type rules out the no-case way gets TSV052 on the route where today plans (#2660)", (t) => {
  check(
    [
      // (declared: the boolean and `askChoice` forms, `DECLARED_WAY_ERRORS`)
      ...DECLARED_WAY_ERRORS.map((declared) => ({
        name: `declared: ${declared.form}`,
        files: declared.files,
        expect: "way" as const,
      })),
      // (inherited: a type case, and its twin without a `switch` on the base)
      one(
        "inherited: a type case",
        "let s = 1\nswitch s {\n  case is integer {\n    exit\n  }\n}\n",
        "way",
      ),
      one("inherited: the twin", 'let s = 1\nif s is integer {\n  exit\n}\nsay "after"\n', "way"),
    ],
    t,
  );
});
