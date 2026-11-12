// A per-field repair: fromJson on both lowerings and a load (ADR 0021 rule 6.5), a default that runs instructions, a
// sibling's repair, and the files a file store keeps, across a store's answer and every checkpoint (F18).

import assert from "node:assert/strict";
import test from "node:test";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { run } from "../../../src/runtime/engine.js";
import { completeAction } from "../../../src/runtime/operations/complete-action.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import type { RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { propertyStep } from "../../../src/type-inference/core/program.js";
import { VALUE_KIND_NAMES } from "../../../src/value-kinds.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../../helpers/runtime-equivalence.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { readFixture } from "../../helpers/type-core/type-core-fixture.js";
import { recordDifferences } from "../../helpers/type-core-records.js";
import {
  OPTIONS,
  inBothOrders,
  decision,
  contentOf,
  candidatePlan,
  legacyPlan,
  type Ran,
  summary,
  runWith,
  halted,
  at,
  object,
  ran,
  STORED,
  stored,
  listOf,
  bound,
} from "../../helpers/type-core/type-core-discharge-runtime-setup.js";

test("fromJson reads its JSON as its expected type on both lowerings, a wrong kind giving the default and an object repaired per field (F18, ADR 0021 rule 2.6)", () => {
  for (const files of ["", ", files: false"]) {
    const scalar = `let n = fromJson(hostValue, default: 0${files})\nsay n\nexit\n`;
    const call = at(scalar, `fromJson(hostValue, default: 0${files})`);
    // the decision: F18's definite kinds, the boundary at the call against the destination's contract
    const known = decision(scalar);
    assert.deepEqual(known.diagnostics, []);
    assert.deepEqual(known.checks, [`copy-type n [integer] boundary @${call}`]);
    const plan = candidatePlan(scalar);
    assert.ok(
      contentOf(plan).includes(`expected ${files === "" ? "fileStore" : "call"}@${call} integer`),
      JSON.stringify(contentOf(plan)),
    );
    assert.deepEqual(ran(runWith(plan, "5")), halted(["5"]));
    // JSON of another kind gives the default, with the developer warning at the call; text that is no JSON, without
    assert.deepEqual(ran(runWith(plan, '"x"')), halted(["0"], [`TSW020@${call}`]));
    assert.deepEqual(ran(runWith(plan, "{")), halted(["0"]));
    // the legacy plan gives what the JSON holds, as it did
    assert.deepEqual(ran(runWith(legacyPlan(scalar), '"x"')), halted(["x"]));
    // an object default reads a JSON object as that object, field by field, its other keys left out
    const record = `let p = fromJson(hostValue, default: {name: "Guest", count: 0}${files})\nsay p.name\nsay p.count\nexit\n`;
    const parse = at(record, `fromJson(hostValue, default: {name: "Guest", count: 0}${files})`);
    const repaired = candidatePlan(record);
    assert.ok(
      contentOf(repaired).includes(
        `expected ${files === "" ? "fileStore" : "call"}@${parse} {name: string, count: integer}`,
      ),
      JSON.stringify(contentOf(repaired)),
    );
    assert.deepEqual(
      ran(runWith(repaired, '{"name": "Ada", "count": 3, "extra": 1}')),
      halted(["Ada", "3"]),
    );
    assert.deepEqual(
      ran(runWith(repaired, '{"name": "Ada", "count": "bad"}')),
      halted(["Ada", "0"], [`TSW020@${parse}`]),
    );
    assert.deepEqual(
      ran(runWith(repaired, '{"count": 4}')),
      halted(["Guest", "4"], [`TSW020@${parse}`]),
    );
    assert.deepEqual(ran(runWith(repaired, "[1]")), halted(["Guest", "0"], [`TSW020@${parse}`]));
  }
  // a property that is `null` in the default and nothing else settles takes any value, and the default's without a
  // warning where the JSON lacks it (ADR 0021 rule 2.6)
  const open =
    'let p = fromJson(hostValue, default: {name: "Guest", extra: null})\nsay p.name\nexit\n';
  const openPlan = candidatePlan(open);
  assert.deepEqual(ran(runWith(openPlan, '{"name": "Ada", "extra": [1, 2]}')), halted(["Ada"]));
  assert.deepEqual(ran(runWith(openPlan, '{"name": "Ada"}')), halted(["Ada"]));
});

