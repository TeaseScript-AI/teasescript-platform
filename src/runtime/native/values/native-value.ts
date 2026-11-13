import type {
  SerializableCameraViewHandle,
  SerializableMediaHandle,
  SerializableMessageHandle,
  SerializablePermanentButtonHandle,
  SerializableRegex,
  SerializableRuntimeAngle,
  SerializableRuntimeCalendarDuration,
  SerializableRuntimeDuration,
  SerializableRuntimeRange,
  SerializableRuntimeScalar,
  SerializableRuntimeTemporal,
  SerializableScriptReference,
  SerializableSpeakerReference,
  SerializableTimerHandle,
} from "../../values/serializable-values.js";

/**
 * The native engine's values: what its bindings, temporaries and collections hold while it runs. A canonical value
 * (`SerializableRuntimeValue`) becomes one through `fromCanonical` and back through `toCanonical` (`codec.ts`).
 *
 * - Text, numbers, `true`/`false` and `null` are JavaScript primitives, as in canonical values.
 * - A list is a plain array of native values.
 * - An object and a dict are classes over a `Map`, in insertion order; replacing a value keeps its position.
 * - A set is a `NativeSet`, whose members only `native-set.ts` changes.
 * - Every other value (ranges, durations, dates, handles, regexes, ...) is its canonical record, frozen, and shared:
 *   nothing changes it in place.
 *
 * Ownership: each list, object, dict and set has exactly one holder (a binding, a temporary, or a slot of another
 * collection). Storing a value that another holder keeps stores a copy (`copyNativeValue`); a value nothing else holds,
 * such as a literal's or an operation's result, is stored as it is.
 */
export type NativeValue =
  SerializableRuntimeScalar | NativeList | NativeObject | NativeDict | NativeSet | NativeLeaf;

export type NativeList = NativeValue[];

/**
 * A value that holds no other values and is never changed in place, kept as its frozen canonical record: each kind is
 * listed, so that a new kind of value is classified here (and in `fromCanonical`'s switch) before it can be held.
 */
export type NativeLeaf = Readonly<
  | SerializableRuntimeRange
  | SerializableRuntimeDuration
  | SerializableRuntimeCalendarDuration
  | SerializableRuntimeAngle
  | SerializableRuntimeTemporal
  | SerializableTimerHandle
  | SerializableMediaHandle
  | SerializablePermanentButtonHandle
  | SerializableMessageHandle
  | SerializableCameraViewHandle
  | SerializableSpeakerReference
  | SerializableScriptReference
  | SerializableRegex
>;

/** An object's properties by name, in the order they were first set. */
export class NativeObject {
  public readonly kind = "object";
  public readonly properties: Map<string, NativeValue>;

  public constructor(properties: Map<string, NativeValue> = new Map()) {
    this.properties = properties;
  }
}

/** A dict's entries by key, in insertion order; a removed key added again goes last. */
export class NativeDict {
  public readonly kind = "dict";
  public readonly entries: Map<string, NativeValue>;

  public constructor(entries: Map<string, NativeValue> = new Map()) {
    this.entries = entries;
  }
}

/**
 * Unique members by `==`, in insertion order. Only `native-set.ts` changes `items` and `membership`: its operations
 * keep `membership`, once built, an exact index of `items`, and `appendUniqueMember` fills a new set before its index
 * exists. A member is never changed in place.
 */
export class NativeSet {
  public readonly kind = "set";
  public readonly items: NativeValue[] = [];
  /** The index of `items`, built at the first operation that needs it; `null` until then. */
  public membership: NativeSetMembership | null = null;
}

/**
 * A set's members by key: primitives as themselves (a `Set` compares `-0` and `0` as `==` does), every other member
 * under its key (`nativeValueKey`), or under a hash of a long key with the members whose keys share that hash.
 */
export interface NativeSetMembership {
  readonly scalars: Set<SerializableRuntimeScalar>;
  readonly records: Map<string, NativeValue[]>;
}

/** A list, object, dict or set: a value that holds others. */
export type NativeComposite = NativeList | NativeObject | NativeDict | NativeSet;

export function isNativeComposite(value: NativeValue): value is NativeComposite {
  return (
    Array.isArray(value) ||
    value instanceof NativeObject ||
    value instanceof NativeDict ||
    value instanceof NativeSet
  );
}
