import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../src/compiler.js";
import { CONVERSIONS } from "../../src/conversions.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { RuntimeSnapshot } from "../../src/runtime/snapshot/state.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { nodeOf, SliceIndex } from "../../src/type-inference/core/check-result/slice-index.js";
import { REASON, type ItemTag } from "../../src/type-inference/core/items.js";
import {
  COMMAND_OPERANDS,
  commandOperands,
  DISPOSITIONS,
  operandRules,
  outsideSyntax,
  type OperandRule,
  type SyntaxKind,
} from "../../src/type-inference/core/slice-syntax.js";
import { VALUE_KINDS, type ValueKind } from "../../src/value-kinds.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { runGlobals } from "../helpers/type-core-route.js";
import {
  checkKey,
  DOMAIN,
  type DifferentialRecord,
  errorsOf,
  outcome,
  records,
} from "../helpers/type-core/row-guard-records.js";
import {
  CONTEXTS,
  CONVERSION_INPUTS,
  DECLARED_REFUSALS,
  DECLINED_ORIGINS,
  HOST_VALUES,
  HOSTLESS_VALUES,
  type Sample,
  samples,
} from "../helpers/type-core/declared-samples.js";
import {
  filesOf,
  OPERAND_TEMPLATES,
  ROW_TEMPLATES,
  SAMPLED_TEMPLATES,
} from "../helpers/type-core/row-templates.js";

/*
 * The command operand table (#2488's step 1½, `COMMAND_OPERANDS`): each command and request operand position holds each
 * sample's value (`samples`: each origin with its own kinds), compiled by today's checker and by the candidate route in
 * the four held modes, and run with the host global at every value of the domain and, for a typed ingress, at a value
 * of its kind. Where today's checker refuses the source with the position's compile error, the route refuses it at the
 * operand (`outsideAnswers`), as no consumer of the core judges it there. Where today's checker plans, the route
 * publishes with today's checks and runs, but where the value's origin is one the table declines (`DECLINED_ORIGINS`:
 * an outside value carried, R10), which is counted (R11). The same holds in each context (`CONTEXTS`); where the route
 * refuses the value alone there, it refuses the command alike (R16).
 */

/** The text of the table's refusal (`outsideAnswers`, `src/type-inference/core/backend.ts`). */
const TABLE_REFUSAL = "an operand its instruction does not take";

const ruleOf = (sample: Sample): OperandRule | undefined =>
  operandRules(sample.row)?.[sample.operand];

/** A sample's source with its command in `context`: its prelude first. */
const inContext = (sample: Sample, command: string, context: string): string =>
  `${sample.prelude}${CONTEXTS[context]!(command)}`;

// EVIDENCE: invariant: the syntax table's keys are exactly the AST kinds (its mapped type).
const TABLE_ROWS = (Object.keys(DISPOSITIONS) as SyntaxKind[]).filter(
  (kind) => operandRules(kind) !== undefined,
);

/** A command operand position's templates (`SAMPLED_TEMPLATES`), by its row's name. */
const templatesOf = (row: string, operand: string): readonly string[] | undefined =>
  Object.entries(SAMPLED_TEMPLATES).find(([key]) => key === row)?.[1]?.[operand];

/**
 * The samples judged here: at a position of the table, those a declared refusal names aside (the row guard's), and a
 * value ending in a number before a `wait`'s unit, whose number the unit makes a duration literal (`wait 2 s`,
 * `wait hostValue otherwise 2 s`), not an amount.
 */
const SAMPLES = samples().filter(
  (sample) =>
    ruleOf(sample) !== undefined &&
    !DECLARED_REFUSALS.some((declared) => declared.refused === sample.prelude + sample.command) &&
    !(sample.operand === "amount" && /\d$/u.test(sample.value)),
);

/**
 * The positions where the route's refusal of one of the core's diagnostics (`"this operand"`, whichever consumer gave
 * it) may decline an outside value carried: a choice object's written in place (`CHOICE_OBJECT_OPERANDS`), as it
 * refuses the host global there (`DECLARED_REFUSALS`), and an unlabelled option or element, where the core checks what
 * the buttons return (`choiceValues`).
 */
const CORE_REFUSED_AT = new Set([
  "askChoice.returnedText",
  "askChoice.value",
  "askChoice.option",
  "askChoice.element",
]);