test("fromJson's object repair waits for a default that runs instructions, also across a file store's answer and every checkpoint (F18, S3's handoff)", () => {
  // a default that runs as instructions (a file store of its own): the JSON's dict waits in the result's temporary
  const source =
    'let p = fromJson("{\\"name\\": \\"Ada\\"}", default: fromJson("{\\"name\\": \\"G\\", \\"count\\": 1}", default: {name: "Guest", count: 0}))\nsay p.name\nsay p.count\nexit\n';
  const plan = candidatePlan(source);
  assert.ok(contentOf(plan).some((entry) => entry.startsWith("repair storeTemporary@")));
  assert.deepEqual(
    ran(runWith(plan, null)),
    halted(["Ada", "1"], [`TSW020@${at(source, source.slice(8, source.indexOf("\nsay")))}`]),
  );
  assertRuntimeResumeEquivalent(source, { transformPlan: () => candidatePlan(source) });
  // JSON with a stored file: the Player keeps it, the call reads the replaced JSON as its object, and the field the
  // JSON lacks comes from the default, through a checkpoint of the request and of the answer
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]).toString("base64");
  const withFile =
    'let p = fromJson(hostValue, default: {photo: "", count: 0})\nsay p.photo\nsay p.count\nexit\n';
  const filePlan = candidatePlan(withFile);
  const restored = (snapshot: RuntimeSnapshot): RuntimeSnapshot =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(filePlan, snapshot))).snapshot;
  let result = run(
    filePlan,
    createImmediatePacingRuntimeSnapshot(filePlan, {
      globals: { hostValue: `{"photo": "data:image/png;base64,${png}"}` },
    }),
  );
  const events = [...result.events];
  assert.equal(result.snapshot.status, "waiting");
  const action = restored(result.snapshot).foregroundAction!;
  assert.equal(action.kind, "fileStore");
  const completed = completeAction(
    filePlan,
    restored(result.snapshot),
    {
      actionId: action.actionId,
      actionKind: "fileStore",
      payload: { kind: "stored", references: ["stored:1"] },
    },
    { capturedMedia: { holds: () => true } },
  );
  assert.equal(completed.outcome.kind, "completed");
  events.push(...completed.events);
  result = run(filePlan, restored(completed.snapshot));
  events.push(...result.events);
  const parse = at(withFile, 'fromJson(hostValue, default: {photo: "", count: 0})');
  assert.deepEqual(
    summary(events, result.snapshot.status),
    halted(["stored:1", "0"], [`TSW020@${parse}`]),
  );
});

/** A PNG's data URL, which `fromJson`'s file store recognizes; `seed` makes each one another file. */
function pngDataUrl(seed: number): string {
  const bytes = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    seed,
  ];
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * A run of `plan` with `hostValue` through the file store's request and the host's `payload`, the snapshot restored from
 * a checkpoint before the request is answered and after (`checkpoints`), or kept as it is: what it says and warns, and
 * how many files it asked to store.
 */
function throughFileStore(
  plan: InstructionPlan,
  hostValue: string,
  payload: Readonly<Record<string, unknown>>,
  checkpoints: boolean,
): Ran & { readonly stored: number; readonly snapshot: RuntimeSnapshot } {
  const kept = (snapshot: RuntimeSnapshot): RuntimeSnapshot =>
    checkpoints
      ? deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot))).snapshot
      : snapshot;
  let result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const events = [...result.events];
  let stored = 0;
  if (result.snapshot.status === "waiting") {
    const action = kept(result.snapshot).foregroundAction;
    assert.ok(action?.kind === "fileStore" && action.operation === "store");
    stored = action.files.length;
    const completed = completeAction(
      plan,
      kept(result.snapshot),
      { actionId: action.actionId, actionKind: "fileStore", payload },
      { capturedMedia: { holds: () => true } },
    );
    assert.equal(completed.outcome.kind, "completed");
    events.push(...completed.events);
    result = run(plan, kept(completed.snapshot));
    events.push(...result.events);
  }
  return { ...summary(events, result.snapshot.status), stored, snapshot: result.snapshot };
}

