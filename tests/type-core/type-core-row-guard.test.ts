import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../src/type-inference/core/budget.js";
import { DISPOSITIONS, type SyntaxKind } from "../../src/type-inference/core/slice-syntax.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import {
  checkKey,
  DOMAIN,
  type DifferentialRecord,
  outcome,
  records,
  script,
} from "../helpers/type-core/row-guard-records.js";
import {
  DECLARED_REFUSALS,
  DECLARED_RUN_DIFFERENCES,
  OPERAND_TEMPLATES,
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
 * citations exempt no check of today's plan from rule 2. The command operands' declared rule differences are
 * `type-core-declared-positions.test.ts`'s.
 */

interface GuardCase {
  readonly name: string;
  readonly source: string;
  /** The refusal the route must make in every mode, for a declared refusal's source. */
  readonly refusal?: string;
}

// EVIDENCE: invariant: the table's keys are exactly the AST kinds (its mapped type).
const OPEN = (Object.keys(DISPOSITIONS) as SyntaxKind[]).filter(
  (kind) => DISPOSITIONS[kind].row !== "refused",
);

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
  ];
}

/** A run's failure as the record writes it: the code at the span of `at` in the source, or `null` without one. */
const failureAt = (source: string, code: string, at: string | null): string | null =>
  at === null ? null : `${code}@${source.indexOf(at)}:${source.indexOf(at) + at.length}`;

/** The guard's failures for one case's record; `seen` collects each declared difference that occurred, by mode. */
function judge(guardCase: GuardCase, record: DifferentialRecord, seen: Set<string>): string[] {
  const failures: string[] = [];
  const { checker } = record;
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
  const seen = new Set<string>();
  const failures = cases.flatMap((guardCase, index) => judge(guardCase, found[index]!, seen));
  // each declared run difference occurs in every mode
  for (const declared of DECLARED_RUN_DIFFERENCES)
    for (const mode of HELD_MODES.map((held) => held.name))
      if (!seen.has(`${declared.template} [${mode}]`))
        failures.push(
          `the declared run difference no longer occurs: ${declared.template} [${mode}]`,
        );
  assert.deepEqual(failures, []);
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