/**
 * The samples sampled in every context: in each position, a list written in place, a date by a conversion and a dict
 * by a typed ingress, each a value most positions do not take, and the failing producer.
 */
const IN_CONTEXTS = SAMPLES.filter(
  (sample) =>
    (sample.origin === "literal" && sample.kind === "list") ||
    (sample.origin === "conversion" && sample.kind === "date") ||
    (sample.origin === "ingress" && sample.kind === "dict") ||
    sample.origin === "failing",
);

/** A declined sample's carrier form, as its count names it: the conversion, the element read or the carrier written. */
const carrierOf = (sample: Sample): string =>
  sample.origin === "conversion"
    ? `${sample.value.slice(0, sample.value.indexOf("("))}(…, default: hostValue)`
    : `${sample.prelude.trimEnd().replaceAll(/\n\s*/gu, "; ")}; ${sample.value}`.replace(
        /^; /u,
        "",
      );

/**
 * One sample in one context. `seen` collects each position's codes today refuses with, `declined` the samples the
 * route declines where today plans, by origin.
 */
function judge(
  sample: Sample,
  context: string,
  found: ReadonlyMap<string, DifferentialRecord>,
  seen: Set<string>,
  declined: Map<string, number>,
): string[] {
  const source = inContext(sample, sample.command, context);
  const record = found.get(source)!;
  const name = `${JSON.stringify(source)} (${sample.kind}, ${sample.origin}, ${context})`;
  const rule = ruleOf(sample)!;
  const today = errorsOf(record.checker);
  const failures: string[] = [];
  const alone = found.get(inContext(sample, `let v = ${sample.value}`, context));
  record.candidate.modes.forEach((mode, index) => {
    const at = `${name} [${mode.mode}]`;
    const aloneMode = alone?.candidate.modes[index];
    if (mode.threw !== undefined) {
      failures.push(`${at}: the route threw ${mode.threw}`);
      return;
    }
    // R16: where the route refuses the value alone, it refuses the command alike (the site is checked in-process)
    if (aloneMode?.outside !== undefined) {
      if (mode.outside !== aloneMode.outside)
        failures.push(
          `${at}: the value alone is refused (${aloneMode.outside}), the command ${mode.outside ?? "not"}`,
        );
      return;
    }
    if (!record.checker.plan) {
      // today refuses the source: the route publishes nothing (R1); where today's errors are the position's, each is
      // one the rule names
      if (mode.plan) failures.push(`${at}: today ${today.join(" ")}, the route a plan`);
      if (today.some((code) => rule.today.includes(code)))
        for (const code of today)
          if (rule.today.includes(code)) seen.add(`${sample.row} ${sample.operand} ${code}`);
          else
            failures.push(`${at}: today's ${code} is not the position's (${rule.today.join(" ")})`);
      return;
    }
    if (mode.outside !== undefined) {
      // today plans: the route declines only an outside value carried, by the table's refusal or, at a choice's
      // position, by its refusal of a core diagnostic (`CORE_REFUSED_AT`); each is counted (R11)
      const by =
        mode.outside === TABLE_REFUSAL
          ? "table"
          : mode.outside === "this operand" && CORE_REFUSED_AT.has(sample.operand)
            ? "core"
            : null;
      if (by !== null && DECLINED_ORIGINS.has(sample.origin)) {
        const key = `${sample.origin} (${by === "table" ? by : sample.operand}): ${carrierOf(sample)}`;
        if (index === 0) declined.set(key, (declined.get(key) ?? 0) + 1);
      } else failures.push(`${at}: today a plan, the route refuses (${mode.outside})`);
      return;
    }
    // both publish: with today's checks, and their runs are equal
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
  });
  return failures;
}

