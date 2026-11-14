import type { StaticScalar } from "../static-evaluation.js";
import type { ScalarValue } from "../static-types.js";
import type { ValueKind } from "../value-kinds.js";

export type PlaceId = number;
export type FunctionId = number;
export type HandlerId = number;

/** A source site: the index of its file in the project and the offsets of its span. */
export interface SourceSite {
  readonly file: number;
  readonly start: number;
  readonly end: number;
}

/** Why a value is one the compiler cannot know (ADR 0021 rule 1.7). */
export type DynamicWhy =
  | "storage"
  | "computed key"
  | "host"
  | "json"
  | "unknown member"
  | "unknown callee"
  | "unknown function result"
  /** A written `list`, `set`, `dict`, or `object` says nothing about its parts. */
  | "unwritten parts";

/** A type as the source writes it or as a built-in fixes it: no inference inside. */
export type TypeTerm =
  /** A kind of the registry: `integer`, `string`, `null`, `speaker`, `timer`, ... */
  | { readonly kind: "atom"; readonly name: ValueKind }
  | { readonly kind: "never" }
  | { readonly kind: "dynamic"; readonly why: DynamicWhy }
  | { readonly kind: "list" | "set" | "dict"; readonly element: TypeTerm }
  /** `null` properties: the written type `object`, whose properties are unknown. */
  | {
      readonly kind: "object";
      readonly properties: readonly { readonly name: string; readonly type: TypeTerm }[] | null;
    }
  | { readonly kind: "union"; readonly members: readonly TypeTerm[] }
  /** A scalar that only takes these values, as an `askChoice` result. */
  | {
      readonly kind: "restricted";
      readonly name: ValueKind;
      readonly values: readonly ScalarValue[];
    }
  /** The type of another place: a literal's own cell or property. */
  | { readonly kind: "ref"; readonly place: PlaceId };

export type PlaceKind =
  | {
      readonly kind: "binding";
      readonly declared: "let" | "global" | "parameter" | "loop" | "host";
      readonly name: string;
      readonly written: TypeTerm | null;
    }
  /** The value of one expression occurrence, by the node's kind. */
  | { readonly kind: "value"; readonly node: string }
  /** An element, entry, or property that an occurrence reaches in place (held, not copied), written or read there. */
  | { readonly kind: "target"; readonly node: string }
  /** A literal's own element cell, or a dict literal's own value cell. */
  | { readonly kind: "cell"; readonly owner: PlaceId; readonly step: "element" | "entry" }
  /** A literal's own property. */
  | { readonly kind: "property"; readonly owner: PlaceId; readonly name: string }
  | { readonly kind: "speakerProperty"; readonly speaker: string; readonly name: string }
  /** The bound a call must meet: the written type or the default's type; the body's own view is derived. */
  | {
      readonly kind: "parameter";
      readonly fn: FunctionId;
      readonly index: number;
      readonly name: string;
      readonly written: TypeTerm | null;
    }
  | { readonly kind: "result"; readonly fn: FunctionId; readonly written: TypeTerm | null }
  | { readonly kind: "storageKey"; readonly key: string }
  /** One load's own view of its key; `null` for a computed key. */
  | { readonly kind: "loadView"; readonly key: string | null };

export interface Place {
  readonly id: PlaceId;
  readonly site: SourceSite | null;
  /** How a dump names the place: `x`, `f.p0`, `vera.mood`, `key "level"`, `@12`. */
  readonly label: string;
  readonly kind: PlaceKind;
}

export interface FunctionSignature {
  readonly id: FunctionId;
  readonly name: string;
  readonly site: SourceSite;
  readonly global: boolean;
  readonly parameters: readonly PlaceId[];
  readonly result: PlaceId;
}

/** The code a constraint stands in. */
export type RegionRef =
  | { readonly kind: "start" }
  | { readonly kind: "file"; readonly file: number }
  | { readonly kind: "function"; readonly fn: FunctionId }
  | { readonly kind: "handler"; readonly handler: HandlerId };

/** A timer, media, or button block, which runs later with the names visible where it was created. */
export interface HandlerRegion {
  readonly id: HandlerId;
  readonly site: SourceSite;
  readonly created: RegionRef;
  /** The name a media block binds to its own handle, or `null`. */
  readonly selfHandle: string | null;
}

/** What the author sees at a constraint's site, for blame. */
export type Role =
  | "initializer"
  | "assignment"
  | "compound assignment"
  | "element"
  | "elements"
  | "entry"
  | "property"
  | "argument"
  | "named argument"
  | "parameter default"
  | "return"
  | "saved value"
  | "default"
  | "receiver"
  | "operand"
  | "condition"
  | "key"
  | "read"
  | "loop variable"
  | "start value"
  | "call"
  | "load";

export interface Origin {
  readonly site: SourceSite;
  readonly role: Role;
  readonly region: RegionRef;
}

export interface PointRef {
  readonly site: SourceSite;
}

