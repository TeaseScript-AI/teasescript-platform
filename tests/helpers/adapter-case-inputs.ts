import assert from "node:assert/strict";

import type { OperationInputs } from "../../src/type-inference/adapters/relation.js";
import { collectGraph } from "../../src/type-inference/collector.js";
import type {
  ChoiceElementEvidence,
  ContractRef,
  DynamicWhy,
  FormDescriptorEvidence,
  PlaceId,
  SyntaxEvidence,
} from "../../src/type-inference/graph.js";
import type { OperandView } from "../../src/type-inference/adapters/relation.js";
import {
  closedView,
  dynamicView,
  inputsOf,
  structureOf,
  type LegacyOutcome,
} from "./adapter-parity.js";
import { parseTypeText } from "./type-text.js";

/**
 * The inputs of an operation's relation, read from the source itself (O4 stage 2b case tables): the collector's
 * `operation` constraint at the operation gives the operand places and the evidence, and the legacy oracle's fact at
 * each place gives its view. A fact the legacy does not know is a dynamic view of the case's declared provenance; a
 * fact that is not closed has no view here, and the case fails.
 */
export interface CaseInputs {
  readonly contract: ContractRef;
  /** The inputs, or none when an operand holds a slot the legacy has not decided (`open`). */
  readonly inputs: OperationInputs | null;
  /** The places the relation is given that are dynamic, by their role, for the result's provenance rule. */
  readonly dynamic: {
    readonly positional: readonly number[];
    readonly named: readonly string[];
    readonly evidence: boolean;
  };
  /**
   * Whether a place holds a slot that saw only null (`?null`): the legacy leaves what reads it unknown until the slot
   * is decided, which is the solver's to represent, not a relation's; no inputs are built.
   */
  readonly open: boolean;
}

export function caseInputs(outcome: LegacyOutcome, why: DynamicWhy | null): CaseInputs {
  const graph = collectGraph(outcome.request);
  const start = outcome.node.span.start.offset;
  const end = outcome.node.span.end.offset;
  const operations = graph.constraints.filter(
    (constraint) =>
      constraint.kind === "operation" &&
      constraint.site.file === 0 &&
      constraint.site.start === start &&
      constraint.site.end === end,
  );
  assert.equal(operations.length, 1, "one operation constraint at the operation");
  const operation = operations[0]!;
  assert.ok(operation.kind === "operation");
  const sites = new Map(graph.places.map((place) => [place.id, place.site]));
  const referenced = [
    ...(operation.receiver === null ? [] : [operation.receiver]),
    ...operation.arguments,
    ...operation.named.map((entry) => entry.value),
    ...(operation.evidence === undefined ? [] : evidencePlaces(operation.evidence)),
  ];
  const factOf = (place: PlaceId): string => {
    const site = sites.get(place);
    assert.ok(site !== undefined && site !== null, `a site for place ${place}`);
    const facts = outcome.factsAt(site);
    assert.equal(facts.length, 1, `one fact at place ${place} (${facts.join(", ")})`);
    return facts[0]!;
  };
  const facts = new Map(referenced.map((place) => [place, factOf(place)]));
  // A slot that saw only null is written `?null`, or `?` beside `null` in a union (markers outside quoted values).
  const open = [...facts.values()].some((fact) => /\?null|\(\?\||\|\?[|)]/.test(structureOf(fact)));
  const isDynamic = (place: PlaceId): boolean => facts.get(place) === "unknown";
  const evidenceDynamic =
    operation.evidence !== undefined && evidencePlaces(operation.evidence).some(isDynamic);
  const dynamic = {
    positional: operation.arguments.flatMap((place, index) => (isDynamic(place) ? [index] : [])),
    named: operation.named.filter((entry) => isDynamic(entry.value)).map((entry) => entry.name),
    evidence: evidenceDynamic,
  };
  if (open) return { contract: operation.contract, inputs: null, dynamic, open };
  const places = new Map<PlaceId, OperandView>();
  const view = (place: PlaceId): OperandView => {
    const kept = places.get(place);
    if (kept !== undefined) return kept;
    const fact = facts.get(place)!;
    let made: OperandView;
    if (fact === "unknown") {
      assert.ok(why !== null, `a declared provenance for the unknown operand at place ${place}`);
      made = dynamicView(why);
    } else {
      assert.ok(
        !/[!+]/.test(structureOf(fact)),
        `no held unknown or open shape at place ${place}: ${fact}`,
      );
      made = closedView(parseTypeText(fact));
    }
    places.set(place, made);
    return made;
  };
  const positional = operation.arguments.map(view);
  const named: Record<string, OperandView> = {};
  for (const entry of operation.named) named[entry.name] = view(entry.value);
  for (const place of referenced) view(place);
  return {
    contract: operation.contract,
    dynamic,
    open,
    inputs: inputsOf({
      ...(operation.receiver === null ? {} : { receiver: view(operation.receiver) }),
      arguments: positional,
      named,
      ...(operation.evidence === undefined ? {} : { evidence: operation.evidence }),
      places,
    }),
  };
}

/** Every place the evidence names, so that the relation can ask for its view. */
function evidencePlaces(evidence: SyntaxEvidence): PlaceId[] {
  const found: PlaceId[] = [];
  const elements = (list: readonly ChoiceElementEvidence[]): void => {
    for (const element of list) {
      found.push(element.place);
      if (element.object !== null) {
        if (element.object.value !== null) found.push(element.object.value);
        if (element.object.text !== null) found.push(element.object.text);
      }
    }
  };
  const descriptor = (written: FormDescriptorEvidence): void => {
    if (written.kind === "list") elements(written.elements);
    if (written.kind !== "object") return;
    for (const place of [written.value, written.min, written.max])
      if (place !== null) found.push(place);
    if (written.options !== null) {
      found.push(written.options.place);
      if (written.options.elements !== null) elements(written.options.elements);
    }
  };
  switch (evidence.kind) {
    case "choice":
      for (const option of evidence.options) {
        found.push(option.place);
        if (option.content.kind === "list" || option.content.kind === "set")
          elements(option.content.elements);
        else if (option.content.kind === "object") {
          if (option.content.object.value !== null) found.push(option.content.object.value);
          if (option.content.object.text !== null) found.push(option.content.object.text);
        }
      }
      break;
    case "form":
      if (evidence.fields !== "computed")
        for (const field of evidence.fields.entries) {
          found.push(field.place);
          descriptor(field.written);
        }
      break;
    default:
      break;
  }
  return found;
}
