import type { OwnedDiagnosticCode } from "./diagnostic-codes.js";
import { isAskImageCall, isLockCall, isTakePhotoCall } from "./capture-call.js";
import { IMAGE_REQUEST_OPTIONS } from "./image-input.js";
import type {
  AssignmentTarget,
  Block,
  Identifier,
  SayParts,
  ShowButtonParts,
  ShowPermanentButtonParts,
  TimerParts,
  Expression,
  MediaParts,
  FunctionDeclaration,
  GlobalStatement,
  Program,
  SpeakerDeclaration,
  Statement,
  FileTarget,
  ForStatement,
  FunctionParameter,
  LabelTarget,
  LetStatement,
  OpenUrlStatement,
  ExportTextStatement,
  RegexLiteral,
  ShowPopupParts,
} from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { createSourcePosition, createSourceSpan, type SourceSpan } from "./source.js";
import { canonicalRegexFlags, compileRegex, regexFlagProblem } from "./regex.js";
import {
  COMMANDS,
  CORE_RUNTIME_BUILTINS,
  KEYWORD_TOKENS,
  PLATFORM_STANDARD_LIBRARY_PRELUDE,
  PROTECTED_NAME_CODE,
  protectedNameMessage,
  RENAMED_BUILTINS,
  RENAMED_METHODS,
  TEASESCRIPT_GRAMMAR_KEYWORDS,
  TEASESCRIPT_PROTECTED_NAMES,
} from "./language-facts.js";
import { runCompileTask, compileChild, type CompileTask } from "./compiler/continuation.js";
import {
  askOperands,
  askParts,
  expressionChildren,
  mediaHandlerBlocks,
  mediaOperands,
  sayOperands,
  showButtonOptions,
  tagQueryOperands,
  timerOperands,
} from "./expression-children.js";
import { validateSwitchCases } from "./switch-cases.js";
import {
  COLLECTION_CHANGES,
  LIST_REORDERS,
  noteSharing,
  rootName,
  type Sharing,
} from "./operation-checks.js";
import {
  globMatches,
  isPathGlob,
  packageGlobProblem,
  packagePathProblem,
} from "./project-paths.js";
import type { StatementFlow } from "./reachability.js";
import { MAIN_FILE_PATH } from "./project-paths.js";
import {
  PLAYER_DECLARATION,
  runsOnItsOwn,
  sessionDeclarations,
  setsDefaultSpeaker,
} from "./project-globals.js";
import { PLAYER, SPEAKER_NAME_LISTS } from "./speaker-terms.js";
import { duplicateEntryMessage } from "./object-properties.js";
import { startValueMessage } from "./start-value-rules.js";
import {
  argumentCountMessage,
  argumentsTaken,
  leadingArgumentMessage,
  leadingArgumentTwiceMessage,
  missingArgumentMessage,
  missingDefaultMessage,
  unknownNamedArgumentMessage,
} from "./argument-rules.js";

export interface SemanticValidationOptions {
  readonly globals?: readonly string[];
  readonly builtins?: readonly string[];
}

export interface SemanticValidationResult {
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * A place where a `goto`, `call`, or `fallback`, or a `script(...)` reference, may enter a file with fresh top-level
 * variables: its top (`label` null) or a label. As the source shows it, a computed path stands for every file (`path`
 * null) and a computed label for every label of those files (`label` true) (ADR 0022 §3.4).
 */
export interface FileEntry {
  readonly path: string | null;
  readonly label: string | null | true;
}

/** `global` is a name the host configures; a `global` declared in a script is a project `variable`. */
type BindingKind = "variable" | "speaker" | "global" | "function";

interface Binding {
  readonly kind: BindingKind;
  /** The declaration of a function. */
  readonly declaration?: FunctionDeclaration;
  /** Where the project declares a global, a speaker, or a global function, which every file sees. */
  readonly project?: ProjectDeclaration;
  /** The declaration of a function, loop, or block variable. */
  site?: VariableSite;
}

/**
 * The declaration of a function, loop, or block variable: its `let`, its `for` (the key of a pair loop), the value name
 * of a pair loop, or its parameter.
 */
export type VariableSite = LetStatement | ForStatement | Identifier | FunctionParameter;

interface ProjectDeclaration {
  readonly file: number;
  readonly span: SourceSpan;
  readonly description: "global" | "speaker" | "global function";
  /** The position of a global or speaker in the order a session initializes them; a global function has none. */
  readonly order: number | null;
}

const semanticCode = {
  duplicateDeclaration: "TSV001",
  unknownVariable: "TSV002",
  unknownAssignment: "TSV003",
  invalidAssignment: "TSV004",
  unknownSpeaker: "TSV005",
  duplicateProperty: "TSV007",
  invalidLoopControl: "TSV008",
  chainedRange: "TSV009",
  duplicateFunction: "TSV013",
  duplicateParameter: "TSV014",
  requiredAfterDefault: "TSV015",
  nestedFunction: "TSV016",
  returnOutsideFunction: "TSV017",
  unknownFunction: "TSV018",
  nonCallable: "TSV019",
  argumentCount: "TSV020",
  unknownNamedArgument: "TSV022",
  duplicateNamedArgument: "TSV023",
  missingNamedArgument: "TSV024",
  laterParameterDefault: "TSV025",
  functionAssignment: "TSV026",
  functionValue: "TSV028",
  unsupportedBlockingContext: "TSV032",
  invalidTimer: "TSV033",
  invalidLabel: "TSV051",
  skippedInitialization: "TSV054",
  invalidStartValue: "TSV055",
  fileName: "TSV056",
  invalidFileTarget: "TSV057",
  noSpeaker: "TSV063",
  invalidRegex: "TSV064",
  invalidMediaForm: "TSV069",
} as const satisfies Record<string, NamePassCode>;

type NamePassCode = OwnedDiagnosticCode<"name pass", "error">;

/** Where code runs, for the initialization check: a top-level statement, a function, or a handler and its origin. */
type FlowContext =
  | { readonly kind: "root"; readonly statement: number }
  | { readonly kind: "function"; readonly name: string }
  /** A block runs where its timer or media started: in `origin`, when `created` runs. */
  | { readonly kind: "handler"; readonly origin: FlowContext; readonly created: Statement };

/**
 * The name-pass errors that leave the type check its basis: every name resolves, and every construct it walks is whole.
 * They are a start value's placement (TSV055) and a `load` without `default:`, so the type check still reports the
 * problems of the values in them, such as a load's key that is a comparison.
 */
const LEAVES_TYPES_CHECKABLE = new WeakSet<Diagnostic>();

/** Whether a name-pass error leaves the type check without a basis (see `LEAVES_TYPES_CHECKABLE`). */
export function stopsTypeCheck(diagnostic: Diagnostic): boolean {
  return (
    diagnostic.severity === DiagnosticSeverity.Error && !LEAVES_TYPES_CHECKABLE.has(diagnostic)
  );
}

/** Validates one source as the `main.tease` of a single-file project. */
export function validateSemantics(
  program: Program,
  options: SemanticValidationOptions = {},
): SemanticValidationResult {
  return Object.freeze({
    diagnostics: validateProjectSemantics([{ path: MAIN_FILE_PATH, program }], options)[0]!
      .diagnostics,
  });
}

/** The name checks of one file; the transfer and initialization checks wait for the flow of the type check. */
export interface FileSemanticResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Where this file's transfers enter files afresh, of those that can run by the flow of the type check. */
  reachableEntries(flow: StatementFlow): readonly FileEntry[];
  /** The files each glob target may pick, in project order. */
  readonly picks: ReadonlyMap<FileTarget, readonly string[]>;
  /** The variables each timer, media, or button block shares with the code that created it (V30 §14). */
  readonly captures: ReadonlyMap<Block, readonly string[]>;
  /** The declarations of the shared variables that a block assigns or changes in place, with how. */
  readonly sharedWrites: ReadonlyMap<VariableSite, Sharing>;
  /** The speaker that each `speaker` names: the one a message names with `as`, or whose properties use it. */
  readonly speakers: ReadonlyMap<Identifier, string>;
  /** Checks the uses of top-level variables after labels, given the labels of this file that are entered afresh. */
  checkInitialization(freshLabels: ReadonlySet<string>, flow: StatementFlow): readonly Diagnostic[];
}

/** A file of a project by its package path, in project order: `main.tease` first, then the others by path. */
export interface ProjectProgram {
  readonly path: string;
  readonly program: Program;
}

/**
 * Validates the names of a project's files together. Globals, global functions, and speakers belong to the whole
 * project (ADR 0022 §3, §6); every other name belongs to its file. `validate` selects the files whose statements are
 * validated; the others only contribute their project names, for example while they have syntax errors. `onFile` hears
 * of each file before it is validated.
 */
export function validateProjectSemantics(
  files: readonly ProjectProgram[],
  options: SemanticValidationOptions = {},
  validate: (file: number) => boolean = () => true,
  onFile: (file: number) => void = () => {},
): readonly FileSemanticResult[] {
  const project = new ProjectNames(files, options);
  const validators = files.map((file, index) => {
    if (!validate(index)) return null;
    onFile(index);
    const validator = new SemanticValidator(options, project, index);
    validator.validate(file.program);
    return validator;
  });
  // Code can run in every file's top level, and in the functions that calls which can run reach, across files.
  const reachability = new WeakMap<StatementFlow, ReadonlySet<string>>();
  const reachable = (flow: StatementFlow): ReadonlySet<string> => {
    const known = reachability.get(flow);
    if (known !== undefined) return known;
    const callees = new Map<string, string[]>();
    for (const validator of validators) {
      for (const [caller, callee] of validator?.callEdges(flow) ?? []) {
        const list = callees.get(caller) ?? [];
        list.push(callee);
        callees.set(caller, list);
      }
    }
    const nodes = new Set(files.map((_, index) => `${index}:`));
    const pending = [...nodes];
    while (pending.length > 0) {
      for (const callee of callees.get(pending.pop()!) ?? []) {
        if (nodes.has(callee)) continue;
        nodes.add(callee);
        pending.push(callee);
      }
    }
    reachability.set(flow, nodes);
    return nodes;
  };
  return project.diagnostics.map((diagnostics, index) =>
    Object.freeze({
      diagnostics: Object.freeze([...diagnostics]),
      picks: validators[index]?.picks ?? new Map<FileTarget, readonly string[]>(),
      captures: validators[index]?.captures ?? new Map<Block, readonly string[]>(),
      sharedWrites: validators[index]?.sharedWrites ?? new Map<VariableSite, Sharing>(),
      speakers: validators[index]?.speakers ?? new Map<Identifier, string>(),
      reachableEntries: (flow: StatementFlow) =>
        validators[index]?.reachableEntries(flow, reachable(flow)) ?? [],
      checkInitialization: (freshLabels: ReadonlySet<string>, flow: StatementFlow) =>
        validators[index]?.checkInitialization(files[index]!.program, freshLabels, flow) ?? [],
    }),
  );
}

/** The project scope: host globals, then the globals, speakers, and global functions of every file. */
class ProjectNames {
  readonly scope = new SemanticScope();

  /** The top-level labels of each file, by path, which transfers may name. */
  readonly labels = new Map<string, ReadonlySet<string>>();

  /** The files that run nothing on their own: they hold declarations only. */
  readonly declarationsOnly = new Set<string>();

  readonly diagnostics: Diagnostic[][];

  /** Each global and speaker declaration with its position in the session-start order. */
  readonly #orders = new Map<GlobalStatement | SpeakerDeclaration, number>();

  #setsDefaultSpeaker: boolean | undefined;

