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
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { VALUE_KIND_NAMES } from "../src/value-kinds.js";
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
    // the whole access the store writes through (TABLE §3.4)
    const access = at(source, target);
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check member-read @${access}`), source);
    assert.ok(known.checks.includes(`null-check ${receiver} [non-null] @${access}`), source);
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

/** Every object of a plan, as an external source may edit it. */
function planNodes(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const pending = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    // EVIDENCE: invariant: a non-array object of a JSON-safe plan is a record.
    const record = node as Record<string, unknown>;
    found.push(record);
    for (const item of Object.values(record)) pending.push(item);
  }
  return found;
}

test("a checked list get without its index fails the plan's and the checkpoint's validation, and a run of it reports the call's own error (Astra B3)", () => {
  const source = "let xs = [1]\nlet v = xs.get(hostValue, default: 0)\nsay v\nexit\n";
  const index = at(source, "hostValue");
  assert.ok(decision(source).checks.includes(`integer-check hostValue [integer] @${index}`));
  const plan = candidatePlan(source);
  assert.deepEqual(contentOf(plan), [
    `indexCheck call@${at(source, "xs.get(hostValue, default: 0)")}`,
  ]);
  assert.deepEqual(ran(runWith(plan, 0)), halted(["1"]));
  assert.deepEqual(ran(runWith(plan, 0.5)), failed(`TSR024@${index}`));
  // a plan from outside whose checked call lost its index: the plan's validation and the checkpoint's reject it
  const indexless = structuredClone(plan);
  const call = planNodes(indexless).find(
    (node) => node.kind === "call" && node.indexCheck === true,
  );
  assert.ok(call !== undefined);
  call.arguments = [];
  assert.ok(
    JSON.stringify(validateInstructionPlan(indexless).errors).includes(
      "Only a 'get' call with its index checks its index.",
    ),
  );
  const start = createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue: 0 } });
  assert.throws(
    () => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(indexless, start))),
    (error) => error instanceof Error && !(error instanceof TypeError),
  );
  // a run given it validates it first: the same structured error, never a native one
  assert.throws(
    () => run(indexless, start),
    (error) =>
      error instanceof Error &&
      !(error instanceof TypeError) &&
      error.message.includes("Only a 'get' call with its index checks its index."),
  );
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
      "Only a 'get' call with its index checks its index.",
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
  // a nested object default gives its structure at every depth, on both lowerings
  for (const files of ["", ", files: false"]) {
    const named = `let p = fromJson(hostValue, default: {stats: {count: 0}}${files})\nsay p.stats.count\nexit\n`;
    const parse = at(named, `fromJson(hostValue, default: {stats: {count: 0}}${files})`);
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
    `let out = fromJson(hostValue, default: ${"{f: ".repeat(depth)}0${"}".repeat(depth)}, files: false)\n` +
    `say out${".f".repeat(depth)}\nsay "AFTER"\nexit\n`;
  const followed = deep(128);
  assert.deepEqual(
    ran(runWith(candidatePlan(followed), `${'{"f":'.repeat(128)}"bad"${"}".repeat(128)}`)),
    halted(["0", "AFTER"], [`TSW020@10:${followed.indexOf("\n")}`]),
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

test("a typed parse's or load's contract stays the one the core decided, or its program leaves the slice, in three layers, in both orders (S7 review r4 B1, B2, N1)", () => {
  // a default that reads a variable: the core's answer at the call follows the stores that reach the read, the result's
  // place the type the program settled; the slice leaves both out until the core's F18 relates them (a lead question)
  const reading = "a typed parse's or load's default that reads a variable";
  const structure = "a value whose structure the slice does not follow";
  for (const [source, what] of [
    [
      "let d = {n: 0}\nd.n = null\nlet out = fromJson(hostValue, default: d, files: false)\nsay out.n\nexit\n",
      reading,
    ],
    [
      "let d = {n: 1.5}\nd.n = 0\nlet out = fromJson(hostValue, default: d, files: false)\nsay out.n\nexit\n",
      reading,
    ],
    [
      "let d = {a: {n: 0}}\nlet out = fromJson(hostValue, default: d.a, files: false)\nsay out.n\nexit\n",
      reading,
    ],
    ['let d = {n: 0}\nlet out = load("k", default: d)\nsay out.n\nexit\n', reading],
    [
      "let a: number[] = [0]\nlet b = a\nlet out = fromJson(hostValue, default: b, files: false)\nexit\n",
      reading,
    ],
    // fields some records of a list lack, also where a record gives them as `null` or host data
    [
      "let out = fromJson(hostValue, default: [{n: null, a: 1}, {m: null, a: 2}], files: false)\nsay out[0].a\nexit\n",
      structure,
    ],
    [
      "let out = fromJson(hostValue, default: [{n: null}, {m: null}], files: false)\nexit\n",
      structure,
    ],
  ] as const)
    assert.throws(
      () => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND),
      (error) => error instanceof CandidateOutsideSlice && error.what === what,
      source,
    );
  // a `null` field of the default that the program types elsewhere: the core answers the call with it unknown and the
  // place with that type, so the slice leaves it out too
  assert.throws(
    () =>
      compileSourceWithBackend(
        "let p = fromJson(hostValue, default: {a: 1, b: null}, files: false)\np.b = 2\nsay p.a\nexit\n",
        OPTIONS,
        CORE_BACKEND,
      ),
    (error) =>
      error instanceof CandidateOutsideSlice &&
      error.what === "an open part of a typed parse's or load's default that its destination types",
  );
  // where nothing else types it, it stays unknown: any JSON value there, the others read as typed
  const open =
    'let p = fromJson(hostValue, default: {a: 1, b: null}, files: false)\nsay p.a\nsay "AFTER"\nexit\n';
  const parse = at(open, "fromJson(hostValue, default: {a: 1, b: null}, files: false)");
  const plan = candidatePlan(open);
  assert.deepEqual(checkedStores(plan), ["'p' {a: integer}"]);
  assert.ok(
    contentOf(plan).some((entry) => entry.startsWith(`expected call@${parse} {a: integer, b: `)),
    JSON.stringify(contentOf(plan)),
  );
  assert.deepEqual(ran(runWith(plan, '{"a": 3, "b": "x"}')), halted(["3", "AFTER"]));
  assert.deepEqual(
    ran(runWith(plan, '{"a": "x", "b": 4}')),
    halted(["1", "AFTER"], [`TSW020@${parse}`]),
  );
  // a record's fields keep its own default's order, whatever another record writes first
  const ordered =
    "let unused = {b: 0, a: 0}\nlet p = fromJson(hostValue, default: {a: 1, b: 2}, files: false)\nsay p.a\nexit\n";
  assert.deepEqual(contentOf(candidatePlan(ordered)), [
    `expected call@${at(ordered, "fromJson(hostValue, default: {a: 1, b: 2}, files: false)")} {a: integer, b: integer}`,
  ]);
});

test("a known `null` reads as the `null` type, an unknown stays open, and each record keeps its own fields' order, in three layers, in both orders (S7 review r5 B1, N1)", () => {
  // a written `null` target, at the root and as a list's elements, on both lowerings
  for (const files of ["", ", files: false"])
    for (const [written, fallback, expected, fitting, said] of [
      ["null", "null", "null", "null", "null"],
      ["null[]", "[null]", "list<null>", "[null]", "null"],
    ] as const) {
      const source = `let p: ${written} = fromJson(hostValue, default: ${fallback}${files})\nsay ${written === "null" ? "p" : "p[0]"}\nsay "AFTER"\nexit\n`;
      const parse = at(source, `fromJson(hostValue, default: ${fallback}${files})`);
      assert.ok(
        decision(source).checks.some((check) => check.endsWith(`boundary @${parse}`)),
        source,
      );
      const plan = candidatePlan(source);
      assert.ok(
        contentOf(plan).some((entry) => entry.endsWith(`@${parse} ${expected}`)),
        `${source}: ${JSON.stringify(contentOf(plan))}`,
      );
      assert.deepEqual(ran(runWith(plan, fitting)), halted([said, "AFTER"]), source);
      assert.deepEqual(
        ran(runWith(plan, written === "null" ? "3" : "[3]")),
        halted([said, "AFTER"], [`TSW020@${parse}`]),
        source,
      );
    }
  // without a written type, a `null` default leaves the value unknown (F19): no expected type
  assert.deepEqual(
    contentOf(
      candidatePlan(
        'let p = fromJson(hostValue, default: null, files: false)\nsay "AFTER"\nexit\n',
      ),
    ),
    [],
  );
  // each record's fields in the order its own literal writes them, not a sibling's or a descendant's
  const nested =
    'let p = fromJson(hostValue, default: {r: {b: 0, a: 0}, s: {a: 1, b: 2}}, files: false)\nsay p.s.a\nsay "AFTER"\nexit\n';
  const parse = at(
    nested,
    "fromJson(hostValue, default: {r: {b: 0, a: 0}, s: {a: 1, b: 2}}, files: false)",
  );
  const plan = candidatePlan(nested);
  const type = "{r: {b: integer, a: integer}, s: {a: integer, b: integer}}";
  assert.deepEqual(contentOf(plan), [`expected call@${parse} ${type}`]);
  assert.deepEqual(checkedStores(plan), [`'p' ${type}`]);
  const repaired = runWith(plan, '{"r": {"b": 0, "a": 0}, "s": {"a": "bad", "b": "bad"}}');
  assert.deepEqual(ran(repaired), halted(["1", "AFTER"], [`TSW020@${parse}`, `TSW020@${parse}`]));
  assert.deepEqual(
    repaired.events.flatMap((event) =>
      event.kind === "developerWarning" ? [/'(s\.[ab])'/.exec(event.message)?.[1]] : [],
    ),
    ["s.a", "s.b"],
  );
});

test("a literal wider than a native call takes compiles and keeps its checks, in three layers (S7 review r7 B1, r8 B1)", () => {
  // more elements than one call passes as spread arguments: the contracts collect them one at a time; one order only,
  // as the width is the defect's cause and each compile of it is costly
  const source = `let p = [hostValue, ${Array.from({ length: 131_071 }, () => "0").join(", ")}]\nsay p[0]\nsay "AFTER"\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  // the core's boundary at the host value, against the elements' integer (C9)
  const hostValue = `${source.indexOf("hostValue")}:${source.indexOf("hostValue") + 9}`;
  assert.ok(
    compactAnalysis(request).checks.some(
      (check) =>
        check.boundary &&
        check.target === "p.element" &&
        `${check.site.offset}:${check.site.end}` === hostValue &&
        check.against.join() === "integer",
    ),
  );
  const plan = compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).plan;
  assert.ok(plan !== null);
  assert.deepEqual(validateInstructionPlan(plan).errors, []);
  assert.deepEqual(checkedStores(plan), ["'p' list<integer>"]);
  assert.deepEqual(ran(runWith(plan, 1)), halted(["1", "AFTER"]));
  assert.deepEqual(ran(runWith(plan, "bad")), failed(`TSR058@8:${source.indexOf("\n")}`));
});

