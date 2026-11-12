import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../src/compiler.js";
import { CONVERSIONS } from "../../src/conversions.js";
import { run } from "../../src/runtime/engine.js";
import type { RuntimeSnapshot } from "../../src/runtime/snapshot/state.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { VALUE_KINDS, type ValueKind } from "../../src/value-kinds.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import {
  checkKey,
  diagnosed,
  DOMAIN,
  type DifferentialRecord,
  type Entry,
  errorsOf,
  outcome,
  records,
} from "../helpers/type-core/row-guard-records.js";
import {
  CONTEXTS,
  CONVERSION_INPUTS,
  DECLARED_REFUSALS,
  DECLARED_RULE_DIFFERENCES,
  HOST_VALUES,
  HOSTLESS_VALUES,
  FAILING_PRODUCER,
  filesOf,
  OPERAND_TEMPLATES,
  PAIRED_SAMPLES,
  type Sample,
  samples,
  twinCommand,
} from "../helpers/type-core/row-templates.js";

/*
 * The command operand positions' declared rule differences (#2488's design rulings, R2, keyed by position as the lead's
 * R14 has it; `DECLARED_RULE_DIFFERENCES`): each command operand position holds a value of every kind from every origin
 * (`samples`), compiled by today's checker and by the candidate route in the four held modes, and runs with the host
 * global at every value of the domain and, for a typed ingress, at a value of its kind. Where today's checker gives the
 * position's compile error, the route publishes as for the fitting twin, and each run ends in one of R18's three ways: as
 * the twin's where it does not reach the command; as the value alone does where its evaluation fails; with the
 * position's code at the command where every operand evaluates (R15: asserted where the run reaches it). Where today's
 * checker gives none, both publish and their runs are equal. The same holds in each context (`CONTEXTS`, R12), where the
 * route admits the value alone there; where it refuses that, it refuses the command alike (R16).
 */

const position = (sample: Sample) =>
  DECLARED_RULE_DIFFERENCES.find(
    (declared) => declared.row === sample.row && declared.operand === sample.operand,
  );

/** A sample's source with its command in `context`: its prelude first. */
const inContext = (sample: Sample, command: string, context: string): string =>
  `${sample.prelude}${CONTEXTS[context]!(command)}`;

/** The samples the guard judges here: those a declared refusal names are the row guard's. */
const SAMPLES = samples().filter(
  (sample) => !DECLARED_REFUSALS.some((declared) => declared.refused === sample.command),
);

/**
 * The samples sampled in every context: in each declared position, a list written in place, a date by a conversion and a
 * dict by a typed ingress, each a value the position does not take.
 */
const IN_CONTEXTS = SAMPLES.filter(
  (sample) =>
    position(sample) !== undefined &&
    ((sample.origin === "literal" && sample.kind === "list") ||
      (sample.origin === "conversion" && sample.kind === "date") ||
      (sample.origin === "ingress" && sample.kind === "dict") ||
      sample.origin === "failing"),
);

/** The contexts no run reaches the command in: each run there ends as the fitting twin's. */
const UNREACHED: ReadonlySet<string> = new Set([
  "after exit",
  "after an exiting if",
  "after an exiting for",
]);

/** The refusal of a transfer's path the core knows to be no text (`argumentKinds`, `src/type-inference/core/backend.ts`). */
const PATH_REFUSAL = "an argument that its built-in checks";

/** A run's failure as `[code, start, end]`, or `null` for a run that does not fail with a site. */
function failureOf(run: string): [string, number, number] | null {
  const match = /^failed (\w+)@(\d+):(\d+)$/u.exec(run);
  return match === null ? null : [match[1]!, Number(match[2]), Number(match[3])];
}

/** The R5 ledger's inherited warnings the route gives where today's checker gives none, and the other way round. */
const ROUTE_ONLY: readonly string[] = ["TSV010", "TSV011", "TSV012", "TSV041", "TSV043"];
const TODAY_ONLY: readonly string[] = ["TSV046"];

/**
 * Where a reaching run fails: the command, the value in it, or the call holding the value (a transfer's `script(…)`), in
 * a source whose command starts at `start`.
 */