  public constructor(
    readonly files: readonly ProjectProgram[],
    options: SemanticValidationOptions,
  ) {
    this.diagnostics = files.map(() => []);
    for (const { path, program } of files) {
      this.labels.set(
        path,
        new Set(
          program.statements.flatMap((statement) =>
            statement.kind === "labelStatement" ? [statement.name.name] : [],
          ),
        ),
      );
      if (!program.statements.some(runsOnItsOwn)) this.declarationsOnly.add(path);
    }
    for (const name of options.globals ?? []) this.scope.declare(name, { kind: "global" });
    const protectedNames = new Set([...TEASESCRIPT_PROTECTED_NAMES, ...(options.builtins ?? [])]);
    const declare = (
      name: Identifier,
      binding: Binding & { readonly project: ProjectDeclaration },
    ): void => {
      // A protected name is reported where the file's own statements are validated.
      if (protectedNames.has(name.name)) return;
      const existing = this.scope.resolve(name.name);
      if (existing === undefined) {
        this.scope.declare(name.name, binding);
        return;
      }
      if (existing.project === undefined) {
        this.report(
          binding.project.file,
          semanticCode.duplicateDeclaration,
          `'${name.name}' is already a global that the host gives every script. Choose another name.`,
          name.span,
        );
        return;
      }
      this.reportClash(name.name, binding.project, existing.project);
    };
    for (const [order, { file, declaration }] of sessionDeclarations(
      files.map((file) => file.program),
    ).entries()) {
      this.#orders.set(declaration, order);
      const speaker = declaration.kind === "speakerDeclaration";
      const binding = {
        kind: speaker ? "speaker" : "variable",
        project: {
          file,
          span: declaration.name.span,
          description: speaker ? "speaker" : "global",
          order,
        },
      } as const;
      // The built-in speaker has a protected name, which no script declaration may take.
      if (declaration === PLAYER_DECLARATION) this.scope.declare(PLAYER, binding);
      else declare(declaration.name, binding);
    }
    for (const [file, { program }] of files.entries())
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration" && statement.global)
          declare(statement.name, {
            kind: "function",
            declaration: statement,
            project: {
              file,
              span: statement.name.span,
              description: "global function",
              order: null,
            },
          });
  }

  /** Whether a file sets the default speaker anywhere, which a message without `as` needs for its `speaker`. */
  public get setsDefaultSpeaker(): boolean {
    this.#setsDefaultSpeaker ??= setsDefaultSpeaker(this.files.map((file) => file.program));
    return this.#setsDefaultSpeaker;
  }

  /** The position of a global or speaker in the session-start order. */
  public order(declaration: GlobalStatement | SpeakerDeclaration): number {
    return this.#orders.get(declaration)!;
  }

  /** Whether `declaration` is the one its name stands for, rather than a clashing second one. */
  public owns(declaration: GlobalStatement | SpeakerDeclaration | FunctionDeclaration): boolean {
    const binding = this.scope.resolve(declaration.name.name);
    return binding?.project !== undefined && binding.project.span === declaration.name.span;
  }

  /** Where a declaration is, as seen from `file`: `line 3` or `line 3 of helpers.tease`. */
  public where(declaration: { readonly file: number; readonly span: SourceSpan }, file: number) {
    const line = `line ${declaration.span.start.line + 1}`;
    return declaration.file === file ? line : `${line} of ${this.files[declaration.file]!.path}`;
  }

  /** Reports two declarations of one project name, at both places. */
  public reportClash(
    name: string,
    second: { readonly file: number; readonly span: SourceSpan; readonly description: string },
    first: ProjectDeclaration,
  ): void {
    const rule =
      "Globals, global functions, and speakers need a name of their own in the whole project. Rename one of them.";
    this.report(
      second.file,
      semanticCode.duplicateDeclaration,
      `'${name}' is already the name of the ${first.description} on ${this.where(first, second.file)}. ${rule}`,
      second.span,
    );
    this.report(
      first.file,
      semanticCode.duplicateDeclaration,
      `The ${first.description} '${name}' has the same name as the ${second.description} on ${this.where(second, first.file)}. ${rule}`,
      first.span,
    );
  }

  /** `checkable` marks an error that leaves the type check its basis (see `LEAVES_TYPES_CHECKABLE`). */
  public report(
    file: number,
    code: NamePassCode,
    message: string,
    span: SourceSpan,
    checkable = false,
  ): void {
    const diagnostic = createDiagnostic(DiagnosticSeverity.Error, code, message, span);
    if (checkable) LEAVES_TYPES_CHECKABLE.add(diagnostic);
    this.diagnostics[file]!.push(diagnostic);
  }
}

class SemanticScope {
  readonly bindings = new Map<string, Binding>();

  /**
   * For the scope of the locals a timer, media, or button block shares with the code that created it: the names the
   * block uses from it, in the order of first use.
   */
  readonly captured: Set<string> | null;

  public constructor(
    readonly parent: SemanticScope | null = null,
    captures = false,
  ) {
    this.captured = captures ? new Set() : null;
  }

  public resolve(name: string): Binding | undefined {
    let scope: SemanticScope | null = this;
    while (scope !== null) {
      const binding = scope.bindings.get(name);
      if (binding !== undefined) {
        if (binding.kind === "variable") scope.captured?.add(name);
        return binding;
      }
      scope = scope.parent;
    }
    return undefined;
  }

  /** The declaration of the variable `name` when it is one that a block shares with the code that created it. */
  public sharedSite(name: string): VariableSite | undefined {
    for (let scope: SemanticScope | null = this; scope !== null; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding !== undefined) return scope.captured === null ? undefined : binding.site;
    }
    return undefined;
  }

  /** Whether `name` is a variable that a block shares with the code that created it. */
  public isShared(name: string): boolean {
    for (let scope: SemanticScope | null = this; scope !== null; scope = scope.parent)
      if (scope.bindings.has(name)) return scope.captured !== null;
    return false;
  }

  public declare(name: string, binding: Binding): boolean {
    if (this.resolve(name) !== undefined) return false;
    this.bindings.set(name, binding);
    return true;
  }
}

/**
 * The names that a host may not configure, as a global or a built-in, because the language gives them a meaning of its
 * own: the grammar keywords, such as `if` and `load`, and `wait`, which the lexer reads as a token of its own; the
 * commands and asks, which the parser reads by name; `takePhoto` and `askImage`, whose calls wait for the Player;
 * `pi`, which the parser reads as the number it names; and `debugMode`, which the engine reads from the session.
 */
const UNCONFIGURABLE_NAMES: ReadonlySet<string> = new Set([
  ...TEASESCRIPT_GRAMMAR_KEYWORDS,
  ...KEYWORD_TOKENS.keys(),
  ...Object.keys(COMMANDS),
  "takePhoto",
  "askImage",
  "pi",
  "debugMode",
]);

/** How a message names the resource whose block is validated. */
const HANDLER_NAMES = { timer: "timer", media: "media", button: "button" } as const;

/** A timer expiry block, media cue block, or permanent button block, validated after the function bodies. */
interface PendingHandler {
  readonly block: Block;
  readonly owner: "timer" | "media" | "button";
  readonly selfHandle: string | null;
  /**
   * The locals of the code that created the block, as they are visible where it does: the block shares these variables
   * with that code (V30 §14). Its parent holds the file's names, or the project's alone.
   */
  readonly scope: SemanticScope;
  /** The block whose code created this one, or `null` when a function or a file's top level did. */
  readonly parent: PendingHandler | null;
  /** The global function the block is in, directly or through other blocks. */
  readonly globalFunction: FunctionDeclaration | null;
  /** Where the block runs, for the initialization check: in `origin`, when `created` runs. */
  readonly origin: FlowContext;
  readonly created: Statement;
}

class SemanticValidator {
  readonly #builtins: ReadonlySet<string>;

  readonly #protectedNames: ReadonlySet<string>;

  /** The file's own names: its top-level variables and functions, under the project's names. */
  readonly #root: SemanticScope;

  /** The functions of this file to validate. */
  readonly #functions = new Map<string, FunctionDeclaration>();

  /**
   * The global function whose body, parameter defaults, or timer and media blocks are being validated. They are
   * validated under the project's names alone, without the file's own (ADR 0022 §3).
   */
  #globalFunction: FunctionDeclaration | null = null;

  readonly #invalidConfiguredNames: readonly string[];

  #functionDepth = 0;

  /**
   * Timer expiry blocks and media cue blocks are validated after all top-level names are known, like function bodies.
   * A media block may bind the handle of its own `let` declaration.
   */
  readonly #pendingHandlers: PendingHandler[] = [];

  #context: FlowContext = { kind: "root", statement: 0 };

  /** Reads and writes of top-level variables, with where they run. */
  readonly #rootAccesses: {
    readonly name: string;
    readonly span: SourceSpan;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  /** The innermost statement being checked, which decides whether what it holds can run. */
  #statement: Statement | null = null;
  /** The value of each `say` statement, whose call of an unknown `skippable` or `unskippable` gets a hint. */
  readonly #sayStatementValues = new WeakSet<Expression>();
  /** The questions of asks, whose call of an unknown `prose` or `bubble` is a mode written with its question. */
  readonly #askQuestions = new WeakSet<Expression>();

