import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { CONVERSIONS } from "../../src/conversions.js";
import { run } from "../../src/runtime/engine.js";
import type { RuntimeSnapshot } from "../../src/runtime/snapshot/state.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../src/type-inference/core/budget.js";
import { DISPOSITIONS, type SyntaxKind } from "../../src/type-inference/core/slice-syntax.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import {
  ADMITTED_KINDS,
  CONTEXTS,
  DECLARED_REFUSALS,
  DECLARED_RULE_DIFFERENCES,
  DECLARED_RUN_DIFFERENCES,
  misfitSources,
  OPERAND_TEMPLATES,
  REFUSED_KINDS,
  ROW_TEMPLATES,
} from "../helpers/type-core/row-templates.js";

/*
 * The row guard (#2500; #2488's design, Addition 2, "The row guard", with the lead's R8 and R9): every open row of the
 * candidate route's syntax table is compiled from its templates (`row-templates.ts`) by today's checker and by the
 * candidate route in the four held modes, through the differential record (`tests/families/differential.mjs`, on this
 * tree), and judged per source and mode: (1) the route publishes a plan, never refusing or throwing, except a refusal
 * `DECLARED_REFUSALS` names, which must occur; (2) every check today's plan carries is in the route's, by path, offsets
 * and field; (3) each run, with the host global at every value of the derived domain, ends as today's does (status and
 * failure, with its site), except a difference `DECLARED_RUN_DIFFERENCES` names, which must occur. A `pass` row's runtime
 * citations exempt no check of today's plan from rule 2.
 */

/** The host values each plan runs with: a whole number, text, a truth value, a fraction, null (fitting and not). */
const DOMAIN = [2, "text", true, 2.5, null];

interface Check {
  readonly field: string;
  readonly path: string | null;
  readonly offset: number | null;
  readonly end: number | null;
}

interface Run {
  readonly status?: string;
  readonly failure?: string | null;
  readonly threw?: string;
}

interface Entry {
  readonly diagnostics?: readonly {
    readonly code: string;
    readonly severity: string;
    readonly message?: string;
    readonly offset?: number;
    readonly end?: number;
  }[];
  readonly plan?: { readonly checks: readonly Check[] } | null;
  readonly runs?: readonly Run[];
  readonly outside?: string;
  readonly threw?: string;
}

interface DifferentialRecord {
  readonly name: string;
  readonly checker: Entry;
  readonly candidate: { readonly modes: readonly (Entry & { readonly mode: string })[] };
}

interface GuardCase {
  readonly name: string;
  readonly source: string;
  /** The refusal the route must make in every mode, for a declared refusal's source. */
  readonly refusal?: string;
  /** A command operand's misfit, which today's checker may refuse at compile time (`DECLARED_RULE_DIFFERENCES`). */
  readonly misfit?: true;
  /** A declared rule difference's command in a context, or its fitting twin there (R12), judged by `judgeContexts`. */
  readonly context?: true;
}

// EVIDENCE: invariant: the table's keys are exactly the AST kinds (its mapped type).
const OPEN = (Object.keys(DISPOSITIONS) as SyntaxKind[]).filter(
  (kind) => DISPOSITIONS[kind].row !== "refused",
);

const script = (template: string): string => `${template}\nexit\n`;

/** Every case of the guard: each template, and each declared refusal's source and its admitted twin. */
function guardCases(): GuardCase[] {
  return [
    ...OPEN.flatMap((row) =>
      (ROW_TEMPLATES[row] ?? []).map((template, at) => ({
        name: `${row} ${at}`,
        source: script(template),
      })),
    ),
    ...DECLARED_REFUSALS.flatMap((declared) => [
      {
        name: `${declared.row} ${declared.position}, refused`,
        source: script(declared.refused),
        refusal: declared.text,
      },
      { name: `${declared.row} ${declared.position}, admitted`, source: script(declared.admitted) },
    ]),
    // (a misfit a declared refusal names is judged as that refusal)
    ...misfitSources()
      .filter(({ source }) => !DECLARED_REFUSALS.some((declared) => declared.refused === source))
      .map(({ row, operand, source }) => ({
        name: `${row} ${operand}: ${source}`,
        source: script(source),
        misfit: true as const,
      })),
    // each declared rule difference in each context, and each fitting twin there once
    ...[
      ...new Map(
        DECLARED_RULE_DIFFERENCES.flatMap((declared) =>
          Object.values(CONTEXTS).flatMap((wrap): [string, string][] => [
            [wrap(declared.source), declared.source],
            [wrap(declared.fitting), declared.fitting],
          ]),
        ),
      ),
    ].map(([source, command]) => ({
      name: `in context: ${command}: ${JSON.stringify(source)}`,
      source,
      context: true as const,
    })),
  ];
}