/**
 * What a projection reaches: the elements of a list or set, the values of a dict (`entry`), the element or value that
 * `owner[index]` names as the owner's kind says (`index`), the value a loop over the owner gives (`iteration`: an
 * element, a dict key, or a range number), or a property. A property of a set, a dict, text, a handle, or a date and
 * time value is a member the owner's kind computes, which the member contracts say; only an object's property and a
 * list's element are held in place.
 */
export type ProjectionStep =
  "element" | "entry" | "index" | "iteration" | { readonly property: string };

export type ContractFamily =
  /** A method or property of the receiver's kind. */
  | "method"
  | "member"
  | "operator"
  | "unary"
  | "comparison"
  | "logic"
  | "typeTest"
  | "interpolation"
  | "unit"
  | "angle"
  | "range"
  | "conversion"
  | "random"
  | "numeric"
  | "clock"
  | "listFunction"
  | "speakerField"
  | "interaction"
  | "say"
  | "showButton"
  | "popup"
  | "timer"
  | "media"
  | "camera"
  | "tagQuery"
  | "capture"
  | "builtin";

export interface ContractRef {
  readonly family: ContractFamily;
  readonly name: string;
}

/**
 * What the source says about an operation beyond its operands' types: a written form descriptor is not a computed one,
 * a written `allowSkip: false` proves a photo is taken, an `askChoice` option with a label before `:` returns that
 * label. One entry per written element, each with the place of its expression, collected without reading any type.
 */
export type SyntaxEvidence =
  | {
      readonly kind: "form";
      /** The written fields of an object or dict literal, or `"computed"` for any other `fields:`. */
      readonly fields:
        | { readonly shape: "object" | "dict"; readonly entries: readonly FormFieldEvidence[] }
        | "computed";
      readonly cancel: boolean;
      readonly timeout: boolean;
      readonly onTimeout: string | null;
    }
  | { readonly kind: "choice"; readonly options: readonly ChoiceOptionEvidence[] }
  | { readonly kind: "booleans"; readonly cancel: boolean }
  | { readonly kind: "image"; readonly allowSkip: boolean | "computed" | null }
  | {
      readonly kind: "tagQuery";
      readonly catalog: "images" | "scripts";
      readonly select: "random" | "list";
    }
  | { readonly kind: "timer"; readonly form: "short" | "named"; readonly async: boolean }
  | { readonly kind: "media"; readonly media: string; readonly async: boolean }
  /**
   * The selectors of a list function or of `randomWeighted` (`by:`, `x:`, `y:`, `weight:`): the text each is written
   * as, or `null` for one that is not written as text (a variable, even a known one).
   */
  | {
      readonly kind: "selectors";
      readonly written: readonly { readonly name: string; readonly text: string | null }[];
    };

/** A written form field: its name, the place of its descriptor, and the descriptor's written shape. */
export interface FormFieldEvidence {
  readonly name: string;
  readonly place: PlaceId;
  readonly written: FormDescriptorEvidence;
}

/** The written shape of a field's descriptor; a computed one is known by its place alone. */
export type FormDescriptorEvidence =
  | { readonly kind: "null" }
  | {
      readonly kind: "object";
      /** A written `type:` text, or `"computed"` for a `type:` that is not plain text. */
      readonly type: string | "computed" | null;
      /** A written `optional:` literal, or `"computed"` for any other `optional:`. */
      readonly optional: boolean | "computed" | null;
      readonly value: PlaceId | null;
      readonly min: PlaceId | null;
      readonly max: PlaceId | null;
      readonly options: OptionsEvidence | null;
    }
  /** A list written as the field: the shorthand of a cycle's options. */
  | { readonly kind: "list"; readonly elements: readonly ChoiceElementEvidence[] }
  | { readonly kind: "other" };

/** A written `options:`: its place, and its elements when it is a list literal. */
export interface OptionsEvidence {
  readonly place: PlaceId;
  readonly elements: readonly ChoiceElementEvidence[] | null;
}

/** A written literal value, as the known-value fold sees a literal; `null` is the written `null`. */
export type WrittenLiteral = { readonly value: StaticScalar | null } | null;

/**
 * One written element of a choice: the place of its expression, its written literal when the button's value is one
 * (a literal, or a written choice object's literal `value`, else `text`), and a written choice object's `value` and
 * `text` places. A computed element keeps only its place.
 */
export interface ChoiceElementEvidence {
  readonly place: PlaceId;
  readonly literal: WrittenLiteral;
  readonly object: ChoiceObjectEvidence | null;
}

/** A written choice object, by the places of the expressions it writes. */
export interface ChoiceObjectEvidence {
  readonly value: PlaceId | null;
  readonly text: PlaceId | null;
}