test("each sampled kind, origin and position: where today refuses it, the route refuses it; where today plans, it publishes alike or declines a carried outside value", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "declared-positions-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // each sample straight, and the context samples in every context; each with its value alone
  const sources = new Map<
    string,
    { readonly sample: Sample; readonly hosts: readonly unknown[] }
  >();
  const add = (sample: Sample, context: string) => {
    const hosts = sample.host === undefined ? [] : [sample.host];
    sources.set(inContext(sample, sample.command, context), { sample, hosts });
    sources.set(inContext(sample, `let v = ${sample.value}`, context), { sample, hosts });
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
  const declined = new Map<string, number>();
  const failures = [
    ...SAMPLES.flatMap((sample) => judge(sample, "straight", found, seen, declined)),
    ...IN_CONTEXTS.flatMap((sample) =>
      Object.keys(CONTEXTS)
        .filter((context) => context !== "straight")
        .flatMap((context) => judge(sample, context, found, seen, declined)),
    ),
  ];
  // each position's rule refuses some source today refuses with one of its codes
  for (const row of Object.keys(COMMAND_OPERANDS))
    for (const [operand, rule] of Object.entries(operandRules(row) ?? {}))
      if (!rule.today.some((code) => seen.has(`${row} ${operand} ${code}`)))
        failures.push(`${row} ${operand}: no sample today refuses with ${rule.today.join(" ")}`);
  assert.deepEqual(failures, []);
  // the carried outside values the route declines where today plans (R11): the table declines each declining origin
  t.diagnostic(`declined: ${JSON.stringify(Object.fromEntries([...declined].sort()))}`);
  assert.deepEqual(
    [
      ...new Set(
        [...declined.keys()]
          .filter((key) => key.includes(" (table): "))
          .map((key) => key.split(" ")[0]),
      ),
    ].sort(),
    [...DECLINED_ORIGINS].sort(),
  );
});

test("the table refuses a value its position does not take at the operand, with its text, in every mode", () => {
  let judged = 0;
  for (const sample of SAMPLES) {
    const rule = ruleOf(sample)!;
    // (a literal of a kind the position does not take: no earlier rule refuses it)
    if (sample.origin !== "literal" || rule.takes.some((tag) => tag === sample.kind)) continue;
    const source = `${sample.prelude}${CONTEXTS.straight!(sample.command)}`;
    const today = compileProject(filesOf(sample.row, source), { globals: ["hostValue"] });
    if (today.plan !== null) continue;
    const template = templatesOf(sample.row, sample.operand)![0]!;
    const start = sample.prelude.length + template.indexOf("hostValue");
    for (const mode of HELD_MODES) {
      const at = `${source} [${mode.name}]`;
      let refusal: CandidateOutsideSlice | null = null;
      try {
        const { plan } = mode.run(() =>
          compileProjectWithBackend(
            filesOf(sample.row, source),
            { globals: ["hostValue"] },
            CORE_BACKEND,
          ),
        );
        // (or the core's own diagnostic, without a plan)
        assert.equal(plan, null, at);
      } catch (error) {
        if (!(error instanceof CandidateOutsideSlice)) throw error;
        refusal = error;
      }
      if (refusal?.what !== TABLE_REFUSAL) continue;
      judged += 1;
      assert.deepEqual(
        [refusal.site.file, refusal.site.start, refusal.site.end],
        [0, start, start + sample.value.length],
        at,
      );
    }
  }
  assert.ok(judged > 0);
});

test("a property read that finds no such property fails at the read: the table judges the other sources' kinds, and the route publishes as today", () => {
  for (const source of [
    'let xs = [{a: "x"}, {b: "y"}]\nshowPopup xs[1].a\nexit\n',
    'let o = {a: "x"}\nlet p = {a: "y", b: "z"}\nshowPopup [o, p][0].b\nexit\n',
    'let xs = [{a: "x"}, {b: "y"}]\nlet r = askText(xs[0].a)\nexit\n',
  ]) {
    const files = [{ path: "main.tease", source }];
    const today = compileProject(files, { globals: ["hostValue"] });
    assert.ok(today.plan !== null, source);
    for (const mode of HELD_MODES) {
      const { plan } = mode.run(() =>
        compileProjectWithBackend(files, { globals: ["hostValue"] }, CORE_BACKEND),
      );
      assert.ok(plan !== null, `${source} [${mode.name}]`);
      assert.deepEqual(
        runGlobals(plan, { hostValue: null }),
        runGlobals(today.plan, { hostValue: null }),
        `${source} [${mode.name}]`,
      );
    }
  }
});