/** The differential record of each case, on this tree, in the cases' order. */
function records(cases: readonly GuardCase[], folder: string): DifferentialRecord[] {
  const casesFile = join(folder, "cases.jsonl");
  const out = join(folder, "records.jsonl");
  const lines = cases.map(({ name, source }) =>
    JSON.stringify({ name, source, runs: DOMAIN.map((hostValue) => ({ hostValue })) }),
  );
  writeFileSync(casesFile, lines.map((line) => `${line}\n`).join(""));
  const ran = spawnSync(
    process.execPath,
    [resolve("tests/families/differential.mjs"), resolve("."), casesFile, "--out", out],
    { encoding: "utf8" },
  );
  assert.notEqual(ran.status, 2, ran.stderr);
  const written = readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  return written.map(
    (line) =>
      // EVIDENCE: invariant: `differential.mjs` writes one record a line (tests/families/README.md).
      JSON.parse(line) as DifferentialRecord,
  );
}

/** A run's failure as the record writes it: the code at the span of `at` in the source, or `null` without one. */
const failureAt = (source: string, code: string, at: string | null): string | null =>
  at === null ? null : `${code}@${source.indexOf(at)}:${source.indexOf(at) + at.length}`;

const checkKey = (check: Check): string =>
  `${check.field} ${check.path}:${check.offset}:${check.end}`;
const outcome = (run: Run | undefined): string =>
  run === undefined ? "none" : (run.threw ?? `${run.status} ${run.failure}`);

/** The guard's failures for one case's record; `seen` collects each declared difference that occurred, by mode. */
function judge(guardCase: GuardCase, record: DifferentialRecord, seen: Set<string>): string[] {
  const failures: string[] = [];
  const { checker } = record;
  if (guardCase.context === true) return [];
  if (guardCase.misfit === true && checker.threw === undefined && !checker.plan)
    return judgeRefusedToday(guardCase, record, seen);
  if (checker.threw !== undefined || !checker.plan)
    return [
      `${record.name}: today's checker publishes no plan (${checker.threw ?? JSON.stringify(checker.diagnostics)})`,
    ];
  const declared = DECLARED_RUN_DIFFERENCES.find(
    (difference) => script(difference.template) === guardCase.source,
  );
  const modes = record.candidate.modes.map((mode) => mode.mode);
  if (JSON.stringify(modes) !== JSON.stringify(HELD_MODES.map((mode) => mode.name)))
    failures.push(`${record.name}: the record's modes are ${modes.join(", ")}, not the held modes`);
  for (const mode of record.candidate.modes) {
    const at = `${record.name} [${mode.mode}]`;
    if (guardCase.refusal !== undefined) {
      if (mode.outside !== guardCase.refusal)
        failures.push(`${at}: the declared refusal "${guardCase.refusal}" no longer occurs`);
      continue;
    }
    if (mode.outside !== undefined || mode.threw !== undefined || !mode.plan) {
      failures.push(`${at}: rule 1, no plan: ${mode.outside ?? mode.threw ?? "an error"}`);
      continue;
    }
    const carried = new Set(mode.plan.checks.map(checkKey));
    for (const check of checker.plan.checks.map(checkKey))
      if (!carried.has(check)) failures.push(`${at}: rule 2, today's check missing: ${check}`);
    (checker.runs ?? []).forEach((run, index) => {
      const other = mode.runs?.[index];
      if (outcome(run) === outcome(other)) return;
      if (
        declared !== undefined &&
        run.failure === failureAt(guardCase.source, declared.code, declared.todayAt) &&
        other?.failure === failureAt(guardCase.source, declared.code, declared.at) &&
        mode.plan?.checks.some(
          (check) =>
            check.field === declared.field &&
            check.path === "main.tease" &&
            check.offset === guardCase.source.indexOf(declared.checkAt) &&
            check.end === guardCase.source.indexOf(declared.checkAt) + declared.checkAt.length,
        )
      ) {
        seen.add(`${declared.template} [${mode.mode}]`);
        return;
      }
      failures.push(
        `${at}: rule 3, run ${JSON.stringify(DOMAIN[index])}: today ${outcome(run)}, route ${outcome(other)}`,
      );
    });
  }
  return failures;
}

