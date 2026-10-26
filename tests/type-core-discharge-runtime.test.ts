import assert from "node:assert/strict";
import test from "node:test";

import { compileSource, compileSourceWithBackend } from "../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../src/runtime/host-data/script-storage.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { recordDifferences } from "./helpers/type-core-records.js";

/*
 * The discharge map's new rows (the port plan's S3 §4, step S7) through the candidate route, each in the three layers of
 * the runtime-check evidence rule (docs/TESTING.md): the core's obligation at its site; the plan content that carries
 * its check at the intended site, with its target and type; and runs through the public route, a fitting value reaching
 * the next effect and a violating one stopping at the check, with its TSR code there, before that effect. Every layer
 * in both orders of the core. Each row's legacy plan carries none of the content and runs as before (D7).
 */

const OPTIONS = { globals: ["hostValue"] };

/** `make` in the core's order and with its consumers' and solver's orders reversed: both, equal. */
function inBothOrders<T>(make: () => T): T {
  const forward = make();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), make),
  );
  assert.deepEqual(reversed, forward);
  return forward;
}

/** The core's decision for a program: its diagnostics and its checks, as `class kind @start:end` and `kind target [against] @start:end`. */
function decision(source: string): { diagnostics: string[]; checks: string[] } {
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null, source);
  return inBothOrders(() => {
    const record = compactAnalysis(request);
    // as multisets: a record's order is not part of it
    return {
      diagnostics: record.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.class} ${diagnostic.kind} @${diagnostic.site.offset}:${diagnostic.site.end}`,
        )
        .sort(),
      checks: record.checks
        .map(
          (check) =>
            `${check.kind} ${check.target} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} ` +
            `@${check.site.offset}:${check.site.end}`,
        )
        .sort(),
    };
  });
}

/** A type as these tests write it: `integer`, `integer|number`, `list<any>`, `{name: string, count: integer}`. */
function typeText(type: TypePlan): string {
  switch (type.kind) {
    case "union":
      return type.members.map(typeText).join("|");
    case "list":
    case "set":
    case "dict":
      return `${type.kind}<${type.element === null ? "any" : typeText(type.element)}>`;
    case "object":
      return `{${type.properties.map((property) => `${property.name}: ${typeText(property.type)}`).join(", ")}}`;
    default:
      return type.kind;
  }
}

const S7_FIELDS = ["requireExisting", "indexCheck", "fallbackCheck", "expected", "repair"] as const;
const S7_NAMES: readonly string[] = S7_FIELDS;

/**
 * The S7 content of a plan, each as `field node@start:end value`, in plan order: the new fields of the discharge map's
 * rows (S3 §4's "Serialised contracts"), and a load's `type` beside its `repair`.
 */
function contentOf(plan: InstructionPlan): string[] {
  const found: string[] = [];
  const pending: unknown[] = [...plan.instructions].reverse();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (let at = node.length - 1; at >= 0; at -= 1) pending.push(node[at]);
      continue;
    }
    // EVIDENCE: invariant: a plan node is a plain object of fields, read here by name.
    const fields = node as Readonly<Record<string, unknown>>;
    // EVIDENCE: invariant: a plan node's span is its plan location.
    const span = fields["span"] as { readonly so: number; readonly eo: number } | undefined;
    const at = `${String(fields["kind"])}@${span?.so ?? "?"}:${span?.eo ?? "?"}`;
    for (const field of S7_FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      if (value === true) {
        found.push(`${field} ${at}`);
        continue;
      }
      // EVIDENCE: invariant: the other S7 fields hold a type check (`fallbackCheck`) or a type.
      const type =
        field === "fallbackCheck" ? (value as { type: TypePlan }).type : (value as TypePlan);
      found.push(`${field} ${at} ${typeText(type)}`);
    }
    if (fields["kind"] === "storageLoad" && fields["repair"] === true) {
      // EVIDENCE: invariant: plan validation admits `repair` only beside an object type.
      const type = fields["type"] as TypePlan;
      found.push(`type ${at} ${typeText(type)}`);
    }
    const children = Object.entries(fields).filter(
      ([key]) => key !== "span" && !S7_NAMES.includes(key),
    );
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]![1]);
  }
  return found;
}

/** The candidate route's plan of `source`, in both orders, and its S7 content. */
function candidatePlan(source: string): InstructionPlan {
  const plan = inBothOrders(() => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).plan);
  assert.ok(plan !== null, source);
  assert.deepEqual(validateInstructionPlan(plan).errors, [], source);
  return plan;
}

/** The legacy backend's plan of `source`, which production selects: none of S7's content (D7). */
function legacyPlan(source: string): InstructionPlan {
  const plan = compileSource(source, OPTIONS).plan;
  assert.ok(plan !== null, source);
  assert.deepEqual(contentOf(plan), [], `${source}: the legacy plan carries no S7 content`);
  return plan;
}

interface Ran {
  readonly status: string;
  readonly said: readonly string[];
  readonly failure: string | null;
  readonly warnings: readonly string[];
}

function summary(events: readonly InterpreterEvent[], status: string): Ran {
  const failure = events.find((event) => event.kind === "runtimeFailure");
  return {
    status,
    said: events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
    warnings: events.flatMap((event) =>
      event.kind === "developerWarning"
        ? [`${event.code}@${event.span.start.offset}:${event.span.end.offset}`]
        : [],
    ),
  };
}

/** A run of `plan` to its end, without reading pauses, with `hostValue` and the stored values. */
function runWith(
  plan: InstructionPlan,
  hostValue: SerializableRuntimeValue,
  scriptStorage: readonly RuntimeScriptStorageEntrySnapshot[] = [],
): Ran & { readonly snapshot: RuntimeSnapshot; readonly events: readonly InterpreterEvent[] } {
  const result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue }, scriptStorage }),
  );
  return {
    ...summary(result.events, result.snapshot.status),
    snapshot: result.snapshot,
    events: result.events,
  };
}

const halted = (said: readonly string[], warnings: readonly string[] = []): Ran => ({
  status: "halted",
  said,
  failure: null,
  warnings,
});

const failed = (failure: string, said: readonly string[] = []): Ran => ({
  status: "failed",
  said,
  failure,
  warnings: [],
});

/** The span of the `nth` occurrence of `text` in `source`, as `start:end`. */
function at(source: string, text: string, nth = 0): string {
  let start = -1;
  for (let count = 0; count <= nth; count += 1) start = source.indexOf(text, start + 1);
  assert.ok(start >= 0, `${text} in ${source}`);
  return `${start}:${start + text.length}`;
}

/** The span of the line of `source` that starts with `text`, without its line break. */
function line(source: string, text: string): string {
  const start = source.startsWith(text) ? 0 : source.indexOf(`\n${text}`) + 1;
  return `${start}:${source.indexOf("\n", start)}`;
}

const object = (
  fields: Readonly<Record<string, SerializableRuntimeValue>>,
): SerializableRuntimeValue => ({
  kind: "object",
  properties: Object.entries(fields).map(([name, value]) => ({ name, value })),
});

const ran = (result: Ran): Ran => ({
  status: result.status,
  said: result.said,
  failure: result.failure,
  warnings: result.warnings,
});

test("a store of a property its object may lack requires it, in three layers, in both orders (C5c, S3 §4)", () => {
  // an unknown receiver, and an object some source lacks the property in
  const unknown = 'let x = hostValue\nx.n = 2\nsay "AFTER"\nexit\n';
  const some =
    'let room = [{count: 1}, {name: "hall"}][hostValue]\nroom.count = 2\nsay "AFTER"\nexit\n';
  for (const [source, receiver, store, target, fits, misses] of [
    [unknown, "x", "x.n = 2", "x.n", object({ n: 1 }), object({ m: 1 })],
    [some, "room", "room.count = 2", "room.count", 0, 1],
  ] as const) {
    // the receiver as the store reads it, after its declaration
    const recv = at(source, receiver, 1);
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check member-read @${recv}`), source);
    assert.ok(known.checks.includes(`null-check ${receiver} [non-null] @${recv}`), source);
    const plan = candidatePlan(source);
    assert.ok(contentOf(plan).includes(`requireExisting assign@${line(source, store)}`), source);
    assert.deepEqual(
      ran(runWith(plan, fits)),
      halted(["AFTER"]),
      `${source} with a fitting object`,
    );
    assert.deepEqual(
      ran(runWith(plan, misses)),
      failed(`TSR017@${at(source, target)}`),
      `${source} with an object that lacks the property`,
    );
    // the legacy plan adds the property, as it did
    assert.deepEqual(ran(runWith(legacyPlan(source), misses)), halted(["AFTER"]), source);
  }
  // a store every source has the property for needs no check; one no source has it for is the error at the literal
  assert.deepEqual(contentOf(candidatePlan("let room = {count: 1}\nroom.count = 2\nexit\n")), []);
  assert.deepEqual(decision('let room = {count: 1}\nroom.name = "x"\nexit\n').diagnostics, [
    "compile-error member-read @11:21",
  ]);
});