test("a file store keeps the files of the fields fromJson keeps, never of a key it leaves out or a field its default supplies, across the store's answer and its checkpoints (Astra B2)", () => {
  const failed = { kind: "failed" };
  for (const [fallback, json, said, warned, stored] of [
    // a key the expected type leaves out, at the top and in a nested record: never stored, the call keeps the rest
    ["{n: 0}", `{"n": 7, "extra": "${pngDataUrl(1)}"}`, ["7"], 0, 0],
    ["{a: {n: 0}}", `{"a": {"n": 7, "extra": "${pngDataUrl(1)}"}}`, ["7"], 0, 0],
    // a field of the wrong type holding a data URL: the default's, never stored, the good field kept
    ["{n: 0, count: 1}", `{"n": 7, "count": "${pngDataUrl(1)}"}`, ["7"], 1, 0],
    // the control: a field the call keeps needs its file, and only that one
    [
      '{n: 0, photo: ""}',
      `{"n": 7, "photo": "${pngDataUrl(1)}", "extra": "${pngDataUrl(2)}"}`,
      ["7"],
      0,
      1,
    ],
  ] as const) {
    const source = `let out = fromJson(hostValue, default: ${fallback})\nsay out${fallback.startsWith("{a:") ? ".a" : ""}.n\nexit\n`;
    const parse = at(source, `fromJson(hostValue, default: ${fallback})`);
    assert.ok(decision(source).checks.some((check) => check.endsWith(`boundary @${parse}`)));
    const plan = candidatePlan(source);
    assert.ok(
      contentOf(plan).some((entry) => entry.startsWith(`expected fileStore@${parse} `)),
      JSON.stringify(contentOf(plan)),
    );
    // the same with the snapshot restored from checkpoints before and after the answer; where the call keeps a file, a
    // store the Player refuses gives its default with TSW019, as the file store's contract has it
    for (const checkpoints of [false, true]) {
      const kept = throughFileStore(
        plan,
        json,
        { kind: "stored", references: ["stored:1"] },
        checkpoints,
      );
      assert.equal(kept.stored, stored, source);
      assert.deepEqual(
        { status: kept.status, said: kept.said, failure: kept.failure, warnings: kept.warnings },
        halted(
          said,
          Array.from({ length: warned }, () => `TSW020@${parse}`),
        ),
        `${source} with ${json}`,
      );
      if (stored === 0) continue;
      const refused = throughFileStore(plan, json, failed, checkpoints);
      assert.deepEqual(ran(refused), halted(["0"], [`TSW019@${parse}`]), source);
    }
  }
  // a written `object` keeps every key (#1223): another key's file is stored and kept, a wrong field's data URL is the
  // default's and never stored
  const written = "let out: object = fromJson(hostValue, default: {n: 0})\nsay out.n\nexit\n";
  const parse = at(written, "fromJson(hostValue, default: {n: 0})");
  const plan = candidatePlan(written);
  for (const checkpoints of [false, true]) {
    const json = `{"n": "${pngDataUrl(1)}", "extra": "${pngDataUrl(2)}"}`;
    const kept = throughFileStore(
      plan,
      json,
      { kind: "stored", references: [STORED] },
      checkpoints,
    );
    assert.equal(kept.stored, 1);
    assert.deepEqual(ran(kept), halted(["0"], [`TSW020@${parse}`]));
    assert.deepEqual(bound(kept.snapshot, "out"), object({ n: 0, extra: STORED }));
  }
});

