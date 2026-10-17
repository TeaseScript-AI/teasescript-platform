import type {
  AssignmentStatement,
  CallArgument,
  CallExpression,
  FunctionParameter,
  GlobalStatement,
  Identifier,
  InteractionExpression,
  LetStatement,
  LoadExpression,
  Program,
  Statement,
} from "../ast.js";
import type { Diagnostic } from "../diagnostics.js";
import type { Sharing } from "../operation-checks.js";
import type {
  PlanImage,
  PlanTag,
  PreparedFormShape,
  TypeCheckPlan,
  TypePlan,
} from "../plan/model.js";
import type { VariableSite } from "../semantic.js";
import type { SpeakerFlowInput } from "../speaker-flow.js";
import type { WayFacts } from "../way-facts.js";

/**
 * The boundary in front of the type analysis of a project (ADR 0021): the compiler hands it the parsed files and what
 * name checking found, and takes back what lowering and the checks that follow the plan consume. A backend decides
 * every type the analysis infers and checks every value against them; the compiler never sees how. The legacy backend
 * (`legacy-rounds.ts`) checks in whole-program rounds; the constraint backend (O4) collects constraints, solves them
 * once, and checks once. Both produce the same `TypeCheckResult`, so the compiler, lowering, and the plan checks are
 * written once.
 */
export interface TypeAnalysisBackend {
  readonly name: "legacy" | "constraints";
  analyze(request: TypeAnalysisRequest): TypeAnalysisOutcome;
}

export interface TypeAnalysisRequest {
  /** The project's files with their parsed programs, in project order. */
  readonly files: readonly { readonly path: string; readonly program: Program }[];
  readonly options: TypeCheckOptions;
  /** Hears of each file whose source the analysis enters, so a stack exhaustion is blamed on the right file. */
  readonly onFile?: (file: number) => void;
}

export interface TypeAnalysisOutcome {
  /** What the compiler consumes: diagnostics, runtime checks, form shapes, way facts, speaker input, storage plans. */
  readonly checked: TypeCheckResult;
  /**
   * The facts the analysis settled on, in a form that two analyses of the same sources can be compared by (the
   * differential tests of O4); computed when asked for, from the final state of the analysis.
   */
  facts(): SolvedTypeFacts;
}

export interface TypeCheckOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
  /** The package images that tag queries search, when the compilation was given them. */
  readonly imageCatalog?: readonly PlanImage[];
  /** Whether some file of the project takes photos with tags, which join the catalog at runtime. */
  readonly capturesTaggedPhotos?: boolean;
  /**
   * The project's files with the tags of their headers, which script tag queries match; `null` tags for a file of
   * declarations only, which is never picked or listed.
   */
  readonly scriptCatalog?: readonly {
    readonly path: string;
    readonly tags: readonly PlanTag[] | null;
  }[];
  /**
   * The declarations of the variables that a timer, media, or button block shares and assigns or changes in place, with
   * how, from name checking.
   */
  readonly sharedWrites?: ReadonlyMap<VariableSite, Sharing>;
  /**
   * The `let` declarations and globals whose variables some code assigns, stores into, or changes or reorders in place,
   * from name checking. Every other one keeps its first value, which counts as known (see `KnownValues`). Without it,
   * no variable counts as known.
   */
  readonly written?: {
    readonly lets: ReadonlySet<LetStatement>;
    readonly globals: ReadonlySet<string>;
  };
  /**
   * The speaker that each `speaker` names, where a message names it with `as` or its properties use it, from name
   * checking.
   */
  readonly speakers?: ReadonlyMap<Identifier, string>;
}