  /** The `script(...)` call that a transfer statement being checked names directly, as in `goto script("a.tease")`. */
  #directTarget: {
    readonly call: Expression;
    readonly transfer: "gotoStatement" | "callFileStatement" | "fallbackStatement";
  } | null = null;

  readonly #gotos: {
    readonly label: string;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  /** Every call of an author function, also of another file's global function, by its call-graph node. */
  readonly #callEdges: {
    readonly callee: string;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  readonly #calls: {
    readonly name: string;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  public constructor(
    options: SemanticValidationOptions,
    private readonly project: ProjectNames,
    private readonly file: number,
  ) {
    this.#root = new SemanticScope(project.scope);
    this.#invalidConfiguredNames = Object.freeze(
      [...(options.globals ?? []), ...(options.builtins ?? [])].filter((name) =>
        UNCONFIGURABLE_NAMES.has(name),
      ),
    );
    this.#builtins = new Set([
      ...CORE_RUNTIME_BUILTINS,
      ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
      ...(options.builtins ?? []),
    ]);
    this.#protectedNames = new Set([...TEASESCRIPT_PROTECTED_NAMES, ...(options.builtins ?? [])]);
  }

  /** The files each glob target may pick. */
  readonly picks = new Map<FileTarget, readonly string[]>();

  /** Where transfers and `script(...)` references of this file enter files afresh, with the code that runs them. */
  readonly #entries: {
    readonly entry: FileEntry;
    readonly context: FlowContext;
    readonly statement: Statement;
  }[] = [];

  /** Where `script(...)` references in start values enter files afresh; start values always run. */
  readonly #startEntries: FileEntry[] = [];

  /** Set while a start value is validated. */
  #startValue = false;

  public validate(program: Program): void {
    // The configuration belongs to the project, so its problems are reported once, in main.tease.
    for (const name of this.file === 0 ? new Set(this.#invalidConfiguredNames) : []) {
      this.#report(
        semanticCode.duplicateDeclaration,
        `Configured name '${name}' conflicts with a protected TeaseScript name.`,
        program.span,
      );
    }
    for (const statement of program.statements) {
      if (statement.kind !== "functionDeclaration") continue;
      if (statement.global) {
        if (this.#protectedNames.has(statement.name.name))
          this.#declare(statement.name.name, "function", statement.name.span, this.#root);
        else if (this.project.owns(statement)) this.#functions.set(statement.name.name, statement);
        continue;
      }
      if (this.#functions.has(statement.name.name)) {
        this.#report(
          semanticCode.duplicateFunction,
          `Duplicate function declaration '${statement.name.name}'.`,
          statement.name.span,
        );
        continue;
      }
      if (
        this.#declare(statement.name.name, "function", statement.name.span, this.#root, statement)
      ) {
        this.#functions.set(statement.name.name, statement);
      }
    }
    for (const statement of program.statements) {
      if (statement.kind !== "labelStatement") continue;
      const name = statement.name.name;
      if (this.#protectedNames.has(name)) {
        this.#report(PROTECTED_NAME_CODE, protectedNameMessage(name, "label"), statement.name.span);
      } else if (this.#labels.has(name)) {
        this.#report(
          semanticCode.invalidLabel,
          `This file already has a label '${name}'. Give each label in a file its own name.`,
          statement.name.span,
        );
      } else {
        this.#labels.add(name);
      }
    }
    program.statements.forEach((statement, index) => {
      if (statement.kind !== "functionDeclaration") {
        this.#context = { kind: "root", statement: index };
        runCompileTask(this.#validateStatement(statement, this.#root, 0));
      }
    });
    for (const statement of program.statements) {
      if (
        statement.kind === "functionDeclaration" &&
        this.#functions.get(statement.name.name) === statement
      ) {
        this.#context = { kind: "function", name: statement.name.name };
        this.#validateFunction(statement);
      }
    }
    for (let index = 0; index < this.#pendingHandlers.length; index += 1) {
      const handler = this.#pendingHandlers[index]!;
      this.#context = { kind: "handler", origin: handler.origin, created: handler.created };
      this.#handler = handler;
      this.#validateHandler(handler);
    }
    this.#handler = null;
    this.#collectCaptures();
  }

  /**
   * A handler block sees top-level names, the locals of the code that created it, and its own locals. A media block's
   * self-handle is a local of the handler scope, so it shadows any outer name of the same spelling.
   */
  #validateHandler(handler: PendingHandler): void {
    this.#functionDepth += 1;
    this.#handlerDepth += 1;
    this.#handlerOwner = handler.owner;
    this.#globalFunction = handler.globalFunction;
    try {
      const scope = new SemanticScope(handler.scope);
      if (handler.selfHandle !== null) {
        scope.bindings.set(handler.selfHandle, { kind: "variable" });
      }
      runCompileTask(this.#validateStatements(handler.block.statements, scope, 0));
    } finally {
      this.#functionDepth -= 1;
      this.#handlerDepth -= 1;
      this.#globalFunction = null;
    }
  }

  /** The scope a function body or handler block starts under: the file's names, or the project's alone. */
  #outerScope(): SemanticScope {
    return this.#globalFunction === null ? this.#root : this.project.scope;
  }

  /** The block whose statements are being validated, or `null` outside blocks. */
  #handler: PendingHandler | null = null;

  /**
   * The locals by which a block created here shares variables with this code: those visible now, so not one declared
   * later in the same scope, under the file's or the project's names.
   */
  #captureScope(scope: SemanticScope): SemanticScope {
    const outer = this.#outerScope();
    const captures = new SemanticScope(outer, true);
    for (let current: SemanticScope | null = scope; current !== null && current !== outer;) {
      for (const [name, binding] of current.bindings)
        if (!captures.bindings.has(name)) captures.bindings.set(name, binding);
      current = current.parent;
    }
    return captures;
  }

  #pendHandler(
    block: Block,
    owner: PendingHandler["owner"],
    selfHandle: string | null,
    scope: SemanticScope,
  ): void {
    this.#pendingHandlers.push({
      block,
      owner,
      selfHandle,
      scope: scope.captured === null ? this.#captureScope(scope) : scope,
      parent: this.#handler,
      globalFunction: this.#globalFunction,
      origin: this.#context,
      created: this.#statement!,
    });
  }

  /** The variables each block shares with the code that created it, by its block, for the lowering. */
  readonly captures = new Map<Block, readonly string[]>();

  /**
   * The declarations of the variables that a block shares and assigns or changes in place, so a suspension may change
   * them (V30 §13).
   */
  readonly sharedWrites = new Map<VariableSite, Sharing>();

  /** The speaker that each `speaker` names, where a message names it with `as` or its properties use it. */
  readonly speakers = new Map<Identifier, string>();

  /** Records that the running block assigns or changes `name`, when that is a variable it shares. */
  #recordSharedWrite(name: string | null, scope: SemanticScope, how: Sharing): void {
    const site = name === null ? undefined : scope.sharedSite(name);
    if (site !== undefined) noteSharing(this.sharedWrites, site, how);
  }

  /**
   * A block that creates another one also shares the variables the inner block uses from outside the outer one. Inner
   * blocks come after the block that created them, so walking backwards completes each block before its creator.
   */
  #collectCaptures(): void {
    for (let index = this.#pendingHandlers.length - 1; index >= 0; index -= 1) {
      const handler = this.#pendingHandlers[index]!;
      const captured = handler.scope.captured!;
      const parent = handler.parent;
      if (parent !== null)
        for (const name of captured) {
          const binding = parent.scope.bindings.get(name);
          if (binding !== undefined && binding === handler.scope.bindings.get(name))
            parent.scope.captured!.add(name);
        }
      this.captures.set(handler.block, [...captured]);
    }
  }

  #handlerDepth = 0;

  /** The labels of the file, which stand only in its outer scope. */
  readonly #labels = new Set<string>();

  #handlerOwner: "timer" | "media" | "button" = "timer";

  #validateTimer(timer: TimerParts, scope: SemanticScope, valuePosition: boolean): void {
    for (const operand of timerOperands(timer)) this.#validateExpression(operand, scope, null);
    if (!timer.async) {
      const invalid = timer.handler ?? (timer.repeat || timer.persist ? timer : null);
      if (invalid !== null) {
        this.#report(
          semanticCode.invalidTimer,
          "Only an async timer may have an expiry block, repeat, or persist.",
          invalid.span,
        );
      }
      if (valuePosition) {
        this.#report(
          semanticCode.invalidTimer,
          "A blocking timer returns no handle. Use 'timer async ...' to keep one.",
          timer.span,
        );
      }
    }
    if (timer.handler !== null) this.#pendHandler(timer.handler, "timer", null, scope);
  }

  /** The button text is checked like any shown text; the click action runs later, like a timer expiry block. */
  *#validatePermanentButtonTask(
    button: ShowPermanentButtonParts,
    scope: SemanticScope,
  ): CompileTask<void> {
    yield* compileChild(this.#validateExpressionTask(button.text, scope, null));
    this.#pendHandler(button.handler, "button", null, scope);
  }

  /** The names and form of a play command; the type check checks its values. */
  *#validateMediaTask(
    media: MediaParts,
    scope: SemanticScope,
    valuePosition: boolean,
    selfHandle: string | null,
  ): CompileTask<void> {
    const command = media.media === "audio" ? "playAudio" : "playVideo";
    for (const operand of mediaOperands(media)) {
      yield* compileChild(this.#validateExpressionTask(operand, scope, null));
    }
    if (!media.async && valuePosition) {
      this.#report(
        semanticCode.invalidMediaForm,
        `Blocking media returns no handle. Use '${command} async ...' to keep one.`,
        media.span,
      );
    }
    if (media.handlers?.kind === "cues") {
      let finishes = 0;
      for (const cue of media.handlers.cues) {
        if (cue.kind === "finish") {
          finishes += 1;
          if (finishes > 1) {
            this.#report(
              semanticCode.invalidMediaForm,
              "A media block may declare 'finish' only once.",
              cue.keywordSpan,
            );
          }
        }
      }
    }
    // The blocks of one media share its variables.
    const captures = this.#captureScope(scope);
    for (const block of mediaHandlerBlocks(media))
      this.#pendHandler(block, "media", media.async ? selfHandle : null, captures);
  }

  *#validateStatements(
    statements: readonly Statement[],
    scope: SemanticScope,
    loopDepth: number,
  ): CompileTask<void> {
    for (const statement of statements) {
      yield* compileChild(this.#validateStatement(statement, scope, loopDepth));
    }
  }

  *#validateStatement(
    statement: Statement,
    scope: SemanticScope,
    loopDepth: number,
  ): CompileTask<void> {
    const outer = this.#statement;
    this.#statement = statement;
    try {
      yield* compileChild(this.#validateStatementKind(statement, scope, loopDepth));
    } finally {
      this.#statement = outer;
    }
  }

  *#validateStatementKind(
    statement: Statement,
    scope: SemanticScope,
    loopDepth: number,
  ): CompileTask<void> {
    switch (statement.kind) {
      case "letStatement": {
        const initializer = unwrapParentheses(statement.initializer);
        if (initializer.kind === "playMediaExpression") {
          yield* compileChild(
            this.#validateMediaTask(initializer, scope, true, statement.name.name),
          );
        } else {
          this.#validateExpression(statement.initializer, scope, null);
        }
        if (this.#declare(statement.name.name, "variable", statement.name.span, scope)) {
          scope.bindings.get(statement.name.name)!.site = statement;
        }
        return;
      }
      case "speakerDeclaration": {
        // Speakers belong to the project, which declared them already.
        if (statement.name.name === PLAYER)
          this.#report(
            PROTECTED_NAME_CODE,
            protectedNameMessage(PLAYER, "speaker"),
            statement.name.span,
          );
        const declared =
          statement.name.name === PLAYER
            ? false
            : this.#protectedNames.has(statement.name.name)
              ? this.#declare(statement.name.name, "speaker", statement.name.span, scope)
              : this.project.owns(statement);
        const names = new Set<string>();
        for (const property of statement.properties) {
          if (names.has(property.name.name)) {
            this.#report(
              semanticCode.duplicateProperty,
              duplicateEntryMessage("speaker", property.name.name),
              property.name.span,
            );
          }
          names.add(property.name.name);
          this.#validateStartValue(
            property.value,
            scope,
            statement,
            declared ? statement.name.name : null,
          );
        }
        return;
      }
      case "globalStatement":
        if (this.#protectedNames.has(statement.name.name))
          this.#declare(statement.name.name, "variable", statement.name.span, scope);
        // The assignment runs exactly when the declaration does, so what it uses keeps the declaration as its statement.
        if (statement.assignment !== null)
          yield* compileChild(this.#validateStatementKind(statement.assignment, scope, loopDepth));
        this.#validateStartValue(statement.initial, scope, statement, null);
        return;
      case "speakerSetterStatement":
        this.#validateSpeakerReference(statement.speaker.name, statement.speaker.span, scope);
        return;
      case "sayStatement":
        yield* compileChild(this.#validateSayTask(statement, scope, true));
        return;
      case "showButtonStatement":
        yield* compileChild(this.#validateShowButtonTask(statement, scope));
        return;
      case "waitStatement":
        this.#validateExpression(statement.duration, scope, null);
        return;
      case "timerStatement":
        this.#validateTimer(statement, scope, false);
        return;
      case "showPermanentButtonStatement":
        yield* compileChild(this.#validatePermanentButtonTask(statement, scope));
        return;
      case "playMediaStatement":
        yield* compileChild(this.#validateMediaTask(statement, scope, false, null));
        return;
      case "showImageStatement":
        this.#validateExpression(statement.image, scope, null);
        return;
      case "hideImageStatement":
      case "showCameraStatement":
      case "hideCameraStatement":
      case "stopAudioStatement":
        return;
      case "showPopupStatement":
        this.#validateShowPopupArguments(statement);
        for (const argument of statement.arguments)
          this.#validateExpression(argument.value, scope, null);
        return;
      case "openUrlStatement":
        this.#validateOpenUrlArguments(statement);
        for (const argument of statement.arguments)
          this.#validateExpression(argument.value, scope, null);
        return;
      case "exportTextStatement":
        this.#validateExportTextArguments(statement);
        for (const argument of statement.arguments)
          this.#validateExpression(argument.value, scope, null);
        return;
      case "saveStatement":
        this.#validateExpression(statement.value, scope, null);
        this.#validateExpression(statement.key, scope, null);
        return;
      case "deleteStatement":
        this.#validateExpression(statement.key, scope, null);
        return;
      case "assignmentStatement":
        this.#validateAssignmentTarget(statement.target, scope);
        this.#validateExpression(statement.value, scope, null);
        return;
      case "expressionStatement":
        this.#validateExpression(statement.expression, scope, null);
        return;
      case "ifStatement":
        this.#validateExpression(statement.condition, scope, null);
        yield* compileChild(this.#validateBlock(statement.thenBlock, scope, loopDepth));
        if (statement.elseBlock !== null) {
          if (statement.elseBlock.kind === "ifStatement") {
            yield* compileChild(this.#validateStatement(statement.elseBlock, scope, loopDepth));
          } else {
            yield* compileChild(this.#validateBlock(statement.elseBlock, scope, loopDepth));
          }
        }
        return;
      case "switchStatement":
        this.#validateExpression(statement.subject, scope, null);
        validateSwitchCases(
          statement,
          (name) => scope.resolve(name)?.kind === "speaker",
          (code, message, span) => this.#report(code, message, span),
        );
        for (const switchCase of statement.cases) {
          yield* compileChild(this.#validateBlock(switchCase.body, scope, loopDepth));
        }
        if (statement.defaultBlock !== null) {
          yield* compileChild(this.#validateBlock(statement.defaultBlock, scope, loopDepth));
        }
        return;
      case "repeatStatement":
        this.#validateExpression(statement.count, scope, null);
        yield* compileChild(this.#validateBlock(statement.body, scope, loopDepth + 1));
        return;
      case "forStatement": {
        this.#validateExpression(statement.iterable, scope, null);
        const loopScope = new SemanticScope(scope);
        if (this.#declare(statement.variable.name, "variable", statement.variable.span, loopScope))
          loopScope.bindings.get(statement.variable.name)!.site = statement;
        if (
          statement.valueVariable !== null &&
          this.#declare(
            statement.valueVariable.name,
            "variable",
            statement.valueVariable.span,
            loopScope,
          )
        )
          loopScope.bindings.get(statement.valueVariable.name)!.site = statement.valueVariable;
        yield* compileChild(
          this.#validateStatements(statement.body.statements, loopScope, loopDepth + 1),
        );
        return;
      }
      case "whileStatement":
        this.#validateExpression(statement.condition, scope, null);
        yield* compileChild(this.#validateBlock(statement.body, scope, loopDepth + 1));
        return;
      case "breakStatement":
      case "continueStatement":
        if (loopDepth === 0) {
          this.#report(
            semanticCode.invalidLoopControl,
            `'${statement.kind === "breakStatement" ? "break" : "continue"}' may only appear inside a loop.`,
            statement.span,
          );
        }
        return;
      case "functionDeclaration":
        this.#report(
          semanticCode.nestedFunction,
          "Nested function declarations are not supported in this milestone.",
          statement.span,
        );
        return;
      case "returnStatement":
        if (this.#functionDepth === 0) {
          this.#report(
            semanticCode.returnOutsideFunction,
            "'return' may only appear inside a function.",
            statement.span,
          );
        } else if (this.#handlerDepth > 0 && statement.value !== null) {
          this.#report(
            semanticCode.invalidTimer,
            this.#handlerOwner === "timer"
              ? "A timer expiry block may use 'return' only without a value."
              : this.#handlerOwner === "media"
                ? "A media block may use 'return' only without a value."
                : "A button block may use 'return' only without a value.",
            statement.value.span,
          );
        }
        if (statement.value !== null) {
          this.#validateExpression(statement.value, scope, null);
        }
        return;
      case "exitStatement":
      case "endStatement":
        return;
      case "labelStatement":
        if (scope !== this.#root || this.#functionDepth > 0) {
          this.#report(
            semanticCode.invalidLabel,
            `A label stands only in the outer level of a file, not inside a block, loop, function, or handler. Move 'label ${statement.name.name}' out of the block. A goto may still jump to it from anywhere in the file.`,
            statement.span,
          );
        }
        return;
      case "gotoStatement":
      case "callFileStatement":
      case "fallbackStatement": {
        const target = statement.target;
        if (target?.kind === "scriptTarget") {
          this.#directTarget = {
            call: unwrapParentheses(target.expression),
            transfer: statement.kind,
          };
          this.#validateExpression(target.expression, scope, null);
          this.#directTarget = null;
          return;
        }
        if (target === null || !this.#validateTransferTarget(target, statement.kind)) return;
        if (target.kind === "fileTarget") {
          for (const path of this.picks.get(target) ?? [target.path]) {
            this.#entries.push({
              entry: { path, label: target.label?.name ?? null },
              context: this.#context,
              statement,
            });
          }
        } else if (statement.kind === "gotoStatement" && this.#globalFunction === null) {
          // A goto to a label of the same file keeps the file's variables.
          this.#gotos.push({
            label: target.label.name,
            context: this.#context,
            statement: this.#statement!,
          });
        } else {
          // `call label` and `fallback label`, and in a global function or its blocks also `goto label`, enter
          // this file afresh at the label (ADR 0022 §3.5).
          this.#entries.push({
            entry: { path: this.project.files[this.file]!.path, label: target.label.name },
            context: this.#context,
            statement,
          });
        }
        return;
      }
    }
  }

  /** Reports a missing file or label; a label alone names one of this file. */
  #validateTransferTarget(
    target: LabelTarget | FileTarget,
    transfer: "gotoStatement" | "callFileStatement" | "fallbackStatement",
  ): boolean {
    if (target.kind === "labelTarget") {
      if (this.#labels.has(target.label.name)) return true;
      this.#report(
        semanticCode.invalidLabel,
        `This file has no label '${target.label.name}'. Add 'label ${target.label.name}' in the outer level of the file.`,
        target.label.span,
      );
      return false;
    }
    if (isPathGlob(target.path)) return this.#validateGlobTarget(target);
    const problem = packagePathProblem(target.path);
    if (problem !== null) {
      this.#report(
        semanticCode.invalidFileTarget,
        `'${target.path}' is not a package file path: ${problem}.`,
        target.pathSpan,
      );
      return false;
    }
    const labels = this.project.labels.get(target.path);
    if (labels === undefined) {
      this.#report(
        semanticCode.invalidFileTarget,
        `The project has no file '${target.path}'. Paths start at the package root, such as "rooms/hall.tease".`,
        target.pathSpan,
      );
      return false;
    }
    if (target.label !== null && !labels.has(target.label.name)) {
      this.#report(
        semanticCode.invalidLabel,
        `'${target.path}' has no label '${target.label.name}'.`,
        target.label.span,
      );
      return false;
    }
    if (transfer !== "callFileStatement" && this.project.declarationsOnly.has(target.path)) {
      this.#report(
        semanticCode.invalidFileTarget,
        `'${target.path}' holds declarations only and runs nothing, so going there would end nowhere. Call its functions instead.`,
        target.pathSpan,
      );
      return false;
    }
    return true;
  }

  /**
   * A `script(...)` call whose path is literal text is checked like a file target. Whatever its arguments, it marks the
   * labels it may enter afresh, by whether its path and label are literal text (ADR 0022 §3.4).
   */
  #validateScriptReference(call: Extract<Expression, { kind: "callExpression" }>): void {
    const positional = call.arguments.filter((argument) => argument.kind === "positionalArgument");
    // The type check reports another number of paths.
    if (positional.length !== 1) return;
    const pathArgument = positional[0]!.value;
    const labelArgument = call.arguments.find(
      (argument) => argument.kind === "namedArgument" && argument.name.name === "label",
    )?.value;
    const path = literalText(pathArgument) ?? null;
    const label = labelArgument === undefined ? null : (literalText(labelArgument) ?? true);
    if (path !== null) {
      const transfer = this.#directTarget?.call === call ? this.#directTarget.transfer : null;
      const keyword =
        transfer === "callFileStatement"
          ? "call"
          : transfer === "fallbackStatement"
            ? "fallback"
            : "goto";
      const pathProblem = packagePathProblem(path);
      const problem = isPathGlob(path)
        ? `A glob cannot be inside script(...). To pick a random file, write ${keyword} ${JSON.stringify(path)}${typeof label === "string" ? ` ${label}` : ""} directly.`
        : pathProblem !== null
          ? `'${path}' is not a package file path: ${pathProblem}.`
          : !this.project.labels.has(path)
            ? `The project has no file '${path}'. Paths start at the package root, such as "rooms/hall.tease".`
            : transfer !== null &&
                transfer !== "callFileStatement" &&
                this.project.declarationsOnly.has(path)
              ? `'${path}' holds declarations only and runs nothing, so going there would end nowhere. Call its functions instead.`
              : null;
      if (problem !== null) {
        this.#report(semanticCode.invalidFileTarget, problem, pathArgument.span);
        return;
      }
      if (typeof label === "string" && !this.project.labels.get(path)!.has(label)) {
        this.#report(
          semanticCode.invalidLabel,
          `'${path}' has no label '${label}'.`,
          labelArgument!.span,
        );
        return;
      }
    }
    // A start value runs at the start of every session, wherever its global is declared.
    if (this.#startValue) this.#startEntries.push({ path, label });
    else
      this.#entries.push({
        entry: { path, label },
        context: this.#context,
        statement: this.#statement!,
      });
  }

  /**
   * A glob picks among the files it matches that have the label, if one is given, and that run something; it is an
   * error only when none remains (ADR 0022 §2.2).
   */
  #validateGlobTarget(target: FileTarget): boolean {
    const problem = packageGlobProblem(target.path);
    if (problem !== null) {
      this.#report(
        semanticCode.invalidFileTarget,
        `'${target.path}' is not a pattern of package file paths: ${problem}.`,
        target.pathSpan,
      );
      return false;
    }
    const label = target.label?.name ?? null;
    const matches = globMatches(target.path, this.project.labels.keys());
    const labelled =
      label === null
        ? matches
        : matches.filter((path) => this.project.labels.get(path)!.has(label));
    const runnable = labelled.filter((path) => !this.project.declarationsOnly.has(path));
    if (runnable.length > 0) {
      this.picks.set(target, runnable);
      return true;
    }
    this.#report(
      semanticCode.invalidFileTarget,
      matches.length === 0
        ? `No file of the project matches '${target.path}'. Paths start at the package root, such as "rooms/*.tease".`
        : labelled.length === 0
          ? `No file matching '${target.path}' has label '${label}'.`
          : `Every file matching '${target.path}'${label === null ? "" : ` with label '${label}'`} holds declarations only and runs nothing, so there is nothing to pick.`,
      target.pathSpan,
    );
    return false;
  }

  #validateFunction(declaration: FunctionDeclaration): void {
    this.#globalFunction = declaration.global ? declaration : null;
    try {
      this.#validateFunctionParts(declaration);
    } finally {
      this.#globalFunction = null;
    }
  }

  #validateFunctionParts(declaration: FunctionDeclaration): void {
    const names = new Set<string>();
    let sawDefault = false;
    const bodyScope = new SemanticScope(this.#outerScope());
    for (const parameter of declaration.parameters) {
      const duplicate = names.has(parameter.name.name);
      if (duplicate) {
        this.#report(
          semanticCode.duplicateParameter,
          `Duplicate function parameter '${parameter.name.name}'.`,
          parameter.name.span,
        );
      }
      names.add(parameter.name.name);
      if (parameter.defaultValue === null && sawDefault) {
        this.#report(
          semanticCode.requiredAfterDefault,
          "Required parameters must precede parameters with defaults.",
          parameter.span,
        );
      }
      sawDefault ||= parameter.defaultValue !== null;
      if (
        !duplicate &&
        this.#declare(parameter.name.name, "variable", parameter.name.span, bodyScope)
      ) {
        bodyScope.bindings.get(parameter.name.name)!.site = parameter;
      }
    }

    const defaultScope = new SemanticScope(this.#outerScope());
    const laterNameCounts = new Map<string, number>();
    for (const parameter of declaration.parameters) {
      const name = parameter.name.name;
      laterNameCounts.set(name, (laterNameCounts.get(name) ?? 0) + 1);
    }
    for (const parameter of declaration.parameters) {
      const name = parameter.name.name;
      const remaining = (laterNameCounts.get(name) ?? 1) - 1;
      if (remaining === 0) {
        laterNameCounts.delete(name);
      } else {
        laterNameCounts.set(name, remaining);
      }
      if (parameter.defaultValue !== null) {
        const blockingInteraction = findFirstInteraction(parameter.defaultValue);
        if (blockingInteraction !== null) {
          this.#report(
            semanticCode.unsupportedBlockingContext,
            blockingInteraction.kind === "playMediaExpression"
              ? "Media playback is not supported in function parameter defaults."
              : blockingInteraction.kind === "showCameraExpression"
                ? "Camera views are not supported in function parameter defaults."
                : blockingInteraction.kind === "sayExpression"
                  ? "A say is not supported in function parameter defaults."
                  : isTakePhotoCall(blockingInteraction)
                    ? "Camera capture is not supported in function parameter defaults."
                    : isLockCall(blockingInteraction) &&
                        blockingInteraction.kind === "callExpression" &&
                        blockingInteraction.callee.kind === "identifier"
                      ? `${blockingInteraction.callee.name}(...) is not supported in function parameter defaults, because it may ask the player. Call it in the function's body.`
                      : "Blocking interactions are not supported in function parameter defaults.",
            blockingInteraction.span,
          );
        }
        this.#reportLaterParameterReferences(parameter.defaultValue, laterNameCounts);
        this.#validateExpression(parameter.defaultValue, defaultScope, null);
      }
      defaultScope.declare(name, { kind: "variable", site: parameter });
    }

    this.#functionDepth += 1;
    try {
      runCompileTask(this.#validateStatements(declaration.body.statements, bodyScope, 0));
    } finally {
      this.#functionDepth -= 1;
    }
  }

  *#validateBlock(block: Block, parent: SemanticScope, loopDepth: number): CompileTask<void> {
    yield* compileChild(
      this.#validateStatements(block.statements, new SemanticScope(parent), loopDepth),
    );
  }

  #validateAssignmentTarget(target: AssignmentTarget, scope: SemanticScope): void {
    // A store into an element or property changes the variable that holds it in place.
    this.#recordSharedWrite(
      rootName(target),
      scope,
      target.kind === "identifier" ? "assigns" : "changes",
    );
    if (target.kind === "identifier") {
      if (target.name === "debugMode" || target.name === "account") {
        this.#report(
          semanticCode.invalidAssignment,
          `Cannot assign to '${target.name}', which is read-only.`,
          target.span,
        );
        return;
      }
      const binding = scope.resolve(target.name);
      this.#recordRootAccess(target.name, binding, target.span);
      if (binding === undefined) {
        if (!this.#reportFileName(target.name, target.span))
          this.#report(
            semanticCode.unknownAssignment,
            `Cannot assign to unknown variable '${target.name}'.`,
            target.span,
          );
      } else if (binding.kind === "function") {
        this.#report(
          semanticCode.functionAssignment,
          `Cannot assign to function '${target.name}'.`,
          target.span,
        );
      } else if (binding.kind !== "variable") {
        this.#report(
          semanticCode.invalidAssignment,
          `Cannot replace ${binding.kind} '${target.name}'.`,
          target.span,
        );
      }
      return;
    }

    if (rootName(target) === "account") {
      this.#reportAccountChange(target, true);
      return;
    }
    this.#validateExpression(target.object, scope, null);
    if (target.kind === "indexExpression") {
      this.#validateExpression(target.index, scope, null);
    }
  }

  /**
   * Reports a store into the read-only account at `place` (`store`), or a change of one of its lists through it
   * (V30 §37).
   */
  #reportAccountChange(place: Expression, store: boolean): void {
    let field = unwrapParentheses(place);
    while (
      (field.kind === "propertyAccessExpression" || field.kind === "indexExpression") &&
      unwrapParentheses(field.object).kind !== "identifier"
    )
      field = unwrapParentheses(field.object);
    const name = field.kind === "propertyAccessExpression" ? field.property.name : null;
    // An assignment of a field itself, as opposed to a change inside it.
    const assigned = store && name !== null && field === unwrapParentheses(place);
    const label = name === null ? "account" : `account.${name}`;
    const instead = name === null ? "its field" : `'player.${name}'`;
    this.#report(
      semanticCode.invalidAssignment,
      `Cannot ${assigned ? "assign to" : "change"} '${label}': the account is read-only. Copy it into the player with 'player.copyFrom(account)' and ${assigned ? "assign" : "change"} ${instead} instead.`,
      place.span,
    );
  }

  #validateExpression(
    expression: Expression,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): void {
    return runCompileTask(this.#validateExpressionTask(expression, scope, contextualSpeaker));
  }

  *#validateExpressionTask(
    expression: Expression,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    while (
      expression.kind === "parenthesizedExpression" ||
      expression.kind === "unaryExpression" ||
      expression.kind === "unitExpression" ||
      expression.kind === "angleExpression"
    ) {
      expression =
        expression.kind === "parenthesizedExpression" ? expression.expression : expression.operand;
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "durationLiteral":
        return;
      case "regexLiteral":
        this.#validateRegexLiteral(expression);
        return;
      case "stringLiteral":
        for (const part of expression.parts) {
          if (part.kind === "stringInterpolation") {
            yield* compileChild(
              this.#validateExpressionTask(part.expression, scope, contextualSpeaker),
            );
          }
        }
        return;
      case "interactionExpression": {
        const contextualSpeaker = this.#interactionSpeaker(expression.speaker, scope);
        if (expression.interactionKind === "choice") {
          yield* compileChild(this.#validateChoiceTask(expression, scope, contextualSpeaker));
        } else {
          if (expression.question !== null) this.#askQuestions.add(expression.question);
          for (const operand of askOperands(expression))
            yield* compileChild(this.#validateExpressionTask(operand, scope, contextualSpeaker));
        }
        return;
      }
      case "identifier":
        if (expression.name === "speaker" && contextualSpeaker !== null) {
          if (contextualSpeaker !== "speaker") this.speakers.set(expression, contextualSpeaker);
          // Without `as`, a message has the default speaker, which a script that never sets one cannot have.
          else if (!this.project.setsDefaultSpeaker)
            this.#report(
              semanticCode.noSpeaker,
              "This message has no speaker, so 'speaker' has no value: it names none with 'as', and the script never sets a default speaker. Give it one with 'as name', or set a default speaker with 'speaker name'.",
              expression.span,
            );
          return;
        }
        // Protected, so never a binding: the engine reads it from the session.
        if (expression.name === "debugMode") return;
        if (expression.name === "account") {
          this.#report(
            semanticCode.functionValue,
            "'account' is not a value of its own. Read one of its fields, as in 'account.firstName', or copy it into the player with 'player.copyFrom(account)'.",
            expression.span,
          );
          return;
        }
        const binding = scope.resolve(expression.name);
        this.#recordRootAccess(expression.name, binding, expression.span);
        if (binding === undefined) {
          if (
            this.#builtins.has(expression.name) ||
            expression.name === "takePhoto" ||
            expression.name === "askImage" ||
            expression.name === "showPopup" ||
            expression.name === "openUrl" ||
            expression.name === "exportText"
          ) {
            this.#report(
              semanticCode.functionValue,
              `Builtin '${expression.name}' is not a first-class runtime value.`,
              expression.span,
            );
          } else if (!this.#reportFileName(expression.name, expression.span)) {
            this.#report(
              semanticCode.unknownVariable,
              `Unknown variable '${expression.name}'.`,
              expression.span,
            );
          }
        } else if (binding.kind === "function") {
          this.#report(
            semanticCode.functionValue,
            `Function '${expression.name}' is not a first-class runtime value.`,
            expression.span,
          );
        }
        return;
      case "listLiteral":
      case "setLiteral":
        yield* compileChild(
          this.#validateCollectionExpressionTask(expression, scope, contextualSpeaker),
        );
        return;
      case "objectLiteral":
        yield* compileChild(
          this.#validateCollectionExpressionTask(expression, scope, contextualSpeaker),
        );
        return;
      case "dictLiteral":
        for (const entry of expression.entries) {
          yield* compileChild(this.#validateExpressionTask(entry.key, scope, contextualSpeaker));
          yield* compileChild(this.#validateExpressionTask(entry.value, scope, contextualSpeaker));
        }
        return;
      case "propertyAccessExpression":
        // The account is read by its fields, which the type check knows.
        if (isAccount(expression.object)) return;
        yield* compileChild(
          this.#validateExpressionTask(expression.object, scope, contextualSpeaker),
        );
        return;
      case "showButtonExpression":
        yield* compileChild(this.#validateShowButtonTask(expression, scope));
        return;
      case "showPopupExpression":
        this.#validateShowPopupArguments(expression);
        for (const argument of expression.arguments)
          yield* compileChild(this.#validateExpressionTask(argument.value, scope, null));
        return;
      case "timerExpression":
        this.#validateTimer(expression, scope, true);
        return;
      case "showPermanentButtonExpression":
        yield* compileChild(this.#validatePermanentButtonTask(expression, scope));
        return;
      case "playMediaExpression":
        yield* compileChild(this.#validateMediaTask(expression, scope, true, null));
        return;
      case "showCameraExpression":
        return;
      case "loadExpression":
        yield* compileChild(this.#validateExpressionTask(expression.key, scope, contextualSpeaker));
        if (expression.defaultValue === null) {
          const key = literalText(expression.key);
          this.#report(
            semanticCode.argumentCount,
            missingDefaultMessage(
              `load(${key === undefined ? "key" : JSON.stringify(key)}, default: value)`,
              "for a key that has not been saved",
              "Add one, such as 'default: 0', or 'default: null' to check for a missing value with '!= null'.",
            ),
            expression.span,
            true,
          );
        } else {
          yield* compileChild(
            this.#validateExpressionTask(expression.defaultValue, scope, contextualSpeaker),
          );
        }
        return;
      case "indexExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.object, scope, contextualSpeaker),
        );
        yield* compileChild(
          this.#validateExpressionTask(expression.index, scope, contextualSpeaker),
        );
        return;
      case "callExpression": {
        const authorFunction =
          expression.callee.kind === "identifier" &&
          scope.resolve(expression.callee.name)?.declaration !== undefined;
        // Only an author function's parameters are known here; for every other callee a repeated name is still an error.
        if (!authorFunction) this.#validateDistinctNamedArguments(expression);
        // Grouping a method does not detach it from its receiver: `(text.trim)()` calls `text.trim()`.
        const method = unwrapParentheses(expression.callee);
        // A list of the account changes in place as a list of anything else does, also when it is reordered; a text of
        // the account reverses into a new text.
        if (
          method.kind === "propertyAccessExpression" &&
          rootName(method.object) === "account" &&
          (COLLECTION_CHANGES.has(method.property.name) ||
            (LIST_REORDERS.has(method.property.name) && isAccountList(method.object)))
        ) {
          this.#reportAccountChange(method.object, false);
          return;
        }
        if (
          method.kind === "propertyAccessExpression" &&
          COLLECTION_CHANGES.has(method.property.name)
        )
          this.#recordSharedWrite(rootName(method.object), scope, "changes");
        if (expression.callee.kind === "identifier") {
          const name = expression.callee.name;
          const binding = scope.resolve(name);
          if (isTakePhotoCall(expression)) {
            const positional = expression.arguments.filter(
              (argument) => argument.kind === "positionalArgument",
            ).length;
            if (positional > 0)
              this.#report(
                semanticCode.argumentCount,
                argumentCountMessage(
                  "takePhoto",
                  "no arguments without a name",
                  positional,
                  `Name its tags, as in 'takePhoto(tags: ["bedroom"])'.`,
                ),
                expression.span,
              );
            for (const argument of expression.arguments)
              if (argument.kind === "namedArgument" && argument.name.name !== "tags")
                this.#report(
                  semanticCode.unknownNamedArgument,
                  unknownNamedArgumentMessage("takePhoto", argument.name.name, ["tags"]),
                  argument.name.span,
                );
          } else if (isAskImageCall(expression)) {
            this.#validateAskImageArguments(expression);
            // `askImage` has no `as`, so the default speaker asks: `speaker` in its mode and in every argument is that
            // speaker, as in a basic ask.
            if (expression.presentation !== undefined)
              yield* compileChild(
                this.#validateExpressionTask(expression.presentation, scope, "speaker"),
              );
          } else if (name === "openUrl" || name === "exportText") {
            // A statement of its own is an `openUrlStatement` or an `exportTextStatement`.
            this.#report(
              semanticCode.functionValue,
              `${name}(...) gives no value, so it can only be a statement of its own.`,
              expression.callee.span,
            );
          } else if (binding?.declaration !== undefined) {
            // The initialization check follows the calls of this file's functions.
            if (this.#functions.get(name) === binding.declaration)
              this.#calls.push({ name, context: this.#context, statement: this.#statement! });
            this.#callEdges.push({
              callee: binding.declaration.global ? `global:${name}` : `${this.file}:${name}`,
              context: this.#context,
              statement: this.#statement!,
            });
            this.#validateFunctionCall(expression, binding.declaration);
          } else if (this.#builtins.has(name)) {
            // The type check checks the arguments of the core built-ins it knows.
            if (name === "script") this.#validateScriptReference(expression);
          } else if (binding !== undefined) {
            this.#report(
              semanticCode.nonCallable,
              `'${name}' is a ${binding.kind}, not a callable function.`,
              expression.callee.span,
            );
          } else if (name === "removePermanentButton") {
            // A permanent button removes itself, as a timer stops itself (#836).
            const [button] = expression.arguments;
            const unwrapped = button === undefined ? undefined : unwrapParentheses(button.value);
            this.#report(
              semanticCode.unknownFunction,
              `removePermanentButton(...) is replaced by the button's own remove(), like stop() on a timer. ${
                unwrapped?.kind === "identifier" && expression.arguments.length === 1
                  ? `Write '${unwrapped.name}.remove()'.`
                  : "Call remove() on the button that showPermanentButton gave, as in 'button.remove()'."
              }`,
              expression.callee.span,
            );
          } else if (RENAMED_BUILTINS.has(name)) {
            this.#report(
              semanticCode.unknownFunction,
              `Unknown function '${name}'. Use '${RENAMED_BUILTINS.get(name)}'.`,
              expression.callee.span,
            );
          } else if (unboundValue(name, contextualSpeaker) !== null) {
            this.#report(
              semanticCode.nonCallable,
              `'${name}' is ${unboundValue(name, contextualSpeaker)}, not a callable function.`,
              expression.callee.span,
            );
          } else if (!this.#reportFileName(name, expression.callee.span)) {
            // A statement reads `say unskippable("Hi")` as a call, as before parentheses could hold a value's text, and an
            // ask reads `askText prose("Name?")` as a question that calls `prose`, as `say` does.
            const hint =
              this.#sayStatementValues.has(expression) &&
              (name === "skippable" || name === "unskippable")
                ? ` To say a message ${name}, write its text without parentheses, as in 'say ${name} "Hi"'. Only a say used as a value, such as 'let line = say ${name} ("Hi", instant)', takes its text in parentheses.`
                : this.#askQuestions.has(expression) && (name === "bubble" || name === "prose")
                  ? ` To show the question as ${name}, write the question after '${name}' without parentheses around it, as in '${name} "Name?"', or give '${name}' its own parentheses first, as in '${name}() ("Name?")'.`
                  : "";
            this.#report(
              semanticCode.unknownFunction,
              `Unknown function '${name}'.${hint}`,
              expression.callee.span,
            );
          }
        } else if (method.kind === "propertyAccessExpression") {
          yield* compileChild(
            this.#validateExpressionTask(method.object, scope, contextualSpeaker),
          );
          // No value has a method by an earlier name, so its call names the fix whatever the value is.
          const renamed = RENAMED_METHODS.get(method.property.name);
          if (renamed !== undefined)
            this.#report(
              semanticCode.unknownFunction,
              `Unknown method '${method.property.name}'. Use '${renamed}()'.`,
              method.property.span,
            );
        } else {
          yield* compileChild(
            this.#validateExpressionTask(expression.callee, scope, contextualSpeaker),
          );
          // Grouping a name does not make it callable: `(x)()` fails as `x()` does. The check of the name as a value
          // already reports a function, a built-in, or an unknown name.
          if (method.kind === "identifier") {
            const binding = scope.resolve(method.name);
            const kind =
              unboundValue(method.name, contextualSpeaker) ??
              (binding !== undefined && binding.kind !== "function" ? `a ${binding.kind}` : null);
            if (kind !== null)
              this.#report(
                semanticCode.nonCallable,
                `'${method.name}' is ${kind}, not a callable function.`,
                method.span,
              );
          } else {
            // Functions are not values, so no other expression, such as `items[0]` or `pick(1)`, gives one to call.
            this.#report(
              semanticCode.nonCallable,
              "Only a function or a method can be called. Call a function by its name instead.",
              method.span,
            );
          }
        }
        const argumentSpeaker = isAskImageCall(expression) ? "speaker" : contextualSpeaker;
        for (const argument of expression.arguments) {
          // `copyFrom` takes the account as a whole; the type check reports any other form of it.
          if (
            method.kind === "propertyAccessExpression" &&
            method.property.name === "copyFrom" &&
            isAccount(argument.value)
          )
            continue;
          yield* compileChild(this.#validateExpressionTask(argument.value, scope, argumentSpeaker));
        }
        return;
      }
      case "binaryExpression": {
        yield* compileChild(
          this.#validateExpressionTask(expression.left, scope, contextualSpeaker),
        );
        yield* compileChild(
          this.#validateExpressionTask(expression.right, scope, contextualSpeaker),
        );
        return;
      }
      case "rangeExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.start, scope, contextualSpeaker),
        );
        yield* compileChild(this.#validateExpressionTask(expression.end, scope, contextualSpeaker));
        if (
          expression.start.kind === "rangeExpression" ||
          expression.end.kind === "rangeExpression"
        ) {
          this.#report(semanticCode.chainedRange, "Ranges may not be chained.", expression.span);
        }
        return;
      case "typeTestExpression":
        yield* compileChild(
          this.#validateExpressionTask(expression.value, scope, contextualSpeaker),
        );
        return;
      case "sayExpression":
        yield* compileChild(this.#validateSayTask(expression, scope, false));
        return;
      case "tagQueryExpression":
        for (const operand of tagQueryOperands(expression)) {
          yield* compileChild(this.#validateExpressionTask(operand, scope, contextualSpeaker));
        }
        return;
    }
    expression satisfies never;
  }

  /** A regex literal has valid flags, and RE2 compiles its pattern within the regex limits (V30 §8). */
  #validateRegexLiteral(literal: RegexLiteral): void {
    const flagProblem = regexFlagProblem(literal.flags);
    if (flagProblem !== null) {
      // The flags are the letters at the end of the literal's line.
      const end = literal.span.end;
      const start = createSourcePosition(
        end.offset - literal.flags.length,
        end.line,
        end.column - literal.flags.length,
      );
      this.#report(semanticCode.invalidRegex, flagProblem, createSourceSpan(start, end));
      return;
    }
    const compiled = compileRegex(literal.source, canonicalRegexFlags(literal.flags));
    if (!compiled.ok) this.#report(semanticCode.invalidRegex, compiled.problem, literal.span);
  }

  /** A `say`, as a statement or a value: its operands under the speaker it chooses, and its presentation and pacing. */
  *#validateSayTask(parts: SayParts, scope: SemanticScope, statement: boolean): CompileTask<void> {
    const contextualSpeaker =
      parts.speaker === null
        ? "speaker"
        : this.#validateSpeakerReference(parts.speaker.name, parts.speaker.span, scope)
          ? parts.speaker.name
          : null;
    if (parts.presentation !== null)
      yield* compileChild(
        this.#validateExpressionTask(parts.presentation, scope, contextualSpeaker),
      );
    if (statement) this.#sayStatementValues.add(parts.value);
    yield* compileChild(this.#validateExpressionTask(parts.value, scope, contextualSpeaker));
    if (parts.pacing !== null && parts.pacing !== "instant")
      yield* compileChild(this.#validateExpressionTask(parts.pacing, scope, contextualSpeaker));
  }

  #interactionSpeaker(
    speaker: Extract<Expression, { kind: "interactionExpression" }>["speaker"],
    scope: SemanticScope,
  ): string | null {
    return speaker === null
      ? "speaker"
      : this.#validateSpeakerReference(speaker.name, speaker.span, scope)
        ? speaker.name
        : null;
  }

  /** Validates the operands of a statement or expression `showButton` in source order. */
  *#validateShowButtonTask(parts: ShowButtonParts, scope: SemanticScope): CompileTask<void> {
    const contextualSpeaker = this.#interactionSpeaker(parts.speaker, scope);
    yield* compileChild(this.#validateExpressionTask(parts.label, scope, contextualSpeaker));
    for (const option of showButtonOptions(parts))
      yield* compileChild(this.#validateExpressionTask(option.value, scope, contextualSpeaker));
  }

  *#validateChoiceTask(
    expression: Extract<Expression, { kind: "interactionExpression" }>,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    // The parser rejects a choice without options (TSP030). The type checker checks the options: what each button
    // shows and returns, and how many buttons a choice has.
    for (const option of expression.options)
      yield* compileChild(
        this.#validateExpressionTask(option.expression, scope, contextualSpeaker),
      );
    if (expression.prefill !== null)
      yield* compileChild(
        this.#validateExpressionTask(expression.prefill, scope, contextualSpeaker),
      );
  }

  *#validateCollectionExpressionTask(
    root: Extract<Expression, { kind: "listLiteral" | "setLiteral" | "objectLiteral" }>,
    scope: SemanticScope,
    contextualSpeaker: string | null,
  ): CompileTask<void> {
    if (root.kind === "objectLiteral") {
      const names = new Set<string>();
      for (const property of root.properties) {
        if (names.has(property.name.name))
          this.#report(
            semanticCode.duplicateProperty,
            duplicateEntryMessage("object", property.name.name),
            property.name.span,
          );
        names.add(property.name.name);
        yield* compileChild(this.#validateExpressionTask(property.value, scope, contextualSpeaker));
      }
      return;
    }
    for (const element of root.elements)
      yield* compileChild(this.#validateExpressionTask(element, scope, contextualSpeaker));
  }

  /**
   * Positional arguments fill parameters from left to right; named arguments that follow them fill parameters by name.
   * Each parameter receives at most one value, and every parameter without a default needs one.
   */
  #validateFunctionCall(
    expression: Extract<Expression, { kind: "callExpression" }>,
    declaration: FunctionDeclaration,
  ): void {
    const positional = expression.arguments.filter(
      (argument) => argument.kind === "positionalArgument",
    );
    const named = expression.arguments.filter((argument) => argument.kind === "namedArgument");
    const functionName = declaration.name.name;
    const parameterNames = declaration.parameters.map((parameter) => parameter.name.name);
    const required = declaration.parameters.filter(
      (parameter) => parameter.defaultValue === null,
    ).length;
    if (positional.length > parameterNames.length) {
      this.#report(
        semanticCode.argumentCount,
        argumentCountMessage(
          functionName,
          argumentsTaken(parameterNames, required),
          positional.length,
        ),
        expression.span,
      );
      return;
    }
    if (named.length === 0) {
      if (positional.length < required)
        this.#report(
          semanticCode.argumentCount,
          argumentCountMessage(
            functionName,
            argumentsTaken(parameterNames, required),
            positional.length,
          ),
          expression.span,
        );
      return;
    }
    const indexes = new Map(parameterNames.map((name, index) => [name, index]));
    const supplied = new Set(parameterNames.slice(0, positional.length));
    for (const argument of named) {
      const name = argument.name.name;
      const index = indexes.get(name);
      if (index === undefined) {
        this.#report(
          semanticCode.unknownNamedArgument,
          unknownNamedArgumentMessage(functionName, name, parameterNames, false),
          argument.name.span,
        );
      } else if (index < positional.length) {
        this.#report(
          semanticCode.duplicateNamedArgument,
          `Parameter '${name}' already receives positional argument ${index + 1}. Remove one of the two.`,
          argument.name.span,
        );
      } else if (supplied.has(name)) {
        this.#report(
          semanticCode.duplicateNamedArgument,
          `Argument '${name}' is given twice. Remove one of them.`,
          argument.name.span,
        );
      }
      supplied.add(name);
    }
    for (const parameter of declaration.parameters) {
      if (parameter.defaultValue === null && !supplied.has(parameter.name.name)) {
        this.#report(
          semanticCode.missingNamedArgument,
          missingArgumentMessage(
            functionName,
            `a value for '${parameter.name.name}'`,
            `Add it by position or as '${parameter.name.name}: ...'.`,
          ),
          expression.span,
        );
      }
    }
  }

  /** Reports a parameter name given twice in a call whose parameters only the callee knows. */
  /**
   * `askImage(...)` takes its message first, positionally or as `message:`, and the named options of V30 §20. The
   * invalid-input options are not supported yet.
   */
  #validateAskImageArguments(expression: Extract<Expression, { kind: "callExpression" }>): void {
    let message = false;
    for (const [index, argument] of expression.arguments.entries()) {
      if (argument.kind === "positionalArgument") {
        if (index > 0 || message)
          this.#report(
            semanticCode.argumentCount,
            leadingArgumentMessage(
              "askImage",
              "its message",
              'askImage("Add an image", allowCamera: false)',
            ),
            argument.span,
          );
        message = true;
        continue;
      }
      const name = argument.name.name;
      if (name === "message") {
        if (message)
          this.#report(
            semanticCode.argumentCount,
            leadingArgumentTwiceMessage("askImage", "message"),
            argument.name.span,
          );
        message = true;
      } else if (name === "invalidMessage" || name === "invalidLlmInstruction") {
        this.#report(
          semanticCode.unknownNamedArgument,
          `askImage(${name}:) is not supported yet.`,
          argument.name.span,
        );
      } else if (!IMAGE_REQUEST_OPTIONS.has(name)) {
        this.#report(
          semanticCode.unknownNamedArgument,
          unknownNamedArgumentMessage("askImage", name, ["message", ...IMAGE_REQUEST_OPTIONS]),
          argument.name.span,
        );
      }
    }
  }

  /**
   * `showPopup` takes its message first, without a name or as `message:`, and an optional `buttonText:` (V30 §31). A
   * repeated name is reported with the other arguments.
   */
  #validateShowPopupArguments(parts: ShowPopupParts): void {
    this.#validateDistinctNamedArguments(parts);
    let message = false;
    for (const [index, argument] of parts.arguments.entries()) {
      if (argument.kind === "positionalArgument") {
        if (index > 0 || message)
          this.#report(
            semanticCode.argumentCount,
            leadingArgumentMessage(
              "showPopup",
              "its message",
              'showPopup("Task completed", buttonText: "Continue")',
            ),
            argument.span,
          );
        message = true;
        continue;
      }
      const name = argument.name.name;
      if (name === "message") {
        if (message)
          this.#report(
            semanticCode.argumentCount,
            leadingArgumentTwiceMessage("showPopup", "message"),
            argument.name.span,
          );
        message = true;
      } else if (name !== "buttonText") {
        this.#report(
          semanticCode.unknownNamedArgument,
          unknownNamedArgumentMessage("showPopup", name, ["message", "buttonText"]),
          argument.name.span,
        );
      }
    }
    if (!message)
      this.#report(
        semanticCode.missingNamedArgument,
        missingArgumentMessage(
          "showPopup",
          "a message",
          `Give it first, as in 'showPopup "Task completed"'.`,
        ),
        parts.span,
      );
  }

  /**
   * `openUrl` takes one web address without a name, first, and the optional `buttonText:` and `alwaysButton:` (V30
   * §33). A repeated name is reported with the other arguments.
   */
  #validateOpenUrlArguments(statement: OpenUrlStatement): void {
    this.#validateDistinctNamedArguments(statement);
    const addresses = statement.arguments.filter(
      (argument) => argument.kind === "positionalArgument",
    );
    const addressed =
      addresses.length === 1 && statement.arguments[0]?.kind === "positionalArgument";
    if (!addressed)
      this.#report(
        semanticCode.argumentCount,
        leadingArgumentMessage(
          "openUrl",
          "one web address",
          'openUrl("https://example.com", buttonText: "Open the page")',
        ),
        statement.span,
      );
    for (const argument of statement.arguments)
      if (
        argument.kind === "namedArgument" &&
        argument.name.name !== "buttonText" &&
        argument.name.name !== "alwaysButton" &&
        // A named address without a positional one is the error above.
        (addressed || argument.name.name !== "url")
      )
        this.#report(
          semanticCode.unknownNamedArgument,
          unknownNamedArgumentMessage("openUrl", argument.name.name, [
            "buttonText",
            "alwaysButton",
          ]),
          argument.name.span,
        );
  }

  /**
   * `exportText` takes one text without a name, first, and the optional `title:` and `fileName:` (V30 §31). A repeated
   * name is reported with the other arguments.
   */
  #validateExportTextArguments(statement: ExportTextStatement): void {
    this.#validateDistinctNamedArguments(statement);
    const texts = statement.arguments.filter((argument) => argument.kind === "positionalArgument");
    const given = texts.length === 1 && statement.arguments[0]?.kind === "positionalArgument";
    if (!given)
      this.#report(
        semanticCode.argumentCount,
        leadingArgumentMessage(
          "exportText",
          "one text",
          'exportText(report, title: "Your report")',
        ),
        statement.span,
      );
    for (const argument of statement.arguments)
      if (
        argument.kind === "namedArgument" &&
        argument.name.name !== "title" &&
        argument.name.name !== "fileName" &&
        // A named text without a positional one is the error above.
        (given || argument.name.name !== "text")
      )
        this.#report(
          semanticCode.unknownNamedArgument,
          unknownNamedArgumentMessage("exportText", argument.name.name, ["title", "fileName"]),
          argument.name.span,
        );
  }

  #validateDistinctNamedArguments(
    expression: Pick<Extract<Expression, { kind: "callExpression" }>, "arguments">,
  ): void {
    const names = new Set<string>();
    for (const argument of expression.arguments) {
      if (argument.kind !== "namedArgument") continue;
      if (names.has(argument.name.name))
        this.#report(
          semanticCode.duplicateNamedArgument,
          `Argument '${argument.name.name}' is given twice. Remove one of them.`,
          argument.name.span,
        );
      names.add(argument.name.name);
    }
  }

  #reportLaterParameterReferences(
    expression: Expression,
    laterNameCounts: ReadonlyMap<string, number>,
  ): void {
    visitExpression(expression, (identifier) => {
      if (!laterNameCounts.has(identifier.name)) return;
      this.#report(
        semanticCode.laterParameterDefault,
        `Default expression may not reference later parameter '${identifier.name}'.`,
        identifier.span,
      );
    });
  }

  #declare(
    name: string,
    kind: BindingKind,
    span: SourceSpan,
    scope: SemanticScope,
    declaration?: FunctionDeclaration,
  ): boolean {
    if (this.#protectedNames.has(name)) {
      this.#report(PROTECTED_NAME_CODE, protectedNameMessage(name, "other"), span);
      return false;
    }
    if (scope.declare(name, declaration === undefined ? { kind } : { kind, declaration }))
      return true;
    const project = scope.resolve(name)?.project;
    if (project !== undefined) {
      this.project.reportClash(
        name,
        {
          file: this.file,
          span,
          description:
            kind === "function"
              ? "function"
              : this.#functionDepth > 0
                ? "local variable"
                : "variable",
        },
        project,
      );
      return false;
    }
    this.#report(
      semanticCode.duplicateDeclaration,
      scope.isShared(name)
        ? `'${name}' already names a variable of the code that created this ${HANDLER_NAMES[this.#handlerOwner]}, which the block shares. Rename the block's variable.`
        : `Declaration '${name}' duplicates a visible name.`,
      span,
    );
    return false;
  }

  #recordRootAccess(name: string, binding: Binding | undefined, span: SourceSpan): void {
    if (
      this.#statement !== null &&
      binding?.kind === "variable" &&
      this.#root.bindings.get(name) === binding
    ) {
      this.#rootAccesses.push({ name, span, context: this.#context, statement: this.#statement });
    }
  }

  /**
   * The entries of transfers that can run: their statement runs by the type check's flow, in the file's top level, a
   * function that a call which can run reaches, or a block whose timer or media is started where code can run. Like a
   * goto, a transfer that cannot run enters nothing (ADR 0022 §3.4).
   */
  /** The node of the call graph that a context runs in, or `undefined` when a block's start cannot run. */
  #codeNode(start: FlowContext, flow: StatementFlow): string | undefined {
    let context = start;
    while (context.kind === "handler") {
      if (flow.unreachable.has(context.created)) return undefined;
      context = context.origin;
    }
    if (context.kind === "root") return `${this.file}:`;
    return this.#functions.get(context.name)?.global === true
      ? `global:${context.name}`
      : `${this.file}:${context.name}`;
  }

  /** The calls of author functions that can run, as edges between the code that calls and the function called. */
  callEdges(flow: StatementFlow): readonly (readonly [string, string])[] {
    return this.#callEdges.flatMap(({ callee, context, statement }) => {
      if (flow.unreachable.has(statement)) return [];
      const caller = this.#codeNode(context, flow);
      return caller === undefined ? [] : [[caller, callee] as const];
    });
  }

  /**
   * The entries of this file's transfers and script references whose code can run, given the code reachable in the
   * project, and those of its start values, which always run.
   */
  reachableEntries(flow: StatementFlow, reachable: ReadonlySet<string>): readonly FileEntry[] {
    return [
      ...this.#startEntries,
      ...this.#entries.flatMap(({ entry, context, statement }) => {
        const owner = this.#codeNode(context, flow);
        return !flow.unreachable.has(statement) && owner !== undefined && reachable.has(owner)
          ? [entry]
          : [];
      }),
    ];
  }

  /**
   * A goto can reach a label without running the top-level `let`s between the place it starts and the label. A use of
   * a variable of the file is an error when a goto can make it miss its `let`: it has a value on every way there
   * without gotos, but not on every way with them. A goto has run what came before the statement it stands in, or
   * before the call of its function or the start of its handler. Which statements run and continue is the flow of the
   * type check, so this check and the ending check agree. A file entered afresh at a label, by a `goto` or `call`
   * naming a file, a `call` of a label, or a fallback, has run nothing there. Other early uses, such as a function
   * called before the `let`, are checked when they run.
   */
  checkInitialization(
    program: Program,
    freshLabels: ReadonlySet<string>,
    flow: StatementFlow,
  ): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if ((this.#gotos.length === 0 && freshLabels.size === 0) || this.#rootAccesses.length === 0)
      return diagnostics;
    // Only the variables that are used need following.
    const used = new Set(this.#rootAccesses.map((access) => access.name));
    const withGotos = this.#initializedVariables(program, freshLabels, flow, used, true);
    const withoutGotos = this.#initializedVariables(program, freshLabels, flow, used, false);
    const reported = new Set<string>();
    for (const access of this.#rootAccesses) {
      if (flow.unreachable.has(access.statement)) continue;
      const known = withGotos(access.context);
      const knownWithoutGotos = withoutGotos(access.context);
      if (
        known === null ||
        known.has(access.name) ||
        (knownWithoutGotos !== null && !knownWithoutGotos.has(access.name))
      )
        continue;
      const key = `${access.span.start.offset}:${access.name}`;
      if (reported.has(key)) continue;
      reported.add(key);
      diagnostics.push(
        createDiagnostic(
          DiagnosticSeverity.Error,
          semanticCode.skippedInitialization,
          freshLabels.size === 0
            ? `A goto can reach this line without running 'let ${access.name}' first, so ${access.name} may have no value here. Move the label that the goto jumps to before 'let ${access.name}', or set ${access.name} on every way here.`
            : `This line can be reached without running 'let ${access.name}' first, through a goto, call, or fallback to a label after it, so ${access.name} may have no value here. Set ${access.name} after that label, or make it a global.`,
          access.span,
        ),
      );
    }
    return diagnostics;
  }

  /**
   * The top-level variables that have a value wherever code of a context runs, following gotos or not. `null` stands
   * for "every variable": no way there is known, so nothing is missing.
   */
  #initializedVariables(
    program: Program,
    freshLabels: ReadonlySet<string>,
    flow: StatementFlow,
    used: ReadonlySet<string>,
    followGotos: boolean,
  ): (context: FlowContext) => ReadonlySet<string> | null {
    type Known = ReadonlySet<string> | null;
    const statements = program.statements;
    const meet = (left: Known, right: Known): Known =>
      left === null
        ? right
        : right === null
          ? left
          : new Set([...left].filter((name) => right.has(name)));
    // Function declarations run nothing; the file starts at its first other statement.
    const order = statements.flatMap((statement, index) =>
      statement.kind === "functionDeclaration" ? [] : [index],
    );
    const before: Known[] = statements.map((_, index) => (index === order[0] ? new Set() : null));
    const after = (index: number): Known => {
      const known = before[index]!;
      const statement = statements[index]!;
      return known !== null &&
        statement.kind === "letStatement" &&
        used.has(statement.name.name) &&
        !known.has(statement.name.name)
        ? new Set([...known, statement.name.name])
        : known;
    };
    const functionStart = new Map<string, Known>();
    // A handler starts with what ran where it was created; handlers nest without limit, so this is a loop.
    const atContext = (start: FlowContext): Known => {
      let context = start;
      while (context.kind === "handler") {
        if (flow.unreachable.has(context.created)) return null;
        context = context.origin;
      }
      return context.kind === "root"
        ? before[context.statement]!
        : (functionStart.get(context.name) ?? null);
    };
    const calls = this.#calls.filter((call) => !flow.unreachable.has(call.statement));
    const gotos = this.#gotos.filter((goto) => !flow.unreachable.has(goto.statement));
    for (let changed = true; changed;) {
      changed = false;
      // A function starts with what every call of it has run; one never called adds nothing.
      for (let functionsChanged = true; functionsChanged;) {
        functionsChanged = false;
        const starts = new Map<string, Known>();
        for (const call of calls) {
          starts.set(
            call.name,
            starts.has(call.name)
              ? meet(starts.get(call.name)!, atContext(call.context))
              : atContext(call.context),
          );
        }
        for (const [name, known] of starts) {
          if (!sameKnown(functionStart.get(name) ?? null, known)) {
            functionStart.set(name, known);
            functionsChanged = true;
          }
        }
      }
      for (let position = 1; position < order.length; position += 1) {
        const index = order[position]!;
        const previous = order[position - 1]!;
        let known: Known = flow.continuing.has(statements[previous]!) ? after(previous) : null;
        const statement = statements[index]!;
        if (followGotos && statement.kind === "labelStatement") {
          if (freshLabels.has(statement.name.name)) known = new Set();
          for (const goto of gotos) {
            if (goto.label === statement.name.name) known = meet(known, atContext(goto.context));
          }
        }
        if (!sameKnown(before[index]!, known)) {
          before[index] = known;
          changed = true;
        }
      }
    }
    return atContext;
  }

  /**
   * Reports a name of the file used inside a global function, which can be called from any file and so sees only the
   * project's names (ADR 0022 §3). Returns whether it did.
   */
  #reportFileName(name: string, span: SourceSpan): boolean {
    const fn = this.#globalFunction;
    const binding = fn === null ? undefined : this.#root.resolve(name);
    if (fn === null || binding === undefined) return false;
    this.#report(
      semanticCode.fileName,
      binding.kind === "function"
        ? `Global function '${fn.name.name}' can be called from any file, so it can call only global functions and built-ins, not '${name}' of this file. Make '${name}' a global function.`
        : `Global function '${fn.name.name}' can be called from any file, so it cannot use '${name}' of this file. Make '${name}' a global, or pass it as a parameter.`,
      span,
    );
    return true;
  }

  /**
   * Validates a start value: a global's value at session start, or a speaker property. It runs before the story, so
   * it may use literals, the globals and speakers set up before it, host globals, operators, and `load` (ADR 0022 §6).
   * `contextualSpeaker` is a speaker's own name, which its properties may use.
   */
  #validateStartValue(
    value: Expression,
    scope: SemanticScope,
    owner: GlobalStatement | SpeakerDeclaration,
    contextualSpeaker: string | null,
  ): void {
    this.#startValue = true;
    this.#validateExpression(value, scope, contextualSpeaker);
    this.#startValue = false;
    const speaker = owner.kind === "speakerDeclaration";
    const order = this.project.order(owner);
    const work = [value];
    while (work.length > 0) {
      const expression = work.pop()!;
      switch (expression.kind) {
        case "interactionExpression":
        case "sayExpression":
        case "showButtonExpression":
        case "showPopupExpression":
        case "timerExpression":
        case "playMediaExpression":
        case "showCameraExpression":
        case "showPermanentButtonExpression":
          this.#report(
            semanticCode.invalidStartValue,
            startValueMessage(owner, { kind: "effect" }),
            expression.span,
            true,
          );
          continue;
        case "callExpression":
        case "tagQueryExpression":
          // A script reference is made without effects, like a literal; its arguments follow the same rules.
          if (
            expression.kind === "callExpression" &&
            expression.callee.kind === "identifier" &&
            expression.callee.name === "script"
          ) {
            for (const argument of expression.arguments) work.push(argument.value);
            continue;
          }
          this.#report(
            semanticCode.invalidStartValue,
            startValueMessage(owner, { kind: "call" }),
            expression.span,
            true,
          );
          continue;
        case "identifier": {
          if (expression.name === "speaker" && contextualSpeaker !== null) continue;
          const binding = scope.resolve(expression.name);
          if (binding === undefined || binding.kind === "global" || binding.kind === "function")
            continue;
          const used = binding.project;
          if (used === undefined) {
            const value =
              owner.kind === "globalStatement" ? unwrapParentheses(owner.initial) : null;
            this.#report(
              semanticCode.invalidStartValue,
              startValueMessage(owner, {
                kind: "local",
                name: expression.name,
                assigned: value?.kind === "identifier" ? value.name : "...",
              }),
              expression.span,
              true,
            );
          } else if (
            used.order !== null &&
            (used.order > order || (used.order === order && !speaker))
          ) {
            this.#report(
              semanticCode.invalidStartValue,
              startValueMessage(
                owner,
                used.order === order
                  ? { kind: "itself" }
                  : { kind: "later", name: expression.name },
              ),
              expression.span,
              true,
            );
          }
          continue;
        }
        default:
          for (const child of expressionChildren(expression)) work.push(child);
      }
    }
  }

  #validateSpeakerReference(name: string, span: SourceSpan, scope: SemanticScope): boolean {
    if (scope.resolve(name)?.kind === "speaker") return true;
    this.#report(semanticCode.unknownSpeaker, `Unknown speaker '${name}'.`, span);
    return false;
  }

  #report(code: NamePassCode, message: string, span: SourceSpan, checkable = false): void {
    this.project.report(this.file, code, message, span, checkable);
  }
}

