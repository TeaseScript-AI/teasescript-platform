import {
  familyOf,
  VALUE_KIND_NAMES,
  VALUE_KINDS,
  type PlainKind,
  type ScalarKind,
  type ValueKind,
} from "../value-kinds.js";

/**
 * What the constraint-based inference knows about the kinds of values, read from the one registry (`VALUE_KINDS`)
 * instead of a list of its own: which kinds exist, how the compiler holds each, and what each kind can do. The
 * inference derives its atoms and capabilities from here; the registry stays the owner of every fact.
 */
export interface RegistryView {
  /** Every kind by name, in the registry's order. */
  readonly kinds: readonly ValueKind[];
  /** The kinds the compiler holds as a scalar of their name. */
  readonly scalars: readonly ScalarKind[];
  /** The kinds the compiler holds as a type of their own without parts, such as `range` and `timer`. */
  readonly plain: readonly PlainKind[];
  /** The kinds whose values an annotation can write by name. */
  readonly written: ReadonlySet<ValueKind>;
  /** The kind that `==` and `<` take values of `kind` as, when not the kind itself: an integer is a number. */
  family(kind: ValueKind): ValueKind;
  /** Whether `<`, `sort()`, `min`, and `max` order values of the kind. */
  ordered(kind: ValueKind): boolean;
  /** Whether a value of the kind names something that exists only in the session (equality by identity). */
  hasIdentity(kind: ValueKind): boolean;
  /** Whether a button may return a value of the kind as its choice value. */
  choice(kind: ValueKind): boolean;
  /** Whether a literal of the kind may be a `case` value. */
  caseValue(kind: ValueKind): boolean;
  /** Whether a value of the kind may be a dict key. */
  dictKey(kind: ValueKind): boolean;
  /** Whether `${...}` and `say` show a value of the kind as text. */
  shown(kind: ValueKind): boolean;
}

/** The registry as the inference reads it, built once. */
export function registryView(): RegistryView {
  return REGISTRY_VIEW;
}

const VIEW: RegistryView = {
  kinds: VALUE_KIND_NAMES,
  scalars: Object.freeze(
    VALUE_KIND_NAMES.filter((kind): kind is ScalarKind => VALUE_KINDS[kind].type === "scalar"),
  ),
  plain: Object.freeze(
    VALUE_KIND_NAMES.filter((kind): kind is PlainKind => VALUE_KINDS[kind].type === "kind"),
  ),
  written: new Set(VALUE_KIND_NAMES.filter((kind) => VALUE_KINDS[kind].written)),
  family: (kind) => familyOf(kind),
  ordered: (kind) => VALUE_KINDS[kind].ordered,
  hasIdentity: (kind) => VALUE_KINDS[kind].equality === "identity",
  choice: (kind) => VALUE_KINDS[kind].choice,
  caseValue: (kind) => VALUE_KINDS[kind].case,
  dictKey: (kind) => VALUE_KINDS[kind].dictKey,
  shown: (kind) => VALUE_KINDS[kind].shown !== null,
};

const REGISTRY_VIEW: RegistryView = Object.freeze(VIEW);
