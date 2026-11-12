import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { DISPOSITIONS, type SyntaxKind } from "../../src/type-inference/core/slice-syntax.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import {
  DECLARED_REFUSALS,
  DECLARED_RUN_DIFFERENCES,
  ROW_TEMPLATES,
} from "../helpers/type-core/row-templates.js";

/*
 * The row guard (#2500; #2488's design, Addition 2, "The row guard", with the lead's R8 and R9): every open row of the
 * candidate route's syntax table is compiled from its templates (`row-templates.ts`) by today's checker and by the
 * candidate route in the four held modes, through the differential record (`tests/families/differential.mjs`, on this
 * tree), and judged per source and mode: (1) the route publishes a plan, never refusing or throwing, except a refusal
 * `DECLARED_REFUSALS` names, which must occur; (2) every check today's plan carries is in the route's, by path, offsets
 * and field; (3) each run, with the host global at every value of the derived domain, ends as today's does (status and
 * failure, with its site), except a difference `DECLARED_RUN_DIFFERENCES` names, which must occur. No row cites a check
 * its instruction makes whatever the plan says, so rule 2 has no exception.
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
  readonly diagnostics?: readonly { readonly code: string; readonly message?: string }[];
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

const checkKey = (check: Check): string =>
  `${check.field} ${check.path}:${check.offset}:${check.end}`;
const outcome = (run: Run | undefined): string =>
  run === undefined ? "none" : (run.threw ?? `${run.status} ${run.failure}`);

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
      const start = guardCase.source.indexOf(declared?.at ?? "\0");
      if (
        declared !== undefined &&
        run.failure === null &&
        other?.failure === `${declared.code}@${start}:${start + declared.at.length}` &&
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
  for (const declared of DECLARED_RUN_DIFFERENCES) {
    assert.ok(Object.values(ROW_TEMPLATES).flat().includes(declared.template), declared.template);
    const at = declared.template.indexOf(declared.at);
    assert.ok(at >= 0 && at === declared.template.lastIndexOf(declared.at), declared.template);
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