function reached(sample: Sample, start: number): Set<string> {
  const declared = position(sample)!;
  const value = start + OPERAND_TEMPLATES[sample.row]![sample.operand]![0]!.indexOf("hostValue");
  const [from, to] =
    declared.at === "statement"
      ? [start, start + sample.command.length]
      : declared.at === "value"
        ? [value, value + sample.value.length]
        : [value - "script(".length, value + sample.value.length + ")".length];
  return new Set(declared.failure.map((code) => `failed ${code}@${from}:${to}`));
}

/**
 * One sample in one context, judged against its fitting twin (`twin`, the route's where it publishes, else today's) and
 * the value alone there (`alone`). `seen` collects each position's codes that occurred. `reach` lists the runs that reach
 * the command, which must fail there (R15).
 */
function judge(
  sample: Sample,
  context: string,
  found: ReadonlyMap<string, DifferentialRecord>,
  seen: Set<string>,
  reach: readonly number[],
): string[] {
  const source = inContext(sample, sample.command, context);
  const record = found.get(source)!;
  const name = `${JSON.stringify(source)} (${sample.kind}, ${sample.origin}, ${context})`;
  const declared = position(sample);
  const today = errorsOf(record.checker);
  const failures: string[] = [];
  const alone = found.get(inContext(sample, `let v = ${sample.value}`, context));
  record.candidate.modes.forEach((mode, index) => {
    const at = `${name} [${mode.mode}]`;
    const aloneMode = alone?.candidate.modes[index];
    // R16: where the route refuses the value alone, it refuses the command alike (the site is checked in-process)
    if (aloneMode?.outside !== undefined) {
      if (mode.outside !== aloneMode.outside)
        failures.push(
          `${at}: the value alone is refused (${aloneMode.outside}), the command ${mode.outside ?? "not"}`,
        );
      return;
    }
    // in code no run reaches, the core reads a typed ingress at its written type: a transfer's path of a written type
    // other than text is refused by the path's argument rule, as one written in place is (`DECLARED_REFUSALS`, R28)
    if (
      declared?.at === "call" &&
      sample.origin === "ingress" &&
      sample.kind !== "string" &&
      UNREACHED.has(context)
    ) {
      if (mode.outside !== PATH_REFUSAL)
        failures.push(
          `${at}: route ${mode.outside ?? mode.threw ?? "a plan"}, not "${PATH_REFUSAL}"`,
        );
      return;
    }
    if (mode.outside !== undefined || mode.threw !== undefined) {
      failures.push(
        `${at}: route ${mode.outside ?? mode.threw}, today ${today.join(" ") || "a plan"}`,
      );
      return;
    }
    if (record.checker.plan) {
      // where today's checker gives no error: both publish, with today's checks, and their runs are equal
      if (!mode.plan) failures.push(`${at}: today a plan, the route none`);
      const carried = new Set(mode.plan?.checks.map(checkKey) ?? []);
      for (const check of record.checker.plan.checks.map(checkKey))
        if (!carried.has(check)) failures.push(`${at}: today's check missing: ${check}`);
      const [runs, todays] = [
        (mode.runs ?? []).map(outcome),
        (record.checker.runs ?? []).map(outcome),
      ];
      if (JSON.stringify(runs) !== JSON.stringify(todays))
        failures.push(`${at}: runs ${runs.join(", ")}, today ${todays.join(", ")}`);
      return;
    }
    if (
      declared === undefined ||
      today.length === 0 ||
      today.some((code) => !declared.today.includes(code))
    ) {
      // another compile error today: the route publishes no plan either, with today's errors
      if (mode.plan || JSON.stringify(errorsOf(mode)) !== JSON.stringify(today))
        failures.push(
          `${at}: today ${today.join(" ")}, route ${mode.plan ? "a plan" : errorsOf(mode).join(" ")}`,
        );
      return;
    }
    // the declared difference: the route answers as for the fitting twin, but that a reaching run fails at the command
    const twinRecord = found.get(inContext(sample, twinCommand(sample), context))!;
    const twinMode = twinRecord.candidate.modes[index];
    // (today's twin only where the route refuses the twin at its duration literal, which the slice does not hold)
    if (!twinMode?.plan && twinMode?.outside !== "this duration literal") {
      failures.push(
        `${at}: its twin ${twinMode?.outside ?? twinMode?.threw ?? "publishes no plan"}`,
      );
      return;
    }
    const reference: Entry = twinMode.plan ? twinMode : twinRecord.checker;
    const start = source.indexOf(sample.command, sample.prelude.length);
    const value = start + OPERAND_TEMPLATES[sample.row]![sample.operand]![0]!.indexOf("hostValue");
    const shift = twinCommand(sample).length - sample.command.length;
    const asTwin = (offset: number): number | null =>
      offset <= value ? offset : offset >= value + sample.value.length ? offset + shift : null;
    // (where the twin is today's, the R5 ledger's inherited classes stand apart: the warnings only the route gives,
    // and those only today gives, among them TSV065 after an exiting `for`, #1623, R13)
    const todays = reference === twinRecord.checker;
    const expected = diagnosed(reference)
      .filter(
        (diagnostic) =>
          !todays ||
          !(
            TODAY_ONLY.some((code) => diagnostic.startsWith(`warning ${code} `)) ||
            (context === "after an exiting for" && diagnostic.startsWith("warning TSV065 "))
          ),
      )
      .sort();
    const answered = diagnosed(mode, asTwin)
      .filter(
        (diagnostic) =>
          !todays || !ROUTE_ONLY.some((code) => diagnostic.startsWith(`warning ${code} `)),
      )
      .sort();
    const runs = (mode.runs ?? []).map(outcome);
    const twinRuns = (reference.runs ?? []).map(outcome);
    const aloneRuns = (aloneMode?.runs ?? []).map(outcome);
    const fails = reached(sample, start);
    // each run ends in one of three ways, in the runtime's order (R18): it does not reach the command, as the twin's; an
    // operand's evaluation fails, as the value alone does there; every operand evaluates, the command refuses the value
    const aloneStart =
      inContext(sample, `let v = ${sample.value}`, context).indexOf(
        `let v = ${sample.value}`,
        sample.prelude.length,
      ) + "let v = ".length;
    const wrong = runs.flatMap((ran, run) => {
      const failed = failureOf(aloneRuns[run] ?? "");
      if (
        failed !== null &&
        failed[1] >= aloneStart &&
        failed[2] <= aloneStart + sample.value.length
      ) {
        const [code, from, to] = failed;
        const shift = value - aloneStart;
        return ran === `failed ${code}@${from + shift}:${to + shift}`
          ? []
          : [`run ${run}: ${ran}, its operand alone ${aloneRuns[run]}`];
      }
      if (ran === twinRuns[run] && !reach.includes(run)) return [];
      return fails.has(ran) && !UNREACHED.has(context)
        ? []
        : [`run ${run}: ${ran}, its twin ${twinRuns[run]}`];
    });
    if (
      !mode.plan ||
      JSON.stringify(answered) !== JSON.stringify(expected) ||
      runs.length !== twinRuns.length ||
      wrong.length > 0
    ) {
      failures.push(
        `${at}: route ${mode.plan ? "a plan" : "no plan"}, ${answered.join(", ")}; its twin ${expected.join(", ")}; ${wrong.join("; ")}`,
      );
      return;
    }
    for (const code of today) seen.add(`${declared.row} ${declared.operand} ${code}`);
    for (const outcomeOf of runs)
      if (fails.has(outcomeOf))
        seen.add(`${declared.row} ${declared.operand} ${outcomeOf.split(/[ @]/u)[1]}`);
  });
  return failures;
}

