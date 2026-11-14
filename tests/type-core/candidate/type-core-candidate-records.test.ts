// The candidate route's record loop: each fixture record inside the slice planned and run as its record derives, and
// the derived (S7) oracle it is checked against.

import assert from "node:assert/strict";
import test from "node:test";

import {
  compileProjectWithBackend,
  compileSourceWithBackend,
  type CompilationResult,
} from "../../../src/compiler.js";
import { type SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { reportedDiagnostics } from "../../../src/type-inference/core/check-result/check-result.js";
import { VALUE_KIND_NAMES } from "../../../src/value-kinds.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  derivedText,
  syntaxOf,
  Underivable,
} from "../../helpers/type-core/derived/type-core-derived.js";
import { derive } from "../../helpers/type-core/derived/type-core-derived-checks.js";
import { companions } from "../../helpers/type-core/derived/type-core-derived-companions.js";
import {
  evaluate,
  type CheckEvent,
  type PredictedRun,
} from "../../helpers/type-core/derived/type-core-derived-runs.js";
import {
  type FixtureRecord,
  heldBack,
  readFixture,
} from "../../helpers/type-core/type-core-fixture.js";
import { evaluateProject } from "../../helpers/type-core/derived/derived-transfers.js";
import {
  assignments,
  derivedContent,
  derivedStores,
  planOfFile,
  plannedContent,
  plannedStores,
  recordOfFile,
  runGlobals,
} from "../../helpers/type-core-route.js";
import { recordDifferences } from "../../helpers/type-core-records.js";
import {
  OPTIONS,
  candidate,
  insideSlice,
  inBothOrders,
} from "../../helpers/type-core/type-core-candidate-setup.js";

/** The code a checked store fails with (S3). */
const STORE_CODES: readonly (string | null)[] = ["TSR058"];

/**
 * The codes each runtime discharge fails with, as the derived evaluation gives them: a whole-number use at a count or an
 * index, an element of an empty list, a member a receiver may lack or not be able to hold, a selected fallback; a typed
 * parse's or load's reading never fails (`null`, its event).
 */
const NATIVE_CODES: Readonly<Record<string, readonly (string | null)[]>> = {
  "integer-use": ["TSR024", "TSR043"],
  // (C13, S9b: a loop's own check of its source, a call's of its argument)
  iteration: ["TSR044"],
  argument: ["TSV043", "TSV042", "TSR024"],
  empty: ["TSR018", "TSR019"],
  member: ["TSR003", "TSR004", "TSR008", "TSR016", "TSR017", "TSR061", "TSR062"],
  fallback: ["TSR058"],
  "typed-ingress": [null],
};

/**
 * The reached fixture, derived from its records (S6-CARRIERS revision 5; the lead's answer 3). Every
 * record of the positive list (the cells test's: all but those `heldBack` names) is tried on the candidate route in both
 * orders. A record the route accepts is checked in four layers, each derived from the record and its source alone:
 * - **records:** its C1 and C2 diagnostics at their whole sites, its obligations exactly (the cells test's comparison),
 *   and a plan exactly where it is not a compile error, alike on the one-file route;
 * - **discharges:** each obligation discharged by one rule (`derive`), a checked store or the runtime;
 * - **checked stores:** the plan's are exactly the derived ones, target, spans and whole type;
 * - **runs:** the original as written, its outcome with each host input at the value that fits the earliest check it
 *   feeds, and the original and every companion under every assignment of the domain to their host inputs, each
 *   predicted by the rules and run on the engine. A companion keeps its record's spans, kinds and decisions, so it
 *   compiles on the route with the record's derived checked stores, or the test fails (Codex r20 H1).
 * Each discharge is then classified by the runs: violable (a run fails there), preempted (a value that violates it
 * always fails an earlier check first), not violable (no derived value violates it) or unreachable (no run evaluates
 * it). A record the route rejects (`CandidateOutsideSlice`) is counted by its first construct outside the slice.
 */
/** The codes of each record kind's rules on the route (D3): a store's or a literal's, a count's or an index's, a member's. */
const RECORD_CODES: Readonly<Record<string, readonly string[]>> = {
  "written-target": ["TSV041", "TSV044"],
  "integer-use": ["TSV011", "TSV043"],
  // (C13: a `for` loop's iterable, a method's argument; the elements a `join` or a `sort` reads are a member's)
  operator: ["TSV012", "TSV043"],
  "member-read": ["TSV042", "TSV043"],
  // (the checks that owe the runtime nothing, `staticCode`: a repeat count, a conversion, an empty range, a fallback
  // never used)
  static: ["TSV011", "TSV043", "TSV046", "TSV062"],
};