/** A misfit today's checker refuses at compile time: the route refuses it alike, or a declared rule difference holds. */
function judgeRefusedToday(
  guardCase: GuardCase,
  record: DifferentialRecord,
  seen: Set<string>,
): string[] {
  const errors = (entry: Entry): string[] =>
    (entry.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.code)
      .sort();
  const today = errors(record.checker);
  const declared = DECLARED_RULE_DIFFERENCES.find(
    (difference) => script(difference.source) === guardCase.source,
  );
  const failures: string[] = [];
  for (const mode of record.candidate.modes) {
    const at = `${record.name} [${mode.mode}]`;
    if (mode.outside !== undefined || mode.threw !== undefined) {
      failures.push(`${at}: today ${today.join(" ")}, route ${mode.outside ?? mode.threw}`);
      continue;
    }
    if (!mode.plan) {
      if (JSON.stringify(errors(mode)) !== JSON.stringify(today))
        failures.push(`${at}: today ${today.join(" ")}, route ${errors(mode).join(" ")}`);
      continue;
    }
    const runs = (mode.runs ?? []).map((run) => run.threw ?? `${run.status} ${run.failure}`);
    if (declared === undefined) {
      failures.push(
        `${at}: undeclared: today ${today.join(" ")}, route a plan, runs ${runs.join(", ")}`,
      );
      continue;
    }
    const expected = `failed ${failureAt(guardCase.source, declared.failure.code, declared.failure.at)}`;
    if (!today.includes(declared.code) || runs.length === 0 || runs.some((run) => run !== expected))
      failures.push(
        `${at}: declared ${declared.code} and ${expected}, found today ${today.join(" ")}, runs ${runs.join(", ")}`,
      );
    else seen.add(`${declared.source} [${mode.mode}]`);
  }
  return failures;
}

/** Each diagnostic of an entry as `severity code start:end`. */
const diagnosed = (
  entry: Entry,
  at: (offset: number) => number | null = (offset) => offset,
): string[] =>
  (entry.diagnostics ?? []).flatMap((diagnostic) => {
    const [start, end] = [at(diagnostic.offset ?? -1), at(diagnostic.end ?? -1)];
    return start === null || end === null
      ? []
      : [`${diagnostic.severity} ${diagnostic.code} ${start}:${end}`];
  });

/**
 * Each declared rule difference in each context (R12): today its code and no plan; the route a plan, in every mode, that
 * answers as its fitting twin's does (the route's, or today's where the twin's operand is outside the slice), apart from
 * diagnostics inside the misfitting value, which are its producer's own: the same diagnostics, and each run ending as the
 * twin's or, where it reaches the command, failing there with the entry's code. The one inherited difference: after an
 * exiting `for`, today warns that the twin never runs (TSV065) and the route does not (R13).
 */
