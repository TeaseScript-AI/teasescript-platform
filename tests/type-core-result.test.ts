import assert from "node:assert/strict";
import test from "node:test";

import {
  makeItem,
  mergeItems,
  reasonContext,
  REASON,
  type Item,
  type ItemFields,
  type Writer,
} from "../src/type-inference/core/items.js";
import { operationItems } from "../src/type-inference/core/operator-table.js";
import {
  contextOf,
  coreRecord,
  elementStep,
  explainingItem,
  offendingKinds,
  outcomeOf,
  provenanceOf,
  targetName,
  type CoreDiagnostic,
  type CoreResult,
  type Obligation,
} from "../src/type-inference/core/result.js";
import { itemScope } from "./helpers/type-core-items.js";
import {
  compactRecord,
  readCompactRecord,
  recordDifferences,
  type CompactRecord,
} from "./helpers/type-core-records.js";

// The core's structured result (TABLE §3.4, §4, F28, §10.5): which word and which writer explain a warning, which kinds
// owe their own diagnostics, how targets are named, and the record the tests compare with the expectation set.

const writer = (kind: string, start: number, file = 0): Writer => ({
  kind,
  file,
  start,
  end: start + 1,
});
const unknown = (reasons: number, at: number, fields: ItemFields = {}): Item =>
  makeItem("unknown", writer("assignment", at), { cert: "pos", reasons, ...fields });

test("one unknown's word is its first reason's in the rank external, opaque, deferred, missing (TABLE §1)", () => {
  const { external, opaque, deferred, missing, budget } = REASON;
  for (const [reasons, word] of [
    [external, "unknown"],
    [opaque, "unmodelled"],
    [deferred, "deferred-parameter"],
    [missing, "missing"],
    [external | opaque, "unknown"],
    [external | deferred, "unknown"],
    [external | missing, "unknown"],
    [opaque | deferred | missing, "unmodelled"],
    [deferred | missing, "deferred-parameter"],
    [missing | budget, "missing"],
    [0, "unknown"],
  ] as const)
    assert.equal(reasonContext(reasons), word, `reasons ${reasons}`);
  // the reasons name an unknown whatever word it carries: a condition's, or a reason word the rank overrides
  assert.equal(contextOf(unknown(opaque, 1, { context: "call" })), "unmodelled");
  assert.equal(contextOf(unknown(external | missing, 1, { context: "missing" })), "unknown");
  assert.equal(contextOf(makeItem("null", null, { cert: "pos", word: "unknown" })), "unknown");
  assert.equal(contextOf(makeItem("integer", null, { cert: "pos", context: "branch" })), "branch");
});

test("an unknown whose word comes first explains an obligation, and its writer is the warning's (F28)", () => {
  const known = makeItem("integer", writer("literal", 1), { cert: "pos", context: "call" });
  const external = unknown(REASON.external, 5);
  const opaque = unknown(REASON.opaque, 9);
  assert.equal(explainingItem([known, opaque, external]), opaque);
  assert.equal(explainingItem([known, makeItem("string")]), known);
  // a condition's word an unknown took does not put it first, and of two alike the first explains
  const missing = unknown(REASON.missing, 3);
  assert.equal(
    explainingItem([missing, unknown(REASON.external, 4, { context: "loop" })]),
    missing,
  );
  assert.equal(explainingItem([external, unknown(REASON.external, 7)]), external);
  assert.equal(explainingItem([]), undefined);
  assert.deepEqual(provenanceOf(opaque), { writers: [opaque.writer], context: "unmodelled" });
  assert.deepEqual(provenanceOf(makeItem("null", null, { cert: "pos" })), {
    writers: [],
    context: "unknown",
  });
});

test("each kind offends once, the rows of one unknown operand as one kind and every unknown as one (§4)", () => {
  const scope = itemScope();
  const host = unknown(REASON.external, 20);
  // `x / 4` with `x` unknown: number, duration, calendar duration and angle, all standing for `x`
  const quotient = operationItems("/", [[host], [makeItem("integer")]], scope, {
    file: 0,
    start: 30,
    end: 35,
  });
  const nothing = makeItem("null", writer("assignment", 2), { cert: "pos" });
  const opaque = unknown(REASON.opaque, 40);
  const kinds = offendingKinds([nothing, ...quotient, unknown(REASON.external, 41), opaque]);
  assert.deepEqual(
    kinds.map((kind) => kind.kinds),
    [["null"], ["number", "duration", "calendarDuration", "angle"], ["unknown"]],
  );
  assert.equal(kinds[1]?.item.writer, host.writer);
  assert.equal(kinds[2]?.item, opaque);
});

