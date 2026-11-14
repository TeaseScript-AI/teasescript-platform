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
  diagnosed,
  DOMAIN,
  type DifferentialRecord,
  outcome,
  records,
  script,
} from "../helpers/type-core/row-guard-records.js";
import {
  DECLARED_REFUSALS,
  DECLARED_RUN_DIFFERENCES,
} from "../helpers/type-core/declared-samples.js";
import {
  ANSWERED_AS_TODAY,
  filesOf,
  OPERAND_TEMPLATES,
  ROW_HOSTS,
  ROW_TEMPLATES,
  type Template,
  type TemplateFile,
} from "../helpers/type-core/row-templates.js";

/*
 * The row guard (#2500; #2488's design, Addition 2, "The row guard", with the lead's R8 and R9): every open row of the
 * candidate route's syntax table is compiled from its templates (`row-templates.ts`, a source or a project's files) by
 * today's checker and by the candidate route in the four held modes, through the differential record
 * (`tests/families/differential.mjs`, on this tree), and judged per source and mode: (1) the route publishes a plan,
 * never refusing or throwing, except a refusal `DECLARED_REFUSALS` names, which must occur whatever today's checker
 * answers (the route publishes nothing there); (2) every check today's plan carries is in the route's, by path, offsets
 * and field; (3) each run, with the host global at every value of the derived domain, ends as today's does (status and
 * failure, with its site), except a difference `DECLARED_RUN_DIFFERENCES` names, which must occur. A source of
 * `ANSWERED_AS_TODAY`, which today's compiler refuses, gets today's diagnostics and no plan in every mode. A `pass`
 * row's runtime citations exempt no check of today's plan from rule 2. The command operands' declared rule differences
 * are `type-core-declared-positions.test.ts`'s.
 */

interface GuardCase {
  readonly name: string;
  /** The project: `main.tease` first. */
  readonly files: readonly TemplateFile[];
  /** The host values its runs take after the domain's. */
  readonly hosts: readonly string[];
  /** The refusal the route must make in every mode, for a declared refusal's source. */
  readonly refusal?: string;
  /** A source today's compiler refuses with a compile error, which the route must give alike (`ANSWERED_AS_TODAY`). */
  readonly asToday?: true;
}

/** A template of `row` as the project the guard compiles: a source ends with `exit`, beside the row's destinations. */
const projectOf = (row: SyntaxKind, template: Template): readonly TemplateFile[] =>
  typeof template === "string" ? filesOf(row, script(template)) : template;

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
        files: projectOf(row, template),
        hosts: ROW_HOSTS[row] ?? [],
      })),
    ),
    ...DECLARED_REFUSALS.flatMap((declared) => [
      {
        name: `${declared.row} ${declared.position}, refused`,
        files: projectOf(declared.row, declared.refused),
        hosts: ROW_HOSTS[declared.row] ?? [],
        refusal: declared.text,
      },
      {
        name: `${declared.row} ${declared.position}, admitted`,
        files: projectOf(declared.row, declared.admitted),
        hosts: ROW_HOSTS[declared.row] ?? [],
      },
    ]),
    ...ANSWERED_AS_TODAY.map((source) => ({
      name: `as today: ${source}`,
      files: [{ path: "main.tease", source: script(source) }],
      hosts: [],
      asToday: true as const,
    })),
  ];
}

/** A run's failure as the record writes it: the code at the span of `at` in the source, or `null` without one. */
const failureAt = (source: string, code: string, at: string | null): string | null =>
  at === null ? null : `${code}@${source.indexOf(at)}:${source.indexOf(at) + at.length}`;

/** The guard's failures for one case's record; `seen` collects each declared difference that occurred, by mode. */
function judge(guardCase: GuardCase, record: DifferentialRecord, seen: Set<string>): string[] {
  const failures: string[] = [];
  const { checker } = record;
  const source = guardCase.files[0]!.source;
  if (guardCase.asToday === true) {
    if (checker.threw !== undefined || checker.plan)
      return [`${record.name}: today's checker publishes a plan or throws`];
    for (const mode of record.candidate.modes)
      if (
        mode.outside !== undefined ||
        mode.threw !== undefined ||
        mode.plan ||
        JSON.stringify(diagnosed(mode)) !== JSON.stringify(diagnosed(checker))
      )
        failures.push(
          `${record.name} [${mode.mode}]: not today's answer: ${mode.outside ?? mode.threw ?? JSON.stringify(diagnosed(mode))}`,
        );
    return failures;
  }
  const modes = record.candidate.modes.map((mode) => mode.mode);
  if (JSON.stringify(modes) !== JSON.stringify(HELD_MODES.map((mode) => mode.name)))
    failures.push(`${record.name}: the record's modes are ${modes.join(", ")}, not the held modes`);
  // a declared refusal publishes nothing, whatever today's checker answers
  if (guardCase.refusal !== undefined) {
    for (const mode of record.candidate.modes)
      if (mode.outside !== guardCase.refusal)
        failures.push(
          `${record.name} [${mode.mode}]: the declared refusal "${guardCase.refusal}" no longer occurs`,
        );
    return failures;
  }
  if (checker.threw !== undefined || !checker.plan)
    return [
      ...failures,
      `${record.name}: today's checker publishes no plan (${checker.threw ?? JSON.stringify(checker.diagnostics)})`,
    ];
  const declared = DECLARED_RUN_DIFFERENCES.find(
    (difference) => script(difference.template) === source,
  );
  for (const mode of record.candidate.modes) {
    const at = `${record.name} [${mode.mode}]`;
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
        run.failure === failureAt(source, declared.code, declared.todayAt) &&
        other?.failure === failureAt(source, declared.code, declared.at) &&
        mode.plan?.checks.some(
          (check) =>
            check.field === declared.field &&
            check.path === "main.tease" &&
            check.offset === source.indexOf(declared.checkAt) &&
            check.end === source.indexOf(declared.checkAt) + declared.checkAt.length,
        )
      ) {
        seen.add(`${declared.template} [${mode.mode}]`);
        return;
      }
      failures.push(
        `${at}: rule 3, run ${JSON.stringify([...DOMAIN, ...guardCase.hosts][index])}: today ${outcome(run)}, route ${outcome(other)}`,
      );
    });
  }
  return failures;
}

test("every open row of the syntax table has templates, and the declared lists name only open rows and templates", () => {
  // EVIDENCE: invariant: the templates' keys are AST kinds (`ROW_TEMPLATES`' type).
  assert.deepEqual((Object.keys(ROW_TEMPLATES) as SyntaxKind[]).sort(), [...OPEN].sort());
  for (const declared of DECLARED_REFUSALS) assert.ok(OPEN.includes(declared.row), declared.row);
  // each `pass` row's operand position is a cited operand of its row, and each cited operand has a position
  for (const row of OPEN) {
    const disposition = DISPOSITIONS[row];
    if (disposition.row !== "pass") continue;
    assert.deepEqual(
      Object.keys(OPERAND_TEMPLATES[row] ?? {}).sort(),
      Object.keys(disposition.operands).sort(),
      row,
    );
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
  // (whichever refusal comes first: at a command's operand, the operand table's)
  const refused = DECLARED_REFUSALS.filter((declared) =>
    declared.position.endsWith("with a typed default"),
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
