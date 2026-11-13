// The discharge runtime tests' shared setup (tests/type-core/discharge/): the core's decision, the candidate and legacy
// plans and their content, and a run's outcome at its next effect.

import assert from "node:assert/strict";

import { compileSource, compileSourceWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../../../src/plan/model.js";
import { validateInstructionPlan } from "../../../src/plan/validation.js";
import { run } from "../../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../../src/runtime/events.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../../src/runtime/host-data/script-storage.js";
import type { RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "../immediate-pacing-runtime.js";
import { compactAnalysis, coreRequest } from "../type-core-analysis.js";

export const OPTIONS = { globals: ["hostValue"] };

/** `make` in the core's order and with its consumers' and solver's orders reversed: both, equal. */
export function inBothOrders<T>(make: () => T): T {
  const forward = make();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), make),
  );
  assert.deepEqual(reversed, forward);
  return forward;
}

/** The core's decision for a program: its diagnostics and its checks, as `class kind @start:end` and `kind target [against] @start:end`. */
export function decision(source: string): { diagnostics: string[]; checks: string[] } {
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
export function typeText(type: TypePlan): string {
  switch (type.kind) {
    case "union":
      return type.members.map(typeText).join("|");
    case "list":
    case "set":
    case "dict":
      return `${type.kind}<${type.element === null ? "any" : typeText(type.element)}>`;
    case "object":
      // `...`: a written `object`'s other keys, kept (#1223)
      return `{${[...type.properties.map((property) => `${property.name}: ${typeText(property.type)}`), ...(type.keepExtra === true ? ["..."] : [])].join(", ")}}`;
    default:
      return type.kind;
  }
}

const S7_FIELDS = ["requireExisting", "indexCheck", "fallbackCheck", "expected", "repair"] as const;
const S7_NAMES: readonly string[] = S7_FIELDS;

/**
 * The S7 content of a plan, each as `field node@start:end value`, in plan order: the new fields of the discharge map's
 * rows (S3's "Serialised contracts"), and a load's `type` beside its `repair`.
 */
export function contentOf(plan: InstructionPlan): string[] {
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
      // EVIDENCE: invariant: plan validation admits `repair` only beside an object type or a union with one.
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
export function candidatePlan(source: string): InstructionPlan {
  const plan = inBothOrders(() => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).plan);
  assert.ok(plan !== null, source);
  assert.deepEqual(validateInstructionPlan(plan).errors, [], source);
  return plan;
}

/** The legacy backend's plan of `source`, which production selects: none of S7's content (D7). */
export function legacyPlan(source: string): InstructionPlan {
  const plan = compileSource(source, OPTIONS).plan;
  assert.ok(plan !== null, source);
  assert.deepEqual(contentOf(plan), [], `${source}: the legacy plan carries no S7 content`);
  return plan;
}

export interface Ran {
  readonly status: string;
  readonly said: readonly string[];
  readonly failure: string | null;
  readonly warnings: readonly string[];
}

export function summary(events: readonly InterpreterEvent[], status: string): Ran {
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
export function runWith(
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

export const halted = (said: readonly string[], warnings: readonly string[] = []): Ran => ({
  status: "halted",
  said,
  failure: null,
  warnings,
});

export const failed = (failure: string, said: readonly string[] = []): Ran => ({
  status: "failed",
  said,
  failure,
  warnings: [],
});

/** The span of the `nth` occurrence of `text` in `source`, as `start:end`. */
export function at(source: string, text: string, nth = 0): string {
  let start = -1;
  for (let count = 0; count <= nth; count += 1) start = source.indexOf(text, start + 1);
  assert.ok(start >= 0, `${text} in ${source}`);
  return `${start}:${start + text.length}`;
}

export const object = (
  fields: Readonly<Record<string, SerializableRuntimeValue>>,
): SerializableRuntimeValue => ({
  kind: "object",
  properties: Object.entries(fields).map(([name, value]) => ({ name, value })),
});

export const ran = (result: Ran): Ran => ({
  status: result.status,
  said: result.said,
  failure: result.failure,
  warnings: result.warnings,
});

/** Every object of a plan, as an external source may edit it. */
export function planNodes(value: unknown): Record<string, unknown>[] {
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

/** A stored file of the session, which `decryptFile` reads. */
export const STORED = "stored:1";

/** A stored value of the records below, as the host gives it: a record of its fields, nested records too. */
export function stored(value: unknown): SerializableRuntimeValue {
  if (typeof value !== "object" || value === null) {
    // EVIDENCE: fixture: the scenarios' stored values are JSON data, records, lists and scalars.
    return value as SerializableRuntimeValue;
  }
  if (Array.isArray(value)) return { kind: "list", items: value.map(stored) };
  return object(
    Object.fromEntries(Object.entries(value).map(([name, field]) => [name, stored(field)])),
  );
}

/** A list value as the runtime holds it. */
export const listOf = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});

/** The value `name` is bound to where a run of the main program ends. */
export function bound(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const found = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(found !== undefined, `binding ${name}`);
  return found.value;
}
