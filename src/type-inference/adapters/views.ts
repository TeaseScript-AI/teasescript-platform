import { members, resolved, valueKindOfType, type StaticType } from "../../static-types.js";
import type { ValueKind } from "../../value-kinds.js";
import type { DynamicWhy, ProjectionStep } from "../graph.js";
import type {
  OperandPath,
  OperandRef,
  OperandView,
  OperationInputs,
  OperationResult,
} from "./relation.js";

/** The member rules of the receiver kinds one module owns. */
export interface MemberRules {
  readonly kinds: readonly ValueKind[];
  /** Reading `name` on a receiver of `kind`: a held part of the receiver, a computed result, or no such member. */
  property(kind: ValueKind, name: string, receiver: OperandView): MemberAnswer | undefined;
  /**
   * Calling `name` on a receiver of `kind` with `inputs`: the receiver's view as a whole, since a rule's gate may read
   * the receiver's other kinds; a rule that reads the members of its kind restricts the view itself (`restrictedTo`). A
   * `byReceiver` case holds for the restricted view.
   */
  method(kind: ValueKind, name: string, inputs: OperationInputs): OperationResult | undefined;
}

/**
 * The answer to a property read: a held part keeps the graph's `project` link (an object's property, a list's
 * `first`, `last` or `random` element), a computed member is a result like any operation's.
 */
export type MemberAnswer =
  { readonly kind: "held"; readonly step: ProjectionStep } | OperationResult;

/** The alternatives of a view, each resolved, with a union split into its members. */
export function viewMembers(view: OperandView): readonly StaticType[] {
  return (view.alternatives ?? []).flatMap((alternative) => members(resolved(alternative)));
}

/** Whether nothing is known of the operand yet: no alternative and no dynamic source. */
export function isBottom(view: OperandView): boolean {
  return view.alternatives === null && view.dynamic === null;
}

/** A view restricted to the alternatives of one kind: the receiver a `byReceiver` case holds for. */
export function restrictedTo(view: OperandView, kind: ValueKind): OperandView {
  const kept = viewMembers(view).filter((member) => valueKindOfType(member) === kind);
  return { alternatives: kept, dynamic: view.dynamic, known: view.known };
}

export const INVALID: OperationResult = Object.freeze({ kind: "invalid" });
export const UNCONSTRAINED: OperationResult = Object.freeze({ kind: "unconstrained" });

export function typeResult(type: StaticType): OperationResult {
  return { kind: "type", type };
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

export function alternativesOf(...results: readonly OperationResult[]): OperationResult {
  return results.length === 1 ? results[0]! : { kind: "alternatives", results };
}

export const RECEIVER: OperandRef = Object.freeze({ receiver: true });

export function named(name: string): OperandRef {
  return { named: name };
}