test("a typed parse or load into a copy of a written type leaves the slice until the core's F18 takes the copied domain (the lead's ruling 2)", () => {
  // the copied written domain is F18's receiving context (A4, TABLE r4.75 (1), (1a)); the core answers the call by its
  // default there and its later facts follow that answer (no check at a later `let n: integer = b`), so the lowering
  // cannot widen the expected type alone
  for (const source of [
    "let a: number = 0\nlet b = a\nb = fromJson(hostValue, default: 0, files: false)\nsay b\nexit\n",
    "let a: number = 0\nlet b = a\nb = fromJson(hostValue, default: 0)\nsay b\nexit\n",
    "let a: number = 0\nlet b = a\nlet c = b\nc = fromJson(hostValue, default: 0, files: false)\nsay c\nexit\n",
    'let a: number = 0\nlet b = a\nb = load("k", default: 0)\nsay b\nexit\n',
    "let a: number[] = [0]\nlet b = a\nb = fromJson(hostValue, default: [0], files: false)\nsay b[0]\nexit\n",
    // below a composite destination: a literal's element, a copied record's field, an empty intermediate (Sol r9)
    'let a: number = 0\nlet out = [a]\nout = fromJson(hostValue, default: [0], files: false)\nsay "AFTER"\nexit\n',
    'let a: number = 0\nlet base = {n: a}\nlet out = base\nout.n = fromJson(hostValue, default: 0, files: false)\nsay "AFTER"\nexit\n',
    'let a: number[] = [0]\nlet middle = []\nmiddle = a\nlet out = middle\nout = fromJson(hostValue, default: [0], files: false)\nsay "AFTER"\nexit\n',
  ])
    assert.throws(
      () => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND),
      (error) =>
        error instanceof CandidateOutsideSlice &&
        error.what === "a typed parse or load into a copy of a written type",
      source,
    );
  // a place its own store decides, not a copy of a written type: F18 reads the default's kinds, in three layers
  const decided =
    'let b = 1.5\nb = fromJson(hostValue, default: 0, files: false)\nsay b\nsay "AFTER"\nexit\n';
  const parse = at(decided, "fromJson(hostValue, default: 0, files: false)");
  assert.ok(decision(decided).checks.some((check) => check.endsWith(`boundary @${parse}`)));
  const plan = candidatePlan(decided);
  assert.deepEqual(contentOf(plan), [`expected call@${parse} integer`]);
  assert.deepEqual(ran(runWith(plan, "3")), halted(["3", "AFTER"]));
  assert.deepEqual(ran(runWith(plan, "1.5")), halted(["0", "AFTER"], [`TSW020@${parse}`]));
  // a copy of a place its own literal decides, not of a written type, whole or selected from a literal (Sol r10 B1):
  // the default's kinds too
  for (const copy of [
    "base",
    "[base][0]",
    "[base].get(0, default: {n: 0})",
    "null otherwise [base][0]",
  ]) {
    const copied = `let base = {n: 1.5}\nlet out = ${copy}\nout = fromJson(hostValue, default: {n: 0}, files: false)\nsay out.n\nexit\n`;
    const read = at(copied, "fromJson(hostValue, default: {n: 0}, files: false)");
    assert.ok(
      decision(copied).checks.some((check) => check.endsWith(`boundary @${read}`)),
      copied,
    );
    const copiedPlan = candidatePlan(copied);
    assert.ok(
      contentOf(copiedPlan).includes(`expected call@${read} {n: integer}`),
      `${copied}: ${JSON.stringify(contentOf(copiedPlan))}`,
    );
    assert.deepEqual(ran(runWith(copiedPlan, '{"n": 3}')), halted(["3"]), copied);
    assert.deepEqual(
      ran(runWith(copiedPlan, '{"n": 1.5}')),
      halted(["0"], [`TSW020@${read}`]),
      copied,
    );
  }
});