test("a target names a selection or index `element`, a dict's value `entry` (§10.5)", () => {
  assert.equal(elementStep(["list", "set", "empty"]), "element");
  assert.equal(elementStep(["dict", "empty"]), "entry");
  assert.equal(elementStep(["dict", "null"]), "element");
  assert.equal(elementStep([]), "element");
  assert.equal(
    targetName("state", ["party", elementStep(["list"]), "hp"]),
    "state.party.element.hp",
  );
  assert.equal(targetName("d", [elementStep(["dict"])]), "d.entry");
  assert.equal(targetName("use.data", []), "use.data");
});

const at = (start: number, end: number, file = 0) => ({ file, start, end });

function warning(
  kind: CoreDiagnostic["kind"],
  item: Item,
  obligation: Omit<Obligation, "boundary">,
): CoreDiagnostic {
  return {
    class: "warning-runtime-check",
    kind,
    site: obligation.site,
    provenance: provenanceOf(item),
    obligation: { ...obligation, boundary: false },
  };
}

function result(
  diagnostics: readonly CoreDiagnostic[],
  checks: readonly Obligation[] = [],
): CoreResult {
  return { outcome: outcomeOf(diagnostics), diagnostics, checks };
}

/**
 * Three records of the expectation set (`expected-cp9-cells/cases.jsonl`), each as an analysis that meets it gives
 * it, and as the set's records compare: an error; a member warning with a boundary check; a warning in a called file.
 */
const RECORDS: readonly {
  name: string;
  paths: string[];
  result: CoreResult;
  expected: CompactRecord;
}[] = [
  {
    // let local = 1.5 / global n = local, default: 1 / repeat n {} / exit
    name: "cp9-cells/F1a/executable",
    paths: ["main.tease"],
    result: result([{ class: "compile-error", kind: "integer-use", site: at(52, 53) }]),
    expected: {
      outcome: "compile-error",
      diagnostics: [
        {
          kind: "integer-use",
          class: "compile-error",
          site: { file: "main.tease", offset: 52 },
          context: null,
        },
      ],
      checks: [],
    },
  },
  {
    // let value=hostValue / value[0]=2 / exit
    name: "cp9-cells/r46/m3/astra-m3/external-receiver/index-store",
    paths: ["main.tease"],
    result: result(
      [
        warning("member-read", unknown(REASON.external, 0), {
          kind: "null-check",
          target: "value",
          against: ["non-null"],
          on: "check that 'value' is non-null and supports indexed writes through [0] before this access",
          site: at(20, 28),
        }),
      ],
      [
        {
          kind: "copy-type",
          target: "value",
          against: ["unknown"],
          on: "validate external ingress at 'value'",
          site: at(10, 19),
          boundary: true,
        },
      ],
    ),
    expected: {
      outcome: "warning-runtime-check",
      diagnostics: [
        {
          kind: "member-read",
          class: "warning-runtime-check",
          site: { file: "main.tease", offset: 20 },
          context: "unknown",
        },
      ],
      checks: [
        {
          kind: "null-check",
          target: "value",
          against: ["non-null"],
          boundary: false,
          site: { file: "main.tease", offset: 20 },
        },
        {
          kind: "copy-type",
          target: "value",
          against: ["unknown"],
          boundary: true,
          site: { file: "main.tease", offset: 10 },
        },
      ],
    },
  },
  {
    // main.tease: global n = 1 / n = 1.5 / call "part.tease" / exit; part.tease: repeat n {} / end
    name: "cp9-cells/O10/file-read",
    paths: ["main.tease", "part.tease"],
    result: result([
      warning(
        "integer-use",
        makeItem("number", writer("assignment", 13), { cert: "pos", context: "call" }),
        {
          kind: "integer-check",
          target: "n",
          against: ["integer"],
          on: "check 'n' is a whole number",
          site: at(7, 8, 1),
        },
      ),
    ]),
    expected: {
      outcome: "warning-runtime-check",
      diagnostics: [
        {
          kind: "integer-use",
          class: "warning-runtime-check",
          site: { file: "part.tease", offset: 7 },
          context: "call",
        },
      ],
      checks: [
        {
          kind: "integer-check",
          target: "n",
          against: ["integer"],
          boundary: false,
          site: { file: "part.tease", offset: 7 },
        },
      ],
    },
  },
];

test("an external ingress merged with an opaque unknown keeps both reasons and records external's word", () => {
  const scope = itemScope();
  const ingress = unknown(REASON.external, 10, {
    ingress: scope.ingress.leaf(writer("assignment", 10)),
    context: "unknown",
  });
  const member = unknown(REASON.opaque, 20, { context: "unmodelled" });
  for (const order of [
    [ingress, member],
    [member, ingress],
  ]) {
    const [merged] = mergeItems(order, scope);
    assert.equal(merged?.reasons, REASON.external | REASON.opaque);
    assert.ok(merged?.ingress !== undefined);
    assert.equal(provenanceOf(merged!).context, "unknown");
    const record = coreRecord(
      result([
        warning("operator", merged!, {
          kind: "operand",
          target: "value",
          against: ["integer", "number"],
          on: "check the operand of + when it runs",
          site: at(30, 35),
        }),
      ]),
      ["main.tease"],
    );
    assert.equal(record.diagnostics[0]?.provenance?.context, "unknown");
  }
});