/** The text of a string literal without interpolation, looking through parentheses. */
function literalText(expression: Expression): string | undefined {
  const literal = unwrapParentheses(expression);
  if (literal.kind !== "stringLiteral") return undefined;
  let text = "";
  for (const part of literal.parts) {
    if (part.kind !== "stringText") return undefined;
    text += part.value;
  }
  return text;
}

/**
 * The first interaction, media playback, or camera capture in a parameter default, which cannot pause a default's
 * evaluation.
 */
function findFirstInteraction(
  expression: Expression,
): Extract<
  Expression,
  {
    kind:
      | "interactionExpression"
      | "showButtonExpression"
      | "showPopupExpression"
      | "playMediaExpression"
      | "showCameraExpression"
      | "sayExpression"
      | "callExpression";
  }
> | null {
  const work = [expression];
  while (work.length) {
    const current = work.pop()!;
    if (
      current.kind === "interactionExpression" ||
      current.kind === "showButtonExpression" ||
      current.kind === "showPopupExpression" ||
      current.kind === "playMediaExpression" ||
      current.kind === "showCameraExpression" ||
      current.kind === "sayExpression" ||
      (current.kind === "callExpression" &&
        (isTakePhotoCall(current) || isAskImageCall(current) || isLockCall(current)))
    )
      return current;
    const children = expressionChildren(current);
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
  }
  return null;
}