test("a field fromJson keeps whole beside a sibling its default repairs keeps its files, at depths one and two, across the store's answer and its checkpoints, on both lowerings (Astra r2 B4)", () => {
  // the core answers the field `null` in the default as unknown, so the reading keeps whatever the JSON holds there
  const witness = "fromJson(hostValue, default: {n: 0, payload: null})";
  const witnessSource = `let out = ${witness}\nsay "AFTER"\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source: witnessSource }], OPTIONS.globals);
  assert.ok(request !== null);
  const answers = analyseCore(request);
  const call = answers.graph.expressionAt({
    file: 0,
    start: witnessSource.indexOf(witness),
    end: witnessSource.indexOf(witness) + witness.length,
  });
  assert.ok(call !== undefined);
  assert.ok(
    answers.valueAt(call, [propertyStep("payload")]).items.some((item) => item.tag === "unknown"),
  );
  const photo = pngDataUrl(1);
  const dict = (
    entries: Readonly<Record<string, SerializableRuntimeValue>>,
  ): SerializableRuntimeValue => ({
    kind: "dict",
    entries: Object.entries(entries).map(([key, value]) => ({ key, value })),
  });
  // each default, JSON whose unknown field (`null` in the default) holds a file beside a field the default repairs, and
  // the value the call gives, the file as `kept`: its stored reference, or its data URL where no file is stored
  for (const [fallback, json, given] of [
    // Astra's witness: `n` missing, `payload` kept whole
    [
      "{n: 0, payload: null}",
      `{"payload": {"photo": "${photo}"}}`,
      (kept: string) => object({ n: 0, payload: dict({ photo: kept }) }),
    ],
    [
      "{n: 0, payload: null}",
      `{"n": "bad", "payload": {"photo": "${photo}"}}`,
      (kept: string) => object({ n: 0, payload: dict({ photo: kept }) }),
    ],
    // depth two: the repair inside the nested record that keeps the field, outside it, and beside it
    [
      "{a: {n: 0, payload: null}}",
      `{"a": {"payload": {"photo": "${photo}"}}}`,
      (kept: string) => object({ a: object({ n: 0, payload: dict({ photo: kept }) }) }),
    ],
    [
      "{n: 0, a: {payload: null}}",
      `{"a": {"payload": {"photo": "${photo}"}}}`,
      (kept: string) => object({ n: 0, a: object({ payload: dict({ photo: kept }) }) }),
    ],
    [
      "{a: {n: 0}, payload: null}",
      `{"a": {"n": "x"}, "payload": {"photo": "${photo}"}}`,
      (kept: string) => object({ a: object({ n: 0 }), payload: dict({ photo: kept }) }),
    ],
  ] as const)
    for (const files of ["", ", files: false"]) {
      const source = `let out = fromJson(hostValue, default: ${fallback}${files})\nsay "AFTER"\nexit\n`;
      const parse = at(source, `fromJson(hostValue, default: ${fallback}${files})`);
      assert.ok(
        decision(source).checks.some((check) => check.endsWith(`boundary @${parse}`)),
        source,
      );
      const plan = candidatePlan(source);
      assert.ok(
        contentOf(plan).some(
          (entry) =>
            entry.startsWith(`expected ${files === "" ? "fileStore" : "call"}@${parse} {`) &&
            entry.includes("dict<any>"),
        ),
        `${source}: ${JSON.stringify(contentOf(plan))}`,
      );
      if (files !== "") {
        const result = runWith(plan, json);
        assert.deepEqual(ran(result), halted(["AFTER"], [`TSW020@${parse}`]), source);
        assert.deepEqual(bound(result.snapshot, "out"), given(photo), source);
        continue;
      }
      for (const checkpoints of [false, true]) {
        const result = throughFileStore(
          plan,
          json,
          { kind: "stored", references: [STORED] },
          checkpoints,
        );
        assert.equal(result.stored, 1, `${source}: the kept field's file is stored`);
        assert.deepEqual(ran(result), halted(["AFTER"], [`TSW020@${parse}`]), source);
        assert.deepEqual(bound(result.snapshot, "out"), given(STORED), source);
      }
    }
});

const PROFILE_SOURCE =
  'let profile = load("profile", default: {name: "Guest", count: 0})\nsay profile.name\nsay profile.count\nexit\n';

/**
 * AD-2's runtime requirements (the expectation set's `runtime-observations.json` at revision `81b3a0c419ed542b`, SHA-256
 * `9553ef4a788c348d…`): per scenario its source, the stored values before, what it says, the fields its
 * warnings name (`null` for the whole value), and the stored values after, which are those before. Its runnable
 * scenarios but `repeated-load` and `record-field-destination`, which load one key twice or store into a record's
 * field, outside the candidate slice.
 */