test("each sampled kind, origin and position answers as today's checker's answer declares, in every context", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "declared-positions-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // each sample straight, and the context samples in every context; each with its fitting twin and its value alone
  const sources = new Map<
    string,
    { readonly sample: Sample; readonly hosts: readonly unknown[] }
  >();
  const add = (sample: Sample, context: string) => {
    const hosts = sample.host === undefined ? [] : [sample.host];
    sources.set(inContext(sample, sample.command, context), { sample, hosts });
    sources.set(inContext(sample, `let v = ${sample.value}`, context), { sample, hosts });
    if (position(sample) !== undefined)
      sources.set(inContext(sample, twinCommand(sample), context), { sample, hosts });
  };
  for (const sample of SAMPLES) add(sample, "straight");
  for (const sample of IN_CONTEXTS)
    for (const context of Object.keys(CONTEXTS)) add(sample, context);
  const cases = [...sources].map(([source, { sample, hosts }], index) => ({
    name: `${index}`,
    files: filesOf(sample.row, source),
    hosts,
  }));
  const found = new Map(
    records(cases, folder).map((record, index) => [cases[index]!.files[0]!.source, record]),
  );
  const seen = new Set<string>();
  const failures = [
    // R15: straight, every run reaches the command, but a typed ingress's runs whose value its type refuses
    ...SAMPLES.flatMap((sample) =>
      judge(
        sample,
        "straight",
        found,
        seen,
        sample.host === undefined ? DOMAIN.map((_, run) => run) : [DOMAIN.length],
      ),
    ),
    ...IN_CONTEXTS.flatMap((sample) =>
      Object.keys(CONTEXTS)
        .filter((context) => context !== "straight")
        .flatMap((context) => judge(sample, context, found, seen, [])),
    ),
  ];
  // each position's codes occur
  for (const declared of DECLARED_RULE_DIFFERENCES)
    for (const code of [...declared.today, ...declared.failure])
      if (!seen.has(`${declared.row} ${declared.operand} ${code}`))
        failures.push(`${declared.row} ${declared.operand}: ${code} no longer occurs`);
  assert.deepEqual(failures, []);
});

