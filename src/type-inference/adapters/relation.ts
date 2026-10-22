import type { StaticType } from "../../static-types.js";
import type { ValueKind } from "../../value-kinds.js";
import type { ContractRef, DynamicWhy, PlaceId, ProjectionStep, SyntaxEvidence } from "../graph.js";

// The contract between the solver and the built-in contracts (O4 stage 2): an operation's result as a relation over
// what the solver knows of its operands so far. Each contract family has one adapter that reads the owning contract
// module (`conversions.ts`, `numeric-functions.ts`, `text-operations.ts`, ...) and answers in these terms; the solver
// never reads a contract itself. Nothing here is implemented in stage 2a: the types are the frozen surface that the
// adapters of stage 2b fill in and that stage 3 consumes.

/** A reference to one operand of an operation: its receiver, a positional argument, or a named one. */
export type OperandRef =
  { readonly receiver: true } | { readonly argument: number } | { readonly named: string };

/**
 * What the solver knows of an operand so far. `alternatives` lists the types the operand may have, as the solver has
 * them now (closed types, no open slots); `null` means no evidence yet (bottom), which is not a value. `dynamic` says
 * why the operand may hold data the compiler cannot know, beside any alternatives.
 */
export interface OperandView {
  readonly alternatives: readonly StaticType[] | null;
  readonly dynamic: DynamicWhy | null;
}

export interface OperationInputs {
  readonly receiver: OperandView | null;
  readonly arguments: readonly OperandView[];
  readonly named: ReadonlyMap<string, OperandView>;
  /** What the source says beyond the operands' types (see `SyntaxEvidence`). */
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
   * text. The solver keeps them as possibilities with the operand's provenance, so a store of the result into a place
   * that none of them fits is still an error, and a place one of them fits keeps a runtime check.
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
  /** The operands can never combine under the contract; the check reports it, the result has no value. */
  | { readonly kind: "invalid" }
  /** One of several results, as `fromBase64(text, default: box)` gives text or a copy of its default. */
  | { readonly kind: "alternatives"; readonly results: readonly OperationResult[] }
  /**
   * A result per kind the receiver may have, as `union(other)` on a receiver that is a list or a set. The solver
   * evaluates each case with the receiver's view restricted to that kind, and every operand path inside the case
   * refers to that restricted receiver; the cases join as alternatives do.
   */
  | {
      readonly kind: "byReceiver";
      readonly cases: readonly { readonly receiver: ValueKind; readonly result: OperationResult }[];
    };

export interface OperationRelation {
  readonly contract: ContractRef;
  /**
   * The result for operands known as `inputs` says. Called again whenever an operand's view grows, so it must be a
   * function of its inputs alone: no state, no reading of other places.
   */
  result(inputs: OperationInputs): OperationResult;
}

/** The relations of every contract family, by family and name, which the solver asks. */
export interface OperationRelations {
  relation(contract: ContractRef): OperationRelation | undefined;
}