const AD2: readonly (readonly [
  name: string,
  source: string,
  before: Readonly<Record<string, unknown>>,
  said: readonly string[],
  warned: readonly (string | null)[],
])[] = [
  ["audit-e2", "audit-e2", { profile: { name: "Ada", count: "bad" } }, ["Ada"], ["count"]],
  [
    "valid-record-control",
    "valid-record-control",
    { profile: { name: "Ada", count: 7 } },
    ["Ada"],
    [],
  ],
  [
    "observe-repaired-count",
    "observe-repaired-count",
    { profile: { name: "Ada", count: "bad" } },
    ["Ada", "0"],
    ["count"],
  ],
  ["missing-count", PROFILE_SOURCE, { profile: { name: "Ada" } }, ["Ada", "0"], ["count"]],
  ["wrong-name", PROFILE_SOURCE, { profile: { name: false, count: 7 } }, ["Guest", "7"], ["name"]],
  ["missing-name", PROFILE_SOURCE, { profile: { count: 7 } }, ["Guest", "7"], ["name"]],
  [
    "both-fields-wrong",
    PROFILE_SOURCE,
    { profile: { name: false, count: "bad" } },
    ["Guest", "0"],
    ["name", "count"],
  ],
  ["all-fields-missing", PROFILE_SOURCE, { profile: {} }, ["Guest", "0"], ["name", "count"]],
  ["absent-key-control", PROFILE_SOURCE, {}, ["Guest", "0"], []],
  ["nonrecord-value-control", PROFILE_SOURCE, { profile: "bad" }, ["Guest", "0"], [null]],
  [
    "extra-field-control",
    PROFILE_SOURCE,
    { profile: { name: "Ada", count: 7, extra: true } },
    ["Ada", "7"],
    [],
  ],
  [
    "nested-field",
    "nested-field",
    { profile: { name: "Ada", stats: { count: "bad", rank: 7 } } },
    ["Ada", "0", "7"],
    ["stats.count"],
  ],
  [
    "nested-container",
    "nested-field",
    { profile: { name: "Ada", stats: "bad" } },
    ["Ada", "0", "1"],
    ["stats"],
  ],
  [
    "scalar-field-destination-control",
    "scalar-field-destination-control",
    { count: "bad" },
    ["Guest", "0"],
    [null],
  ],
];

test("a load repairs a stored record per field, the stored value kept, each bad field named by TSW016: the expectation set's records and scenarios (ADR 0021 rule 6.5)", () => {
  // the set's five AD-2 records, in the fixture since S6b's refresh
  const records = new Map(
    readFixture()
      .filter((record) => record.name.startsWith("cp9-cells/s4/s7/load-field-repair/"))
      .map((record) => [record.name.split("/").at(-1)!, record]),
  );
  assert.deepEqual([...records.keys()].sort(), [
    "audit-e2",
    "nested-field",
    "observe-repaired-count",
    "scalar-field-destination-control",
    "valid-record-control",
  ]);
  // the decision: each record of the set exactly, in both orders
  for (const [name, record] of records) {
    const request = coreRequest(record.files);
    assert.ok(request !== null, name);
    assert.deepEqual(
      inBothOrders(() => recordDifferences(record.expected, compactAnalysis(request))),
      [],
      name,
    );
  }
  for (const [name, named, before, said, warned] of AD2) {
    const source = records.get(named)?.files[0]!.source ?? named;
    const storage = Object.entries(before).map(([key, value]) => ({ key, value: stored(value) }));
    const plan = candidatePlan(source);
    // the plan: a load of an object type repairs it, against the type its default gives
    const load = /load\("\w+", default: [^\n]*\)/.exec(source)![0];
    const repairs = contentOf(plan).filter((entry) => entry.startsWith("repair "));
    assert.deepEqual(
      repairs,
      load.includes("{") ? [`repair storageLoad@${at(source, load)}`] : [],
      name,
    );
    const result = runWith(plan, null, storage);
    assert.deepEqual(result.said, said, name);
    assert.equal(result.failure, null, name);
    // one TSW016 at the load per field it takes from the default, naming it; the stored values stay as they were
    const warnings = result.events.filter((event) => event.kind === "developerWarning");
    assert.deepEqual(
      warnings.map(
        (warning) => `${warning.code}@${warning.span.start.offset}:${warning.span.end.offset}`,
      ),
      warned.map(() => `TSW016@${at(source, load)}`),
      name,
    );
    warned.forEach((field, index) => {
      if (field !== null) assert.match(warnings[index]!.message, new RegExp(`'${field}'`), name);
    });
    assert.deepEqual(
      result.snapshot.scriptStorage,
      [...storage].sort((a, b) => (a.key < b.key ? -1 : 1)),
      name,
    );
  }
  // the legacy plan replaces the whole record, as it did
  const legacy = runWith(legacyPlan(PROFILE_SOURCE), null, [
    { key: "profile", value: stored({ name: "Ada", count: "bad" }) },
  ]);
  assert.deepEqual(legacy.said, ["Guest", "0"]);
  // a default that runs as instructions: the stored record waits in the result's temporary at every boundary
  const lowered =
    'let profile = load("profile", default: fromJson("{\\"name\\": \\"G\\", \\"count\\": 1}", default: {name: "Guest", count: 0}))\nsay profile.name\nsay profile.count\nexit\n';
  const profile = [{ key: "profile", value: stored({ name: "Ada", count: "bad" }) }];
  assert.deepEqual(runWith(candidatePlan(lowered), null, profile).said, ["Ada", "1"]);
  assertRuntimeResumeEquivalent(lowered, {
    scriptStorage: profile,
    transformPlan: () => candidatePlan(lowered),
  });
  // the same into a written `object` (#1223): the record keeps its other fields, its wrong one the default's
  const lazy = 'load("profile", default: fromJson("{\\"n\\": 1}", default: {n: 0}))';
  const written = `let profile: object = ${lazy}\nsay profile.n\nexit\n`;
  const other = [{ key: "profile", value: stored({ n: "bad", m: 2 }) }];
  const repaired = runWith(candidatePlan(written), null, other);
  assert.deepEqual(ran(repaired), halted(["1"], [`TSW016@${at(written, lazy)}`]));
  assert.deepEqual(bound(repaired.snapshot, "profile"), stored({ n: 1, m: 2 }));
  assertRuntimeResumeEquivalent(written, {
    scriptStorage: other,
    transformPlan: () => candidatePlan(written),
  });
});

