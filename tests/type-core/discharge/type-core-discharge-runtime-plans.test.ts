// The plans S7 serialises: a legacy plan's checkpoint, S7's fields in plan validation, and the loads the candidate
// route rejects.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import { validateInstructionPlan } from "../../../src/plan/validation.js";
import { run } from "../../../src/runtime/engine.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../../helpers/runtime-equivalence.js";
import {
  OPTIONS,
  candidatePlan,
  legacyPlan,
  summary,
  halted,
} from "../../helpers/type-core/type-core-discharge-runtime-setup.js";

/*
 * The revisions (docs/RUNTIME.md "Format evolution"): the content above is new plan content, so the plan and checkpoint
 * revisions both increase once for S7; a plan without it, such as every legacy plan, and its checkpoints stay valid and
 * run as before, and plan validation rejects the new fields where they do not belong.
 */
test("a legacy plan's checkpoint restores at the current revisions and resumes as before, at every boundary", () => {
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

test("plan validation rejects S7's fields where they do not belong (S3's serialised contracts)", () => {
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

test("the candidate route rejects the loads whose storage rules S9b brings (S3)", () => {
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