test("a result's record has the expectation set's shape, survives JSON, and compares as the set's records do", () => {
  for (const { name, paths, result: analysed, expected } of RECORDS) {
    const record = coreRecord(analysed, paths);
    assert.deepEqual(JSON.parse(JSON.stringify(record)), record, name);
    const compact = compactRecord(record);
    assert.deepEqual(readCompactRecord(JSON.parse(JSON.stringify(compact)), name), compact, name);
    assert.deepEqual(recordDifferences(expected, compact), [], name);
  }
  const [, external, called] = RECORDS;
  const record = coreRecord(external!.result, external!.paths);
  // a warning's obligation is a runtime check too, and every check is listed once
  assert.deepEqual(
    record.runtimeChecks.map(
      (check) => `${check.kind} ${check.boundary === true ? check.reason : "use"}`,
    ),
    ["null-check use", "copy-type external-data"],
  );
  assert.deepEqual(
    coreRecord(
      result(external!.result.diagnostics, [
        ...external!.result.checks,
        ...external!.result.checks,
      ]),
      external!.paths,
    ).runtimeChecks,
    record.runtimeChecks,
  );
  // writers are file-qualified tokens; sites name their file
  const crossing = coreRecord(called!.result, called!.paths);
  assert.deepEqual(crossing.diagnostics[0]?.provenance, {
    writers: ["assignment@main.tease:13"],
    more: false,
    context: "call",
  });
  assert.deepEqual(crossing.runtimeChecks[0]?.site, { file: "part.tease", offset: 7, end: 8 });
  assert.throws(() => coreRecord(called!.result, ["main.tease"]), /no file 1/u);
});

test("two warnings owing alike list their obligation twice, and a check alike to one of them not again", () => {
  // `x + "a"` with `x` a possible text and an unknown: one operand obligation per offending kind, alike (§4)
  const owed: Omit<Obligation, "boundary"> = {
    kind: "operand",
    target: "x",
    against: ["integer", "number"],
    on: "check the operand of + when it runs",
    site: at(10, 11),
  };
  const text = makeItem("string", writer("assignment", 2), { cert: "pos" });
  const record = coreRecord(
    result(
      [warning("operator", text, owed), warning("operator", unknown(REASON.external, 4), owed)],
      [{ ...owed, boundary: false }],
    ),
    ["main.tease"],
  );
  assert.deepEqual(
    record.runtimeChecks.map((check) => `${check.kind} ${check.target} ${check.site.offset}`),
    ["operand x 10", "operand x 10"],
  );
});

test("the comparison counts each check and asserts only the contexts the set names", () => {
  const ingress = (offset: number) => ({
    kind: "copy-type" as const,
    target: "meter",
    against: ["integer", "null"],
    boundary: true,
    site: { file: "main.tease", offset },
  });
  const expected: CompactRecord = {
    outcome: "warning-runtime-check",
    diagnostics: [
      {
        kind: "written-target",
        class: "warning-runtime-check",
        site: { file: "main.tease", offset: 40 },
        context: null,
      },
    ],
    checks: [ingress(12), ingress(30)],
  };
  const actual: CompactRecord = {
    ...expected,
    diagnostics: [{ ...expected.diagnostics[0]!, context: "later" }],
  };
  // an unasserted context matches any word, an asserted one only its own
  assert.deepEqual(recordDifferences(expected, actual), []);
  assert.deepEqual(recordDifferences(actual, expected), [
    "missing context written-target warning-runtime-check main.tease:40 later ×1",
  ]);
  // the second ingress check replaced by a copy of the first (the port plan's negative control) differs
  assert.deepEqual(
    recordDifferences(expected, { ...expected, checks: [ingress(12), ingress(12)] }),
    [
      "missing check copy-type meter [integer|null] boundary main.tease:30 ×1",
      "extra check copy-type meter [integer|null] boundary main.tease:12 ×1",
    ],
  );
  assert.deepEqual(
    recordDifferences(expected, { ...expected, outcome: "valid", checks: [] }).length,
    3,
  );
  assert.throws(() => readCompactRecord({ ...expected, outcome: "fine" }), /record\.outcome/u);
  assert.throws(
    () => readCompactRecord({ ...expected, checks: [{ ...ingress(12), boundary: "yes" }] }),
    /record\.checks\[0\]\.boundary/u,
  );
});

test("the outcome is the worst class among the diagnostics", () => {
  const error: CoreDiagnostic = { class: "compile-error", kind: "operator", site: at(0, 1) };
  const caution = RECORDS[2]!.result.diagnostics[0]!;
  assert.equal(outcomeOf([]), "valid");
  assert.equal(outcomeOf([caution]), "warning-runtime-check");
  assert.equal(outcomeOf([caution, error]), "compile-error");
});