/** A field nothing settles, as #1058 writes it: it takes every value, and its default's value is 17. */
const OPEN = 'fromJson("17", default: null, files: false)';

/** The type of such a field, as `typeText` writes it: every kind, a collection's elements any. */
const EVERY = VALUE_KIND_NAMES.map((kind) =>
  kind === "object"
    ? "{}"
    : kind === "list" || kind === "set" || kind === "dict"
      ? `${kind}<any>`
      : kind,
).join("|");

test("a field that fits, `null` included, survives a sibling's repair: fromJson on both lowerings, nested, through a file store's answer and every checkpoint, and a load, in three layers, in both orders (#1058)", () => {
  const dictOf = (
    entries: Readonly<Record<string, SerializableRuntimeValue>>,
  ): SerializableRuntimeValue => ({
    kind: "dict",
    entries: Object.entries(entries).map(([key, value]) => ({ key, value })),
  });
  /**
   * `let out = <call>`: the core's decision, a boundary at the call and at a parse its default runs (`inner`), and its
   * plan, whose S7 content is `content` of the call's site.
   */
  const compiled = (
    call: string,
    content: (site: string, source: string) => readonly string[],
    inner?: string,
  ) => {
    const source = `let out = ${call}\nsay "AFTER"\nexit\n`;
    const site = at(source, call);
    assert.deepEqual(
      decision(source).checks,
      [
        ...(inner === undefined
          ? []
          : [`copy-type fromJson.result [object] boundary @${at(source, inner)}`]),
        `copy-type out [object] boundary @${site}`,
      ],
      source,
    );
    const plan = candidatePlan(source);
    assert.deepEqual(contentOf(plan), content(site, source), source);
    return { source, site, plan };
  };
  /** A typed parse's S7 content: its expected type, and on the instruction lowering the repair at its default. */
  const parsed = (fallback: string, files: string, type: string) =>
    compiled(`fromJson(hostValue, default: ${fallback}${files})`, (site, source) =>
      files === ""
        ? [
            `expected fileStore@${site} ${type}`,
            `repair storeTemporary@${at(source, fallback)} ${type}`,
          ]
        : [`expected call@${site} ${type}`],
    );
  /** What a run of `plan` with `hostValue` says and warns, and the value `out` holds where it ends. */
  const read = (plan: InstructionPlan, hostValue: string) => {
    const result = runWith(plan, hostValue);
    return { ...ran(result), out: bound(result.snapshot, "out") };
  };
  const after = (out: SerializableRuntimeValue, warnings: readonly string[] = []) => ({
    ...halted(["AFTER"], warnings),
    out,
  });
  // the values a test of absence or truthiness could take for none, each as JSON and as the value a reading keeps
  const valid: readonly (readonly [json: string, value: SerializableRuntimeValue])[] = [
    ["null", null],
    ["false", false],
    ["0", 0],
    ['""', ""],
    ["[]", listOf()],
    ["{}", dictOf({})],
  ];
  for (const files of ["", ", files: false"]) {
    // #1058's default: only a missing or wrong `m` is the default's, and `n` keeps what the JSON holds; the issue's
    // reproduction is the first value beside a missing `m`
    const { plan, site } = parsed(`{n: ${OPEN}, m: 0}`, files, `{n: ${EVERY}, m: integer}`);
    const repaired = [`TSW020@${site}`];
    for (const [json, value] of valid) {
      assert.deepEqual(read(plan, `{"n": ${json}}`), after(object({ n: value, m: 0 }), repaired));
      assert.deepEqual(
        read(plan, `{"n": ${json}, "m": "x"}`),
        after(object({ n: value, m: 0 }), repaired),
      );
    }
    // the controls: JSON that reads whole, its extra key left out; a missing `n` is the default's, quietly as it takes
    // every value; another value is kept
    assert.deepEqual(
      read(plan, '{"n": null, "m": 4, "extra": 1}'),
      after(object({ n: null, m: 4 })),
    );
    assert.deepEqual(read(plan, '{"m": 4}'), after(object({ n: 17, m: 4 })));
    assert.deepEqual(read(plan, '{"n": 5}'), after(object({ n: 5, m: 0 }), repaired));
    // fields of definite kinds keep their false, zero, empty text, empty list and empty object
    const typed = parsed(
      '{b: true, i: 1, t: "x", l: [1], o: {}, m: 0}',
      files,
      "{b: boolean, i: integer, t: string, l: list<integer>, o: {}, m: integer}",
    );
    assert.deepEqual(
      read(typed.plan, '{"b": false, "i": 0, "t": "", "l": [], "o": {}}'),
      after(object({ b: false, i: 0, t: "", l: listOf(), o: object({}), m: 0 }), [
        `TSW020@${typed.site}`,
      ]),
    );
    // nested: a valid `null` two levels down while a field at the top is repaired, and the reverse
    const nested = parsed(
      `{n: ${OPEN}, a: {b: {n: ${OPEN}, m: 0}}, m: 0}`,
      files,
      `{n: ${EVERY}, a: {b: {n: ${EVERY}, m: integer}}, m: integer}`,
    );
    const deep = (m: SerializableRuntimeValue) => object({ b: object({ n: null, m }) });
    assert.deepEqual(
      read(nested.plan, '{"n": null, "a": {"b": {"n": null, "m": 1}}}'),
      after(object({ n: null, a: deep(1), m: 0 }), [`TSW020@${nested.site}`]),
    );
    assert.deepEqual(
      read(nested.plan, '{"n": null, "a": {"b": {"n": null}}, "m": 2}'),
      after(object({ n: null, a: deep(0), m: 2 }), [`TSW020@${nested.site}`]),
    );
  }
  // the legacy plan gives what the JSON holds, as it did
  const legacy = `let out = fromJson(hostValue, default: {n: ${OPEN}, m: 0})\nsay "AFTER"\nexit\n`;
  assert.deepEqual(read(legacyPlan(legacy), '{"n": null}'), after(dictOf({ n: null })));
  // a file store keeps the file of the kept field only, never the wrong field's or the extra key's, and the valid
  // `null` beside the repaired `m`, with and without checkpoints of the request and of the answer
  const photo = parsed(
    `{photo: "", n: ${OPEN}, m: 0}`,
    "",
    `{photo: string, n: ${EVERY}, m: integer}`,
  );
  const photoJson = `{"photo": "${pngDataUrl(1)}", "n": null, "m": "${pngDataUrl(2)}", "extra": "${pngDataUrl(3)}"}`;
  for (const checkpoints of [false, true]) {
    const result = throughFileStore(
      photo.plan,
      photoJson,
      { kind: "stored", references: [STORED] },
      checkpoints,
    );
    assert.deepEqual(
      { stored: result.stored, ...ran(result), out: bound(result.snapshot, "out") },
      { stored: 1, ...after(object({ photo: STORED, n: null, m: 0 }), [`TSW020@${photo.site}`]) },
    );
  }
  // a default that runs as instructions: the JSON's record waits in the result's temporary, restored at every boundary
  const record = `{n: ${OPEN}, m: 0}`;
  const type = `{n: ${EVERY}, m: integer}`;
  const inner = `fromJson("{\\"m\\": 1}", default: ${record})`;
  const waiting = compiled(
    `fromJson("{\\"n\\": null}", default: ${inner})`,
    (site, source) => [
      `expected fileStore@${site} ${type}`,
      `expected fileStore@${at(source, inner)} ${type}`,
      `repair storeTemporary@${at(source, record)} ${type}`,
      `repair storeTemporary@${at(source, inner)} ${type}`,
    ],
    inner,
  );
  const resumed = assertRuntimeResumeEquivalent(waiting.source, {
    transformPlan: () => waiting.plan,
  });
  assert.deepEqual(
    {
      ...summary(resumed.events, resumed.finalSnapshot.status),
      out: bound(resumed.finalSnapshot, "out"),
    },
    after(object({ n: null, m: 1 }), [`TSW020@${waiting.site}`]),
  );
  // a load repairs a stored record the same way and keeps the stored value, each field it repairs named by TSW016
  const stored = compiled(
    `load("k", default: {n: ${OPEN}, a: {b: {n: ${OPEN}, m: 0}}, m: 0})`,
    (site) => [
      `repair storageLoad@${site}`,
      `type storageLoad@${site} {n: ${EVERY}, a: {b: {n: ${EVERY}, m: integer}}, m: integer}`,
    ],
  );
  const loaded = (value: SerializableRuntimeValue) => {
    const storage = [{ key: "k", value }];
    const result = runWith(stored.plan, null, storage);
    return {
      ...ran(result),
      out: bound(result.snapshot, "out"),
      named: result.events.flatMap((event) =>
        event.kind === "developerWarning"
          ? [/takes '([\w.]+)' from its default/.exec(event.message)?.[1]]
          : [],
      ),
      storage: result.snapshot.scriptStorage,
    };
  };
  const fieldRepaired = (
    before: SerializableRuntimeValue,
    out: SerializableRuntimeValue,
    named: string,
  ) => ({
    ...after(out, [`TSW016@${stored.site}`]),
    named: [named],
    storage: [{ key: "k", value: before }],
  });
  const deepStored = (fields: Readonly<Record<string, SerializableRuntimeValue>>) =>
    object({ b: object({ n: null, ...fields }) });
  for (const [, value] of valid)
    for (const m of [undefined, "x"]) {
      const before = object({
        n: value,
        a: deepStored({ m: 1 }),
        ...(m === undefined ? {} : { m }),
      });
      assert.deepEqual(
        loaded(before),
        fieldRepaired(before, object({ n: value, a: deepStored({ m: 1 }), m: 0 }), "m"),
      );
    }
  const deepMissing = object({ n: null, a: deepStored({}), m: 2 });
  assert.deepEqual(
    loaded(deepMissing),
    fieldRepaired(deepMissing, object({ n: null, a: deepStored({ m: 0 }), m: 2 }), "a.b.m"),
  );
  // a load whose default runs as instructions: the stored record waits in the result's temporary at every boundary
  const loadWaiting = compiled(
    `load("k", default: ${inner})`,
    (site, source) => [
      `repair storageLoad@${site}`,
      `type storageLoad@${site} ${type}`,
      `expected fileStore@${at(source, inner)} ${type}`,
      `repair storeTemporary@${at(source, record)} ${type}`,
      `repair storeTemporary@${at(source, inner)} ${type}`,
    ],
    inner,
  );
  const storage = [{ key: "k", value: object({ n: null }) }];
  const loadResumed = assertRuntimeResumeEquivalent(loadWaiting.source, {
    scriptStorage: storage,
    transformPlan: () => loadWaiting.plan,
  });
  assert.deepEqual(
    {
      ...summary(loadResumed.events, loadResumed.finalSnapshot.status),
      out: bound(loadResumed.finalSnapshot, "out"),
      storage: loadResumed.finalSnapshot.scriptStorage,
    },
    { ...after(object({ n: null, m: 1 }), [`TSW016@${loadWaiting.site}`]), storage },
  );
});
