import type { StaticType } from "../../static-types.js";
import type { KnownValue } from "../../static-evaluation.js";
import type { ValueKind } from "../../value-kinds.js";
import type { ContractRef, DynamicWhy, PlaceId, ProjectionStep, SyntaxEvidence } from "../graph.js";

/** A reference to one operand of an operation: its receiver, a positional argument, or a named one. */
export type OperandRef =
  { readonly receiver: true } | { readonly argument: number } | { readonly named: string };

/**
 * What is known of an operand so far. `alternatives` lists the types the operand may have, as known now (closed
 * types, no open slots); `null` means no evidence yet (bottom), which is not a value. `dynamic` says
 * why the operand may hold data the compiler cannot know, beside any alternatives; `known` is its value from the
 * shared fold, when the contract's result depends on it.
 */
export interface OperandView {
  readonly alternatives: readonly StaticType[] | null;
  readonly dynamic: DynamicWhy | null;
  readonly known: KnownValue | undefined;
}

export interface OperationInputs {
  readonly receiver: OperandView | null;
  readonly arguments: readonly OperandView[];
  readonly named: ReadonlyMap<string, OperandView>;
  /** What the source says beyond the operands' types. */
  readonly evidence: SyntaxEvidence | undefined;
  /** The view of a place the evidence names, such as a written choice object's `value`. */
  view(place: PlaceId): OperandView;
}

/** A part of an operand that a result is made of: the operand itself, or a path into it. */
export interface OperandPath {
  readonly of: OperandRef;
  readonly path: readonly ProjectionStep[];
}

export type OperationResult =
  /** One type, from the contract and the operands' types. */
  | { readonly kind: "type"; readonly type: StaticType }
  /**
   * The types the result may have while an operand's type is not known: `x / 4` with `x` unknown can be a number, never
   * text. The result is one of them, with the operand's provenance.
   */
  | { readonly kind: "possible"; readonly types: readonly StaticType[]; readonly why: DynamicWhy }
  /** A copy of a part of an operand: an element the method gives, a selected property, a dict key. */
  | { readonly kind: "projection"; readonly source: OperandPath }
  /** A new collection whose elements join these parts, as `union` joins both receivers' elements. */
  | {
      readonly kind: "join";
      readonly constructor: "list" | "set" | "dict";
      readonly parts: readonly OperandPath[];
    }
  /** Data the compiler cannot know, from the contract itself: `fromJson`, a load. */
  | { readonly kind: "dynamic"; readonly why: DynamicWhy }
  /** The contract says nothing yet (a numeric callback's `unknown`); no evidence is added or removed. */
  | { readonly kind: "unconstrained" }
  /** The operands can never combine under the contract: the result has no value. */
  | { readonly kind: "invalid" }
  /** One of several results, as `fromBase64(text, default: box)` gives text or a copy of its default. */
  | { readonly kind: "alternatives"; readonly results: readonly OperationResult[] }
  /**
   * A result per kind the receiver may have, as `union(other)` on a receiver that is a list or a set. Each case holds
   * for the receiver's view restricted to that kind (`restrictedTo`), and every operand path inside the case refers to
   * that restricted receiver; the cases join as alternatives do.
   */
  | {
      readonly kind: "byReceiver";
      readonly cases: readonly { readonly receiver: ValueKind; readonly result: OperationResult }[];
    };

export interface OperationRelation {
  readonly contract: ContractRef;
  /**
   * The result for operands known as `inputs` says: a function of its inputs alone, no state and no reading of other
   * places, so a reader may ask again whenever an operand's view grows.
   */
  result(inputs: OperationInputs): OperationResult;
}

export interface OperationRelations {
  relation(contract: ContractRef): OperationRelation | undefined;
}