function judgeContexts(
  cases: readonly GuardCase[],
  found: readonly DifferentialRecord[],
): string[] {
  const bySource = new Map(cases.map((guardCase, at) => [guardCase.source, found[at]!]));
  const failures: string[] = [];
  for (const declared of DECLARED_RULE_DIFFERENCES)
    for (const [context, wrap] of Object.entries(CONTEXTS)) {
      const source = wrap(declared.source);
      const misfit = bySource.get(source)!;
      const twin = bySource.get(wrap(declared.fitting))!;
      const name = `${declared.source} ${context}`;
      const today = (misfit.checker.diagnostics ?? [])
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.code);
      if (misfit.checker.plan || !today.includes(declared.code))
        failures.push(
          `${name}: today ${misfit.checker.plan ? "a plan" : "no plan"}, ${today.join(" ")}`,
        );
      // the misfit's offsets as the twin's: the misfitting value replaced by the fitting one
      const command = source.indexOf(declared.source);
      const value =
        command + OPERAND_TEMPLATES[declared.row]![declared.operand]![0]!.indexOf("hostValue");
      const shift = declared.fitting.length - declared.source.length;
      const asTwin = (offset: number): number | null =>
        offset <= value ? offset : offset >= value + declared.value.length ? offset + shift : null;
      const reached = `failed ${declared.failure.code}@${command + declared.source.indexOf(declared.failure.at)}:${command + declared.source.indexOf(declared.failure.at) + declared.failure.at.length}`;
      misfit.candidate.modes.forEach((mode, at) => {
        const twinMode = twin.candidate.modes[at];
        const reference: Entry = twinMode?.plan ? twinMode : twin.checker;
        const inherited = (diagnostic: string): boolean =>
          reference === twin.checker &&
          context === "after an exiting for" &&
          diagnostic.startsWith("warning TSV065 ");
        const expected = diagnosed(reference)
          .filter((diagnostic) => !inherited(diagnostic))
          .sort();
        const answered = diagnosed(mode, asTwin).sort();
        const runs = (mode.runs ?? []).map(outcome);
        const twinRuns = (reference.runs ?? []).map(outcome);
        if (
          !mode.plan ||
          JSON.stringify(answered) !== JSON.stringify(expected) ||
          runs.length !== twinRuns.length ||
          runs.some((run, index) => run !== reached && run !== twinRuns[index])
        )
          failures.push(
            `${name} [${mode.mode}]: route ${mode.outside ?? mode.threw ?? (mode.plan ? "a plan" : "no plan")}, ${answered.join(", ")}, runs ${runs.join(", ")}; its twin ${expected.join(", ")}, runs ${twinRuns.join(", ")}`,
          );
      });
    }
  return failures;
}

test("every open row of the syntax table has templates, and the declared lists name only open rows and templates", () => {
  // EVIDENCE: invariant: the templates' keys are AST kinds (`ROW_TEMPLATES`' type).
  assert.deepEqual((Object.keys(ROW_TEMPLATES) as SyntaxKind[]).sort(), [...OPEN].sort());
  for (const declared of DECLARED_REFUSALS) assert.ok(OPEN.includes(declared.row), declared.row);
  // each command operand position is a cited operand of its row, and each cited operand has a position
  for (const row of OPEN) {
    const disposition = DISPOSITIONS[row];
    const cited = disposition.row === "pass" ? Object.keys(disposition.operands).sort() : [];
    const positions =
      row === "sayStatement" ? [] : Object.keys(OPERAND_TEMPLATES[row] ?? {}).sort();
    assert.deepEqual(positions, cited, row);
  }
  const misfits = misfitSources().map(({ source }) => source);
  for (const declared of DECLARED_RULE_DIFFERENCES)
    assert.ok(misfits.includes(declared.source), declared.source);
  for (const declared of DECLARED_RUN_DIFFERENCES) {
    assert.ok(Object.values(ROW_TEMPLATES).flat().includes(declared.template), declared.template);
    for (const text of [declared.at, declared.checkAt, declared.todayAt ?? declared.at]) {
      const at = declared.template.indexOf(text);
      assert.ok(at >= 0 && at === declared.template.lastIndexOf(text), declared.template);
    }
  }
});

test("each open row's templates publish on the route, with today's checks and today's runs", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "row-guard-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const cases = guardCases();
  const found = records(cases, folder);
  assert.deepEqual(
    found.map((record) => record.name),
    cases.map((guardCase) => guardCase.name),
  );
  const seen = new Set<string>();
  const failures = [
    ...cases.flatMap((guardCase, index) => judge(guardCase, found[index]!, seen)),
    ...judgeContexts(cases, found),
  ];
  // each declared rule difference, and each declared run difference, occurs in every mode
  for (const declared of DECLARED_RULE_DIFFERENCES)
    for (const mode of HELD_MODES.map((held) => held.name))
      if (!seen.has(`${declared.source} [${mode}]`))
        failures.push(
          `the declared rule difference no longer occurs: ${declared.source} [${mode}]`,
        );
  for (const declared of DECLARED_RUN_DIFFERENCES)
    for (const mode of HELD_MODES.map((held) => held.name))
      if (!seen.has(`${declared.template} [${mode}]`))
        failures.push(
          `the declared run difference no longer occurs: ${declared.template} [${mode}]`,
        );
  assert.deepEqual(failures, []);
});