test("a list get rejects an index that is no whole number, in three layers, in both orders (C2, S3 §4)", () => {
  const source = 'let xs = [1, 2]\nlet v = xs.get(hostValue, default: 0)\nsay "AFTER"\nexit\n';
  const index = at(source, "hostValue");
  const known = decision(source);
  assert.ok(known.diagnostics.includes(`warning-runtime-check integer-use @${index}`));
  assert.ok(known.checks.includes(`integer-check hostValue [integer] @${index}`));
  const plan = candidatePlan(source);
  assert.deepEqual(contentOf(plan), [
    `indexCheck call@${at(source, "xs.get(hostValue, default: 0)")}`,
  ]);
  assert.deepEqual(ran(runWith(plan, 1)), halted(["AFTER"]));
  // a whole number the list does not have still selects the default
  assert.deepEqual(ran(runWith(plan, 7)), halted(["AFTER"]));
  for (const bad of [1.5, "1", null])
    assert.deepEqual(ran(runWith(plan, bad)), failed(`TSR024@${index}`), JSON.stringify(bad));
  // the legacy plan selects the default for every index that is no position, as it did
  assert.deepEqual(ran(runWith(legacyPlan(source), 1.5)), halted(["AFTER"]));
});

test("an otherwise's selected fallback is checked against the value's family, in three layers, in both orders (C10, S3 §4)", () => {
  // the expression form, and the form whose fallback runs as instructions (a file store)
  const direct =
    'let amount = [1, null][1]\nlet result = amount otherwise hostValue\nsay "AFTER"\nexit\n';
  const lowered =
    'let amount = [1, null][1]\nlet result = amount otherwise fromJson(hostValue, default: null)\nsay "AFTER"\nexit\n';
  for (const [source, fallback, node, fits, bad, value] of [
    [direct, "hostValue", "binary", 3, "text", at(direct, "amount otherwise hostValue")],
    [
      lowered,
      "fromJson(hostValue, default: null)",
      "storeTemporary",
      "5",
      '"x"',
      at(lowered, "fromJson(hostValue, default: null)"),
    ],
  ] as const) {
    const site = at(source, fallback);
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${site}`), source);
    assert.ok(known.checks.includes(`copy-type ${fallback} [integer, number] @${site}`), source);
    const plan = candidatePlan(source);
    assert.ok(
      contentOf(plan).includes(
        `fallbackCheck ${node}@${node === "binary" ? value : site} integer|number`,
      ),
      `${source}: ${JSON.stringify(contentOf(plan))}`,
    );
    assert.deepEqual(ran(runWith(plan, fits)), halted(["AFTER"]), source);
    assert.deepEqual(ran(runWith(plan, bad)), failed(`TSR058@${site}`), source);
    // the legacy plan stores any fallback, as it did
    assert.deepEqual(ran(runWith(legacyPlan(source), bad)), halted(["AFTER"]), source);
  }
  // the instruction form across every boundary, a checkpoint round trip at each (the fallback's instructions)
  for (const [json, ending] of [
    ["5", "halted"],
    ['\\"x\\"', "failed"],
  ] as const) {
    const source = `let amount = [1, null][1]\nlet result = amount otherwise fromJson("${json}", default: null)\nsay "AFTER"\nexit\n`;
    assertRuntimeResumeEquivalent(source, { ending, transformPlan: () => candidatePlan(source) });
  }
});

/** A stored file of the session, which `decryptFile` reads. */
const STORED = "stored:1";

/**
 * A run of `plan` with `hostValue` and the stored file, the Player answering each lock that it could not open, a
 * checkpoint round trip on both sides of each answer.
 */
function notOpened(plan: InstructionPlan, hostValue: SerializableRuntimeValue): Ran {
  const restored = (snapshot: RuntimeSnapshot): RuntimeSnapshot =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot))).snapshot;
  let result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue }, storedFiles: [STORED] }),
  );
  const events = [...result.events];
  for (let guard = 0; result.snapshot.status === "waiting"; guard += 1) {
    assert.ok(guard < 5, "the script keeps waiting");
    const snapshot = restored(result.snapshot);
    const action = snapshot.foregroundAction!;
    assert.equal(action.kind, "lock");
    const completed = completeAction(
      plan,
      snapshot,
      { actionId: action.actionId, actionKind: "lock", payload: { kind: "notOpened" } },
      { capturedMedia: { holds: () => true } },
    );
    assert.equal(completed.outcome.kind, "completed", JSON.stringify(completed.outcome));
    events.push(...completed.events);
    result = run(plan, restored(completed.snapshot));
    events.push(...result.events);
  }
  return summary(events, result.snapshot.status);
}

test("the default of fileFromBase64, decryptText and decryptFile is checked where it is selected, in three layers, in both orders (C10, S3 §4)", () => {
  for (const call of [
    'fileFromBase64("!"',
    'decryptText("!", password: "pw"',
    `decryptFile("${STORED}", password: "pw"`,
  ]) {
    const source = `let value = ${call}, default: hostValue)\nsay "AFTER"\nexit\n`;
    const site = at(source, "hostValue");
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${site}`), source);
    assert.ok(known.checks.includes(`copy-type hostValue [string] @${site}`), source);
    const plan = candidatePlan(source);
    assert.ok(contentOf(plan).includes(`fallbackCheck storeTemporary@${site} string`), source);
    // `decryptFile` opens a stored file: the Player cannot, so the default is selected
    const play = call.startsWith("decryptFile")
      ? notOpened
      : (of: InstructionPlan, value: SerializableRuntimeValue) => ran(runWith(of, value));
    assert.deepEqual(play(plan, "abc"), halted(["AFTER"]), source);
    assert.deepEqual(play(plan, null), halted(["AFTER"]), source);
    assert.deepEqual(play(plan, 3), failed(`TSR058@${site}`), source);
    // the legacy plan takes any default, as it did
    assert.deepEqual(play(legacyPlan(source), 3), halted(["AFTER"]), source);
  }
});

