import assert from "node:assert/strict";
import test from "node:test";

import { INTEGER_TYPE, STRING_TYPE } from "../src/static-types.js";
import { PropertyTable } from "../src/static-types/property-tables.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import type { OperandView, OperationInputs } from "../src/type-inference/adapters/relation.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { caseInputs, type CaseInputs } from "./helpers/adapter-case-inputs.js";
import {
  assertCase,
  BOTTOM_VIEW,
  dynamicView,
  legacyOperation,
  type LegacyOutcome,
} from "./helpers/adapter-parity.js";

/**
 * The interactions' relations on inputs the case tables cannot write (work note §6.3): an operand that may also
 * be one the compiler cannot know beside known alternatives, and a part of a written field that the result rule does
 * not read, left bottom. The tables (`tests/fixtures/type-inference/adapter-cases/{choice,form}.jsonl`) pin the
 * written forms.
 */
function interaction(name: string) {
  const relation = operationRelations().relation({ family: "interaction", name });
  assert.ok(relation !== undefined, `a relation for interaction.${name}`);
  return relation;
}

/** The inputs of a source's operation, with one place's view replaced. */
function withView(
  outcome: LegacyOutcome,
  pick: (built: CaseInputs) => PlaceId,
  view: OperandView,
): OperationInputs {
  const built = caseInputs(outcome, "host");
  assert.ok(built.inputs !== null, "inputs of the source");
  const place = pick(built);
  const inputs = built.inputs;
  return { ...inputs, view: (at) => (at === place ? view : inputs.view(at)) };
}

/** The place of the first written field's descriptor part a test replaces. */
function descriptorPlace(
  built: CaseInputs,
  part: (written: {
    readonly value: PlaceId | null;
    readonly options: { readonly place: PlaceId } | null;
  }) => PlaceId | null,
): PlaceId {
  const evidence = built.operation.evidence;
  assert.ok(evidence?.kind === "form" && evidence.fields !== "computed", "written fields");
  const written = evidence.fields.entries[0]!.written;
  assert.ok(written.kind === "object", "a written descriptor");
  const place = part(written);
  assert.ok(place !== null, "the part is written");
  return place;
}

test("an option or a fields value that may also be one the compiler cannot know is not known at all", () => {
  // The legacy's element of `[hostValue, "a"]` is unknown: so is the answer, whatever else the element may be.
  const choice = legacyOperation('let xs = [hostValue, "a"]\nlet r = askChoice xs.first\nexit');
  assertCase(
    interaction("choice"),
    withView(choice, (built) => built.operation.arguments[0]!, dynamicView("host", [STRING_TYPE])),
    choice,
    { fact: "unknown" },
    { dynamic: "host" },
  );
  const form = legacyOperation(
    'let xs = [hostValue, { n: 1 }]\nlet r = askForm("Q", fields: xs.first)\nexit',
  );
  assertCase(
    interaction("form"),
    withView(
      form,
      (built) => built.operation.named.find((entry) => entry.name === "fields")!.value,
      dynamicView("host", [
        { kind: "object", properties: new PropertyTable([["n", INTEGER_TYPE]]) },
      ]),
    ),
    form,
    { fact: "unknown" },
    { dynamic: "host" },
  );
});

test("a written field reads its start only without a type, and its options only for a cycle", () => {
  // With `type:` written, the start value is the visitor's check: the relation does not wait for it.
  const typed = legacyOperation(
    'let r = askForm("Q", fields: { n: { type: "integer", value: hostValue } })\nexit',
  );
  assertCase(
    interaction("form"),
    withView(typed, (built) => descriptorPlace(built, (written) => written.value), BOTTOM_VIEW),
    typed,
    { fact: '{"n":integer}' },
    "fact",
  );
  // A cycle whose options are written one by one reads the elements, never the options' whole type.
  const cycle = legacyOperation(
    'let r = askForm("Q", fields: { n: { type: "cycle", options: [1, 2] } })\nexit',
  );
  assertCase(
    interaction("form"),
    withView(
      cycle,
      (built) => descriptorPlace(built, (written) => written.options?.place ?? null),
      BOTTOM_VIEW,
    ),
    cycle,
    { fact: '{"n":integer}' },
    "fact",
  );
  const toggle = legacyOperation(
    'let r = askForm("Q", fields: { n: { type: "boolean", options: hostList } })\nexit',
  );
  assertCase(
    interaction("form"),
    withView(
      toggle,
      (built) => descriptorPlace(built, (written) => written.options?.place ?? null),
      BOTTOM_VIEW,
    ),
    toggle,
    { fact: '{"n":boolean}' },
    "fact",
  );
});