test("no table operand inside the slice holds an unknown of a reason the table does not admit: its refusal of one has no witness yet", () => {
  // (the family's sources in every context, and the guard's templates of the table's rows)
  const pair = (row: SyntaxKind, source: string): readonly [SyntaxKind, string] => [row, source];
  const sources = [
    ...SAMPLES.map((sample) => pair(sample.row, inContext(sample, sample.command, "straight"))),
    ...IN_CONTEXTS.flatMap((sample) =>
      Object.keys(CONTEXTS).map((context) =>
        pair(sample.row, inContext(sample, sample.command, context)),
      ),
    ),
    ...TABLE_ROWS.flatMap((row) =>
      (ROW_TEMPLATES[row] ?? []).flatMap((template) =>
        typeof template === "string" ? [pair(row, `${template}\nexit\n`)] : [],
      ),
    ),
  ];
  const failures: string[] = [];
  let judged = 0;
  for (const [row, source] of sources) {
    const request = coreRequest([...filesOf(row, source)]);
    if (request === null || outsideSyntax(request.files, new Set(["hostValue"])) !== null) continue;
    const answers = analyseCore(request);
    const index = new SliceIndex(request.files.map((file) => file.program));
    for (const node of [...index.statements, ...index.asks])
      for (const [position, operand] of operandRules(node.kind) === undefined
        ? []
        : commandOperands(node)) {
        judged += 1;
        for (const item of answers.at(nodeOf(answers, index, operand))?.items ?? [])
          if (item.tag === "unknown" && (item.reasons & ~(REASON.external | REASON.missing)) !== 0)
            failures.push(
              `${JSON.stringify(source)} ${position}: an unknown of reasons ${item.reasons}, which \`operandAdmitted\` refuses ` +
                "with no witness inside the slice yet (its mutant `reasons-any` survives): write the witness and the row",
            );
      }
  }
  assert.deepEqual(failures, []);
  assert.ok(judged > 0);
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
  // every position of the table is sampled: it has a template
  for (const row of Object.keys(COMMAND_OPERANDS))
    for (const operand of Object.keys(operandRules(row) ?? {}))
      assert.ok(templatesOf(row, operand) !== undefined, `${row} ${operand}`);
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

/** The kind of a host value of the domain, as the core names it. */
const kindOf = (value: SerializableRuntimeValue): ItemTag =>
  value === null
    ? "null"
    : typeof value === "string"
      ? "string"
      : typeof value === "boolean"
        ? "boolean"
        : Number.isInteger(value)
          ? "integer"
          : "number";

test("the host global at a position, the unknown the table admits: its instruction refuses a value it does not take before the statement acts, in every mode", () => {
  let judged = 0;
  // (the guard's templates: a choice object's positions refuse the host global, `CHOICE_OBJECT_OPERANDS`)
  for (const kind of TABLE_ROWS)
    for (const [operand, templates] of Object.entries(OPERAND_TEMPLATES[kind] ?? {})) {
      const rule = operandRules(kind)?.[operand];
      if (rule === undefined) continue;
      const command = templates[0]!;
      const source = `${command}\nexit\n`;
      const [start, end] = [0, command.length];
      for (const mode of HELD_MODES) {
        const at = `${source} [${mode.name}]`;
        const { plan } = mode.run(() =>
          compileProjectWithBackend(
            filesOf(kind, source),
            { globals: ["hostValue"] },
            CORE_BACKEND,
          ),
        );
        assert.ok(plan !== null, at);
        for (const hostValue of DOMAIN) {
          if (rule.takes.includes(kindOf(hostValue))) continue;
          judged += 1;
          const first = createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } });
          const before = fieldsOf(first);
          const result = run(plan, first);
          const failure = result.events.find((event) => event.kind === "runtimeFailure");
          assert.ok(
            failure?.kind === "runtimeFailure" &&
              failure.span.start.offset >= start &&
              failure.span.end.offset <= end,
            `${at} with ${JSON.stringify(hostValue)}: ${JSON.stringify(failure)}`,
          );
          // nothing of the statement's effect: no event of it but the failure, and the session's state as before the
          // statement, but for the run's own bookkeeping; an ask's form (R38): no field or button opens and the run
          // does not wait, its question perhaps said by its own instruction before
          const ask = kind === "interactionExpression";
          const own = result.events.filter(
            (event) =>
              event.kind !== "runtimeFailure" &&
              !(ask && event.kind === "say") &&
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
          if (ask)
            assert.deepEqual(
              [result.snapshot.status, result.snapshot.foregroundAction],
              ["failed", null],
              `${at}: no field or button opens`,
            );
          else {
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