test("where the route refuses a value alone in a context, it refuses the command at the same site with the same text", () => {
  const refusal = (
    row: Sample["row"],
    source: string,
    mode: (typeof HELD_MODES)[number],
  ): string | null => {
    try {
      mode.run(() =>
        compileProjectWithBackend(filesOf(row, source), { globals: ["hostValue"] }, CORE_BACKEND),
      );
      return null;
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      return `${error.what}: ${source.slice(error.site.start, error.site.end)}`;
    }
  };
  let refused = 0;
  for (const sample of IN_CONTEXTS)
    for (const context of Object.keys(CONTEXTS))
      for (const mode of HELD_MODES) {
        const alone = refusal(
          sample.row,
          inContext(sample, `let v = ${sample.value}`, context),
          mode,
        );
        if (alone === null) continue;
        refused += 1;
        assert.equal(
          refusal(sample.row, inContext(sample, sample.command, context), mode),
          alone,
          `${sample.command} ${context}`,
        );
      }
  // (the date's conversion where the host global is null: its default is only null there)
  assert.ok(refused > 0);
});

test("the samples' origins are complete: each conversion the slice admits, and a host value of every kind but those no host gives", () => {
  const admitted = Object.entries(CONVERSIONS)
    .filter(([, conversion]) => conversion.takes === "value" && conversion.kinds !== "shown")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(Object.keys(CONVERSION_INPUTS).sort(), admitted);
  // EVIDENCE: invariant: the record's keys are value kinds (its type).
  const kinds = Object.keys(VALUE_KINDS) as ValueKind[];
  assert.deepEqual(
    [...Object.keys(HOST_VALUES), ...Object.keys(HOSTLESS_VALUES)].sort(),
    [...kinds].sort(),
  );
  // a host value of a kind no host gives is refused by the host; a kind without a written type is one of them
  const { plan } = compileProject([{ path: "main.tease", source: "exit\n" }], {
    globals: ["hostValue"],
  });
  assert.ok(plan !== null);
  for (const [kind, hostValue] of Object.entries(HOSTLESS_VALUES))
    assert.throws(
      () => createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }),
      TypeError,
      kind,
    );
  for (const kind of kinds)
    if (!VALUE_KINDS[kind].written) assert.ok(kind in HOSTLESS_VALUES, kind);
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