type ExpectedDiagnostic = ReturnType<typeof readFixture>[number]["expected"]["diagnostics"][number];

/**
 * The route's diagnostics and a record's that no one-to-one pairing matches (D2, D3): each reported diagnostic paired
 * with its own expected one of its severity, at its whole site, with a code of the expected kind's rules. Kinds share a
 * code, so the pairing is a matching (by augmenting paths), not a first fit.
 */
function unmatchedDiagnostics(
  reported: CompilationResult["diagnostics"],
  expected: readonly ExpectedDiagnostic[],
): string[] {
  const fits = (
    diagnostic: CompilationResult["diagnostics"][number],
    wanted: ExpectedDiagnostic,
  ): boolean =>
    // (a project's diagnostic stands in its expected entry's file)
    (!("path" in diagnostic) || diagnostic.path === wanted.site.file) &&
    (wanted.class === "compile-error" ? "error" : "warning") === diagnostic.severity &&
    wanted.site.offset === diagnostic.span.start.offset &&
    wanted.site.end === diagnostic.span.end.offset &&
    RECORD_CODES[wanted.kind]?.includes(diagnostic.code) === true;
  const pairedWith = expected.map((): number => -1);
  const pair = (index: number, seen: Set<number>): boolean =>
    expected.some((wanted, at) => {
      if (seen.has(at) || !fits(reported[index]!, wanted)) return false;
      seen.add(at);
      if (pairedWith[at] !== -1 && !pair(pairedWith[at]!, seen)) return false;
      pairedWith[at] = index;
      return true;
    });
  return [
    ...reported
      .filter((_, index) => !pair(index, new Set()))
      .map(
        (diagnostic) =>
          `reported ${diagnostic.severity} ${diagnostic.code} ${diagnostic.span.start.offset}:${diagnostic.span.end.offset}`,
      ),
    ...expected
      .filter((_, at) => pairedWith[at] === -1)
      .map(
        (wanted) =>
          `expected ${wanted.class} ${wanted.kind} ${wanted.site.offset}:${wanted.site.end}`,
      ),
  ];
}

test("the route's diagnostics pair one to one with a record's, so one expected diagnostic never answers two (D2, D3)", () => {
  // a member read of host data: a store's warning and the member's, both at `v.n`
  const record = readFixture().find(
    (found) => found.name === "cp9-cells/r46/m3/sol-m3/external-30",
  );
  assert.ok(record !== undefined);
  const reported = compileProjectWithBackend(
    record.files,
    OPTIONS,
    CORE_BACKEND,
  ).diagnostics.filter(
    (diagnostic) => diagnostic.code === "TSV041" || diagnostic.code === "TSV043",
  );
  assert.deepEqual(reported.map((diagnostic) => diagnostic.code).sort(), ["TSV041", "TSV043"]);
  assert.deepEqual(unmatchedDiagnostics(reported, record.expected.diagnostics), []);
  // the member's code replaced by the store's: the store's expected diagnostic cannot answer both
  const twice = reported.map((diagnostic) => ({ ...diagnostic, code: "TSV041" }));
  assert.equal(unmatchedDiagnostics(twice, record.expected.diagnostics).length, 2);
});

/**
 * Projects of two files inside the slice, recorded by today's analysis: the record loop's own cases of several files, which
 * no fixture record inside the slice has. Each second file holds a checked store at the first file's offsets.
 */
function projectRecords(): FixtureRecord[] {
  const projects = [
    ["let n: integer = hostValue\nexit\n", "let z: integer = hostValue\nexit\n"],
    [
      'let n: integer = load "a", default: hostValue\nexit\n',
      'let z: integer = load "b", default: hostValue\nexit\n',
    ],
  ];
  return projects.map(([first, second], index) => {
    const files = [
      { path: "main.tease", source: first! },
      { path: "part.tease", source: second! },
    ];
    const request = coreRequest(files);
    assert.ok(request !== null, `project ${index}`);
    return {
      name: `two files ${index}`,
      cells: [],
      owner: null,
      files,
      expected: compactAnalysis(request),
    };
  });
}