test("a get's and a conversion's selected default is checked against the result's family, in three layers, in both orders (C10, S3 §4)", () => {
  for (const [source, fits, bad] of [
    ['let v = [1].get(5, default: hostValue)\nsay "AFTER"\nexit\n', 5, "text"],
    ['let n = toInteger("x", default: hostValue)\nsay "AFTER"\nexit\n', 5, "text"],
  ] as const) {
    const site = at(source, "hostValue");
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${site}`), source);
    assert.ok(known.checks.includes(`copy-type hostValue [integer, number] @${site}`), source);
    const plan = candidatePlan(source);
    const call = source.slice(8, source.indexOf("\n"));
    assert.ok(
      contentOf(plan).includes(`fallbackCheck call@${at(source, call)} integer|number`),
      source,
    );
    assert.deepEqual(ran(runWith(plan, fits)), halted(["AFTER"]), source);
    assert.deepEqual(ran(runWith(plan, bad)), failed(`TSR058@${site}`), source);
  }
});

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

test("fromJson's object repair waits for a default that runs instructions, also across a file store's answer and every checkpoint (F18, S3 §4's handoff)", () => {
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

/** A stored value of the records below, as the host gives it: a record of its fields, nested records too. */
function stored(value: unknown): SerializableRuntimeValue {
  if (typeof value !== "object" || value === null) {
    // EVIDENCE: fixture: the scenarios' stored values are JSON data, records and scalars.
    return value as SerializableRuntimeValue;
  }
  return object(
    Object.fromEntries(Object.entries(value).map(([name, field]) => [name, stored(field)])),
  );
}

const PROFILE_SOURCE =
  'let profile = load("profile", default: {name: "Guest", count: 0})\nsay profile.name\nsay profile.count\nexit\n';

/**
 * AD-2's runtime requirements (the expectation set's `runtime-observations.json` at revision `81b3a0c419ed542b`, SHA-256
 * `9553ef4a788c348d…`, TABLE r4.52): per scenario its source, the stored values before, what it says, the fields its
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

test("a load repairs a stored record per field, the stored value kept, each bad field named by TSW016: AD-2's records and scenarios (ADR 0021 rule 6.5)", () => {
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
});

/*
 * The revisions (docs/RUNTIME.md "Format evolution"): the content above is new plan content, so the plan and checkpoint
 * revisions both increase once for S7; a plan without it, such as every legacy plan, and its checkpoints stay valid and
 * run as before, and plan validation rejects the new fields where they do not belong.
 */
test("a legacy plan's checkpoint restores at the current revisions and resumes as before, at every boundary (D7)", () => {
  // every row's construct in one script the production backend compiles: its plan has none of the new content
  const source =
    'let room = {count: 1}\nroom.name = "hall"\nlet xs = [1, 2]\nlet v = xs.get(5, default: 0)\n' +
    'let amount = [1, null][1]\nlet result = amount otherwise 2\nlet n = fromJson("\\"x\\"", default: 0, files: false)\n' +
    "say room.name\nsay n\nexit\n";
  const plan = legacyPlan(source);
  const result = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(summary(result.events, result.finalSnapshot.status), halted(["hall", "x"]));
  // a checkpoint at the current revisions carries the legacy plan as it is, which runs as it did
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, createImmediatePacingRuntimeSnapshot(plan))),
  );
  assert.deepEqual(restored.plan, plan);
  const rest = run(restored.plan, restored.snapshot);
  assert.deepEqual(summary(rest.events, rest.snapshot.status), halted(["hall", "x"]));
});

test("plan validation rejects S7's fields where they do not belong (S3 §4's serialised contracts)", () => {
  const plan = candidatePlan(
    "let x = hostValue\nx.n = 2\nlet xs = [1]\nlet v = xs.get(hostValue, default: hostValue)\n" +
      "let amount = [1, null][1]\nlet result = amount otherwise hostValue\nexit\n",
  );
  const json = JSON.stringify(plan);
  /** The errors of the plan with `change` applied to a copy of its first node that has `field`. */
  const rejected = (field: string, change: (node: Record<string, unknown>) => void): string[] => {
    // EVIDENCE: fixture: the plan's own JSON, an object.
    const copy = JSON.parse(json) as Record<string, unknown>;
    const pending: unknown[] = [copy];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (typeof node !== "object" || node === null) continue;
      if (Array.isArray(node)) pending.push(...node);
      else {
        // EVIDENCE: invariant: a parsed plan node is a plain object.
        const fields = node as Record<string, unknown>;
        if (field in fields) {
          change(fields);
          break;
        }
        pending.push(...Object.values(fields));
      }
    }
    return validateInstructionPlan(copy).errors.map((error) => `${error.code} ${error.message}`);
  };
  const typeCheck = { type: { kind: "integer" }, place: "'x'" };
  for (const [field, change, message] of [
    [
      "requireExisting",
      (node: Record<string, unknown>) => (node["requireExisting"] = false),
      "Only a property store can require an existing property.",
    ],
    [
      "requireExisting",
      (node: Record<string, unknown>) =>
        (node["target"] = { kind: "identifier", name: "x", span: node["span"] }),
      "Only a property store can require an existing property.",
    ],
    [
      "indexCheck",
      (node: Record<string, unknown>) => {
        // EVIDENCE: fixture: a call's callee in the plan's JSON is an object.
        const callee = node["callee"] as Record<string, unknown>;
        callee["name"] = "contains";
      },
      "Only a 'get' call checks its index.",
    ],
    [
      "fallbackCheck",
      (node: Record<string, unknown>) => (node["operator"] = "+"),
      "Only 'otherwise' checks a fallback.",
    ],
    [
      "fallbackCheck",
      (node: Record<string, unknown>) => (node["fallbackCheck"] = { type: { kind: "integer" } }),
      "Expected a non-empty string.",
    ],
    [
      "indexCheck",
      (node: Record<string, unknown>) => (node["expected"] = typeCheck.type),
      "Only a 'fromJson' call reads an expected type.",
    ],
  ] as const) {
    const errors = rejected(field, change);
    assert.ok(
      errors.some((error) => error.endsWith(message)),
      `${field}: ${errors.join("; ")}`,
    );
  }
  // the unchanged plan is valid
  assert.deepEqual(validateInstructionPlan(JSON.parse(json)).errors, []);
});

/** A plan's checked stores, as `target type`: the `let`s and assignments that check what they store. */
function checkedStores(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.typeCheck !== undefined
      ? [`${instruction.typeCheck.place} ${typeText(instruction.typeCheck.type)}`]
      : [],
  );
}

test("a store's check, a parse's expected type and a fallback's check keep the structure the core decided, in three layers, in both orders (S7 review r1 B1, B2, B4, r2 B1, B2)", () => {
  // a record stored whole from host data: its boundary validates the decided fields (C9 at the record level, A7)
  const whole = 'let p = {stats: {n: 1}}\np = hostValue\nsay p.stats.n\nsay "AFTER"\nexit\n';
  assert.ok(
    decision(whole).checks.includes(`copy-type p [object] boundary @${at(whole, "hostValue")}`),
  );
  const store = candidatePlan(whole);
  assert.deepEqual(checkedStores(store), ["'p' {stats: {n: integer}}"]);
  assert.deepEqual(
    ran(runWith(store, object({ stats: object({ n: 3 }) }))),
    halted(["3", "AFTER"]),
  );
  assert.deepEqual(
    ran(runWith(store, object({ stats: object({ n: "bad" }) }))),
    failed(`TSR058@${at(whole, "hostValue")}`),
  );
  // a named object default gives what it holds at every depth, on both lowerings
  for (const files of ["", ", files: false"]) {
    const named = `let d = {stats: {count: 0}}\nlet p = fromJson(hostValue, default: d${files})\nsay p.stats.count\nexit\n`;
    const parse = at(named, `fromJson(hostValue, default: d${files})`);
    assert.ok(decision(named).checks.includes(`copy-type p [object] boundary @${parse}`));
    const plan = candidatePlan(named);
    assert.ok(
      contentOf(plan).some((entry) => entry.endsWith(`@${parse} {stats: {count: integer}}`)),
      JSON.stringify(contentOf(plan)),
    );
    assert.deepEqual(ran(runWith(plan, '{"stats": {"count": 3}}')), halted(["3"]));
    assert.deepEqual(
      ran(runWith(plan, '{"stats": {"count": "bad"}}')),
      halted(["0"], [`TSW020@${parse}`]),
    );
  }
  // a fallback's elements: C10 at the fallback's element depth checks the selected list where it is selected, a null
  // element allowed as C10 allows it
  const nested =
    'let xs = [[1], null][1]\nlet n = (xs otherwise [hostValue, 2])[1]\nsay n\nsay "AFTER"\nexit\n';
  const fallback = at(nested, "[hostValue, 2]");
  assert.ok(
    decision(nested).checks.includes(
      `copy-type [hostValue, 2].element [integer, number] @${fallback}`,
    ),
  );
  const checked = candidatePlan(nested);
  assert.ok(
    contentOf(checked).includes(
      `fallbackCheck binary@${at(nested, "xs otherwise [hostValue, 2]")} list<integer|number|null>`,
    ),
    JSON.stringify(contentOf(checked)),
  );
  assert.deepEqual(ran(runWith(checked, 3)), halted(["2", "AFTER"]));
  assert.deepEqual(ran(runWith(checked, null)), halted(["2", "AFTER"]));
  assert.deepEqual(ran(runWith(checked, "bad")), failed(`TSR058@${fallback}`));
  // the written type of the place a parse lands in directly, through a literal's elements and a get's default,
  // nullable as written: the core's own answer at the call (its kinds possible, F18)
  for (const [source, json, expected, said] of [
    [
      "let xs: number[] = [fromJson(hostValue, default: 0, files: false)]\nsay xs[0]\nexit\n",
      "1.5",
      "number",
      "1.5",
    ],
    [
      "let a: number[] = [[1].get(2, default: fromJson(hostValue, default: 0, files: false))]\nsay a[0]\nexit\n",
      "1.5",
      "number",
      "1.5",
    ],
    [
      "let n: integer? = fromJson(hostValue, default: 0, files: false)\nsay n\nexit\n",
      "null",
      "integer|null",
      "null",
    ],
  ] as const) {
    const call = at(source, "fromJson(hostValue, default: 0, files: false)");
    assert.ok(
      decision(source).checks.some((check) => check.endsWith(`boundary @${call}`)),
      source,
    );
    const plan = candidatePlan(source);
    assert.deepEqual(contentOf(plan), [`expected call@${call} ${expected}`], source);
    assert.deepEqual(ran(runWith(plan, json)), halted([said]), source);
  }
  // the default's kinds as the core reads them, through a copy of a written list: what it holds (F18)
  const copied =
    'let a: number[] = [0]\nlet b = a\nlet p = fromJson(hostValue, default: b, files: false)\nsay p[0]\nsay "AFTER"\nexit\n';
  const parse = at(copied, "fromJson(hostValue, default: b, files: false)");
  const plan = candidatePlan(copied);
  assert.deepEqual(contentOf(plan), [`expected call@${parse} list<integer>`]);
  assert.deepEqual(checkedStores(plan), ["'p' list<integer>"]);
  assert.deepEqual(ran(runWith(plan, "[3]")), halted(["3", "AFTER"]));
  assert.deepEqual(ran(runWith(plan, "[1.5]")), halted(["0", "AFTER"], [`TSW020@${parse}`]));
});

test("a typed parse's known value is the one its run gets: a known bad count is still the kept check's error (S7 review r2 B4)", () => {
  // JSON that fits the expected type keeps its value for the kept count check; JSON that does not gives the default
  assert.deepEqual(
    compileSourceWithBackend(
      'repeat fromJson("-1", default: 0, files: false) { say "BODY" }\nsay "AFTER"\nexit\n',
      OPTIONS,
      CORE_BACKEND,
    ).diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}`),
    ["error TSV011"],
  );
  const repaired =
    'repeat fromJson("1.5", default: 0, files: false) { say "BODY" }\nsay "AFTER"\nexit\n';
  assert.deepEqual(ran(runWith(candidatePlan(repaired), null)).said, ["AFTER"]);
});

