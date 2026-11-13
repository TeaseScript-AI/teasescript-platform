import type { InstructionPlan } from "../../../plan/model.js";
import { referencePlaceLabel } from "../../evaluation/support.js";
import type { RuntimeCapabilities } from "../../evaluator.js";
import type { InterpreterEvent } from "../../events.js";
import type { RuntimeSnapshot } from "../../snapshot/state.js";
import type { NameLocation } from "../prepare/scopes.js";
import type { NativeValue } from "../values/native-value.js";
import { isNativeReference } from "./references.js";

/**
 * One running activation: the root of the session's main file, or a call of a function. Its variables are slot arrays
 * by static scope depth (`scopes[depth][slot]`, as preparation resolved each name); a function's parameters are the
 * first slots of its first scope, by parameter index. Its temporaries are by temporary ID, `undefined` when clear.
 */
export interface NativeActivation {
  readonly scopes: NativeValue[][];
  readonly temps: Array<NativeValue | NativeReference | undefined>;
  readonly loops: NativeLoop[];
  /** The call's ID, or `null` for the root activation. */
  readonly callId: number | null;
  readonly returnInstruction: number;
  readonly destinationTemporary: number;
}

/** One step of a prepared reference's path: a list index, a dict key or an object property. */
export type NativeReferenceStep =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "property"; readonly name: string };

/**
 * A prepared reference (`prepareReference`): the variable it starts at and the steps its indexes, keys and properties
 * gave when it was prepared. It names a place, not a value: `resolveReference` reads what stands there when it is used.
 */
export interface NativeReference {
  readonly kind: "reference";
  readonly rootName: string;
  readonly root: NameLocation;
  readonly steps: readonly NativeReferenceStep[];
}

/** A running loop of an activation, whose rounds' scopes open above `depth`: a `while`, or a `for` over a range. */
export type NativeLoop =
  | { readonly kind: "while"; readonly loopId: number; readonly depth: number }
  | {
      readonly kind: "for";
      readonly loopId: number;
      readonly depth: number;
      readonly start: number;
      readonly length: number;
      position: number;
    };

/**
 * The native engine's state while it runs. `snapshot` holds every part of the session's state that is not a script
 * value (status, RNG, event sequence, speakers, scene times, actions) in today's snapshot shape; its `frames`,
 * `globals`, `temporaries`, `loopFrames` and `callFrames` stay as the fresh session made them: the activations and
 * `globals` hold those. `pc` is the next instruction while the machine runs; `snapshot.nextInstruction` has it between
 * drives. The machine is also the `EvaluationContext` today's value helpers take (plan, snapshot, no trace, no random
 * control).
 */
export class NativeMachine {
  public pc = 0;
  /** Set by an instruction after which the drive ends: one that emits an event under `stepToEvent`, waits or ends. */
  public stop = false;
  /** Every activation, the root first; `current` is the last. */
  public readonly activations: NativeActivation[];
  public current: NativeActivation;
  /** How many temporaries of all activations hold a prepared reference. */
  public liveReferences = 0;
  public readonly trace = null;
  public readonly control = null;
  public readonly startValue = null;
  /** The ID of the latest draw under random control; unused without it, kept for the helpers' context. */
  public drawId = 0;

  public constructor(
    public readonly plan: InstructionPlan,
    /** The session's state, or while a say runs, the stage it runs on (`sayStage`). */
    public snapshot: RuntimeSnapshot,
    public readonly capabilities: RuntimeCapabilities,
    public readonly root: NativeActivation,
    /** The session's globals by the plan's global name index; `undefined` for one not set yet. */
    public readonly globals: Array<NativeValue | undefined>,
    public events: InterpreterEvent[],
  ) {
    this.activations = [root];
    this.current = root;
  }

  /** How the source spells the place of the prepared reference in temporary `temporaryId` (`referencePlaceLabel`). */
  public preparedReferenceLabel(temporaryId: number): string | null {
    const held = this.current.temps[temporaryId];
    if (!isNativeReference(held)) throw new Error(`Temporary ${temporaryId} holds no prepared reference.`);
    return referencePlaceLabel(held.rootName, held.steps);
  }
}

/** A new activation whose first scope holds `first`: a function's parameters, or nothing yet for the root. */
export function newActivation(
  first: NativeValue[],
  callId: number | null,
  returnInstruction: number,
  destinationTemporary: number,
): NativeActivation {
  return { scopes: [first], temps: [], loops: [], callId, returnInstruction, destinationTemporary };
}