/** A list value as the runtime holds it. */
const listOf = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});

/** The value `name` is bound to where a run of the main program ends. */
function bound(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const found = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(found !== undefined, `binding ${name}`);
  return found.value;
}

test("JSON fitting a nullable collection's level reads whole, at every nesting, on both lowerings, in three layers, in both orders (Astra B1)", () => {
  // kind × nullability × nesting: each default, the expected type the core gives it, JSON that fits (also with its
  // nulls) read as that type, and JSON that does not, which gives the default with TSW020
  const n = (value: number): SerializableRuntimeValue => object({ n: value });
  for (const [fallback, type, fitting] of [
    [
      "[null, [{n: 0}]]",
      "list<list<{n: integer}>|null>",
      [
        ['[[{"n": 7}]]', listOf(listOf(n(7)))],
        ['[null, [{"n": 7}], []]', listOf(null, listOf(n(7)), listOf())],
      ],
    ],
    ["[null, [1]]", "list<list<integer>|null>", [["[[2], null]", listOf(listOf(2), null)]]],
    [
      "{items: [null, [1]]}",
      "{items: list<list<integer>|null>}",
      [['{"items": [[2], null], "extra": 1}', object({ items: listOf(listOf(2), null) })]],
    ],
    // the controls: a nullable record, and a nested list without null
    ["[null, {n: 0}]", "list<{n: integer}|null>", [['[{"n": 7}, null]', listOf(n(7), null)]]],
    ["[[{n: 0}]]", "list<list<{n: integer}>>", [['[[{"n": 7}]]', listOf(listOf(n(7)))]]],
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
        contentOf(plan).some((entry) => entry.endsWith(`@${parse} ${type}`)),
        `${source}: ${JSON.stringify(contentOf(plan))}`,
      );
      for (const [json, value] of fitting) {
        const result = runWith(plan, json);
        assert.deepEqual(ran(result), halted(["AFTER"]), `${source} with ${json}`);
        assert.deepEqual(bound(result.snapshot, "out"), value, `${source} with ${json}`);
      }
      const violating = runWith(plan, '[[{"n": "x"}], 1]');
      assert.deepEqual(ran(violating), halted(["AFTER"], [`TSW020@${parse}`]), source);
    }
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