export interface TypeCheckResult {
  /** The diagnostics of each file, in project order. */
  readonly diagnostics: readonly (readonly Diagnostic[])[];
  /** The runtime checks of values the compiler cannot know, by the source of the instruction that stores them. */
  readonly runtimeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>;
  /** The result shape the runtime needs for each `askForm`. */
  readonly formShapes: ReadonlyMap<InteractionExpression, PreparedFormShape>;
  /** Which ways through the source can run, which the checks that follow the compiled plan take from the check. */
  readonly ways: WayFacts;
  /**
   * The statements that the check found never run once their function, block, or file runs, which its narrowing and its
   * loop effects follow: the plan's reachability finds the same ones (tests/reachability-differential.test.ts).
   */
  readonly unreachable: ReadonlySet<Statement>;
  /** What the flow check of speaker properties needs from the check, once the project is lowered (V30 §37). */
  readonly speakerFlow: SpeakerFlowInput;
  /**
   * For each storage key written as a string literal that a load gives a type, the type that every load of it accepts,
   * which a saved value has to fit when the script runs (ADR 0021 §6), sorted by key.
   */
  readonly storageTypes: readonly { readonly key: string; readonly type: TypePlan }[];
}

/**
 * Where a value is stored in a place of known type: a `let` or assignment, the start value of a `global`, a list or
 * set `add` call, the default of a dict `get` call, an argument of an author function, a parameter default, or a
 * `return`.
 */
export type RuntimeCheckSite =
  | LetStatement
  | GlobalStatement
  | AssignmentStatement
  | CallExpression
  | CallArgument
  | FunctionParameter
  | Extract<Statement, { kind: "returnStatement" }>
  | LoadExpression;

/** A source site: the index of its file in the project and the offsets of its span in that file's source. */
export interface FactSite {
  readonly file: number;
  readonly start: number;
  readonly end: number;
}

/**
 * A type as `typeKey` writes it in detail (see `storage-types.ts`): `integer`, `list<(null|string)>`,
 * `{"a":integer,"b":?}`, `(integer|string)`, `integer{1|2}` for a scalar restricted to values; `?` for a place no
 * value decided yet, `?null` for one that so far took only null, `!` after a place that a value the compiler cannot
 * know reached, and `+` in an object whose properties may be more than the known ones.
 */
export type TypeText = string;

/**
 * The facts a type analysis settled on, each at the source site it belongs to, sorted by file, start, and end offset.
 * Types are texts, so facts of two builds or two backends compare as data; a lookup by site is a consumer's own index.
 */
export interface SolvedTypeFacts {
  /** The `let`, `global`, parameter, and loop variable declarations with the type each variable keeps. */
  readonly bindings: readonly {
    readonly site: FactSite;
    /** The declaration's node kind: `letStatement`, `globalStatement`, `functionParameter`, `forStatement`, `identifier`. */
    readonly kind: string;
    readonly name: string;
    readonly type: TypeText;
  }[];
  /** Every checked expression with the type the analysis gave it. */
  readonly values: readonly {
    readonly site: FactSite;
    readonly kind: string;
    readonly type: TypeText;
  }[];
  /**
   * Author functions: the parameter types their declaration and defaults give, the parameters as the body accepts
   * them, and the result, each `null` while unknown (a function never needed is never completed).
   */
  readonly functions: readonly {
    readonly site: FactSite;
    readonly name: string;
    readonly parameters: readonly TypeText[] | null;
    readonly accepted: readonly TypeText[] | null;
    readonly result: TypeText | null;
  }[];
  /** The declared speakers with the types of their custom properties, by name. */
  readonly speakers: readonly {
    readonly name: string;
    readonly properties: readonly { readonly name: string; readonly type: TypeText }[];
  }[];
  /** The custom property names that no speaker keeps a type for (see `UncheckedProperties`). */
  readonly uncheckedProperties: readonly string[];
  /** Each storage key written as a string literal that a load gives a type, with the view of each of its loads. */
  readonly storage: readonly {
    readonly key: string;
    /** The type every load accepts, which a saved value has to fit. */
    readonly type: TypeText;
    /** Whether a load declares the type by the variable it starts or is assigned to. */
    readonly declared: boolean;
    readonly loads: readonly {
      readonly site: FactSite;
      readonly type: TypeText;
      readonly declared: boolean;
    }[];
  }[];
}