test("a typed parse's or load's expected type is the core's own answer at the call, which its store's check holds, in three layers, in both orders (S7 review r3 B1, B2, B3)", () => {
  // a `null` element of the default is one of its values (ADR 0021 2.6), on both lowerings
  for (const files of ["", ", files: false"]) {
    const source = `let out = fromJson(hostValue, default: [null, 1]${files})\nsay out[0]\nsay "AFTER"\nexit\n`;
    const parse = at(source, `fromJson(hostValue, default: [null, 1]${files})`);
    assert.ok(
      decision(source).checks.some((check) => check.endsWith(`boundary @${parse}`)),
      source,
    );
    const plan = candidatePlan(source);
    assert.deepEqual(checkedStores(plan), ["'out' list<integer|null>"], source);
    assert.ok(
      contentOf(plan).some((entry) => entry.endsWith(`@${parse} list<integer|null>`)),
      JSON.stringify(contentOf(plan)),
    );
    assert.deepEqual(
      ran(runWith(plan, '["bad", 2]')),
      halted(["null", "AFTER"], [`TSW020@${parse}`]),
      source,
    );
    assert.deepEqual(ran(runWith(plan, "[3, 2]")), halted(["3", "AFTER"]), source);
  }
  // the load reads its stored value as the same type
  const load = 'let out = load("k", default: [null, 1])\nsay out[0]\nsay "AFTER"\nexit\n';
  const loaded = candidatePlan(load);
  assert.deepEqual(checkedStores(loaded), ["'out' list<integer|null>"]);
  const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
    kind: "list",
    items,
  });
  assert.deepEqual(
    ran(runWith(loaded, null, [{ key: "k", value: list("bad", 2) }])),
    halted(["null", "AFTER"], [`TSW016@${at(load, 'load("k", default: [null, 1])')}`]),
  );
  assert.deepEqual(
    ran(runWith(loaded, null, [{ key: "k", value: list(3, 2) }])),
    halted(["3", "AFTER"]),
  );
  // the records of a list default settle one family: a field's numbers read as numbers
  const records =
    'let out = fromJson(hostValue, default: [{n: 1}, {n: 1.5}], files: false)\nsay out[0].n\nsay "AFTER"\nexit\n';
  const parse = at(records, "fromJson(hostValue, default: [{n: 1}, {n: 1.5}], files: false)");
  const read = candidatePlan(records);
  assert.deepEqual(checkedStores(read), ["'out' list<{n: number}>"]);
  assert.deepEqual(contentOf(read), [`expected call@${parse} list<{n: number}>`]);
  assert.deepEqual(ran(runWith(read, '[{"n": 2.5}]')), halted(["2.5", "AFTER"]));
  assert.deepEqual(ran(runWith(read, '[{"n": "x"}]')), halted(["1", "AFTER"], [`TSW020@${parse}`]));
  // a record as deep as the slice follows repairs its leaf; deeper, and fields some records of a list lack, which no
  // default supplies there, leave the slice rather than check less than the core decided
  const deep = (depth: number): string =>
    `let d = ${"{f: ".repeat(depth)}0${"}".repeat(depth)}\nlet out = fromJson(hostValue, default: d, files: false)\n` +
    `say out${".f".repeat(depth)}\nsay "AFTER"\nexit\n`;
  const followed = deep(128);
  assert.deepEqual(
    ran(runWith(candidatePlan(followed), `${'{"f":'.repeat(128)}"bad"${"}".repeat(128)}`)),
    halted(
      ["0", "AFTER"],
      [`TSW020@${at(followed, "fromJson(hostValue, default: d, files: false)")}`],
    ),
  );
  for (const source of [
    deep(255),
    'let out = fromJson(hostValue, default: [{n: 1}, {m: 2}], files: false)\nsay "AFTER"\nexit\n',
  ])
    assert.throws(
      () => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND),
      (error) =>
        error instanceof CandidateOutsideSlice &&
        error.what === "a value whose structure the slice does not follow",
      source.slice(0, 80),
    );
});

test("the candidate route rejects the loads whose storage rules S9b brings (S3 §3)", () => {
  for (const source of [
    // one key, two spellings: the agreement of a key's loads
    'let a = load("k", default: 0)\nlet b = load("""k""", default: "x")\nexit\n',
    // a default that is only null, without a declared type
    'let d = null\nlet a = load("x", default: d)\nexit\n',
  ])
    assert.throws(
      () => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND),
      (error) => error instanceof CandidateOutsideSlice && error.what === "this load expression",
      source,
    );
});