test("every positive-list record the candidate route reaches plans and runs as its record derives, in both orders", (t) => {
  const routed = new Set(Object.values(RECORD_CODES).flat());
  const accepted: string[] = [];
  const outside = new Map<string, number>();
  const classes = new Map<string, number>();
  const originals = new Map<string, string | null>();
  const classOf = new Map<string, string>();
  const companionRuns = new Map<string, PredictedRun[]>();
  let positive = 0;
  let plans = 0;
  let projects = 0;
  let runs = 0;
  let compared = 0;
  for (const record of [...readFixture(), ...projectRecords()]) {
    if (heldBack(record) !== null) continue;
    positive += 1;
    let result: ReturnType<typeof compileProjectWithBackend>;
    try {
      result = inBothOrders(() => compileProjectWithBackend(record.files, OPTIONS, CORE_BACKEND));
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      const what = record.files.length > 1 ? "several files" : error.what.replace(/^this /, "");
      outside.set(what, (outside.get(what) ?? 0) + 1);
      continue;
    }
    accepted.push(record.name);
    if (record.files.length > 1) projects += 1;
    // records: the diagnostics at their whole sites, each with a code of its kind's rules (D2, D3), the obligations
    // exactly, alike on the one-file route
    const reported = (compiled: Pick<CompilationResult, "diagnostics">) =>
      compiled.diagnostics.filter((diagnostic) => routed.has(diagnostic.code));
    const diagnosed = (compiled: Pick<CompilationResult, "diagnostics">): string[] =>
      reported(compiled)
        .map(
          (diagnostic) =>
            `${diagnostic.severity} ${diagnostic.code} ${diagnostic.span.start.offset}:${diagnostic.span.end.offset} ` +
            diagnostic.message,
        )
        .sort();
    const request = coreRequest(record.files);
    assert.ok(request !== null, record.name);
    // the project's files in project order: the session starts in the first, and inside the slice nothing transfers to
    // another (no `goto` or `call`), so the runs are the first file's, and the stores and content each file's own
    const source = request.files[0]!.source;
    // (a warning on a line that never runs is the record's, but the compiler reports the line instead, #1195)
    const analysis = analyseCore(request);
    const shown = new Set(reportedDiagnostics(analysis));
    const silent = analysis.diagnostics.filter((diagnostic) => !shown.has(diagnostic));
    const expected = [...record.expected.diagnostics];
    for (const quiet of silent) {
      const at = expected.findIndex(
        (wanted) =>
          wanted.class === quiet.class &&
          wanted.kind === quiet.kind &&
          wanted.site.file === request.files[quiet.site.file]!.path &&
          wanted.site.offset === quiet.site.start &&
          wanted.site.end === quiet.site.end,
      );
      assert.ok(at >= 0, record.name);
      expected.splice(at, 1);
    }
    assert.deepEqual(unmatchedDiagnostics(reported(result), expected), [], record.name);
    assert.deepEqual(recordDifferences(record.expected, compactAnalysis(request)), [], record.name);
    assert.equal(result.plan === null, record.expected.outcome === "compile-error", record.name);
    // a record of one file compiles alike on the one-file route
    const single = record.files.length === 1 ? inBothOrders(() => candidate(source)) : null;
    if (single !== null)
      assert.deepEqual(diagnosed(single), diagnosed(result), `${record.name}: the one-file route`);
    if (result.plan === null) continue;
    plans += 1;
    // each file's discharges and checked stores, by rule, from its own source and its record's entries (a construct the
    // rules do not cover fails here, named); the first file's syntax serves every evaluation of it below
    const derivedFiles = request.files.map((file) => {
      try {
        const fileSyntax = syntaxOf(file.source);
        // (with every file's syntax, whose `global function`s its calls may name)
        const project = request.files.map((each) => syntaxOf(each.source));
        return [
          fileSyntax,
          derive(fileSyntax, recordOfFile(record.expected, file.path), project),
        ] as const;
      } catch (error) {
        if (error instanceof Underivable)
          throw new Error(`${record.name}: ${file.path} underivable: ${error.message}`);
        throw error;
      }
    });
    const [syntax, { stores, discharges, content }] = derivedFiles[0]!;
    for (const [index, file] of request.files.entries()) {
      const fileDerived = derivedFiles[index]![1];
      const filePlan = planOfFile(result.plan, file.path);
      assert.deepEqual(
        plannedContent(filePlan, file.source),
        derivedContent(fileDerived.content, file.source),
        `${record.name}: S7 content of ${file.path}`,
      );
      assert.deepEqual(
        plannedStores(filePlan),
        derivedStores(fileDerived.stores),
        `${record.name}: the checked stores of ${file.path}`,
      );
    }
    if (single !== null) {
      assert.deepEqual(
        plannedContent(single.plan!, source),
        derivedContent(content, source),
        `${record.name}: one-file S7 content`,
      );
      assert.deepEqual(
        plannedStores(single.plan!),
        derivedStores(stores),
        `${record.name}: the one-file route's`,
      );
    }
    // runs: the original under every assignment of its host input (in the domain's order), each run once, predicted
    // stopping at its first failing check and evaluated through every check (for the discharges)
    const plan = result.plan;
    // (across the record's files, from its first: a transfer starts the file it names, `derived-transfers.ts`)
    const project = request.files.map((file, index) => ({
      path: file.path,
      syntax: derivedFiles[index]![0],
      ...derivedFiles[index]![1],
    }));
    const own = assignments(["hostValue"]).map((inputs) => ({
      inputs,
      ran: runGlobals(plan, inputs),
      predicted: evaluateProject(project, inputs).run,
      events: evaluateProject(project, inputs, true).events,
    }));
    // the original, as written: each input at the value fitting the earliest check it feeds
    const original =
      own.find(({ events }) => {
        const fed = events.find((event) => event.from.has("hostValue"));
        return fed === undefined || fed.fits;
      }) ?? own[0]!;
    assert.deepEqual(original.ran, original.predicted, `${record.name}: the original`);
    originals.set(record.name, original.ran.failure);
    compared += 1;
    // under every assignment: a violating value stops at its check, as derived
    const observed: { run: PredictedRun; events: readonly CheckEvent[] }[] = [];
    for (const { inputs, ran, predicted, events } of own) {
      assert.deepEqual(
        ran,
        predicted,
        `${record.name}, the original with ${JSON.stringify(inputs)}`,
      );
      observed.push({ run: ran, events });
      runs += 1;
      compared += 1;
    }
    // the companions with the same checked stores, under every assignment of their inputs
    const ranCompanions = companionRuns.get(record.name) ?? [];
    for (const companion of companions(syntax)) {
      const compiled = insideSlice(() =>
        inBothOrders(() =>
          compileSourceWithBackend(
            companion.source,
            { globals: [...companion.globals] },
            CORE_BACKEND,
          ),
        ),
      );
      const at = `${record.name}, companion ${companion.label}`;
      assert.ok(compiled !== null, `${at}: inside the slice`);
      assert.ok(compiled.plan !== null, `${at}: a plan`);
      assert.deepEqual(
        plannedStores(compiled.plan),
        derivedStores(stores),
        `${at}: the checked stores`,
      );
      const companionSyntax = syntaxOf(companion.source);
      const companionContent = derive(
        companionSyntax,
        recordOfFile(record.expected, record.files[0]!.path),
      ).content;
      assert.deepEqual(
        plannedContent(compiled.plan, companion.source),
        derivedContent(companionContent, companion.source),
        `${at}: S7 content`,
      );
      for (const inputs of assignments(companion.globals)) {
        const ran = runGlobals(compiled.plan, inputs);
        assert.deepEqual(
          ran,
          evaluate(companionSyntax, stores, inputs, false, companionContent).run,
          `${record.name}, companion ${companion.label}, with ${JSON.stringify(inputs)}`,
        );
        observed.push({
          run: ran,
          events: evaluate(companionSyntax, stores, inputs, true, companionContent).events,
        });
        ranCompanions.push(ran);
        runs += 1;
        compared += 1;
      }
    }
    if (ranCompanions.length > 0) companionRuns.set(record.name, ranCompanions);
    // each discharge classified by the runs: a store's at its value, the runtime's at its use, each by its own check
    for (const discharge of discharges) {
      if (discharge.by === "native" && discharge.what === "representable") {
        classes.set(
          "not violable (representable)",
          (classes.get("not violable (representable)") ?? 0) + 1,
        );
        continue;
      }
      const named =
        discharge.by === "store"
          ? `${discharge.store.valueSo}:${discharge.store.valueEo}`
          : discharge.site;
      // each discharge by its own check's codes, never another's at the same site
      const codes = discharge.by === "store" ? STORE_CODES : (NATIVE_CODES[discharge.what] ?? []);
      const own = (code: string | null): boolean => codes.includes(code);
      const key = `${record.name}#${discharge.by === "store" ? "store" : discharge.what}@${named}`;
      if (classOf.has(key)) continue;
      const ownAt = (event: CheckEvent): boolean => event.site === named && own(event.code);
      const verdict = observed.some(({ run: ran }) => {
        const [code, at] = ran.failure?.split("@") ?? [];
        return at === named && own(code ?? null);
      })
        ? "violable"
        : observed.some(({ events }) => events.some((event) => ownAt(event) && !event.fits))
          ? "preempted"
          : observed.some(({ events }) => events.some(ownAt))
            ? "not violable"
            : "unreachable";
      classOf.set(key, verdict);
      classes.set(verdict, (classes.get(verdict) ?? 0) + 1);
    }
  }
  const counted = [...outside.values()].reduce((sum, count) => sum + count, 0);
  const listed = (map: ReadonlyMap<string, number>): string =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .map(([what, count]) => `${what} ${count}`)
      .join(", ");
  t.diagnostic(
    `${positive} positive-list records: ${accepted.length} on the candidate route (${projects} of several files), ` +
      `${plans} with a plan, ${runs} ` +
      `runs, ${compared} comparisons with a predicted run (each original's is its fitting assignment's run); ` +
      `discharges: ${listed(classes)}; outside the candidate slice (later port steps): ${listed(outside)}`,
  );
  assert.equal(accepted.length + counted, positive);
  // each project of `projectRecords` went through the loop, not around it
  assert.equal(projects, projectRecords().length);
  // the literal witnesses of the rules: each class and each original outcome the note names
  // each discharge by its kind and site: two at one site are classified each by its own check
  const verdicts: readonly (readonly [string, string, string])[] = [
    ["cp9-cells/r6-bugs/admission/use-before-overwrite", "integer-use@38:43", "preempted"],
    ["cp9-cells/r6-bugs/admission/use-before-overwrite", "store@12:30", "violable"],
    ["cp9-cells/s4/s6/owner/ingress/dead-consumer", "integer-use@42:47", "unreachable"],
    ["cp9-cells/s4/s6/owner/ingress/dead-consumer", "store@9:23", "violable"],
    ["cp9-cells/s4/followup/fit/literal-mixed-repeat", "integer-use@7:18", "violable"],
    ["cp9-cells/r46/m3/two-ingress-targets", "store@59:63", "violable"],
    ["cp9-cells/r46/m3/two-ingress-targets", "store@80:84", "violable"],
    // a member check and a count at one site: the run fails the member first, or the count with the member there
    ["cp9-cells/witness/sol-missing-member-direct", "member@54:62", "violable"],
    ["cp9-cells/witness/sol-missing-member-direct", "integer-use@54:62", "preempted"],
    ["cp9-cells/r44/own-selector/own-last-count", "member@27:33", "not violable"],
    ["cp9-cells/r44/own-selector/own-last-count", "integer-use@27:33", "violable"],
  ];
  assert.deepEqual(
    verdicts.map(([name, at]) => `${name}#${at} ${classOf.get(`${name}#${at}`)}`),
    verdicts.map(([name, at, verdict]) => `${name}#${at} ${verdict}`),
    JSON.stringify(
      [...classOf].filter(([key]) => verdicts.some(([name]) => key.startsWith(`${name}#`))),
    ),
  );
  for (const [name, failure] of [
    ["cp9-cells/X5/outside-definition", "TSR043@28:29"],
    ["cp9-cells/r46/m3/two-ingress-targets", "TSR058@80:84"],
    ["cp9-cells/review/list-position-absent", "TSR025@33:34"],
    ["cp9-cells/r46/m3/empty-index", "TSR025@30:31"],
    ["cp9-cells/s4/followup/fit/literal-mixed-repeat", null],
  ] as const)
    assert.equal(originals.get(name), failure, `${name}: the original`);
  // a companion gives what the original cannot: X5's integer writer and two-ingress-targets' independent inputs halt
  for (const name of ["cp9-cells/X5/outside-definition", "cp9-cells/r46/m3/two-ingress-targets"])
    assert.ok(
      companionRuns
        .get(name)
        ?.some((ran) => ran.status === "halted" && ran.said.at(-1)?.text === "AFTER"),
      `${name}: a fitting companion says AFTER and halts`,
    );
  // a record of the set for each cell of the slice (the pull request lists every record inside it; stage 3b's
  // `r7-bugs/m2/host-local` waits with S10)
  for (const name of [
    "cp9-cells/F1/let",
    "cp9-cells/F2/written-pass",
    "cp9-cells/F2/written-fail",
    "cp9-cells/F3/whole",
    "cp9-cells/F12/0",
    "cp9-cells/X1/dead",
    "cp9-cells/X5/outside-definition",
    "cp9-cells/C1/fail",
    "cp9-cells/C2/fail",
    "cp9-cells/A1/fail",
    "cp9-cells/A3/numeric-family",
    "cp9-cells/P7/repeat-zero",
    "cp9-cells/review/list-position-absent",
    "cp9-cells/r8/written-list/mixed",
  ])
    assert.ok(accepted.includes(name), `${name} inside the slice`);
});

test("a two-file project inside the slice: its first file's oracle is the one-file oracle's, its second file's its own", () => {
  // the second file runs nothing inside the slice (no `goto` or `call` reaches it), and holds a checked store of its own
  const second = { path: "part.tease", source: "let late: integer = hostValue\nexit\n" };
  let checked = 0;
  for (const record of readFixture()) {
    if (heldBack(record) !== null || record.files.length !== 1) continue;
    const source = record.files[0]!.source;
    const files = [{ path: "main.tease", source }, second];
    const one = insideSlice(() => candidate(source));
    if (one === null || one.plan === null) continue;
    const both = compileProjectWithBackend(files, OPTIONS, CORE_BACKEND);
    assert.ok(both.plan !== null, record.name);
    const request = coreRequest(files);
    assert.ok(request !== null, record.name);
    const projectRecord = compactAnalysis(request);
    // the first file: the one-file oracle's derivation, stores, content and runs
    const syntax = syntaxOf(source);
    const alone = derive(syntax, record.expected);
    const first = derive(syntax, recordOfFile(projectRecord, "main.tease"));
    assert.deepEqual(derivedStores(first.stores), derivedStores(alone.stores), record.name);
    assert.deepEqual(
      derivedContent(first.content, source),
      derivedContent(alone.content, source),
      record.name,
    );
    const firstPlan = planOfFile(both.plan, "main.tease");
    assert.deepEqual(plannedStores(firstPlan), plannedStores(one.plan), record.name);
    assert.deepEqual(
      plannedContent(firstPlan, source),
      plannedContent(one.plan, source),
      record.name,
    );
    for (const inputs of assignments(["hostValue"]))
      assert.deepEqual(runGlobals(both.plan, inputs), runGlobals(one.plan, inputs), record.name);
    // the second file: its own stores, derived from its source and its entries of the project's record
    const secondDerived = derive(syntaxOf(second.source), recordOfFile(projectRecord, second.path));
    assert.deepEqual(
      plannedStores(planOfFile(both.plan, second.path)),
      derivedStores(secondDerived.stores),
      record.name,
    );
    assert.equal(secondDerived.stores.length, 1, record.name);
    checked += 1;
  }
  assert.ok(checked >= 50, `${checked} records`);
});

test("the S7 oracle derives receiving written types and observes native discharges", () => {
  for (const [prefix, initializer] of [
    ["let out: number = ", 'fromJson("2.5", default: 0, files: false)'],
    ["let out: number = ", 'load("count", default: 0)'],
    ["let out: number? = 0\nout = ", 'fromJson("2.5", default: null, files: false)'],
    ["let out: number? = 0\nout = ", 'load("count", default: 0)'],
    ["let out: number? = ", 'fromJson("null", default: 0, files: false)'],
  ] as const) {
    const source = `${prefix}${initializer}\nsay out\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const syntax = syntaxOf(source);
    const derived = derive(syntax, compactAnalysis(request));
    const owner = `${prefix.length}:${source.indexOf("\n", prefix.length)}`;
    assert.deepEqual(
      derivedContent(derived.content, source),
      [
        initializer.startsWith("load")
          ? `load ${owner} ${prefix.includes("number?") ? "null|number" : "number"} repair=false`
          : `expected ${owner} ${prefix.includes("number?") ? "null|number" : "number"}`,
      ],
      source,
    );
    const compiled = candidate(source);
    assert.ok(compiled.plan !== null, source);
    assert.deepEqual(
      plannedContent(compiled.plan, source),
      derivedContent(derived.content, source),
      source,
    );
    assert.deepEqual(
      runGlobals(compiled.plan, {}),
      evaluate(syntax, derived.stores, {}, false, derived.content).run,
      source,
    );
  }
  for (const operand of ['load("count", default: 0)', 'fromJson("1", default: 0, files: false)']) {
    const source = `say ${operand}\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const syntax = syntaxOf(source);
    const derived = derive(syntax, compactAnalysis(request));
    const ingress = derived.discharges.filter(
      (entry) => entry.by === "native" && entry.what === "typed-ingress",
    );
    assert.equal(ingress.length, 1, source);
    const predicted = evaluate(syntax, derived.stores, {}, false, derived.content);
    assert.ok(
      predicted.events.some((event) => event.site === `4:${source.indexOf("\n")}` && event.fits),
      source,
    );
    const compiled = candidate(source);
    assert.ok(compiled.plan !== null, source);
    assert.deepEqual(runGlobals(compiled.plan, {}), predicted.run, source);
  }
  for (const access of ["v.first", "v.last", "v[0]"]) {
    const source = `let v = hostValue\nlet out: integer = ${access}\nsay out\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const syntax = syntaxOf(source);
    const derived = derive(syntax, compactAnalysis(request));
    const accessSite = `${source.indexOf(access)}:${source.indexOf(access) + access.length}`;
    assert.ok(
      derived.discharges.some(
        (entry) => entry.by === "native" && entry.what === "member" && entry.site === accessSite,
      ),
      source,
    );
    if (access !== "v[0]")
      assert.ok(
        derived.discharges.some(
          (entry) => entry.by === "native" && entry.what === "empty" && entry.site === accessSite,
        ),
        source,
      );
    const compiled = candidate(source);
    assert.ok(compiled.plan !== null, source);
    for (const hostValue of [
      null,
      { kind: "list", items: [] },
      { kind: "list", items: [2] },
      { kind: "set", items: [] },
      { kind: "dict", entries: [] },
    ] satisfies SerializableRuntimeValue[]) {
      const predicted = evaluate(syntax, derived.stores, { hostValue }, false, derived.content);
      assert.deepEqual(
        runGlobals(compiled.plan, { hostValue }),
        predicted.run,
        `${access}: ${JSON.stringify(hostValue)}`,
      );
      if (hostValue?.kind === "list" && hostValue.items.length === 0)
        assert.equal(
          predicted.run.failure,
          access === "v[0]"
            ? `TSR025@${source.indexOf("0]")}:${source.indexOf("0]") + 1}`
            : `TSR018@${accessSite}`,
          source,
        );
    }
  }
});

const cases = [
  ["let p = {n: 1}\np = hostValue\nsay p.n\nexit\n", "store", "{n: integer}"],
  [
    "let p = {stats: {n: 1}}\np = hostValue\nsay p.stats.n\nexit\n",
    "store",
    "{stats: {n: integer}}",
  ],
  ["let p: object = {n: 1}\np = hostValue\nsay p.n\nexit\n", "store", "{}"],
  // a copied written `object` stays any object below it, its neighbours restricted, no field read (#1215)
  ['let typed: object = {n: 1}\nlet p = typed\np = hostValue\nsay "DONE"\nexit\n', "store", "{}"],
  [
    'let typed: object? = {n: 1}\nlet p = typed\np = hostValue\nsay "DONE"\nexit\n',
    "store",
    "null|{}",
  ],
  [
    'let typed: object[] = [{n: 1}]\nlet p = typed\np = hostValue\nsay "DONE"\nexit\n',
    "store",
    "list<{}>",
  ],
  [
    'let typed: object = {n: 1}\nlet a = typed\nlet b = a\nlet p = b\np = hostValue\nsay "DONE"\nexit\n',
    "store",
    "{}",
  ],
  [
    'let typed: object = {n: 1}\nlet rec = {o: typed}\nlet p = rec.o\np = hostValue\nsay "DONE"\nexit\n',
    "store",
    "{}",
  ],
  [
    'let typed: object = {n: 1}\nlet p = {o: typed}\np = hostValue\nsay "DONE"\nexit\n',
    "store",
    "{o: {}}",
  ],
  [
    'let typed: object = {n: 1}\nlet count: integer = 2\nlet p = {c: count, o: typed}\np = hostValue\nsay "DONE"\nexit\n',
    "store",
    "{c: integer, o: {}}",
  ],
  ['let rec = {n: 1}\nlet p = rec\np = hostValue\nsay "DONE"\nexit\n', "store", "{n: integer}"],
  // a written `list` destination's open element takes a typed parse's open default (Sol's r1 B2 on #1218)
  [
    'let p: list = fromJson(hostValue, default: [], files: false)\nsay "DONE"\nexit\n',
    "expected",
    "list<any>",
  ],
  [
    "let p = fromJson(hostValue, default: [{stats: {n: 0}}, {stats: {n: 1.5}}], files: false)\nsay p[0].stats.n\nexit\n",
    "expected",
    "list<{stats: {n: number}}>",
  ],
  [
    'let p = fromJson(hostValue, default: fromJson("{}", default: {n: 0}, files: false), files: false)\nsay p.n\nexit\n',
    "expected",
    "{n: integer}",
  ],
  [
    'let p = fromJson(hostValue, default: load("p", default: {n: 0}), files: false)\nsay p.n\nexit\n',
    "expected",
    "{n: integer}",
  ],
  [
    "let xs: number[] = [fromJson(hostValue, default: 0, files: false)]\nsay xs[0]\nexit\n",
    "expected",
    "number",
  ],
  [
    'let n: number? = fromJson(hostValue, default: 0, files: false) otherwise fromJson("2.5", default: 0, files: false)\nsay n\nexit\n',
    "expected",
    "null|number",
  ],
  [
    // a `null` field of the default that nothing else types stays unknown (ADR 0021 2.6)
    "let p = fromJson(hostValue, default: {n: null, m: 0}, files: false)\nsay p.m\nexit\n",
    "expected",
    `{n: ${derivedText({ kind: "kinds", kinds: VALUE_KIND_NAMES })}, m: integer}`,
  ],
  // a written `object` reads the default's properties with their types and keeps every other key, at every level of
  // it, as an optional's member and as a list's element (#1223)
  [
    "let p: object = fromJson(hostValue, default: {n: 0, k: null}, files: false)\nsay p.n\nsay p.m\nexit\n",
    "expected",
    `{n: integer, k: ${derivedText({ kind: "kinds", kinds: VALUE_KIND_NAMES })}, ...}`,
  ],
  [
    'let p: object = load("p", default: {n: 0})\nsay p.n\nexit\n',
    "load",
    "{n: integer, ...} repair=true",
  ],
  [
    'let p: object? = fromJson(hostValue, default: {a: {n: 0}, xs: [{m: 1.5}]}, files: false)\nsay "DONE"\nexit\n',
    "expected",
    "null|{a: {n: integer, ...}, xs: list<{m: number, ...}>, ...}",
  ],
  [
    'let p: object[] = fromJson(hostValue, default: [{n: 0}], files: false)\nsay "DONE"\nexit\n',
    "expected",
    "list<{n: integer, ...}>",
  ],
] as const;
const inputs: readonly SerializableRuntimeValue[] = [
  // the fixture route's domain
  2,
  "text",
  true,
  2.5,
  null,
  "null",
  "1.5",
  "{}",
  '{"n":3}',
  '{"stats":{"n":3}}',
  // (#1223: other keys beside a wrong or missing field, at two levels and in a list)
  '{"n":"text","m":1}',
  '{"a":{"n":"text","extra":2},"xs":[{"m":2,"z":3}],"other":3}',
  '[{"n":1,"m":2}]',
  { kind: "object", properties: [{ name: "n", value: 3 }] },
  { kind: "object", properties: [{ name: "n", value: "bad" }] },
  {
    kind: "object",
    properties: [
      { name: "stats", value: { kind: "object", properties: [{ name: "n", value: 3 }] } },
    ],
  },
  // (#1215: an absent field, a fresh object, lists, a nested field and a misfitting field beside)
  { kind: "object", properties: [] },
  { kind: "object", properties: [{ name: "m", value: true }] },
  { kind: "list", items: [{ kind: "object", properties: [{ name: "n", value: "bad" }] }] },
  { kind: "list", items: [2] },
  {
    kind: "object",
    properties: [
      { name: "c", value: 1 },
      { name: "o", value: { kind: "object", properties: [{ name: "n", value: "bad" }] } },
    ],
  },
  {
    kind: "object",
    properties: [
      { name: "c", value: "bad" },
      { name: "o", value: { kind: "object", properties: [{ name: "n", value: 1 }] } },
    ],
  },
  {
    kind: "object",
    properties: [
      { name: "c", value: 1 },
      { name: "o", value: 2 },
    ],
  },
];

test("the S7 oracle derives object admissions and default structures from their source places", () => {
  const failures: string[] = [];
  for (const [source, check, expected] of cases) {
    try {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null);
      const syntax = syntaxOf(source);
      const derived = derive(syntax, compactAnalysis(request));
      const content = derivedContent(derived.content, source);
      assert.ok(
        (check === "store"
          ? derivedStores(derived.stores)
          : content.filter((entry) => entry.startsWith(`${check} `))
        ).some((entry) => entry.endsWith(` ${expected}`)),
        source,
      );
      const compiled = inBothOrders(() => candidate(source));
      assert.ok(compiled.plan !== null, source);
      assert.deepEqual(plannedStores(compiled.plan), derivedStores(derived.stores), source);
      assert.deepEqual(plannedContent(compiled.plan, source), content, source);
      for (const hostValue of inputs)
        assert.deepEqual(
          runGlobals(compiled.plan, { hostValue }),
          evaluate(syntax, derived.stores, { hostValue }, false, derived.content).run,
          `${source} with ${JSON.stringify(hostValue)}`,
        );
    } catch (error) {
      failures.push(`${source}\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

/**
 * The derived evaluator against the engine where a value is parenthesised (Codex r20 H4): a count's, an index's and a checked
 * store's failure is sited at the content, as the engine reports it, and the store's checked value span with it.
 */
test("the derived evaluator sites a parenthesised value's failure at its content, as the engine does", () => {
  for (const [source, hostValue, failure] of [
    ['repeat (hostValue) {\n  say "RUN"\n}\nexit\n', 2.5, "TSR043@8:17"],
    ["let xs = [1, 2]\nlet y = xs[(hostValue)]\nexit\n", 0.5, "TSR024@28:37"],
    ['let out = ([1, hostValue][1])\nsay "AFTER"\nexit\n', "text", "TSR058@11:28"],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const syntax = syntaxOf(source);
    const { stores } = derive(syntax, compactAnalysis(request));
    const compiled = inBothOrders(() => candidate(source));
    assert.ok(compiled.plan !== null, source);
    assert.deepEqual(plannedStores(compiled.plan), derivedStores(stores), source);
    const ran = runGlobals(compiled.plan, { hostValue });
    assert.equal(ran.failure, failure, source);
    assert.deepEqual(ran, evaluate(syntax, stores, { hostValue }).run, source);
  }
});