test("a declared position's instruction refuses a value it does not take before the statement acts, in every mode", () => {
  let judged = 0;
  for (const sample of SAMPLES) {
    const declared = position(sample);
    if (declared === undefined) continue;
    const source = `${sample.prelude}${sample.command}\nexit\n`;
    const today = compileProject(filesOf(sample.row, source), { globals: ["hostValue"] });
    const errors = today.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (
      today.plan !== null ||
      errors.some((diagnostic) => !declared.today.includes(diagnostic.code))
    )
      continue;
    judged += 1;
    const [start, end] = [sample.prelude.length, sample.prelude.length + sample.command.length];
    const fails = reached(sample, start);
    // (the runs that reach the command: every one, or a typed ingress's at its kind's value)
    const hosts = sample.host === undefined ? DOMAIN : [sample.host];
    for (const mode of HELD_MODES) {
      const at = `${source} [${mode.name}]`;
      const { plan } = mode.run(() =>
        compileProjectWithBackend(
          filesOf(sample.row, source),
          { globals: ["hostValue"] },
          CORE_BACKEND,
        ),
      );
      assert.ok(plan !== null, at);
      for (const hostValue of hosts) {
        const first = createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } });
        const before = fieldsOf(first);
        const result = run(plan, first);
        const failure = result.events.find((event) => event.kind === "runtimeFailure");
        const failed =
          failure?.kind === "runtimeFailure"
            ? [failure.code, failure.span.start.offset, failure.span.end.offset]
            : null;
        // (a failing producer fails inside its value, before the command; any other value, at the command, R18)
        const value =
          start + OPERAND_TEMPLATES[sample.row]![sample.operand]![0]!.indexOf("hostValue");
        assert.ok(
          failed !== null &&
            (sample.origin === "failing"
              ? Number(failed[1]) >= value && Number(failed[2]) <= value + sample.value.length
              : fails.has(`failed ${failed[0]}@${failed[1]}:${failed[2]}`)),
          `${at} with ${JSON.stringify(hostValue)}: ${JSON.stringify(failed)}`,
        );
        // nothing of the statement's effect: no event of it but the failure, and the session's state as before the
        // statement, but for the run's own bookkeeping (the ingress's store is before it)
        const own = result.events.filter(
          (event) =>
            event.kind !== "runtimeFailure" &&
            "span" in event &&
            event.span !== null &&
            event.span.start.offset >= start &&
            event.span.start.offset < end,
        );
        assert.deepEqual(
          own.map((event) => event.kind),
          [],
          at,
        );
        if (sample.prelude === "") {
          const after = fieldsOf(result.snapshot);
          const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
            (key) => !BOOKKEEPING.includes(key) && before.get(key) !== after.get(key),
          );
          assert.deepEqual(changed, [], `${at}: the session's state`);
        }
      }
    }
  }
  assert.ok(judged > 0);
});

test("a command with one operand it does not take and another whose producer fails: its run fails, whichever comes first", (t) => {
  const withPositions = Object.entries(OPERAND_TEMPLATES)
    .filter(([, operands]) => Object.keys(operands!).length > 1)
    .map(([row]) => row)
    .sort();
  assert.deepEqual(PAIRED_SAMPLES.map((paired) => paired.row).sort(), withPositions);
  for (const paired of PAIRED_SAMPLES) {
    const source = `${paired.command}\nexit\n`;
    const today = compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] });
    assert.equal(today.plan, null, source);
    const declared = DECLARED_RULE_DIFFERENCES.find(
      (difference) => difference.row === paired.row && difference.operand === paired.misfit,
    )!;
    const producer = source.indexOf(FAILING_PRODUCER);
    const first = new Set<string>();
    for (const mode of HELD_MODES) {
      const { plan } = mode.run(() =>
        compileProjectWithBackend(
          [{ path: "main.tease", source }],
          { globals: ["hostValue"] },
          CORE_BACKEND,
        ),
      );
      assert.ok(plan !== null, `${source} [${mode.name}]`);
      for (const hostValue of DOMAIN) {
        const result = run(
          plan,
          createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }),
        );
        const failure = result.events.find((event) => event.kind === "runtimeFailure");
        assert.ok(failure?.kind === "runtimeFailure", `${source} [${mode.name}]`);
        const atProducer =
          failure.span.start.offset >= producer &&
          failure.span.end.offset <= producer + FAILING_PRODUCER.length;
        assert.ok(
          atProducer || declared.failure.includes(failure.code),
          `${source}: ${failure.code}`,
        );
        first.add(atProducer ? `the producer (${failure.code})` : `the command (${failure.code})`);
      }
    }
    // (which comes first is recorded, not ruled)
    t.diagnostic(`${paired.command}: fails first at ${[...first].join(", ")}`);
  }
});