/** An `askChoice` option: its written label, its place, and what its expression is. */
export interface ChoiceOptionEvidence {
  /** The label written before `:`, which the button returns: a name is text, a number keeps its written kind. */
  readonly label: {
    readonly kind: "string" | "integer" | "number";
    readonly value: string | number;
  } | null;
  readonly place: PlaceId;
  readonly literal: WrittenLiteral;
  readonly content:
    | { readonly kind: "list" | "set"; readonly elements: readonly ChoiceElementEvidence[] }
    | { readonly kind: "object"; readonly object: ChoiceObjectEvidence }
    | { readonly kind: "other" };
}

/** The shape of a condition the graph records as a `test`: a type test, or a test against `null`. */
export type TestShape =
  | { readonly kind: "type"; readonly type: TypeTerm; readonly negated: boolean }
  | { readonly kind: "null"; readonly negated: boolean };

export type StoreKind =
  | "initializer"
  | "assignment"
  | "compound"
  | "element"
  | "elements"
  | "entry"
  | "property"
  | "parameter default"
  | "loop variable"
  | "start value";

export type NamedPlace = { readonly name: string; readonly value: PlaceId };

export type Constraint = Origin &
  /** Known evidence about a place: a literal, a fixed built-in result, a written type's own contribution. */
  (
    | { readonly kind: "has"; readonly place: PlaceId; readonly type: TypeTerm }
    /**
     * The value flows into the place as a copy taken where the value stands (ADR 0014). A `call`'s arguments, a
     * `return`'s value and a `fallback`'s operands are copy boundaries too; a `read` and a `project` are not.
     */
    | {
        readonly kind: "store";
        readonly value: PlaceId;
        readonly into: PlaceId;
        readonly how: StoreKind;
      }
    /** `into` is the owner's element, entry, or property, reached in place: written there, or read as the place itself. */
    | {
        readonly kind: "project";
        readonly owner: PlaceId;
        readonly step: ProjectionStep;
        readonly into: PlaceId;
      }
    /** A variable read at a point: the occurrence takes the variable's type as narrowed there. */
    | {
        readonly kind: "read";
        readonly binding: PlaceId;
        readonly occurrence: PlaceId;
        readonly point: PointRef;
      }
    /** A root replacement of a variable's value. */
    | {
        readonly kind: "assign";
        readonly binding: PlaceId;
        readonly value: PlaceId;
        readonly point: PointRef;
      }
    /** A change in place: an element, entry, or property store, or a method that changes its receiver. */
    | { readonly kind: "mutate"; readonly binding: PlaceId; readonly point: PointRef }
    | {
        readonly kind: "test";
        readonly subject: PlaceId;
        readonly shape: TestShape;
        readonly point: PointRef;
      }
    | {
        readonly kind: "operation";
        readonly contract: ContractRef;
        readonly receiver: PlaceId | null;
        readonly arguments: readonly PlaceId[];
        readonly named: readonly NamedPlace[];
        readonly result: PlaceId;
        readonly evidence?: SyntaxEvidence;
      }
    /** A list or dict `get` with a default: the result joins the element with the fallback. */
    | {
        readonly kind: "get";
        readonly receiver: PlaceId;
        readonly key: PlaceId | null;
        readonly fallback: PlaceId;
        readonly result: PlaceId;
      }
    /** `left otherwise right`; both operands are copied where they stand, the right one only when it runs. */
    | {
        readonly kind: "fallback";
        readonly left: PlaceId;
        readonly right: PlaceId;
        readonly result: PlaceId;
      }
    | {
        readonly kind: "call";
        readonly fn: FunctionId;
        readonly arguments: readonly PlaceId[];
        readonly named: readonly NamedPlace[];
        readonly result: PlaceId;
      }
    | { readonly kind: "return"; readonly fn: FunctionId; readonly value: PlaceId | null }
    /** The end of a body, which completes without a value where it is reachable. */
    | { readonly kind: "exit"; readonly fn: FunctionId }
    /**
     * A load: `receiver` is the written type of the variable it starts or is assigned to, which declares the key's type
     * for every load (ADR 0021 §6.1); without one the view takes its default's type.
     */
    | {
        readonly kind: "load";
        readonly key: string | null;
        readonly view: PlaceId;
        readonly receiver: TypeTerm | null;
        readonly fallback: PlaceId | null;
        readonly result: PlaceId;
      }
    | { readonly kind: "save"; readonly key: string | null; readonly value: PlaceId }
    /** `speaker` null: a speaker the compiler cannot tell apart. */
    | {
        readonly kind: "speakerStore";
        readonly speaker: string | null;
        readonly property: string;
        readonly value: PlaceId;
      }
    | {
        readonly kind: "speakerRead";
        readonly speaker: string | null;
        readonly property: string;
        readonly occurrence: PlaceId;
      }
    /** A read of an unwritten `let` or `global`. */
    | {
        readonly kind: "knownValue";
        readonly occurrence: PlaceId;
        readonly initializer: SourceSite;
      }
  );

export interface ConstraintGraph {
  readonly files: readonly string[];
  readonly places: readonly Place[];
  readonly functions: readonly FunctionSignature[];
  readonly handlers: readonly HandlerRegion[];
  readonly constraints: readonly Constraint[];
}