test("each value kind the slice admits no value of: the route refuses a source holding one, or publishes no plan", () => {
  // (the conversions the slice admits, `sliceCall`'s, give only kinds it admits)
  for (const [name, conversion] of Object.entries(CONVERSIONS))
    if (conversion.takes === "value" && conversion.kinds !== "shown")
      assert.ok(
        ADMITTED_KINDS.some((kind) => kind === conversion.result),
        name,
      );
  for (const [kind, source] of Object.entries(REFUSED_KINDS))
    for (const mode of HELD_MODES) {
      let plan;
      try {
        ({ plan } = mode.run(() =>
          compileProjectWithBackend(
            [{ path: "main.tease", source: script(source) }],
            { globals: ["hostValue"] },
            CORE_BACKEND,
          ),
        ));
      } catch (error) {
        if (!(error instanceof CandidateOutsideSlice)) throw error;
        continue;
      }
      assert.equal(plan, null, `${kind}: ${source} [${mode.name}]`);
    }
});

test("a check that no store takes refuses its source, also where the analysis's budget stops it", () => {
  const refused = DECLARED_REFUSALS.filter(
    (declared) => declared.text === "a check that no store takes",
  );
  assert.equal(refused.length, 3);
  for (const declared of refused) {
    const files = [{ path: "main.tease", source: script(declared.refused) }];
    const request = coreRequest(files);
    assert.ok(request !== null, declared.refused);
    const total = analyseCore(request).budget.total;
    for (const allowance of [1, Math.floor(total / 4), Math.floor(total / 2), total - 1])
      // a refusal, whatever its reason where the stop comes first; never a throw of another kind
      assert.throws(
        () =>
          withTestAllowance(allowance, () =>
            compileProjectWithBackend(files, { globals: ["hostValue"] }, CORE_BACKEND),
          ),
        CandidateOutsideSlice,
        `${declared.refused} at ${allowance} of ${total}`,
      );
  }
});

/**
 * The snapshot's fields a failing run changes whatever the statement does: its status, failure and event count, and,
 * for a command whose operands are prepared before its instruction, its place in the plan and the prepared values.
 */
const BOOKKEEPING: readonly string[] = [
  "status",
  "failure",
  "nextEventSequence",
  "nextInstruction",
  "temporaries",
];

/** Each field of a snapshot as JSON text, taken before the run changes it in place. */
const fieldsOf = (snapshot: RuntimeSnapshot): Map<string, string> =>
  new Map(Object.entries(snapshot).map(([key, value]) => [key, JSON.stringify(value)]));

test("a declared rule difference's instruction refuses its operand before the statement acts, in every mode", () => {
  for (const declared of DECLARED_RULE_DIFFERENCES) {
    const source = script(declared.source);
    // the statement is the source's first line
    const end = declared.source.length;
    for (const mode of HELD_MODES) {
      const at = `${declared.source} [${mode.name}]`;
      const { plan } = mode.run(() =>
        compileProjectWithBackend(
          [{ path: "main.tease", source }],
          { globals: ["hostValue"] },
          CORE_BACKEND,
        ),
      );
      assert.ok(plan !== null, at);
      for (const hostValue of DOMAIN) {
        const start = createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } });
        const before = fieldsOf(start);
        const result = run(plan, start);
        // nothing of the statement's effect: the session's state as it started, but for the run's own bookkeeping
        const after = fieldsOf(result.snapshot);
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
          (key) => !BOOKKEEPING.includes(key) && before.get(key) !== after.get(key),
        );
        assert.deepEqual(changed, [], `${at}: the session's state`);
        const failure = result.events.find((event) => event.kind === "runtimeFailure");
        assert.equal(
          failure?.kind === "runtimeFailure"
            ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
            : null,
          failureAt(source, declared.failure.code, declared.failure.at),
          at,
        );
        // nothing of the statement's effect: no event of it but the failure
        const own = result.events.filter(
          (event) =>
            event.kind !== "runtimeFailure" &&
            "span" in event &&
            event.span !== null &&
            event.span.start.offset < end,
        );
        assert.deepEqual(
          own.map((event) => event.kind),
          [],
          at,
        );
      }
    }
  }
});
