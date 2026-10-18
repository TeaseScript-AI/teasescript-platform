import { members, resolved, union, valueKindOfType, type StaticType } from "../../static-types.js";
import type { ValueKind } from "../../value-kinds.js";
import type { DynamicWhy, PlaceId, ProjectionStep, SyntaxEvidence } from "../graph.js";
import type {
  OperandPath,
  OperandRef,
  OperandView,
  OperationInputs,
  OperationResult,
} from "./relation.js";

/**
 * What every adapter shares (O4 stage 2b): how an operand's view is read, how a result is written, and the rules of
 * the members of one receiver kind, which `members.ts` composes over a receiver that may be of several kinds.
 */

/** The member rules of the receiver kinds one module owns. */
export interface MemberRules {
  readonly kinds: readonly ValueKind[];
  /** Reading `name` on a receiver of `kind`: a held part of the receiver, a computed result, or no such member. */
  property(kind: ValueKind, name: string, receiver: OperandView): MemberAnswer | undefined;
  /**
   * Calling `name` on a receiver of `kind` with `inputs`: the receiver's view as a whole, since a gate of the legacy
   * may read the receiver's other kinds; a rule that reads the members of its kind restricts the view itself
   * (`restrictedTo`). The solver realizes a `byReceiver` case on the restricted view.
   */
  method(kind: ValueKind, name: string, inputs: OperationInputs): OperationResult | undefined;
}

/**
 * The answer to a property read: a held part keeps the graph's `project` link (an object's property, a list's
 * `first`, `last` or `random` element), a computed member is a result like any operation's.
 */
export type MemberAnswer =
  { readonly kind: "held"; readonly step: ProjectionStep } | OperationResult;

/** The closed type an operand has so far: the union of its alternatives, or `null` while it is bottom. */
export function closedType(view: OperandView): StaticType | null {
  if (view.alternatives === null) return null;
  return view.alternatives.length === 1 ? view.alternatives[0]! : union(view.alternatives);
}

/** The alternatives of a view, each resolved, with a union split into its members. */
export function viewMembers(view: OperandView): readonly StaticType[] {
  return (view.alternatives ?? []).flatMap((alternative) => members(resolved(alternative)));
}

/** The value kinds a view's alternatives are of, in their order, each once. */
export function kindsOf(view: OperandView): readonly ValueKind[] {
  const kinds: ValueKind[] = [];
  for (const member of viewMembers(view)) {
    const kind = valueKindOfType(member);
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/** Whether nothing is known of the operand yet: no alternative and no dynamic source. */
export function isBottom(view: OperandView): boolean {
  return view.alternatives === null && view.dynamic === null;
}

/** A view restricted to the alternatives of one kind, as the solver restricts a receiver for a `byReceiver` case. */
export function restrictedTo(view: OperandView, kind: ValueKind): OperandView {
  const kept = viewMembers(view).filter((member) => valueKindOfType(member) === kind);
  return { alternatives: kept, dynamic: view.dynamic, known: view.known };
}

export const INVALID: OperationResult = Object.freeze({ kind: "invalid" });
export const UNCONSTRAINED: OperationResult = Object.freeze({ kind: "unconstrained" });

export function typeResult(type: StaticType): OperationResult {
  return { kind: "type", type };
}

export function possibleResult(types: readonly StaticType[], why: DynamicWhy): OperationResult {
  return { kind: "possible", types, why };
}

export function dynamicResult(why: DynamicWhy): OperationResult {
  return { kind: "dynamic", why };
}

export function pathOf(of: OperandRef, ...path: readonly ProjectionStep[]): OperandPath {
  return { of, path };
}

export function projectionOf(of: OperandRef, ...path: readonly ProjectionStep[]): OperationResult {
  return { kind: "projection", source: pathOf(of, ...path) };
}

export function joinOf(
  constructor: "list" | "set" | "dict",
  ...parts: readonly OperandPath[]
): OperationResult {
  return { kind: "join", constructor, parts };
}

export function structureOf(
  constructor: "object" | "dict",
  parts: ReadonlyMap<string, (inputs: OperationInputs) => OperationResult>,
  nullable: boolean,
): OperationResult {
  return { kind: "structure", constructor, parts, nullable };
}

export function alternativesOf(...results: readonly OperationResult[]): OperationResult {
  return results.length === 1 ? results[0]! : { kind: "alternatives", results };
}

export function byReceiver(
  cases: readonly { readonly receiver: ValueKind; readonly result: OperationResult }[],
): OperationResult {
  return cases.length === 1 ? cases[0]!.result : { kind: "byReceiver", cases };
}

export const RECEIVER: OperandRef = Object.freeze({ receiver: true });

export function placeRef(place: PlaceId, collected = false): OperandRef {
  return collected ? { place, collected: true } : { place };
}

export function named(name: string): OperandRef {
  return { named: name };
}

/** The text a selector such as `by:` is written as, from the `selectors` evidence, or `null` when it is not text. */
export function writtenSelector(evidence: SyntaxEvidence | undefined, name: string): string | null {
  if (evidence?.kind !== "selectors") return null;
  return evidence.written.find((selector) => selector.name === name)?.text ?? null;
}

/**
 * The result an operand's dynamic source gives when the contract does not bound it: the operand's own why, or the
 * unknown-member why for a receiver the contract knows nothing about.
 */
export function dynamicFrom(view: OperandView, fallback: DynamicWhy): OperationResult {
  return dynamicResult(view.dynamic ?? fallback);
}