/** Whether `expression` is a name list of the account, as `account.petNames`. */
function isAccountList(expression: Expression): boolean {
  const node = unwrapParentheses(expression);
  return (
    node.kind === "propertyAccessExpression" &&
    isAccount(node.object) &&
    SPEAKER_NAME_LISTS.has(node.property.name)
  );
}

/** Whether `expression` is the protected `account`, which no binding can have as its name. */
function isAccount(expression: Expression): boolean {
  const node = unwrapParentheses(expression);
  return node.kind === "identifier" && node.name === "account";
}

function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

/** What `speaker` is where a speaker is current, or what `debugMode` is: names that are values without a binding. */
function unboundValue(name: string, contextualSpeaker: string | null): string | null {
  if (name === "speaker" && contextualSpeaker !== null) return "the current speaker";
  return name === "debugMode" ? "a read-only value" : null;
}

function visitExpression(
  expression: Expression,
  visitor: (identifier: Extract<Expression, { kind: "identifier" }>) => void,
): void {
  const work = [expression];
  while (work.length) {
    const current = work.pop()!;
    if (current.kind === "identifier") visitor(current);
    const children =
      current.kind === "sayExpression"
        ? [...(current.speaker === null ? [] : [current.speaker]), ...sayOperands(current)]
        : current.kind === "interactionExpression"
          ? [...(current.speaker === null ? [] : [current.speaker]), ...askParts(current)]
          : current.kind === "showButtonExpression"
            ? [
                ...(current.speaker === null ? [] : [current.speaker]),
                current.label,
                ...showButtonOptions(current).map((option) => option.value),
              ]
            : expressionChildren(current);
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
  }
}

function sameKnown(left: ReadonlySet<string> | null, right: ReadonlySet<string> | null): boolean {
  if (left === null || right === null) return left === right;
  return left.size === right.size && [...left].every((name) => right.has(name));
}
