import { withCounterLoops } from "./counter-loops.ts";
import { withSwitchLadders } from "./switch-ladders.ts";
import {
  constantString,
  groovyParameters,
  isAstNode,
  isRecord,
  variableName,
  walkAst,
  type AstNode,
  type ParsedGroovyFile,
  type SourceComment,
  type SourceSpan,
} from "./ast.ts";
import { rootDiagnostics } from "./diagnostics.ts";
import {
  ACTION_DISPATCHER,
  ACTION_DISPATCHER_MARKER,
  helperCall,
  allHelperStatements,
  helperStatements,
  SECRET_PARAMETER_PARTS,
  SYSTEM_SPEAKER,
  withActionDispatcher,
  withDispatcherResultTypes,
  type HelperName,
} from "./helpers.ts";
import {
  javaAssignment,
  javaBinary,
  javaCallStatement,
  javaConstructor,
  javaDataStatements,
  javaDeclaration,
  javaFileState,
  javaMethodCall,
  javaProperty,
  viewedText,
  type JavaFileState,
  type JavaRuleHost,
  type PackageResources,
} from "./java-data.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
import {
  withAskQuestions,
  withNestedBlocks,
  withoutBlankText,
  withoutRepeatedText,
} from "./repeated-text.ts";
import { withParagraphPicks } from "./paragraph-picks.ts";
import { withParagraphs } from "./paragraphs.ts";
import { withoutCutReadingTimes, withReadingTimes } from "./reading-time.ts";
import { withElapsedDurations } from "./elapsed-time.ts";
import { withMessageHandles } from "./message-handles.ts";
import { withParsedLoads } from "./parsed-loads.ts";
import { withFillableLoads, withStorageDefaults } from "./storage-keys.ts";
import {
  enforceVariableTypes,
  functionResultTypes,
  mapChildren,
  mapOwnExpressions,
  withReturnTypes,
  type TeaseType,
} from "./variable-types.ts";
import { pathTag } from "./image-tags.ts";
import { fontSize, legacyHtmlToMarkup, type TextPart } from "./markup.ts";
import { javaReplacementText, parseRegexSubset, parseTailPattern } from "./regex-subset.ts";
import type { AcceptedForm, MediaFile } from "./workarounds.ts";
import { SEXSCRIPT_API_METHODS } from "./sexscript-api.ts";
import { menuIndexes } from "./menu-indexes.ts";
import {
  BOOLEAN,
  inferType,
  inferVariableTypes,
  LIST,
  NULL,
  NUMBER,
  OBJECT,
  onlyOf,
  STRING,
  type TypeEnvironment,
  type ValueType,
  type VariableBindings,
  UNKNOWN,
} from "./types.ts";
import type {
  MixinModuleInfo,
  IrExpression,
  IrListChoiceOption,
  IrFunctionParameter,
  IrStatement,
  IrSwitchCase,
  LegacyMetadata,
  MigrationDiagnostic,
  MigrationProgram,
} from "./ir.ts";

interface ClosureInfo {
  implicitParameter: boolean;
  minArgs: number;
  maxArgs: number;
  /** Declared in a block of the script, such as an `if` body, and lifted to the top as a script function. */
  nested?: boolean;
}

export interface HelperFunctionInfo {
  /**
   * The arguments up to the last parameter without a default; a default before it stays out of the function, since
   * TeaseScript defaults come last, so a call that leaves such a parameter out needs migration.
   */
  minArgs: number;
  /** The parameters without a default, which Groovy required. */
  requiredArgs: number;
  maxArgs: number;
  stripsMain: boolean;
}

export type HelperRegistry = ReadonlyMap<string, ReadonlyMap<string, HelperFunctionInfo>>;

export interface LowerOptions {
  helperRegistry?: HelperRegistry;
  /** Keeps a text with blank lines as one message instead of one per paragraph (withParagraphs), for a whole unit. */
  keepParagraphs?: boolean;
  /** Functions defined anywhere in the package, such as runtime-loaded mixin methods. */
  packageFunctions?: ReadonlySet<string>;
  /** Runtime-loaded mixin modules of the package. */
  mixinModules?: readonly MixinModuleInfo[];
  /** Names assigned exactly once in the whole package, which no side effect can change afterwards. */
  stableNames?: ReadonlySet<string>;
  /**
   * The literal values the package stores under each storage key, for keys that only ever receive literals
   * (packageStorageLiterals); a branch for any other value of such a key never runs.
   */
  storageLiterals?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The storage keys under which the package saves a number or a boolean (packageNonTextKeys), as key shapes. */
  nonTextKeys?: ReadonlySet<string>;
  /** The storage keys under which the package saves a number or a text (packageNonBooleanKeys), as key shapes. */
  nonBooleanKeys?: ReadonlySet<string>;
  /** Image paths below `images/` that some script of the package copies a photo to (packageCopiedImages). */
  copiedImages?: ReadonlySet<string>;
  /** Value types of package globals defined in other files, such as anonymous-object fields. */
  globalTypes?: ReadonlyMap<string, number>;
  /** Functions whose result some caller uses (packageResultUses); without package context, the file decides. */
  resultUses?: ReadonlySet<string>;
  /** Source names of the package files in each directory, to check that a module loader's directory is complete. */
  directoryFiles?: ReadonlyMap<string, readonly string[]>;
  /**
   * The TeaseScript path of each script of a package (packageScriptPaths), keyed by its legacy name: the path from the
   * package root without `.groovy`, in lower case. Without it, a script name keeps its path.
   */
  scriptPaths?: ReadonlyMap<string, string>;
  /**
   * Rename identifiers TeaseScript rejects (default). Package composition disables this per file and renames
   * the composed program once.
   */
  renameIdentifiers?: boolean;
  /** Accepted forms to emit instead of their workarounds in implemented TeaseScript (workarounds.ts). */
  accepted?: ReadonlySet<AcceptedForm>;
  /** The package's images, which a legacy image count reads at conversion time. */
  media?: readonly MediaFile[];
  /** Every file of the package's legacy data folder, relative to it, which a file existence test reads. */
  files?: readonly string[];
  /** How the script and the modules it loads use their maps (packageMapUses); without it, the file decides. */
  mapUses?: MapUses;
  /** Legacy result types of the functions of the script and its modules (packageFunctionResults). */
  functionResults?: ReadonlyMap<string, number>;
  /** The package's files that package text reads snapshot, and the paths its scripts write (java-data.ts). */
  javaResources?: PackageResources;
}

interface LowerContext {
  diagnostics: MigrationDiagnostic[];
  metadata: LegacyMetadata | null;
  functions: Map<string, ClosureInfo>;
  types: TypeEnvironment;
  /**
   * Statements that must run immediately before the statement being lowered, such as the `say` that shows a
   * legacy input prompt before a compact TeaseScript input expression.
   */
  prelude: IrStatement[];
  /** The Groovy statement being lowered; prelude statements run immediately before it. */
  statementRoot: AstNode | null;
  /**
   * Statements that must run immediately after the statement being lowered, such as the increment of `i++` used as
   * a value. Only a statement lowered directly from a statement list (`postludeRoot`) may add them.
   */
  postlude: IrStatement[];
  postludeRoot: AstNode | null;
  /** Variable nodes that refer to a local variable sharing its name with a closure function. */
  shadowingReferences: ReadonlySet<AstNode>;
  classLoaderVariables: Set<string>;
  legacyHelperClasses: Map<string, string>;
  helperFunctions: Map<string, HelperFunctionInfo>;
  helperMainParameter: string | null;
  packageHelperRegistry: HelperRegistry;
  syntheticHelpers: Set<HelperName>;
  functionDepth: number;
  comments: CommentQueue;
  /** Legacy source lines used to preserve code that needs manual migration. */
  sourceLines: string[];
  /** Diagnostics already rendered as inline notes in the generated output. */
  renderedDiagnostics: Set<MigrationDiagnostic>;
  packageFunctions: ReadonlySet<string>;
  stableNames: ReadonlySet<string>;
  storageLiterals: ReadonlyMap<string, ReadonlySet<string>>;
  nonTextKeys: ReadonlySet<string>;
  nonBooleanKeys: ReadonlySet<string>;
  copiedImages: ReadonlySet<string>;
  /** Set while lowering a branch that never runs because no code stores the value it tests. */
  unreachable: boolean;
  mixinModules: readonly MixinModuleInfo[];
  /** Module directories whose loader this script replaced with direct module calls. */
  loadsModuleDirectories: Set<string>;
  /** Function lowered right now and its parameter/local names, for closure naming and capture checks. */
  currentFunction: {
    name: string;
    locals: ReadonlySet<string>;
    /** The body and parameters, for the names visible at a given point. */
    body?: AstNode;
    parameters?: readonly string[];
  } | null;
  /** Functions generated from closure values, emitted at the program root. */
  closureFunctions: IrStatement[];
  /** Functions referenced by closure-value action IDs; the package dispatcher calls them. */
  actions: Set<string>;
  /** Counter for variables that keep an input result the legacy statement ignored. */
  ignoredInputs: number;
  /** Counter for temporaries that hold a switch value evaluated once for an if chain. */
  switchValues: number;
  /** Counter for variables that keep the start time of a popup whose waiting time is used. */
  popupTimers: number;
  /** Names of generated variables, kept apart from each other and from authored variables. */
  generatedNames: Set<string>;
  resultUses: ReadonlySet<string>;
  directoryFiles: ReadonlyMap<string, readonly string[]>;
  scriptPaths: ReadonlyMap<string, string> | null;
  /** Variables assigned once with the current date (`new Date()`, `Calendar.getInstance()`). */
  dateValues: ReadonlySet<string>;
  /** List variables that Groovy shared with another variable by an assignment of one to the other. */
  aliasedLists: ReadonlySet<string>;
  /** Bindings of closure parameters and loop variables (parameterBindings). */
  parameterBindings: ReadonlySet<string>;
  /** The values each binding is assigned (assignedValues). */
  assignedValues: ReadonlyMap<string, readonly AstNode[]>;
  /** The values each binding is updated to by `+=`, `-=`, `*=`, and `/=` (compoundValues). */
  compoundValues: ReadonlyMap<string, readonly AstNode[]>;
  /** Bindings declared with a value, and those something else may change too (declaredWrites). */
  declaredWrites: DeclaredWrites;
  /** List reads by a menu position that are certainly in range (menu-indexes.ts). */
  menuIndexes: ReadonlySet<AstNode>;
  /** Lists whose elements the code compares with null (nullElementLists), by binding. */
  nullElementLists: ReadonlySet<string>;
  /** Set while a getBooleans whose null result the next statement tests is lowered (cancelledBooleans). */
  cancelBooleans?: true;
  /** How the maps are used, by binding: dicts (#536), object fields, value and key types. */
  mapUses: MapUses;
  /** Binding keys of variables that closures declare (bindingKeys). */
  bindings: BindingKeys;
  /** Bindings declared with a Groovy integer type (`int`, `long`, ...), which store whole numbers. */
  integerVariables: ReadonlySet<string>;
  /** Variables holding a Java array of whole numbers (`new Integer[n]`), whose element stores truncate. */
  integerArrays: ReadonlySet<string>;
  /** Bindings declared with the Groovy type String, which converted every value stored in them to text. */
  textVariables: ReadonlySet<string>;
  /**
   * The reads of a folder walk's loop variable, by node and by source position, with whether it holds the package
   * path of a file or of a subfolder (imageFolderWalk, listedFolderWalk).
   */
  walkedEntries: Map<AstNode | string, "file" | "folder">;
  /** Variables that a path cannot be read from at conversion time: updated in place, parameters, loop variables. */
  changingPaths: ReadonlySet<string>;
  /**
   * The binding keys and assigned values a path is read with (resolvedPath), where they differ from `bindings` and
   * `assignedValues`: a helper method keeps those by name, its paths by binding.
   */
  pathBindings?: { keys: BindingKeys; values: ReadonlyMap<string, readonly AstNode[]> };
  /** Initializers of variables assigned once, by their declaration (staticNumber). */
  constantInitializers: ReadonlyMap<string, AstNode>;
  /** Dict keys known present where the lowering is (presenceFact), from surrounding tests. */
  knownKeys: string[];
  /** Assignment targets being lowered, which are written rather than read. */
  writeTargets: Set<AstNode>;
  /** Java split() calls whose parts are read at a fixed position, `text.split(",")[1]`, which keep TeaseScript split(). */
  indexedSplits: Set<AstNode>;
  accepted: ReadonlySet<AcceptedForm>;
  /**
   * `items -= item` and `items = items - item` inside `for (item in items)`: the loop's element leaves the collection it
   * iterates, so `items` is a list even where nothing else proves it, such as a parameter (elementRemovals).
   */
  elementRemovals: ReadonlySet<AstNode>;
  /** Null without the package's images. */
  media: readonly MediaFile[] | null;
  /** The package's files as `packageFilePath` normalizes them; null without them. */
  files: ReadonlySet<string> | null;
  /** The package's files as they are named, relative to the legacy data folder. */
  actualFiles: readonly string[];
  /** `new File(path)` values that only `.exists()` or `.listFiles()` reads, which convert to their path (fileTests). */
  fileValues: ReadonlySet<AstNode>;
  /** Variables that hold such a path. */
  fileVariables: ReadonlySet<string>;
  /** The variable each such value is kept in. */
  filePathOwners: ReadonlyMap<AstNode, string>;
  /** Variables that hold a photo the script took (getImage, getFile, receiveImage). */
  photoVariables: ReadonlySet<string>;
  /**
   * Whether a read of a name nothing assigns is reported. Only with package context: a file converted alone, such
   * as a mixin module, reads names that other package files define.
   */
  checksUndefinedVariables: boolean;
  /** Java and data API rules of the body (java-data.ts). */
  java: JavaFileState;
}

/** Source comments not yet emitted; shared by every context lowering the same file. */
interface CommentQueue {
  items: SourceComment[];
  next: number;
}

const JAVA_REFLECTION_METHODS = new Set([
  "getConstructor",
  "getDeclaredConstructor",
  "getDeclaredField",
  "getDeclaredMethod",
  "getField",
  "getMethod",
  "invoke",
  "newInstance",
]);

const TYPED_STORAGE_LOADS = new Set(["loadBoolean", "loadFloat", "loadInteger", "loadString"]);

/** Reads of the legacy online service, which kept values on a server for every player and session. */
const ONLINE_LOADS = new Set(["receive", "receiveBoolean", "receiveInteger", "receiveString"]);
const TYPED_ONLINE_LOADS = new Set(["receiveBoolean", "receiveInteger", "receiveString"]);

const ONLINE_STORAGE_NOTE =
  "The legacy online service kept this value on a server, shared by the script's players and sessions; it is kept in the package's storage here (owner decision 2026-10-05), so only this player's sessions share it.";

/** The storage key prefix under which a sent photo reference is kept, by its code (sendImage). */
const SENT_IMAGE_PREFIX = "sexscript.image.";

const DIRECT_STORAGE_LOADS = new Set([
  "load",
  "loadBoolean",
  "loadFloat",
  "loadInteger",
  "loadString",
]);

export function buildHelperRegistry(files: readonly ParsedGroovyFile[]): HelperRegistry {
  const registry = new Map<string, ReadonlyMap<string, HelperFunctionInfo>>();
  for (const file of files) {
    const root = file.root;
    if (root?.kind !== "compilationUnit") continue;
    for (const helperClass of nodeArray(root.classes)) {
      const className = text(helperClass.name);
      if (helperClass.kind !== "class" || className === null) continue;
      registry.set(
        className,
        collectHelperFunctionInfo(nodeArray(withScriptObject(helperClass).methods)),
      );
    }
  }
  return registry;
}

/** Legacy input calls that show a question first (pushPrompt). */
const PROMPTING_CALLS = new Set([
  "getBoolean",
  "getFloat",
  "getInteger",
  "getSelectedValue",
  "getString",
  "getFile",
  "getImage",
]);

/**
 * A file whose `while` conditions ask inside `&&`, `||`, or `?:`, as in `while (name == null ||
 * !getBoolean("Good?"))`, rewritten so each question comes at its own moment: the condition is computed into a
 * variable step by step, asking only where Groovy's short circuit reached the input, and a loop tests it at its top.
 * Other files are returned as they are.
 */
export function withGuardedInputs(file: ParsedGroovyFile): ParsedGroovyFile {
  const body = asNode(file.root?.body);
  if (file.root === null || body === null) return file;
  let found = false;
  walkAst(body, (node) => {
    if (node.kind === "while" && hasGuardedInput(asNode(node.condition))) found = true;
  });
  if (!found) return file;
  const taken = new Set<string>();
  walkAst(body, (node) => {
    const name = variableName(node);
    if (name !== null) taken.add(name);
  });
  const fresh = (): string => {
    let name = "answered";
    for (let suffix = 2; taken.has(name); suffix += 1) name = `answered${suffix}`;
    taken.add(name);
    return name;
  };
  const copy: AstNode = structuredClone(body);
  rewriteGuardedInputs(copy, fresh);
  return { ...file, root: { ...file.root, body: copy } };
}

/** Whether an input call sits where Groovy's `&&`, `||`, or `?:` decides whether it runs. */
function hasGuardedInput(condition: AstNode | null): boolean {
  if (condition === null) return false;
  let guarded = false;
  const visit = (node: AstNode, inGuard: boolean): void => {
    if (node.kind === "closure") return;
    if (inGuard && isPromptingCall(node)) guarded = true;
    if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
      const left = asNode(node.left);
      const right = asNode(node.right);
      if (left !== null) visit(left, inGuard);
      if (right !== null) visit(right, true);
      return;
    }
    if (node.kind === "ternary" || node.kind === "elvis") {
      for (const [key, child] of Object.entries(node))
        if (isAstNode(child)) visit(child, inGuard || (key !== "condition" && key !== "boolean"));
      return;
    }
    for (const child of nodeChildren(node)) visit(child, inGuard);
  };
  visit(condition, false);
  return guarded;
}

function isPromptingCall(node: AstNode): boolean {
  const name = node.kind === "methodCall" ? constantString(node.method) : null;
  const receiver = asNode(node.object);
  return (
    name !== null &&
    PROMPTING_CALLS.has(name) &&
    (node.implicitThis === true || variableName(receiver) === "this")
  );
}

/** Rewrites the statements of every block below `node` (withGuardedInputs). */
function rewriteGuardedInputs(node: AstNode, fresh: () => string): void {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (!isAstNode(item)) continue;
        rewriteGuardedInputs(item, fresh);
        const replaced = guardedStatement(item, fresh);
        if (replaced !== null) {
          value.splice(index, 1, ...replaced);
          index += replaced.length - 1;
        }
      }
    } else if (isAstNode(value)) rewriteGuardedInputs(value, fresh);
  }
}

/** A `while` or `if` statement whose condition asks inside a short circuit, rewritten (withGuardedInputs). */
function guardedStatement(statement: AstNode, fresh: () => string): AstNode[] | null {
  const condition = asNode(statement.condition);
  // An if statement's condition already computes a guarded question first (the deferred conditional).
  if (statement.kind !== "while" || !hasGuardedInput(condition)) return null;
  const span = statement.span ?? null;
  const answer = fresh();
  const variable = (): AstNode => ({ kind: "variable", span, name: answer });
  const steps = [
    {
      kind: "expressionStatement",
      span,
      expression: {
        kind: "declaration",
        span,
        multipleAssignment: false,
        left: variable(),
        right: { kind: "constant", span, value: false },
      },
    },
    ...conditionSteps(condition!, variable, span),
  ];
  const body = asNode(statement.body);
  const inner = body?.kind === "block" ? nodeArray(body.statements) : body === null ? [] : [body];
  return [
    {
      ...statement,
      condition: { kind: "constant", span, value: true },
      body: {
        kind: "block",
        span,
        statements: [
          ...steps,
          {
            kind: "if",
            span,
            condition: { kind: "not", span, value: variable() },
            then: { kind: "block", span, statements: [{ kind: "break", span, label: null }] },
            else: { kind: "empty", span },
          },
          ...inner,
        ],
      },
    },
  ];
}

/** Statements that compute a condition into the answer variable, asking only where the short circuit reaches. */
function conditionSteps(
  condition: AstNode,
  variable: () => AstNode,
  span: SourceSpan | null,
): AstNode[] {
  const assign = (value: AstNode): AstNode => ({
    kind: "expressionStatement",
    span,
    expression: { kind: "binary", span, operator: "=", left: variable(), right: value },
  });
  const branch = (test: AstNode, then: AstNode[], otherwise: AstNode[]): AstNode => ({
    kind: "if",
    span,
    condition: test,
    then: { kind: "block", span, statements: then },
    else: { kind: "block", span, statements: otherwise },
  });
  if (!hasGuardedInput(condition)) return [assign(condition)];
  const left = asNode(condition.left);
  const right = asNode(condition.right);
  if (
    condition.kind === "binary" &&
    (condition.operator === "||" || condition.operator === "&&") &&
    left !== null &&
    right !== null
  ) {
    const or = condition.operator === "||";
    const decided = assign({ kind: "constant", span, value: or });
    // A left side without a question is tested where it stands, so a null test still narrows the right side.
    if (!hasGuardedInput(left))
      return [
        or
          ? branch(left, [decided], conditionSteps(right, variable, span))
          : branch(left, conditionSteps(right, variable, span), [decided]),
      ];
    return [
      ...conditionSteps(left, variable, span),
      branch(
        or ? { kind: "not", span, value: variable() } : variable(),
        conditionSteps(right, variable, span),
        [],
      ),
    ];
  }
  const inner = asNode(condition.value);
  if (condition.kind === "not" && inner !== null)
    return [
      ...conditionSteps(inner, variable, span),
      assign({ kind: "not", span, value: variable() }),
    ];
  return [assign(condition)];
}

export function lowerParsedFiles(files: readonly ParsedGroovyFile[]): MigrationProgram[] {
  const helperRegistry = buildHelperRegistry(files);
  return files.map((file) => lowerParsedFile(file, { helperRegistry }));
}

/** How a script and the mixin modules it loads use their maps, by binding (see `bindingKeys`). */
export interface MapUses {
  /** Maps used as lookup tables, which become dicts (#536). */
  dictionaries: Set<string>;
  /** Fields used on maps that stay objects, which their literals declare (null when Groovy added them later). */
  recordFields: Map<string, string[]>;
  /** Legacy types of the values each dict holds. */
  dictionaryValues: Map<string, number>;
  /** Legacy types of the elements of each dict's list values. */
  dictionaryElements: Map<string, number>;
  /** Dicts that a write may give null: a null value, or a value of unknown type. */
  nullableValues: Set<string>;
  /** Legacy types of the keys each dict is built, looked up, or changed with. */
  dictionaryKeys: Map<string, number>;
  /** Keys every value of a dict holds: the literal keys of every map assigned to it that nothing removes. */
  presentKeys: Map<string, Set<string>>;
  /** Maps that stay objects and that `clear()` empties, so that every field may hold null. */
  clearedRecords: Set<string>;
  /**
   * Variables the code tests for null itself: compared with `== null` or `!= null`, read with `?.`, or switched on with
   * a `case null`, where null and an empty list behave differently. Groovy truth treats them alike.
   */
  nullTested: Set<string>;
  /**
   * Variables a text can show before their first assignment: shown inside a function, which may run first, or at the
   * top level before the top level assigns them.
   */
  shownEarly: Set<string>;
  /** Numbers that start as null and that nothing tests for null, which start at 0 (owner decision 2026-10-05). */
  zeroStartNumbers: Set<string>;
  /**
   * Texts and flags that start as null and that nothing tests for null or passes on, which start with the empty text or
   * false (owner decision 2026-10-08).
   */
  emptyStarts: Map<string, "" | false>;
}

/** One analysed body: a script, an object script with its members, or a mixin module. */
interface MapBody {
  body: AstNode;
  types: TypeEnvironment;
  keys: BindingKeys;
}

/**
 * How a script and the mixin modules it loads use their maps, which modules reach by name: a map that one file uses
 * as a lookup table is a dict in all of them (#536), and the other maps declare every field any file uses.
 */
export function packageMapUses(
  files: readonly ParsedGroovyFile[],
  functionResults: ReadonlyMap<string, number> = new Map(),
): MapUses {
  const globalTypes = packageGlobalTypes(files);
  const functions = packageFunctionNames(files);
  return mapUsesOf(
    files.flatMap((file) => {
      const body = mapAnalysisBody(file);
      if (body === null) return [];
      // A closure's own variables keep their own types, apart from other variables of the same name.
      const keys = bindingKeys(body, file.sourceName);
      const types = withGlobalTypes(
        inferVariableTypes(
          body,
          [],
          functions,
          functionResults,
          variableBindings(keys, file.sourceName),
        ),
        globalTypes,
      );
      return [{ body, types, keys }];
    }),
  );
}

/**
 * The legacy result types of the functions a script and the mixin modules it loads define, which calls in any of
 * them produce; later rounds let results that call functions of another file settle.
 */
export function packageFunctionResults(files: readonly ParsedGroovyFile[]): Map<string, number> {
  const functions = packageFunctionNames(files);
  const bodies = files.flatMap((file) => mapAnalysisBody(file) ?? []);
  let results = new Map<string, number>();
  for (let round = 0; round < 4; round += 1) {
    const next = new Map<string, number>();
    for (const body of bodies) {
      const own = inferVariableTypes(body, [], functions, results).functionResults ?? new Map();
      for (const [name, type] of own) next.set(name, (next.get(name) ?? 0) | type);
    }
    const settled =
      next.size === results.size && [...next].every(([name, type]) => results.get(name) === type);
    results = next;
    if (settled) break;
  }
  return results;
}

/**
 * Functions (closures kept in a variable, and object script methods) that no legacy code of the package names outside
 * their own body, as a call, a value, or a property. None when a call computes its method name, since such a call
 * could reach any function.
 */
export function legacyUnreferencedFunctions(files: readonly ParsedGroovyFile[]): Set<string> {
  const defined = new Set<string>();
  const referenced = new Set<string>();
  let dynamicCalls = false;
  const visit = (node: AstNode, owner: string | null): void => {
    if (node.kind === "declaration" && asNode(node.right)?.kind === "closure") {
      const name = variableName(node.left);
      if (name !== null) defined.add(name);
      visit(asNode(node.right)!, name ?? owner);
      return;
    }
    const names: Array<string | null> = [];
    if (node.kind === "variable") names.push(variableName(node));
    if (node.kind === "methodCall") {
      if (constantString(node.method) === null) dynamicCalls = true;
      names.push(constantString(node.method));
    }
    if (node.kind === "property") names.push(constantString(node.property));
    if (node.kind === "constant" && typeof node.value === "string") names.push(node.value);
    for (const name of names) if (name !== null && name !== owner) referenced.add(name);
    for (const child of nodeChildren(node)) visit(child, owner);
  };
  for (const file of files) {
    const body = mapAnalysisBody(file);
    if (body !== null) visit(body, null);
  }
  return dynamicCalls ? new Set() : new Set([...defined].filter((name) => !referenced.has(name)));
}

/** The body the lowering converts: a mixin module's or object script's desugared form, else the script body. */
function mapAnalysisBody(file: ParsedGroovyFile): AstNode | null {
  const rawBody = asNode(file.root?.body);
  if (rawBody === null || file.root?.kind !== "scriptBody") return null;
  const module = desugarMixinModule(rawBody, file.sourceName);
  if (module !== null) return module.body;
  const parts = objectScriptParts(rawBody, nodeArray(file.root.classes));
  return parts === null
    ? rawBody
    : { ...rawBody, statements: [...parts.statements, ...parts.members, ...parts.entryStatements] };
}

/** Legacy API calls that only show their arguments or ask the player with them. */
const SHOWING_API_CALLS = new Set([
  "show",
  "showButton",
  "showPopup",
  "getBoolean",
  "getBooleans",
  "getFloat",
  "getInteger",
  "getSelectedValue",
  "getString",
]);

/**
 * The variables whose value the code passes on or tells from an empty one: copies it into another variable or a
 * collection, passes it to a function or a method, also as a parameter's default, returns it, compares it with a value
 * that may be empty (`== ""`, `== other`), switches on it with such a case, or sets it to null again. A legacy API call
 * that only shows the value or asks the player with it does not pass it on, and neither does a comparison with a text
 * that is not empty, a number, or true, where null and the empty value give the same result.
 */
function passedOnValues(body: AstNode, keys: BindingKeys, types: TypeEnvironment): Set<string> {
  const passed = new Set<string>();
  const pass = (value: AstNode | null): void => {
    // A choice or a conversion passes on the value it gives; `value ?: other` gives `value` only when it is set.
    if (value?.kind === "ternary")
      for (const branch of [value.true, value.false]) pass(asNode(branch));
    if (value?.kind === "elvis") pass(asNode(value.false));
    if (value?.kind === "cast") pass(asNode(value.value));
    const key = value?.kind === "variable" ? bindingKey(value, keys) : null;
    if (key !== null) passed.add(key);
  };
  // The expressions a block ends with, which a closure or method gives as its result.
  const passResult = (statement: AstNode | null): void => {
    if (statement?.kind === "expressionStatement") pass(asNode(statement.expression));
    if (statement?.kind === "block") passResult(nodeArray(statement.statements).at(-1) ?? null);
    if (statement?.kind === "if") {
      passResult(asNode(statement.then));
      passResult(asNode(statement.else));
    }
  };
  // A constant that equals neither null nor the empty text or false.
  const distinct = (node: AstNode | null): boolean => {
    const value = node?.kind === "constant" ? node.value : undefined;
    return (
      (typeof value === "string" && value !== "") || typeof value === "number" || value === true
    );
  };
  walkAst(body, (node) => {
    if (
      node.kind === "binary" &&
      ["==", "!=", "in", "<", ">", "<=", ">=", "<=>"].includes(String(node.operator))
    ) {
      // An ordering puts null before any value, also a number, which the empty text is not.
      const ordering = !["==", "!=", "in"].includes(String(node.operator));
      const apart = (side: AstNode | null): boolean =>
        ordering
          ? side?.kind === "constant" && typeof side.value === "string" && side.value !== ""
          : distinct(side);
      const left = asNode(node.left);
      const right = asNode(node.right);
      if (!apart(right)) pass(left);
      if (!apart(left)) pass(right);
    }
    // `value.equals(other)` and its kin tell null from an empty value as `==` does.
    if (
      node.kind === "methodCall" &&
      ["equals", "equalsIgnoreCase", "compareTo", "compareToIgnoreCase"].includes(
        constantString(node.method) ?? "",
      ) &&
      !nodeArray(asNode(node.arguments)?.items).every((argument) => distinct(argument))
    )
      pass(asNode(node.object));
    if (
      node.kind === "switch" &&
      !nodeArray(node.cases).every((item) => distinct(asNode(item.expression)))
    )
      pass(asNode(node.expression));
    if (node.kind === "closure")
      for (const parameter of groovyParameters(node.parameters) ?? [])
        if (parameter.defaultValue !== null)
          walkAst(parameter.defaultValue, (child) => {
            if (child.kind === "variable") pass(child);
          });
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    if (assigns) {
      const right = asNode(node.right);
      pass(right);
      // A variable set to null again holds null after its start.
      const key =
        node.kind === "binary" && isNullConstant(right ?? undefined)
          ? bindingKey(asNode(node.left), keys)
          : null;
      if (key !== null) passed.add(key);
    }
    if (node.kind === "binary" && node.operator === "<<") pass(asNode(node.right));
    if (node.kind === "return") pass(asNode(node.value));
    if (node.kind === "list") for (const item of nodeArray(node.items)) pass(item);
    if (node.kind === "map") for (const entry of nodeArray(node.entries)) pass(asNode(entry.value));
    if (node.kind === "closure") passResult(asNode(node.body));
    if (node.kind === "methodCall") {
      const name = constantString(node.method) ?? "";
      const shows =
        node.implicitThis === true &&
        types.localFunctions?.has(name) !== true &&
        SHOWING_API_CALLS.has(name);
      if (!shows) for (const argument of nodeArray(asNode(node.arguments)?.items)) pass(argument);
    }
  });
  return passed;
}

function mapUsesOf(bodies: readonly MapBody[]): MapUses {
  const dictionaries = new Set<string>();
  for (const { body, types, keys } of bodies)
    for (const name of dictionaryVariables(body, types, keys)) dictionaries.add(name);
  const uses: MapUses = {
    dictionaries,
    recordFields: new Map(),
    dictionaryValues: new Map(),
    dictionaryElements: new Map(),
    nullableValues: new Set(),
    dictionaryKeys: new Map(),
    presentKeys: new Map(),
    clearedRecords: new Set(),
    nullTested: new Set(),
    shownEarly: new Set(),
    zeroStartNumbers: new Set(),
    emptyStarts: new Map(),
  };
  const removed = new Map<string, Set<string> | "all">();
  for (const body of bodies) collectMapUses(body, uses, removed);
  for (const body of bodies) collectEarlyDisplays(body, uses.shownEarly);
  // The names each body reads, as variables or as properties such as a module's `owner.field`: a variable of the
  // script that another body reads may pass its value on there.
  const namesRead = bodies.map(({ body }) => {
    const names = new Set<string>();
    walkAst(body, (node) => {
      const name =
        node.kind === "variable"
          ? variableName(node)
          : node.kind === "property"
            ? constantString(node.property)
            : null;
      if (name !== null) names.add(name);
    });
    return names;
  });
  for (const [index, { body, types, keys }] of bodies.entries()) {
    const passed = passedOnValues(body, keys, types);
    const readElsewhere = (key: string): boolean =>
      !key.includes("@") && namesRead.some((names, other) => other !== index && names.has(key));
    const values = assignedValues(body, keys);
    walkAst(body, (node) => {
      const right = node.kind === "declaration" ? asNode(node.right) : null;
      const key = right === null ? null : bindingKey(asNode(node.left), keys);
      const name = variableName(node.left);
      // A function's local has its own type, apart from other variables of the same name.
      const type =
        name === null
          ? UNKNOWN
          : ((key === null ? undefined : types.bindingTypes?.get(key)) ??
            types.variables.get(name) ??
            UNKNOWN);
      if (
        key !== null &&
        (isEmptyGroovyExpression(right!) || isNullConstant(right!)) &&
        !PRIMITIVE_DEFAULTS.has(text(asNode(node.left)?.originType) ?? "") &&
        !uses.nullTested.has(key) &&
        onlyOf(type, NUMBER | NULL) &&
        (type & NUMBER) !== 0
      )
        uses.zeroStartNumbers.add(key);
      // A text or a flag that starts as null, as a placeholder, and that the script uses only where it is: Groovy truth
      // treats null like the empty text and false.
      else if (
        key !== null &&
        (isEmptyGroovyExpression(right!) || isNullConstant(right!)) &&
        !PRIMITIVE_DEFAULTS.has(text(asNode(node.left)?.originType) ?? "") &&
        !uses.nullTested.has(key) &&
        !passed.has(key) &&
        !readElsewhere(key) &&
        // Every value set later is one of a known type, never null; an input the player answers gives a value.
        (values.get(key) ?? []).every(
          (value) =>
            // The start itself, also a declaration without a value; a null set later passes the variable on
            // (passedOnValues).
            isNullConstant(value) ||
            isEmptyGroovyExpression(value) ||
            (inferType(value, types) & NULL) === 0 ||
            (value.kind === "methodCall" &&
              value.implicitThis === true &&
              /^get[A-Z]/u.test(constantString(value.method) ?? "") &&
              types.localFunctions?.has(constantString(value.method) ?? "") !== true),
        )
      ) {
        if (onlyOf(type, STRING | NULL) && (type & STRING) !== 0) uses.emptyStarts.set(key, "");
        else if (onlyOf(type, BOOLEAN | NULL) && (type & BOOLEAN) !== 0)
          uses.emptyStarts.set(key, false);
      }
    });
  }
  for (const [name, keys] of removed) {
    const present = uses.presentKeys.get(name);
    if (present === undefined) continue;
    if (keys === "all") present.clear();
    else for (const key of keys) present.delete(key);
  }
  return uses;
}

/** SexScript calls that show their arguments as text. */
const DISPLAY_CALLS = new Set(["show", "showButton", "showPopup"]);

/**
 * Adds the variables of a body that a text can show before their first assignment (MapUses.shownEarly): read in a
 * shown text inside a closure, or at the top level on a line before the top level first assigns them.
 */
function collectEarlyDisplays({ body, keys }: MapBody, shownEarly: Set<string>): void {
  // The variables each closure kept in a variable assigns, so that a top-level call of it counts as their assignment.
  const assignedBy = new Map<string, string[]>();
  walkAst(body, (node) => {
    const closure = node.kind === "declaration" ? asNode(node.right) : null;
    const name = variableName(node.left);
    if (closure?.kind !== "closure" || name === null) return;
    const assigned: string[] = [];
    walkAst(closure, (inner) => {
      const target =
        inner.kind === "binary" && inner.operator === "="
          ? bindingKey(asNode(inner.left), keys)
          : null;
      if (target !== null) assigned.push(target);
    });
    assignedBy.set(name, assigned);
  });
  const firstAssigned = new Map<string, number>();
  const shown: Array<{ key: string; line: number; inFunction: boolean }> = [];
  const visit = (node: AstNode, inFunction: boolean, displayed: boolean): void => {
    const inside = inFunction || node.kind === "closure";
    const key = node.kind === "variable" ? bindingKey(node, keys) : null;
    if (displayed && key !== null)
      shown.push({ key, line: node.span?.line ?? 0, inFunction: inside });
    const assigns =
      (node.kind === "binary" && node.operator === "=") ||
      (node.kind === "declaration" &&
        asNode(node.right) !== null &&
        !isEmptyGroovyExpression(asNode(node.right)!) &&
        !isNullConstant(asNode(node.right)!));
    const target = assigns ? bindingKey(asNode(node.left), keys) : null;
    if (!inside && target !== null && !firstAssigned.has(target))
      firstAssigned.set(target, node.span?.line ?? 0);
    const called =
      !inside && node.kind === "methodCall" && node.implicitThis === true
        ? assignedBy.get(constantString(node.method) ?? "")
        : undefined;
    for (const assigned of called ?? [])
      if (!firstAssigned.has(assigned)) firstAssigned.set(assigned, node.span?.line ?? 0);
    const shows =
      node.kind === "gstring" ||
      (node.kind === "binary" &&
        node.operator === "+" &&
        [node.left, node.right].some((side) => {
          const operand = asNode(side);
          return operand?.kind === "gstring" || constantString(operand) !== null;
        })) ||
      (node.kind === "methodCall" &&
        node.implicitThis === true &&
        DISPLAY_CALLS.has(constantString(node.method) ?? ""));
    for (const child of Object.values(node)) {
      for (const item of Array.isArray(child) ? child : [child])
        if (isAstNode(item)) visit(item, inside, displayed || shows);
    }
  };
  visit(body, false, false);
  for (const { key, line, inFunction } of shown)
    if (inFunction || line < (firstAssigned.get(key) ?? Number.POSITIVE_INFINITY))
      shownEarly.add(key);
}

/**
 * Records one body's map uses: object fields; and for dicts, the types of their values (literal values, `map[key] =`,
 * `map.key =`, and `put`), the types of their keys, and the literal keys every assigned map has and nothing removes.
 */
function collectMapUses(
  { body, types, keys }: MapBody,
  uses: MapUses,
  removed: Map<string, Set<string> | "all">,
): void {
  const keyOf = (node: unknown): string | null => bindingKey(node, keys);
  const isDict = (name: string | null): name is string =>
    name !== null && uses.dictionaries.has(name);
  const addField = (name: string, field: string): void => {
    const fields = uses.recordFields.get(name) ?? [];
    if (!fields.includes(field)) uses.recordFields.set(name, [...fields, field]);
  };
  const addValue = (name: string | null, value: AstNode | null): void => {
    if (!isDict(name) || value === null) return;
    // A read of the same dict adds no type of its own (`m[k] = (m[k] ?: 0) + 1` stores numbers).
    const ownReads = (node: AstNode): AstNode => {
      const receiver =
        node.kind === "binary" && node.operator === "["
          ? node.left
          : node.kind === "property" ||
              (node.kind === "methodCall" && constantString(node.method) === "get")
            ? node.object
            : null;
      if (receiver !== null && keyOf(receiver) === name) return { kind: "noValue", span: null };
      const copy: AstNode = { ...node };
      for (const [field, child] of Object.entries(node)) {
        if (isAstNode(child)) copy[field] = ownReads(child);
        else if (Array.isArray(child))
          copy[field] = child.map((item) => (isAstNode(item) ? ownReads(item) : item));
      }
      return copy;
    };
    const type = inferType(ownReads(value), types);
    if ((type & NULL) !== 0) uses.nullableValues.add(name);
    if (type !== UNKNOWN)
      uses.dictionaryValues.set(name, (uses.dictionaryValues.get(name) ?? 0) | type);
    const elements =
      value.kind === "list"
        ? nodeArray(value.items).reduce((union, item) => union | inferType(item, types), 0)
        : (types.listElements?.get(variableName(value) ?? "") ?? 0);
    if (elements !== 0 && elements !== UNKNOWN)
      uses.dictionaryElements.set(name, (uses.dictionaryElements.get(name) ?? 0) | elements);
  };
  const addKey = (name: string | null, key: AstNode | null): void => {
    if (!isDict(name) || key === null) return;
    const literal = constantValue(key);
    const type =
      typeof literal === "string"
        ? STRING
        : typeof literal === "number"
          ? NUMBER
          : typeof literal === "boolean"
            ? BOOLEAN
            : inferType(key, types);
    if (type !== UNKNOWN)
      uses.dictionaryKeys.set(name, (uses.dictionaryKeys.get(name) ?? 0) | type);
  };
  const assignKeys = (name: string, present: Set<string>): void => {
    const earlier = uses.presentKeys.get(name);
    uses.presentKeys.set(
      name,
      earlier === undefined ? present : new Set([...earlier].filter((key) => present.has(key))),
    );
  };
  const remove = (name: string, key: string | "all"): void => {
    const earlier = removed.get(name) ?? new Set<string>();
    if (key === "all" || earlier === "all") removed.set(name, "all");
    else removed.set(name, earlier.add(key));
  };
  walkAst(body, (node) => {
    if (node.kind === "binary" && (node.operator === "==" || node.operator === "!=")) {
      for (const [side, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        const tested = keyOf(side);
        if (tested !== null && isNullConstant(asNode(other) ?? undefined))
          uses.nullTested.add(tested);
      }
    }
    if ((node.kind === "property" || node.kind === "methodCall") && node.safe === true) {
      const tested = keyOf(node.object);
      if (tested !== null) uses.nullTested.add(tested);
    }
    if (
      node.kind === "switch" &&
      nodeArray(node.cases).some((item) => isNullConstant(asNode(item.expression) ?? undefined))
    ) {
      const tested = keyOf(node.expression);
      if (tested !== null) uses.nullTested.add(tested);
    }
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    const target = assigns ? asNode(node.left) : null;
    const right = assigns ? asNode(node.right) : null;
    const assigned = keyOf(target);
    if (assigned !== null && right !== null) {
      const entries = right.kind === "map" ? nodeArray(right.entries) : [];
      if (!isDict(assigned)) {
        for (const entry of entries) {
          const field = constantString(entry.key);
          if (field !== null && isTeaseObjectPropertyName(field)) addField(assigned, field);
        }
      } else {
        const present = new Set<string>();
        for (const entry of entries) {
          addValue(assigned, asNode(entry.value));
          addKey(assigned, asNode(entry.key));
          const literal = constantValue(asNode(entry.key) ?? undefined);
          if (literal !== undefined && literal !== null) present.add(String(literal));
        }
        // A map from elsewhere, or null, may lack any key.
        assignKeys(assigned, present);
      }
    }
    if (assigns && target?.kind === "binary" && target.operator === "[")
      addValue(keyOf(target.left), right);
    if (assigns && target?.kind === "property") addValue(keyOf(target.object), right);
    // `map[key] += value` stores the result of the operation.
    if (
      node.kind === "binary" &&
      typeof node.operator === "string" &&
      ["+=", "-=", "*=", "/="].includes(node.operator)
    ) {
      const compound = asNode(node.left);
      const receiver =
        compound?.kind === "binary" && compound.operator === "["
          ? compound.left
          : compound?.kind === "property"
            ? compound.object
            : null;
      if (receiver !== null)
        addValue(keyOf(receiver), { ...node, operator: node.operator.slice(0, -1) });
    }
    if (node.kind === "binary" && node.operator === "[") {
      const name = keyOf(node.left);
      addKey(name, asNode(node.right));
      const field = constantString(node.right);
      if (name !== null && !isDict(name) && field !== null && isTeaseObjectPropertyName(field))
        addField(name, field);
    }
    if (node.kind === "property") {
      const name = keyOf(node.object);
      const field = constantString(node.property);
      if (name !== null && !isDict(name) && field !== null && isTeaseObjectPropertyName(field))
        addField(name, field);
      if (isDict(name))
        uses.dictionaryKeys.set(name, (uses.dictionaryKeys.get(name) ?? 0) | STRING);
    }
    if (node.kind === "methodCall") {
      const method = constantString(node.method);
      const args = nodeArray(asNode(node.arguments)?.items);
      const name = keyOf(node.object);
      if (name !== null && !isDict(name) && method === "clear" && args.length === 0)
        uses.clearedRecords.add(name);
      if (isDict(name) && method !== null) {
        if (["get", "containsKey", "put", "remove"].includes(method) && args.length > 0)
          addKey(name, args[0]!);
        if (method === "put" && args.length === 2) addValue(name, args[1]!);
        const literal = args.length === 1 ? constantValue(args[0]) : undefined;
        if (method === "remove" && literal !== undefined && literal !== null)
          remove(name, String(literal));
        else if (["remove", "clear", "removeAll", "retainAll"].includes(method))
          remove(name, "all");
      }
      // Removing through a view of the keys or values changes the dict as well.
      const view = asNode(node.object);
      const viewed =
        view?.kind === "methodCall" &&
        ["keySet", "values", "entrySet"].includes(constantString(view.method) ?? "")
          ? keyOf(view.object)
          : null;
      if (isDict(viewed) && method !== null && /^(remove|retain|clear)/u.test(method))
        remove(viewed, "all");
    }
  });
}

/**
 * Binding keys of the variables that a closure declares: a closure's parameters and its `def` locals (block-scoped)
 * are variables apart from script-level names of the same spelling, so their key adds the source position of the
 * declaration. Script-level names, which mixin modules reach by name, keep their name and have no entry.
 */
function bindingKeys(body: AstNode, sourceName: string): Map<AstNode | string, string> {
  const keys = new Map<AstNode | string, string>();
  // A copy of a node (substituteNodes) keeps its span, so the key is found by span too.
  const setKey = (node: AstNode, key: string): void => {
    keys.set(node, key);
    const id = bindingSpanId(node);
    if (id !== null) keys.set(id, key);
  };
  const keyAt = (name: string, span: SourceSpan | null | undefined): string =>
    scopedBindingKey(name, span, sourceName);
  const visit = (value: unknown, scopes: ReadonlyArray<Map<string, string>>): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, scopes);
      return;
    }
    if (!isAstNode(value)) return;
    const node = value;
    if (
      node.kind === "closure" ||
      (scopes.length > 0 && (node.kind === "block" || node.kind === "for"))
    ) {
      const scope = new Map<string, string>();
      if (node.kind === "closure") {
        for (const parameter of groovyParameters(node.parameters) ?? [])
          scope.set(parameter.name, keyAt(parameter.name, node.span));
        if (node.parameterSpecified !== true) scope.set("it", keyAt("it", node.span));
      }
      if (node.kind === "for" && typeof node.variable === "string") {
        // The loop node carries its variable's key, since the variable is not a node.
        scope.set(node.variable, keyAt(node.variable, node.span));
        setKey(node, keyAt(node.variable, node.span));
      }
      for (const child of nodeChildren(node)) visit(child, [...scopes, scope]);
      return;
    }
    if (node.kind === "declaration" && scopes.length > 0) {
      visit(node.right, scopes);
      const left = asNode(node.left);
      for (const target of left?.kind === "arguments" ? nodeArray(left.items) : [left]) {
        const name = variableName(target);
        if (target === null || name === null) continue;
        const key = keyAt(name, target.span);
        scopes.at(-1)!.set(name, key);
        setKey(target, key);
      }
      return;
    }
    if (node.kind === "variable") {
      const name = variableName(node);
      const key =
        name === null ? undefined : scopes.findLast((scope) => scope.has(name))?.get(name);
      if (key !== undefined) setKey(node, key);
      return;
    }
    for (const child of nodeChildren(node)) visit(child, scopes);
  };
  visit(body, []);
  return keys;
}

/** Binding keys for type inference, so a closure's variables get types apart from other variables of their name. */
function variableBindings(keys: BindingKeys, sourceName: string): VariableBindings {
  return {
    bindingOf: (node) => bindingKey(node, keys),
    parameterKey: (closure, name) => scopedBindingKey(name, closure.span, sourceName),
    loopKey: (loop) => keys.get(loop) ?? String(loop.variable),
  };
}

/** The key of a variable a closure declares at `span` (see `bindingKeys`). */
function scopedBindingKey(
  name: string,
  span: SourceSpan | null | undefined,
  sourceName: string,
): string {
  return `${name}@${sourceName}:${span?.line ?? 0}:${span?.column ?? 0}`;
}

/**
 * Bindings of closure parameters and loop variables (see `bindingKeys`), which Groovy gave the caller's list or the
 * iterated element itself, where TeaseScript passes a copy. A loop outside closures has no scoped key, so its
 * variable name stands for every script-level binding of that name. Without a source name (a helper class method,
 * whose closures have no scoped keys), every key is the plain name.
 */
function parameterBindings(
  body: AstNode,
  sourceName: string | null,
  parameters: readonly string[] = [],
): Set<string> {
  const keys = new Set<string>(parameters);
  const keyAt = (name: string, span: SourceSpan | null, scoped: boolean): string =>
    scoped && sourceName !== null ? scopedBindingKey(name, span, sourceName) : name;
  const visit = (value: unknown, inClosure: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inClosure);
      return;
    }
    if (!isAstNode(value)) return;
    if (value.kind === "closure") {
      for (const parameter of groovyParameters(value.parameters) ?? [])
        keys.add(keyAt(parameter.name, value.span, true));
      if (value.parameterSpecified !== true) keys.add(keyAt("it", value.span, true));
    }
    if (value.kind === "for" && typeof value.variable === "string")
      keys.add(keyAt(value.variable, value.span, inClosure));
    for (const child of nodeChildren(value)) visit(child, inClosure || value.kind === "closure");
  };
  visit(body, false);
  return keys;
}

/**
 * The values assigned to each binding by a declaration or `=`, by binding key. A name of a destructuring declaration
 * (`def (a, b) = list`) receives an element, which an index read of the list stands for.
 */
function assignedValues(body: AstNode, keys: BindingKeys): Map<string, AstNode[]> {
  const values = new Map<string, AstNode[]>();
  const add = (target: unknown, value: AstNode): void => {
    const key = bindingKey(target, keys);
    if (key === null) return;
    if (!values.has(key)) values.set(key, []);
    values.get(key)!.push(value);
  };
  walkAst(body, (node) => {
    if (node.kind !== "declaration" && !(node.kind === "binary" && node.operator === "=")) return;
    const left = asNode(node.left);
    const right = asNode(node.right);
    if (left === null || right === null) return;
    if (left.kind !== "arguments") {
      add(left, right);
      return;
    }
    for (const item of nodeArray(left.items)) {
      add(item, {
        kind: "binary",
        span: right.span,
        operator: "[",
        left: right,
        right: { kind: "constant", span: null, value: 0 },
      });
    }
  });
  return values;
}

interface DeclaredWrites {
  /** Bindings that a declaration gives a value. */
  initialized: ReadonlySet<string>;
  /** Bindings declared without a value, or changed by `++` or `--`. */
  other: ReadonlySet<string>;
}

/** The bindings declarations give a value, and those that start without one or that `++` and `--` change. */
function declaredWrites(body: AstNode, keys: BindingKeys): DeclaredWrites {
  const initialized = new Set<string>();
  const other = new Set<string>();
  walkAst(body, (node) => {
    if (node.kind === "declaration") {
      const key = bindingKey(node.left, keys);
      if (key !== null) (asNode(node.right) === null ? other : initialized).add(key);
    } else if (node.kind === "postfix" || node.kind === "prefix") {
      const key = bindingKey(node.value, keys);
      if (key !== null) other.add(key);
    }
  });
  return { initialized, other };
}

/** The value each compound update gives its variable, as the binary expression it computes (`x += y` is `x + y`). */
function compoundValues(body: AstNode, keys: BindingKeys): Map<string, AstNode[]> {
  const values = new Map<string, AstNode[]>();
  walkAst(body, (node) => {
    const operator = node.kind === "binary" ? text(node.operator) : null;
    if (operator === null || !["+=", "-=", "*=", "/="].includes(operator)) return;
    const key = bindingKey(node.left, keys);
    if (key === null) return;
    const value: AstNode = { ...node, operator: operator[0] };
    values.set(key, [...(values.get(key) ?? []), value]);
  });
  return values;
}

/**
 * The shape of a storage key: its literal text, with `*` for each computed part (`prefix + ".punishment" + i` as
 * `*.punishment*`), so a computed read and a computed save of the same form match. Null when no part is literal.
 */
export function storageKeyShape(node: AstNode): string | null {
  const parts: string[] = [];
  let literal = false;
  const visit = (part: AstNode): void => {
    const text = constantString(part);
    if (text !== null) {
      parts.push(text);
      literal = true;
      return;
    }
    if (
      part.kind === "binary" &&
      part.operator === "+" &&
      isAstNode(part.left) &&
      isAstNode(part.right)
    ) {
      visit(part.left);
      visit(part.right);
      return;
    }
    if (part.kind === "gstring") {
      const strings = Array.isArray(part.strings) ? part.strings : [];
      const values = nodeArray(part.values);
      strings.forEach((piece, position) => {
        if (typeof piece === "string" && piece !== "") {
          parts.push(piece);
          literal = true;
        }
        if (position < values.length) parts.push("*");
      });
      return;
    }
    parts.push("*");
  };
  visit(node);
  return literal ? parts.join("").replace(/\*+/gu, "*") : null;
}

/** The binding a variable reference names (see `bindingKeys`); null for any other expression. */
function bindingKey(node: unknown, keys: BindingKeys): string | null {
  const name = variableName(node);
  if (name === null || !isAstNode(node)) return name;
  const id = bindingSpanId(node);
  return keys.get(node) ?? (id === null ? undefined : keys.get(id)) ?? name;
}

/** Binding keys of variable nodes (and loop nodes, for their variable), also by source position (bindingSpanId). */
type BindingKeys = ReadonlyMap<AstNode | string, string>;

/** A node's kind, name, and source position, which a copy of the node keeps; null without a position. */
function bindingSpanId(node: AstNode): string | null {
  const span = node.span;
  if (span === null || span === undefined) return null;
  const name = node.kind === "for" ? String(node.variable) : variableName(node);
  return `${node.kind}|${name}|${span.line}:${span.column}:${span.endLine}:${span.endColumn}`;
}

/** The variable name of a binding key. */
function bindingName(key: string): string {
  return key.split("@")[0]!;
}

export function lowerParsedFile(
  file: ParsedGroovyFile,
  options: LowerOptions = {},
): MigrationProgram {
  const context: LowerContext = {
    diagnostics: [],
    metadata: null,
    functions: new Map(),
    types: { variables: new Map() },
    prelude: [],
    statementRoot: null,
    postlude: [],
    postludeRoot: null,
    shadowingReferences: new Set(),
    classLoaderVariables: new Set(),
    legacyHelperClasses: new Map(),
    helperFunctions: new Map(),
    helperMainParameter: null,
    packageHelperRegistry: options.helperRegistry ?? new Map(),
    syntheticHelpers: new Set(),
    functionDepth: 0,
    comments: { items: file.comments ?? [], next: 0 },
    sourceLines: file.source === undefined ? [] : file.source.split(/\r\n?|\n/u),
    renderedDiagnostics: new Set(),
    packageFunctions: options.packageFunctions ?? new Set(),
    stableNames: options.stableNames ?? new Set(),
    storageLiterals: options.storageLiterals ?? new Map(),
    nonTextKeys: options.nonTextKeys ?? new Set(),
    nonBooleanKeys: options.nonBooleanKeys ?? new Set(),
    copiedImages: options.copiedImages ?? new Set(),
    unreachable: false,
    mixinModules: options.mixinModules ?? [],
    loadsModuleDirectories: new Set(),
    currentFunction: null,
    closureFunctions: [],
    actions: new Set(),
    ignoredInputs: 0,
    switchValues: 0,
    popupTimers: 0,
    generatedNames: new Set(),
    resultUses: options.resultUses ?? packageResultUses([file]),
    directoryFiles: options.directoryFiles ?? new Map(),
    scriptPaths: options.scriptPaths ?? null,
    dateValues: new Set(),
    aliasedLists: new Set(),
    parameterBindings: new Set(),
    assignedValues: new Map(),
    compoundValues: new Map(),
    declaredWrites: { initialized: new Set(), other: new Set() },
    menuIndexes: new Set(),
    nullElementLists: new Set(),
    mapUses: mapUsesOf([]),
    bindings: new Map(),
    integerVariables: new Set(),
    integerArrays: new Set(),
    textVariables: new Set(),
    walkedEntries: new Map(),
    changingPaths: new Set(),
    constantInitializers: new Map(),
    knownKeys: [],
    writeTargets: new Set(),
    indexedSplits: new Set(),
    accepted: options.accepted ?? new Set(),
    elementRemovals: new Set(),
    media: options.media ?? null,
    files: options.files === undefined ? null : new Set(options.files.map(packageFilePath)),
    actualFiles: options.files ?? [],
    fileValues: new Set(),
    fileVariables: new Set(),
    filePathOwners: new Map(),
    photoVariables: new Set(),
    checksUndefinedVariables: options.packageFunctions !== undefined,
    java: javaFileState(null, options.javaResources ?? null),
  };
  if (file.diagnostics.length > 0 || file.root === null) {
    for (const diagnostic of file.diagnostics) {
      context.diagnostics.push({
        code: diagnostic.code,
        severity: "error",
        message: diagnostic.message,
        span: null,
      });
    }
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: context.diagnostics,
    };
  }

  if (file.root.kind === "compilationUnit") {
    const unit = lowerHelperCompilationUnit(file, context);
    // A helper class converted on its own gives its reads their defaults by its own saves.
    return options.renameIdentifiers === false
      ? unit
      : (withStorageDefaults([unit], false)[0] ?? unit);
  }
  if (file.root.kind !== "scriptBody") {
    context.diagnostics.push({
      code: "SX_UNIT_LOWERING_DEFERRED",
      severity: "error",
      message: "Non-script Groovy input is parsed but not lowered by the importer.",
      span: file.root.span,
    });
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: context.diagnostics,
    };
  }

  const rawBody = asNode(file.root.body);
  const mixin = rawBody === null ? null : desugarMixinModule(rawBody, file.sourceName);
  const desugared =
    mixin?.body ?? desugarObjectScript(rawBody, nodeArray(file.root.classes), context);
  let body = desugared;
  if (desugared?.kind === "block" && mixin === null) {
    // Scratch variables split by value type first, so every later analysis sees the split names.
    context.types = inferVariableTypes(
      desugared,
      [],
      context.packageFunctions,
      options.functionResults,
    );
    context.bindings = bindingKeys(desugared, file.sourceName);
    body = splitScratchVariables(desugared, context);
  }
  if (body?.kind === "block") {
    context.functions = collectClosureInfo(body);
    context.shadowingReferences = collectShadowingReferences(body, context.functions);
    context.bindings = bindingKeys(body, file.sourceName);
    context.types = withGlobalTypes(
      inferVariableTypes(
        body,
        [],
        context.packageFunctions,
        options.functionResults,
        variableBindings(context.bindings, file.sourceName),
      ),
      options.globalTypes,
    );
    context.dateValues = currentDateVariables(body, context.types);
    context.aliasedLists = aliasedListVariables(body, context.types);
    context.parameterBindings = parameterBindings(body, file.sourceName);
    context.assignedValues = assignedValues(body, context.bindings);
    context.compoundValues = compoundValues(body, context.bindings);
    context.declaredWrites = declaredWrites(body, context.bindings);
    context.menuIndexes = menuIndexes(body);
    context.nullElementLists = nullElementLists(body, context.bindings);
    markSequentialWrites(body, context);
    context.constantInitializers = declarationInitializers(body, context.types);
    context.changingPaths = changingVariables(body, context.bindings);
    context.integerVariables = integerVariables(body, context.bindings);
    context.integerArrays = integerArrays(body, context.bindings);
    context.textVariables = textVariables(body, context.bindings);
    context.mapUses =
      options.mapUses ?? mapUsesOf([{ body, types: context.types, keys: context.bindings }]);
    context.elementRemovals = elementRemovals(body);
    Object.assign(context, fileTests(body));
    context.java = javaFileState(body, options.javaResources ?? null);
    context.photoVariables = photoVariables(body);
    // A lookup reads the type of the dict's values, as an index reads a list's element type.
    const listElements = new Map(context.types.listElements ?? []);
    for (const [key, type] of context.mapUses.dictionaryValues) {
      const name = bindingName(key);
      if (type !== 0) listElements.set(name, (listElements.get(name) ?? 0) | type);
    }
    // A number that starts at 0, or a text or flag that starts empty, instead of null holds no null.
    const variables = new Map(context.types.variables);
    const bindingTypes = new Map(context.types.bindingTypes ?? []);
    for (const key of [
      ...context.mapUses.zeroStartNumbers,
      ...context.mapUses.emptyStarts.keys(),
    ]) {
      const name = bindingName(key);
      const type = variables.get(name);
      if (type !== undefined) variables.set(name, type & ~NULL);
      // A function's own variable has its own type too.
      const scoped = bindingTypes.get(key);
      if (scoped !== undefined) bindingTypes.set(key, scoped & ~NULL);
    }
    context.types = {
      ...context.types,
      variables,
      listElements,
      ...(context.types.bindingTypes === undefined ? {} : { bindingTypes }),
    };
    const helpers = collectLegacyHelperBindings(body);
    context.classLoaderVariables = helpers.classLoaders;
    context.legacyHelperClasses = helpers.helperClasses;
  }
  const lowered = body?.kind === "block" ? lowerBlock(body, context) : [];
  // Every file ends with a transfer or exit (ADR 0022 §4); where the legacy script just ended, its chain ended.
  const authoredStatements =
    mixin === null && !terminates(lowered)
      ? [...lowered, { kind: "exit" as const, span: null }]
      : lowered;
  let stripsTags = false;
  if (body !== null) walkAst(body, (node) => (stripsTags ||= regexWorkaround(node) === "tags"));
  // A module's `object.name`, without its receiver, is the script object's member, not a binding variable. A name of
  // the loading script's object, such as a field, is that object's member too (Groovy read the field where the
  // module's binding had no value).
  const members =
    mixin === null
      ? undefined
      : new Set([...mixin.receiverMembers, ...(options.globalTypes?.keys() ?? [])]);
  const typedStatements = withLegacyMarkup(
    withEnforcedTypes(
      withSetUpActions(
        withDirectClosureCalls(
          withPlacedBindings(
            bindingDeclarations(body, context, members),
            withPlacedFunctions(
              context.closureFunctions,
              withScriptBindings(authoredStatements, body, context, members),
            ),
            context,
          ),
          context,
        ),
        context,
      ),
      context,
    ),
    context,
    stripsTags,
  );
  // The truth and ordering helpers go where variable typing wrote all their tests plainly.
  for (const [helper, name] of [
    ["truth", "sexscriptLegacyTruth"],
    ["compare", "sexscriptLegacyCompare"],
  ] as const) {
    if (!context.syntheticHelpers.has(helper)) continue;
    const others = helperStatements(
      new Set([...context.syntheticHelpers].filter((other) => other !== helper)),
    );
    if (!callsFunction([typedStatements, others], name)) context.syntheticHelpers.delete(helper);
  }
  // The passes over the typed statements, in this order: typed storage reads parsed as legacy did, a button's seconds
  // kept as a duration, empty texts dropped,
  // animations and counters made messages that change in place, legacy waits replaced by reading time, repeated texts
  // shortened, texts folded into asks, picked texts and paragraphs split, and `instant` taken away where it would cut a
  // reading time short.
  const { diagnostics } = context;
  // A module's script variables, and those of a script that loads modules, are shared with other files.
  const shared = mixin !== null || context.loadsModuleDirectories.size > 0;
  let texts = withFillableLoads(
    withParsedLoads(withSwitchLadders(withCounterLoops(typedStatements)), context.syntheticHelpers),
    shared,
  );
  texts = withElapsedDurations(texts, diagnostics, shared);
  texts = withoutBlankText(texts, diagnostics, mixin === null);
  texts = withMessageHandles(texts, diagnostics, mixin !== null);
  texts = withReadingTimes(texts, diagnostics);
  texts = withoutRepeatedText(texts, diagnostics);
  // A picked text splits into its paragraphs first, so that an ask after it keeps no question of several paragraphs.
  texts = withParagraphPicks(texts, diagnostics, options.keepParagraphs === true, shared);
  texts = withAskQuestions(texts, diagnostics);
  texts = withParagraphs(texts, diagnostics, options.keepParagraphs === true);
  texts = withoutCutReadingTimes(texts, diagnostics);
  const statements = [
    ...helperStatements(context.syntheticHelpers),
    ...javaDataStatements(context.java),
    ...texts,
  ];
  if (body?.kind !== "block") {
    addDiagnostic(
      context,
      "SX_INVALID_SCRIPT_BODY",
      "error",
      "Parser output does not contain a script body block.",
      file.root.span,
    );
  }

  const program: MigrationProgram = {
    sourceName: file.sourceName,
    metadata: context.metadata,
    statements,
    diagnostics: context.diagnostics,
    ...(mixin === null ? {} : { module: mixin.info }),
    ...(context.actions.size === 0 ? {} : { actions: [...context.actions] }),
    ...(context.loadsModuleDirectories.size === 0
      ? {}
      : { loadsModuleDirectories: [...context.loadsModuleDirectories].sort() }),
  };
  if (options.renameIdentifiers === false) return program;
  // A file converted on its own gives its reads their defaults by its own saves, as a package does by all of them.
  const stored = withStorageDefaults([program], false)[0] ?? program;
  const results = functionResultTypes(stored.statements);
  const dispatched = withActionDispatcher(
    stored,
    new Set((stored.actions ?? []).filter((action) => results.get(action)?.kind === "null")),
  );
  return renameConflictingIdentifiers({
    ...dispatched,
    statements: withDispatcherResultTypes(withReturnTypes(dispatched.statements)),
  });
}

/**
 * Legacy show() rendered HTML, which `say` text keeps as message markup (markup.ts); layout tags that markup cannot
 * express are dropped, with one note for the file. Other text with HTML tags, such as a message kept in a variable or
 * handed to a function that shows it later, is converted too; its entities alone do not count, since text such as a
 * link may hold an ampersand. A script that removes tags from its text itself (`stripsTags`) keeps such text as written.
 */
function withLegacyMarkup(
  statements: IrStatement[],
  context: LowerContext,
  stripsTags = false,
): IrStatement[] {
  let dropped = 0;
  const fileVariables = new Set(
    statements.flatMap((statement) => (statement.kind === "let" ? [statement.name] : [])),
  );
  // The constant texts folded into their spans, whose `let` goes where nothing reads it any more.
  let folded = new Set<string>();
  const markup = (
    value: IrExpression,
    any: boolean,
    constants: ReadonlyMap<string, string>,
  ): IrExpression => {
    const given: TextPart[] | null =
      value.kind === "literal" && typeof value.value === "string"
        ? [{ text: value.value }]
        : value.kind === "template"
          ? value.parts
          : null;
    if (given === null) return value;
    if (
      !any &&
      (stripsTags || !given.some((part) => "text" in part && SHOWN_HTML_TAG.test(part.text)))
    )
      return value;
    const parts = withFoldedSpanValues(given, constants, folded);
    const result = legacyHtmlToMarkup(parts, { fragment: !any });
    if (!result.changed) return value;
    if (result.dropped) dropped += 1;
    return templateOrLiteral(result.parts);
  };
  // Every text of a statement, inner values first; a say's own text also has its entities decoded.
  const convert = (items: IrStatement[], constants: ReadonlyMap<string, string>): IrStatement[] => {
    const deep = (value: IrExpression): IrExpression =>
      markup(mapChildren(value, deep), false, constants);
    return items.map((statement) => {
      if (statement.kind === "function") {
        const own = constantTexts(statement, fileVariables);
        folded = new Set();
        const converted = convert(statement.body, own);
        const body = withoutNestedSpans(
          withoutUnreadLets(converted, folded),
          statement,
          fileVariables,
        );
        return { ...statement, body };
      }
      const nested = withNestedStatements(statement, (body) => convert(body, constants));
      if (nested.kind === "say")
        return { ...nested, value: markup(mapChildren(nested.value, deep), true, constants) };
      return mapOwnExpressions(nested, deep);
    });
  };
  const converted = convert(statements, new Map());
  if (dropped === 0) return converted;
  const message = `Legacy show() rendered HTML; the text keeps bold, italic, colour, size, and line breaks as message markup, and drops layout such as TEXTFORMAT, ALIGN, and FONT FACE with the size an editor writes beside it (${dropped} text${dropped === 1 ? "" : "s"} in this file).`;
  context.diagnostics.push({ code: "SX_HTML_LAYOUT", severity: "warning", message, span: null });
  return [
    { kind: "comment", text: `// NOTE SX_HTML_LAYOUT: ${message}`, trailing: false, span: null },
    ...converted,
  ];
}

/**
 * A function's texts that never change: variables it declares once with a text literal, `let dots = "\n\n....... "`,
 * and never sets again, with no parameter or script variable of the same name.
 */
function constantTexts(
  fn: Extract<IrStatement, { kind: "function" }>,
  fileVariables: ReadonlySet<string>,
): Map<string, string> {
  const declared = new Map<string, number>();
  const literal = new Map<string, string>();
  const changed = new Set<string>(fn.parameters.map((parameter) => parameter.name));
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "let") {
        declared.set(item.name, (declared.get(item.name) ?? 0) + 1);
        if (item.value.kind === "literal" && typeof item.value.value === "string")
          literal.set(item.name, item.value.value);
      }
      if (item.kind === "assign" && item.target.kind === "variable") changed.add(item.target.name);
      if (item.kind === "for") {
        changed.add(item.variable);
        if (item.valueVariable !== undefined) changed.add(item.valueVariable);
      }
      if (item.kind !== "function")
        withNestedStatements(item, (body) => {
          visit(body);
          return body;
        });
    }
  };
  visit(fn.body);
  return new Map(
    [...literal].filter(
      ([name]) => declared.get(name) === 1 && !changed.has(name) && !fileVariables.has(name),
    ),
  );
}

/**
 * The parts with each value that is a constant text (constantTexts) inside an HTML span written as that text, so that
 * the markup conversion sees its line breaks as it sees the span's own text: legacy joined it into the HTML first.
 */
function withFoldedSpanValues(
  parts: readonly TextPart[],
  constants: ReadonlyMap<string, string>,
  folded: Set<string>,
): TextPart[] {
  if (constants.size === 0) return [...parts];
  let depth = 0;
  // Whether each open FONT sets a size, which is a span too.
  const fonts: boolean[] = [];
  return parts.map((part) => {
    if ("text" in part) {
      for (const match of part.text.matchAll(
        /<(\/?)(b|strong|i|em|strike|s|del|font)\b[^<>]*>/giu,
      )) {
        const closing = match[1] === "/";
        if (match[2]!.toLowerCase() === "font") {
          const size = closing ? null : fontSize(match[0]);
          const sized = closing ? (fonts.pop() ?? false) : size !== null && size !== "normal";
          if (!closing) fonts.push(sized);
          if (!sized) continue;
        }
        depth = Math.max(0, depth + (closing ? -1 : 1));
      }
      return part;
    }
    const name = part.value.kind === "variable" ? part.value.name : "";
    const constant = constants.get(name);
    if (depth === 0 || constant === undefined) return part;
    folded.add(name);
    return { text: constant };
  });
}

/**
 * A function's variable that every read shows as the whole of a span, `say "**${message}**"`, gets its span from those
 * reads, so an assignment of the same span around one value, `message = "**${dialog}**"` from legacy HTML that wrapped
 * the text in `<b>` twice, keeps only the value: nested delimiters would show as written. The span may have sizes
 * around its mark, `[size=x-large]**${message}**[/size]` from `<font size='10'><b>`.
 */
function withoutNestedSpans(
  statements: IrStatement[],
  fn: Extract<IrStatement, { kind: "function" }>,
  fileVariables: ReadonlySet<string>,
): IrStatement[] {
  // The span opening around each variable at every read, such as `**` or `[size=x-large]**`, or null where a read is
  // anything else.
  const marks = new Map<string, string | null>();
  const note = (name: string, mark: string | null): void => {
    marks.set(name, marks.has(name) && marks.get(name) !== mark ? null : mark);
  };
  // The closing of a span opening: its mark, then a `[/size]` for each size.
  const closing = (mark: string): string =>
    /(?:\*\*|\*|~~)?$/u.exec(mark)![0] + "[/size]".repeat(mark.split("[size=").length - 1);
  const wrapped = (parts: readonly TextPart[], at: number): string | null => {
    const before = parts[at - 1];
    const after = parts[at + 1];
    if (before === undefined || after === undefined || !("text" in before) || !("text" in after))
      return null;
    const mark = /(?:^|[^*~])((?:\[size=[a-z-]+\])*(?:\*\*|\*|~~)?)$/u.exec(before.text)?.[1];
    if (
      mark === undefined ||
      mark === "" ||
      !after.text.startsWith(closing(mark)) ||
      after.text.startsWith(`${closing(mark)}*`)
    )
      return null;
    return mark;
  };
  const read = (value: IrExpression): IrExpression => {
    if (value.kind === "template")
      value.parts.forEach((part, at) => {
        if ("value" in part && part.value.kind === "variable")
          note(part.value.name, wrapped(value.parts, at));
      });
    else if (value.kind === "variable") note(value.name, null);
    if (value.kind === "template")
      for (const part of value.parts)
        if ("value" in part && part.value.kind !== "variable") read(part.value);
    return value.kind === "template" ? value : mapChildren(value, read);
  };
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "assign" && item.target.kind === "variable") read(item.value);
      else mapOwnExpressions(item, read);
      withNestedStatements(item, (body) => {
        visit(body);
        return body;
      });
    }
  };
  visit(statements);
  const locals = new Set(fn.parameters.map((parameter) => parameter.name));
  const collect = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      if (item.kind === "let") locals.add(item.name);
      withNestedStatements(item, (body) => {
        collect(body);
        return body;
      });
    }
  };
  collect(statements);
  // A text that is one span of the mark on one line, as `**${dialog}**` or `**Center cheek**`, without the delimiters.
  const unwrap = (target: string, value: IrExpression): IrExpression | null => {
    const mark = marks.get(target);
    if (mark === undefined || mark === null || !locals.has(target) || fileVariables.has(target))
      return null;
    const parts: TextPart[] | null =
      value.kind === "literal" && typeof value.value === "string"
        ? [{ text: value.value }]
        : value.kind === "template"
          ? value.parts
          : null;
    const first = parts?.[0];
    const last = parts?.at(-1);
    if (parts === null || first === undefined || last === undefined) return null;
    if (!("text" in first) || !("text" in last)) return null;
    const texts = parts.flatMap((part) => ("text" in part ? [part.text] : []));
    const inside = texts.join("\u{F0000}");
    const close = closing(mark);
    const span = new RegExp(
      `^${escapeRegExp(mark)}(?![*~])([^\\n]*?)(?<![*~])${escapeRegExp(close)}$`,
      "u",
    );
    const body = span.exec(inside)?.[1];
    const emphasis = /(?:\*\*|\*|~~)?$/u.exec(mark)![0];
    if (
      body === undefined ||
      (emphasis !== "" && body.includes(emphasis)) ||
      body.includes("[size=")
    )
      return null;
    const trimmed = parts.map((part, at) => {
      if (!("text" in part)) return part;
      let text = part.text;
      if (at === 0) text = text.slice(mark.length);
      if (at === parts.length - 1) text = text.slice(0, text.length - close.length);
      return { text };
    });
    return value.kind === "template"
      ? templateOrLiteral(trimmed)
      : { kind: "literal", value: body };
  };
  const rewrite = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => {
      const nested = withNestedStatements(item, rewrite);
      if (
        nested.kind === "assign" &&
        nested.operator === "=" &&
        nested.target.kind === "variable"
      ) {
        const value = unwrap(nested.target.name, nested.value);
        return value === null ? nested : { ...nested, value };
      }
      if (nested.kind === "let") {
        const value = unwrap(nested.name, nested.value);
        return value === null ? nested : { ...nested, value };
      }
      return nested;
    });
  return rewrite(statements);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The statements without the `let` of a folded constant text (`names`) that nothing reads any more. */
function withoutUnreadLets(
  statements: IrStatement[],
  constants: ReadonlySet<string>,
): IrStatement[] {
  if (constants.size === 0) return statements;
  const read = new Set<string>();
  const collect = (value: IrExpression): IrExpression => {
    if (value.kind === "variable") read.add(value.name);
    return mapChildren(value, collect);
  };
  const visit = (items: readonly IrStatement[]): void => {
    for (const item of items) {
      mapOwnExpressions(item, collect);
      withNestedStatements(item, (body) => {
        visit(body);
        return body;
      });
    }
  };
  visit(statements);
  const prune = (items: IrStatement[]): IrStatement[] =>
    items
      .filter((item) => !(item.kind === "let" && constants.has(item.name) && !read.has(item.name)))
      .map((item) => withNestedStatements(item, prune));
  return prune(statements);
}

function lowerHelperCompilationUnit(
  file: ParsedGroovyFile,
  baseContext: LowerContext,
): MigrationProgram {
  const root = file.root;
  if (root === null || root.kind !== "compilationUnit") {
    throw new Error("lowerHelperCompilationUnit requires a compilation unit");
  }
  const topLevel = asNode(root.topLevel);
  if (topLevel !== null && topLevel.kind === "block" && nodeArray(topLevel.statements).length > 0) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_TOP_LEVEL_CODE",
      "error",
      "Auxiliary Groovy helper units with executable top-level code require manual migration.",
      topLevel.span,
    );
  }
  const classes = nodeArray(root.classes);
  if (classes.length !== 1) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_CLASS_COUNT",
      "error",
      `Expected one auxiliary helper class, found ${classes.length}.`,
      root.span,
    );
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: baseContext.diagnostics,
    };
  }
  const helperClass = withScriptObject(classes[0]!);
  // Static fields are package variables that the class's functions share; an instance field has no such meaning.
  const fields = nodeArray(helperClass.fields);
  if (fields.some((field) => field.static !== true)) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_SHARED_STATE",
      "error",
      "Auxiliary Groovy helper classes with instance fields carry per-object state and require explicit migration.",
      helperClass.span,
    );
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: baseContext.diagnostics,
    };
  }
  const fieldStatements: IrStatement[] = fields.flatMap((field): IrStatement[] => {
    const name = text(field.name);
    if (name === null) return [];
    const initial = asNode(field.initialExpression);
    const value = initial === null ? null : lowerExpression(initial, baseContext);
    // A field declared `int` or `long` truncates every number stored in it, as a script variable of that type does.
    const integer = INTEGER_TYPES.has(text(field.type)?.replace(/^java\.lang\./u, "") ?? "");
    return [
      {
        kind: "let",
        name,
        value: value ?? { kind: "literal", value: null },
        span: field.span ?? null,
        ...(integer ? { integer: true as const } : {}),
      },
    ];
  });
  const fieldTypes = new Map(
    fields.flatMap((field): Array<[string, ValueType]> => {
      const name = text(field.name);
      const initial = asNode(field.initialExpression);
      if (name === null) return [];
      const type =
        initial === null || isNullConstant(initial)
          ? UNKNOWN
          : inferType(initial, baseContext.types);
      return [[name, type]];
    }),
  );
  const methods = nodeArray(helperClass.methods);
  const helperFunctions = collectHelperFunctionInfo(methods);
  const statements: IrStatement[] = [];
  for (const method of methods) {
    const leadingComments = takeCommentsBefore(baseContext, method.span).map(
      (comment) => comment.text,
    );
    const lowered = lowerHelperMethod(method, baseContext, helperFunctions, fieldTypes);
    if (lowered === null) continue;
    if (lowered.kind === "function" && leadingComments.length > 0)
      lowered.leadingComments = leadingComments;
    statements.push(lowered);
  }
  const { diagnostics } = baseContext;
  const typedStatements = withoutCutReadingTimes(
    withReadingTimes(
      withMessageHandles(
        withElapsedDurations(
          withFillableLoads(
            withParsedLoads(
              withSwitchLadders(
                withCounterLoops(
                  withEnforcedTypes([...fieldStatements, ...statements], baseContext),
                ),
              ),
              baseContext.syntheticHelpers,
            ),
            true,
          ),
          diagnostics,
          true,
        ),
        diagnostics,
        false,
      ),
      diagnostics,
    ),
    diagnostics,
  );
  return {
    sourceName: file.sourceName,
    metadata: null,
    statements: [
      ...helperStatements(baseContext.syntheticHelpers),
      ...javaDataStatements(baseContext.java),
      ...typedStatements,
    ],
    diagnostics: baseContext.diagnostics,
    ...(baseContext.actions.size === 0 ? {} : { actions: [...baseContext.actions] }),
  };
}

/** A method's own variable types with the class's static fields, which its own variables shadow. */
function withFieldTypes(
  types: TypeEnvironment,
  fields: ReadonlyMap<string, ValueType>,
): TypeEnvironment {
  if (fields.size === 0) return types;
  return { ...types, variables: new Map([...fields, ...types.variables]) };
}

const scriptObjectClasses = new WeakMap<AstNode, AstNode>();

/**
 * A helper class handed the script object (`Helper.run(this, ...)`) calls the SexScript API on its parameter, or on a
 * static field that keeps the parameter: that parameter becomes `main`, which helper methods strip as the legacy
 * host, the field's calls become `main.` calls, and the field and its assignment go. The class node is copied.
 */
function withScriptObject(helperClass: AstNode): AstNode {
  const known = scriptObjectClasses.get(helperClass);
  if (known !== undefined) return known;
  const copy: AstNode = structuredClone(helperClass);
  const closureMethods = withClosureMethods(copy);
  const methods = nodeArray(copy.methods);
  const fieldNames = new Set(nodeArray(copy.fields).flatMap((field) => text(field.name) ?? []));
  const aliases = new Set<string>();
  const assignments = new Set<AstNode>();
  const renamed: Array<Record<string, unknown>> = [];
  for (const method of methods) {
    const parameters: unknown = method.parameters;
    const parameter: unknown = Array.isArray(parameters) ? parameters[0] : undefined;
    const name = isRecord(parameter) && typeof parameter.name === "string" ? parameter.name : null;
    if (!isRecord(parameter) || name === null || name === "main") continue;
    const own = new Set([name]);
    walkAst(method.body, (node) => {
      if (node.kind !== "expressionStatement") return;
      const assignment = asNode(node.expression);
      const field =
        assignment?.kind === "binary" && assignment.operator === "="
          ? variableName(assignment.left)
          : null;
      if (field !== null && fieldNames.has(field) && variableName(assignment!.right) === name) {
        own.add(field);
        assignments.add(node);
      }
    });
    let api = false;
    for (const other of methods)
      walkAst(other.body, (node) => {
        if (node.kind === "methodCall" && own.has(variableName(node.object) ?? ""))
          api ||= SEXSCRIPT_API_METHODS.has(constantString(node.method) ?? "");
      });
    if (!api) continue;
    renamed.push(parameter);
    for (const alias of own) aliases.add(alias);
  }
  if (aliases.size === 0) {
    const result = closureMethods ? copy : helperClass;
    scriptObjectClasses.set(helperClass, result);
    return result;
  }
  for (const parameter of renamed) parameter.name = "main";
  const strip = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const item: unknown = value[index];
        if (isAstNode(item) && assignments.has(item)) value.splice(index, 1);
        else strip(item);
      }
      return;
    }
    if (!isAstNode(value)) return;
    if (value.kind === "variable" && aliases.has(variableName(value) ?? "")) value.name = "main";
    for (const child of Object.values(value)) strip(child);
  };
  for (const method of methods) strip(method.body);
  copy.fields = nodeArray(copy.fields).filter((field) => !aliases.has(text(field.name) ?? ""));
  scriptObjectClasses.set(helperClass, copy);
  return copy;
}

/**
 * A static field that holds a closure literal, is never assigned again, and is only ever called works as a method of
 * the class: `def static showWait = { main, msg -> ... }` called as `Helper.showWait(this, "Wait")`. Such fields become
 * methods of the class node, in source order; whether the copied class changed.
 */
function withClosureMethods(helperClass: AstNode): boolean {
  const fields = nodeArray(helperClass.fields);
  const bodies = [
    ...nodeArray(helperClass.methods).map((method) => method.body),
    ...fields.map((field) => field.initialExpression),
  ];
  // Names that are assigned or used as a value anywhere in the class; a call names its method without a variable.
  const used = new Set<string>();
  for (const body of bodies)
    walkAst(body, (node) => {
      const name =
        node.kind === "variable"
          ? variableName(node)
          : node.kind === "binary" &&
              node.operator === "=" &&
              asNode(node.left)?.kind === "property"
            ? constantString(asNode(node.left)!.property)
            : null;
      if (name !== null) used.add(name);
    });
  const converted = new Set<AstNode>();
  const methods: AstNode[] = [];
  for (const field of fields) {
    const name = text(field.name);
    const closure = asNode(field.initialExpression);
    if (field.static !== true || name === null || used.has(name) || closure?.kind !== "closure")
      continue;
    const body = asNode(closure.body);
    if (body?.kind !== "block") continue;
    let implicit = false;
    if (closure.parameterSpecified !== true)
      walkAst(body, (node) => {
        implicit ||= variableName(node) === "it";
      });
    // Parameters are plain records, not nodes.
    const records =
      closure.parameterSpecified === true && Array.isArray(closure.parameters)
        ? closure.parameters.filter(isRecord)
        : [];
    const parameters = implicit
      ? [
          {
            name: "it",
            hasInitialExpression: true,
            initialExpression: { kind: "constant", value: null },
          },
        ]
      : records.map((record) => ({
          name: record.name,
          hasInitialExpression: isAstNode(record.default),
          initialExpression: isAstNode(record.default) ? record.default : null,
        }));
    converted.add(field);
    methods.push({
      kind: "method",
      span: field.span,
      name,
      modifiers: field.modifiers,
      parameters,
      body,
    });
  }
  if (converted.size === 0) return false;
  const line = (node: AstNode): number => node.span?.line ?? 0;
  helperClass.fields = fields.filter((field) => !converted.has(field));
  helperClass.methods = [...nodeArray(helperClass.methods), ...methods].sort(
    (first, second) => line(first) - line(second),
  );
  return true;
}

/** An HTML tag that legacy show() rendered and message markup expresses or drops (markup.ts). */
const SHOWN_HTML_TAG =
  /<\/?(?:b|strong|i|em|u|s|strike|del|br|p|div|font|span|h[1-6]|li|ul|ol|center|textformat)\b[^<>]*>/iu;

/** What the generated helpers return, computed once. */
let helperResults: ReadonlyMap<string, TeaseType> | undefined;

/**
 * Applies TeaseScript's rule that a variable keeps its type (#519): annotates and truncates where a declaration can
 * express the legacy behavior, and turns the declaration of a variable that held values of two types, or a single
 * invalid compound assignment, into code that needs manual migration.
 */
function withEnforcedTypes(statements: IrStatement[], context: LowerContext): IrStatement[] {
  helperResults ??= functionResultTypes(allHelperStatements());
  const result = enforceVariableTypes(statements, helperResults);
  if (result.rangeAppended.length > 0) context.syntheticHelpers.add("concat");
  if (result.partAppended.length > 0) context.syntheticHelpers.add("listPart");
  if (callsFunction([result.statements], "sexscriptLegacyTextAt"))
    context.syntheticHelpers.add("textAt");
  // An element read open, or repeated, through a helper (variable typing).
  if (callsFunction([result.statements], "sexscriptLegacyValue"))
    context.syntheticHelpers.add("value");
  if (callsFunction([result.statements], "sexscriptLegacyTimes"))
    context.syntheticHelpers.add("times");
  // A list or text append no longer needs the note that its `+` operands were not proven numeric.
  const appendedLines = new Set(
    [...result.appended, ...result.textAppended].map((statement) => statement.span?.line),
  );
  const staleNotes = new Set(
    context.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "SX_PLUS_OPERAND_TYPE" && appendedLines.has(diagnostic.span?.line),
    ),
  );
  for (let index = context.diagnostics.length - 1; index >= 0; index -= 1) {
    if (staleNotes.has(context.diagnostics[index]!)) context.diagnostics.splice(index, 1);
  }
  const staleText = new Set(
    [...staleNotes].map(
      (diagnostic) => `// NOTE SX_PLUS_OPERAND_TYPE line ${diagnostic.span?.line}:`,
    ),
  );
  const isStale = (statement: IrStatement): boolean =>
    statement.kind === "comment" && [...staleText].some((text) => statement.text.startsWith(text));
  const replaced = new Map<IrStatement, IrStatement[]>();
  for (const { statement, name, type, first, start } of result.placeholders) {
    const span = statement.span;
    const started = start ?? "empty text";
    const read = start ?? "the empty text";
    const diagnostic: MigrationDiagnostic = {
      code: "SX_PLACEHOLDER_TYPE",
      severity: "warning",
      message:
        first === undefined
          ? `Groovy started '${name}' as ${started} and later stored ${type}; TeaseScript variables keep one type, so it starts as the empty value of that type, which differs only where ${read} was read.`
          : `Groovy started '${name}' as ${started} and later stored ${type}; the TeaseScript variable keeps these types in a union and starts as the empty value of the first, ${first}, which differs only where ${read} was read.`,
      span,
    };
    context.diagnostics.push(diagnostic);
    context.renderedDiagnostics.add(diagnostic);
    replaced.set(statement, [
      {
        kind: "comment",
        text: `// NOTE ${diagnostic.code}${span === null ? "" : ` line ${span.line}`}: ${diagnostic.message}`,
        trailing: false,
        span,
      },
      statement,
    ]);
  }
  for (const statement of result.loadDefaults) {
    const span = statement.span;
    const name =
      statement.kind === "assign" && statement.target.kind === "variable"
        ? statement.target.name
        : "";
    const diagnostic: MigrationDiagnostic = {
      code: "SX_LOAD_KEEPS_VALUE",
      severity: "warning",
      message: `Groovy stored null in '${name}' when this key was missing, which the variable's type cannot hold; the variable keeps its value then.`,
      span,
    };
    context.diagnostics.push(diagnostic);
    context.renderedDiagnostics.add(diagnostic);
    replaced.set(statement, [
      {
        kind: "comment",
        text: `// NOTE ${diagnostic.code}${span === null ? "" : ` line ${span.line}`}: ${diagnostic.message}`,
        trailing: false,
        span: null,
      },
      statement,
    ]);
  }
  for (const { statement, name, type, example, elements } of result.unions) {
    const span = statement.span;
    const diagnostic: MigrationDiagnostic = {
      code: "SX_UNION_TYPE",
      severity: "warning",
      message: elements
        ? `Groovy gave the list '${name}' elements of several types; TeaseScript declares it '${type}' (ADR 0021 §3), so a use of an element that needs one of these types must keep it in a variable and test it first, as in: if item is ${example} { ... }`
        : `Groovy let '${name}' hold values of several types; TeaseScript declares it '${type}' (ADR 0021 §3), so a use that needs one of these types must test it first, as in: if ${name} is ${example} { ... }`,
      span,
    };
    context.diagnostics.push(diagnostic);
    context.renderedDiagnostics.add(diagnostic);
    replaced.set(statement, [
      {
        kind: "comment",
        text: `// NOTE ${diagnostic.code}${span === null ? "" : ` line ${span.line}`}: ${diagnostic.message}`,
        trailing: false,
        span,
      },
      ...(replaced.get(statement) ?? [statement]),
    ]);
  }
  for (const statement of result.textIntegers) {
    const span = statement.span;
    const diagnostic: MigrationDiagnostic = {
      code: "SX_INTEGER_FROM_TEXT",
      severity: "warning",
      message:
        'If this value is text, Groovy stored the character code of its one character in the integer variable ("3" became 51) and failed for longer text; toInteger() reads the number the text spells.',
      span,
    };
    context.diagnostics.push(diagnostic);
    context.renderedDiagnostics.add(diagnostic);
    replaced.set(statement, [
      {
        kind: "comment",
        text: `// NOTE ${diagnostic.code}${span === null ? "" : ` line ${span.line}`}: ${diagnostic.message}`,
        trailing: false,
        span,
      },
      statement,
    ]);
  }
  for (const conflict of result.conflicts) {
    const span = conflict.statement.span;
    const diagnostic: MigrationDiagnostic = {
      code: conflict.code,
      severity: "error",
      message: conflict.message,
      span,
    };
    context.diagnostics.push(diagnostic);
    context.renderedDiagnostics.add(diagnostic);
    replaced.set(conflict.statement, [
      {
        kind: "comment",
        text: `// TODO ${conflict.code}${span === null ? "" : ` line ${span.line}`}: ${singleLine(conflict.message)}`,
        trailing: false,
        span,
      },
      {
        kind: "unsupported",
        legacySource: span === null ? [] : legacySourceLines(context, span),
        span,
      },
    ]);
  }
  if (replaced.size === 0 && staleText.size === 0) return result.statements;
  const replace = (items: IrStatement[]): IrStatement[] =>
    items.flatMap((statement): IrStatement[] => {
      if (isStale(statement)) return [];
      const replacement = replaced.get(statement);
      if (replacement !== undefined) return replacement;
      switch (statement.kind) {
        case "function":
          return [{ ...statement, body: replace(statement.body) }];
        case "if":
          return [{ ...statement, then: replace(statement.then), else: replace(statement.else) }];
        case "while":
        case "repeat":
        case "for":
          return [{ ...statement, body: replace(statement.body) }];
        case "switch":
          return [
            {
              ...statement,
              cases: statement.cases.map((item) => ({ ...item, body: replace(item.body) })),
              default: replace(statement.default),
            },
          ];
        default:
          return [statement];
      }
    });
  return replace(result.statements);
}

function collectHelperFunctionInfo(methods: AstNode[]): Map<string, HelperFunctionInfo> {
  const result = new Map<string, HelperFunctionInfo>();
  for (const method of methods) {
    const name = text(method.name);
    if (method.kind !== "method" || name === null) continue;
    const parameters = groovyParameters(method.parameters) ?? [];
    const stripsMain = parameters[0]?.name === "main";
    const authored = stripsMain ? parameters.slice(1) : parameters;
    const requiredArgs = authored.filter((parameter) => parameter.defaultValue === null).length;
    const minArgs = authored.findLastIndex((parameter) => parameter.defaultValue === null) + 1;
    result.set(name, { minArgs, requiredArgs, maxArgs: authored.length, stripsMain });
  }
  return result;
}

function lowerHelperMethod(
  method: AstNode,
  baseContext: LowerContext,
  helperFunctions: Map<string, HelperFunctionInfo>,
  /** The types of the class's static fields, which its methods read as package variables. */
  fieldTypes: ReadonlyMap<string, ValueType> = new Map(),
): IrStatement | null {
  const name = text(method.name);
  if (method.kind !== "method" || name === null) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_METHOD",
      "error",
      "Auxiliary helper contains an invalid method.",
      method.span,
    );
    return null;
  }
  const records = groovyParameters(method.parameters);
  if (records === null) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_PARAMETER",
      "error",
      `Helper method ${name} has an invalid parameter.`,
      method.span,
    );
    return null;
  }
  const stripsMain = records[0]?.name === "main";
  const authoredRecords = stripsMain ? records.slice(1) : records;
  const body = asNode(method.body);
  if (body?.kind !== "block") {
    addDiagnostic(
      baseContext,
      "SX_HELPER_BODY",
      "error",
      `Helper method ${name} does not contain a normal block body.`,
      method.span,
    );
    return null;
  }
  // The method's own scopes for reading paths: a closure's parameter is apart from a local of its name.
  const pathKeys = bindingKeys(body, `helper:${name}`);
  const context: LowerContext = {
    diagnostics: baseContext.diagnostics,
    metadata: baseContext.metadata,
    functions: collectClosureInfo(body),
    types: withFieldTypes(
      inferVariableTypes(
        body,
        authoredRecords.map((parameter) => parameter.name),
        helperFunctions.keys(),
      ),
      fieldTypes,
    ),
    prelude: [],
    statementRoot: null,
    postlude: [],
    postludeRoot: null,
    shadowingReferences: collectShadowingReferences(body, collectClosureInfo(body)),
    classLoaderVariables: new Set(),
    legacyHelperClasses: new Map(),
    helperFunctions,
    helperMainParameter: stripsMain ? "main" : null,
    packageHelperRegistry: baseContext.packageHelperRegistry,
    syntheticHelpers: baseContext.syntheticHelpers,
    functionDepth: 1,
    comments: baseContext.comments,
    sourceLines: baseContext.sourceLines,
    renderedDiagnostics: baseContext.renderedDiagnostics,
    packageFunctions: baseContext.packageFunctions,
    stableNames: baseContext.stableNames,
    storageLiterals: baseContext.storageLiterals,
    nonTextKeys: baseContext.nonTextKeys,
    nonBooleanKeys: baseContext.nonBooleanKeys,
    copiedImages: baseContext.copiedImages,
    unreachable: false,
    mixinModules: baseContext.mixinModules,
    loadsModuleDirectories: baseContext.loadsModuleDirectories,
    resultUses: baseContext.resultUses,
    directoryFiles: baseContext.directoryFiles,
    scriptPaths: baseContext.scriptPaths,
    dateValues: new Set(),
    aliasedLists: new Set(),
    parameterBindings: parameterBindings(
      body,
      null,
      authoredRecords.map((parameter) => parameter.name),
    ),
    assignedValues: assignedValues(body, new Map()),
    compoundValues: compoundValues(body, new Map()),
    declaredWrites: declaredWrites(body, new Map()),
    menuIndexes: menuIndexes(body),
    nullElementLists: new Set(),
    mapUses: baseContext.mapUses,
    bindings: new Map(),
    integerVariables: new Set(),
    integerArrays: new Set(),
    textVariables: new Set(),
    walkedEntries: new Map(),
    changingPaths: new Set([
      ...changingVariables(body, pathKeys),
      ...records.map((parameter) => parameter.name),
    ]),
    pathBindings: { keys: pathKeys, values: assignedValues(body, pathKeys) },
    constantInitializers: new Map(),
    knownKeys: [],
    writeTargets: new Set(),
    indexedSplits: new Set(),
    accepted: baseContext.accepted,
    elementRemovals: elementRemovals(body),
    media: baseContext.media,
    files: baseContext.files,
    actualFiles: baseContext.actualFiles,
    ...fileTests(body),
    photoVariables: photoVariables(body),
    checksUndefinedVariables: baseContext.checksUndefinedVariables,
    java: javaFileState(body, null, baseContext.java),
    currentFunction: {
      name,
      locals: functionLocalNames(
        body,
        authoredRecords.map((parameter) => parameter.name),
      ),
    },
    closureFunctions: baseContext.closureFunctions,
    actions: baseContext.actions,
    ignoredInputs: 0,
    switchValues: 0,
    popupTimers: 0,
    generatedNames: new Set(),
  };
  const parameters: IrFunctionParameter[] = [];
  const lastRequired = authoredRecords.findLastIndex(
    (parameter) => parameter.defaultValue === null,
  );
  for (const [position, parameter] of authoredRecords.entries()) {
    const parameterName = parameter.name;
    // A default before a required parameter only applied to calls that left the parameter out (see minArgs).
    const initial = position < lastRequired ? null : parameter.defaultValue;
    const defaultValue = initial === null ? null : lowerExpression(initial, context);
    if (initial !== null && defaultValue === null) {
      addDiagnostic(
        context,
        "SX_HELPER_PARAMETER_DEFAULT",
        "error",
        `Default value for helper parameter ${parameterName} could not be migrated.`,
        method.span,
      );
    }
    parameters.push({ name: parameterName, defaultValue });
  }
  return {
    kind: "function",
    name,
    parameters,
    body: lowerBlock(
      method.returnType === "void" || !context.resultUses.has(name)
        ? body
        : withImplicitReturn(body, context),
      context,
    ),
    span: method.span,
  };
}

function lowerBlock(block: AstNode, context: LowerContext): IrStatement[] {
  return lowerStatementList(nodeArray(block.statements), block.span, context);
}

/** Lowers statements in source order and interleaves the comments that precede or follow them. */
function lowerStatementList(
  statements: AstNode[],
  enclosingSpan: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const result: IrStatement[] = [];
  let previousEndLine: number | null = null;
  const emitComments = (comments: SourceComment[]): void => {
    for (const comment of comments) {
      result.push(...paragraphBreak(context, previousEndLine, comment.line));
      result.push(commentStatement(comment, previousEndLine));
      previousEndLine = comment.endLine;
    }
  };
  let added = 0;
  // Null defaults that moved to their read further up (laterReadDefault).
  const consumed = new Set<number>();
  for (let index = 0; index < statements.length; index += 1) {
    if (consumed.has(index)) continue;
    // A getBooleans whose null result the next statement tests offers the dialog's Cancel (cancelledBooleans).
    const booleansStart = context.diagnostics.length;
    // Comments before the ask stay before it rather than going into the branch of the test.
    const commentsStart = context.comments.next;
    const booleansSpan = statementSpan(statements[index]!);
    const booleansComments = takeCommentsBefore(context, booleansSpan);
    const cancelled = cancelledBooleans(statements, index, context);
    if (cancelled === null) context.comments.next = commentsStart;
    else {
      emitComments(booleansComments);
      if (booleansSpan !== null)
        result.push(...paragraphBreak(context, previousEndLine, booleansSpan.line));
      result.push(...diagnosticNotes(context, booleansStart), ...cancelled);
      const last = statementSpan(statements[index + 1]!);
      if (last !== null) previousEndLine = last.endLine;
      index += 1;
      continue;
    }
    // A run of settings asks, each saved right away, becomes one form (lowerSettingsForm).
    const run = settingsRun(statements, index, context);
    const formStart = context.diagnostics.length;
    const form = run === null ? null : lowerSettingsForm(run.asks, context);
    if (run !== null && form !== null) {
      const first = statementSpan(statements[index]!);
      emitComments(takeCommentsBefore(context, first));
      if (first !== null) result.push(...paragraphBreak(context, previousEndLine, first.line));
      result.push(...diagnosticNotes(context, formStart), ...form);
      const last = statementSpan(statements[index + run.count - 1]!);
      if (last !== null) previousEndLine = last.endLine;
      index += run.count - 1;
      continue;
    }
    // Read-then-default code becomes one read with a default; the `if` is consumed.
    let merged = consumed.has(index + 1)
      ? null
      : readThenDefault(statements[index]!, statements[index + 1], context);
    if (merged !== null) index += 1;
    else {
      const later = laterReadDefault(statements, index, consumed, context);
      merged =
        later < 0 ? null : readThenDefault(statements[index]!, statements[later], context, false);
      if (merged !== null) consumed.add(later);
    }
    merged ??= branchReadDefaults(statements, index, consumed, context);
    const statement = merged ?? statements[index]!;
    const span = statementSpan(statement);
    emitComments(takeCommentsBefore(context, span));
    if (span !== null) result.push(...paragraphBreak(context, previousEndLine, span.line));
    const firstDiagnostic = context.diagnostics.length;
    const [prelude, lowered, postlude] = withSurroundings(context, statement);
    const only = lowered.length === 1 ? lowered[0] : undefined;
    if (only?.kind === "unsupported" && span !== null) {
      only.legacySource = legacySourceLines(context, span);
    }
    result.push(...diagnosticNotes(context, firstDiagnostic), ...prelude, ...lowered, ...postlude);
    if (span !== null) previousEndLine = span.endLine;
    // Keys this statement leaves present stay known for the rest of the list (#536).
    const rest: AstNode = { kind: "block", span: null, statements: statements.slice(index + 1) };
    const facts = keptFacts(factsAfter(statement, context), rest, context);
    context.knownKeys.push(...facts);
    added += facts.length;
  }
  context.knownKeys.splice(context.knownKeys.length - added, added);
  emitComments(takeCommentsBefore(context, enclosingSpan === null ? null : endOf(enclosingSpan)));
  return withCountedLoops(withVisibleCountdowns(withReusedLoopCounters(result), context));
}

/**
 * Groovy scoped the counter a C-style `for` declares to its loop, so later loops declare `i` again, also in a nested
 * block; TeaseScript declares a visible name once, so a later loop assigns the counter instead. A function has its own
 * names.
 */
function withReusedLoopCounters(
  statements: IrStatement[],
  visible: ReadonlySet<string> = new Set(),
): IrStatement[] {
  const counters = new Set(visible);
  return statements.map((statement): IrStatement => {
    if (statement.kind !== "let" || statement.loopCounter !== true) {
      return counters.size === 0
        ? statement
        : withNestedStatements(statement, (body) => withReusedLoopCounters(body, counters));
    }
    if (!counters.has(statement.name)) {
      counters.add(statement.name);
      return statement;
    }
    return {
      kind: "assign",
      target: { kind: "variable", name: statement.name },
      operator: "=",
      value: statement.value,
      span: statement.span,
    };
  });
}

/** The statement with each block it contains, other than a function body, mapped by `map`. */
function withNestedStatements(
  statement: IrStatement,
  map: (body: IrStatement[]) => IrStatement[],
): IrStatement {
  switch (statement.kind) {
    case "if":
      return { ...statement, then: map(statement.then), else: map(statement.else) };
    case "while":
    case "repeat":
    case "for":
      return { ...statement, body: map(statement.body) };
    case "switch":
      return {
        ...statement,
        cases: statement.cases.map((item) => ({ ...item, body: map(item.body) })),
        default: map(statement.default),
      };
    default:
      return statement;
  }
}

/**
 * A loop that only redraws a countdown until `waited = getAbsoluteDateTime().toSeconds() - start` reaches a limit kept the
 * legacy player busy for that time; TeaseScript runs it out of its instruction budget. Right after `waited` is computed, with a
 * body that only shows text and sets its own locals before recomputing `waited`, it becomes a visible timer over the
 * limit (`timer`, as for waitWithGauge), whose display replaces the redrawn text; a limit not above 0 runs no timer, as
 * the loop did not run.
 */
function withVisibleCountdowns(statements: IrStatement[], context: LowerContext): IrStatement[] {
  return statements.flatMap((statement, index): IrStatement[] => {
    if (statement.kind !== "while") return [statement];
    const condition = statement.condition;
    if (
      condition.kind !== "binary" ||
      condition.operator !== "<" ||
      condition.left.kind !== "variable" ||
      (condition.right.kind !== "variable" && condition.right.kind !== "literal")
    ) {
      return [statement];
    }
    const waited = condition.left.name;
    const previous = statements
      .slice(0, index)
      .findLast((item) => item.kind !== "comment" && item.kind !== "blank");
    const start = previous === undefined ? null : elapsedStart(previous, waited);
    const last = statement.body.at(-1);
    const locals = new Set<string>();
    if (
      start === null ||
      last === undefined ||
      elapsedStart(last, waited) !== start ||
      !statement.body.slice(0, -1).every((item) => isDisplayOnly(item, locals))
    ) {
      return [statement];
    }
    const firstDiagnostic = context.diagnostics.length;
    addDiagnostic(
      context,
      "SX_BUSY_COUNTDOWN",
      "warning",
      "The legacy loop redrew a countdown as fast as it could until the time was up; it became a visible timer over the same time, whose display replaces the redrawn text.",
      statement.span,
    );
    const timer: IrStatement = {
      kind: "wait",
      duration: condition.right,
      visible: true,
      unit: "s",
      span: statement.span,
    };
    // A limit already reached, such as a negative typed time, ran the legacy loop not once.
    const limit = condition.right.kind === "literal" ? condition.right.value : null;
    return [
      ...diagnosticNotes(context, firstDiagnostic),
      ...(typeof limit === "number"
        ? limit > 0
          ? [timer]
          : []
        : [
            {
              kind: "if",
              condition: {
                kind: "binary",
                operator: ">",
                left: condition.right,
                right: { kind: "literal", value: 0 },
              },
              then: [timer],
              else: [],
              span: statement.span,
            } satisfies IrStatement,
          ]),
    ];
  });
}

/**
 * A loop over an inclusive range whose only statement adds a number to a variable, `for it in 1..=n { p += 1 }`, only
 * counts; Groovy finished it at once, while TeaseScript runs it out of its instruction budget for a large n. It adds the
 * count in one step where the range is not empty: `if n >= 1 { p += n }`. The bounds are read twice, so they must be
 * free of effects.
 */
function withCountedLoops(statements: IrStatement[]): IrStatement[] {
  return statements.map((statement): IrStatement => {
    if (statement.kind !== "for" || statement.collection.kind !== "range") return statement;
    const { from, to, inclusive } = statement.collection;
    const [only, ...rest] = statement.body;
    if (
      !inclusive ||
      rest.length > 0 ||
      only?.kind !== "assign" ||
      (only.operator !== "+=" && only.operator !== "-=") ||
      only.target.kind !== "variable" ||
      only.target.name === statement.variable ||
      only.value.kind !== "literal" ||
      typeof only.value.value !== "number" ||
      !isRepeatableBound(from) ||
      !isRepeatableBound(to)
    )
      return statement;
    const count: IrExpression =
      from.kind === "literal" && from.value === 1
        ? to
        : {
            kind: "binary",
            operator: "+",
            left: { kind: "binary", operator: "-", left: to, right: from },
            right: { kind: "literal", value: 1 },
          };
    const step = only.value.value;
    return {
      kind: "if",
      condition: { kind: "binary", operator: ">=", left: to, right: from },
      then: [
        {
          ...only,
          value:
            step === 1 ? count : { kind: "binary", operator: "*", left: count, right: only.value },
        },
      ],
      else: [],
      span: statement.span,
    };
  });
}

/** Whether a range bound reads the same value twice: literals, variables, and `floor` and arithmetic of these. */
function isRepeatableBound(value: IrExpression): boolean {
  switch (value.kind) {
    case "literal":
    case "variable":
      return true;
    case "binary":
      return (
        ["+", "-", "*"].includes(value.operator) &&
        isRepeatableBound(value.left) &&
        isRepeatableBound(value.right)
      );
    case "call":
      return (
        ["floor", "ceil", "round"].includes(value.name) &&
        Object.keys(value.named).length === 0 &&
        value.positional.every(isRepeatableBound)
      );
    default:
      return false;
  }
}

/** The start variable of `waited = getAbsoluteDateTime().toSeconds() - start` (declaration or assignment), or null. */
function elapsedStart(statement: IrStatement, waited: string): string | null {
  const value =
    statement.kind === "let" && statement.name === waited
      ? statement.value
      : statement.kind === "assign" &&
          statement.operator === "=" &&
          statement.target.kind === "variable" &&
          statement.target.name === waited
        ? statement.value
        : null;
  if (
    value?.kind !== "binary" ||
    value.operator !== "-" ||
    !isCurrentSeconds(value.left) ||
    value.right.kind !== "variable"
  ) {
    return null;
  }
  return value.right.name;
}

/**
 * The current Unix time in seconds, which legacy code used for elapsed time and "how long ago": an `absoluteDateTime` is the
 * fixed moment for that, while local date and time values have no zone (#532).
 */
function currentSeconds(): IrExpression {
  return {
    kind: "methodCall",
    target: { kind: "call", name: "getAbsoluteDateTime", positional: [], named: {} },
    name: "toSeconds",
    arguments: [],
  };
}

function isCurrentSeconds(value: IrExpression): boolean {
  return (
    value.kind === "methodCall" &&
    value.name === "toSeconds" &&
    value.arguments.length === 0 &&
    value.target.kind === "call" &&
    value.target.name === "getAbsoluteDateTime" &&
    value.target.positional.length === 0
  );
}

/** Whether a loop statement only shows text and computes locals it declares itself. */
function isDisplayOnly(statement: IrStatement, locals: Set<string>): boolean {
  switch (statement.kind) {
    case "say":
      return !hasIrCall(statement.value);
    case "let":
      locals.add(statement.name);
      return !hasIrCall(statement.value);
    case "assign":
      return (
        statement.target.kind === "variable" &&
        locals.has(statement.target.name) &&
        !hasIrCall(statement.value)
      );
    case "if":
      return (
        !hasIrCall(statement.condition) &&
        statement.then.every((item) => isDisplayOnly(item, new Set(locals))) &&
        statement.else.every((item) => isDisplayOnly(item, new Set(locals)))
      );
    case "comment":
    case "blank":
      return true;
    default:
      return false;
  }
}

/** Whether an expression calls anything or asks for input, which a display-only loop body may not do. */
function hasIrCall(expression: IrExpression): boolean {
  switch (expression.kind) {
    case "call":
    case "methodCall":
    case "input":
    case "choice":
    case "listChoice":
    case "load":
      return true;
    case "button":
    case "message":
      return true;
    case "literal":
    case "duration":
    case "variable":
      return false;
    case "list":
      return expression.items.some(hasIrCall);
    case "object":
      return expression.properties.some(
        (property) =>
          hasIrCall(property.value) || (property.key !== undefined && hasIrCall(property.key)),
      );
    case "index":
      return hasIrCall(expression.target) || hasIrCall(expression.index);
    case "property":
      return hasIrCall(expression.target);
    case "range":
      return hasIrCall(expression.from) || hasIrCall(expression.to);
    case "unary":
    case "typeTest":
      return hasIrCall(expression.value);
    case "binary":
      return hasIrCall(expression.left) || hasIrCall(expression.right);
    case "template":
      return expression.parts.some((part) => "value" in part && hasIrCall(part.value));
  }
}

/** Keeps one blank line where the legacy source separated statements or comments by blank lines. */
function paragraphBreak(
  context: LowerContext,
  previousEndLine: number | null,
  nextLine: number,
): IrStatement[] {
  if (previousEndLine === null || nextLine <= previousEndLine + 1) return [];
  const gap = context.sourceLines.slice(previousEndLine, nextLine - 1);
  return gap.length > 0 && gap.every((line) => line.trim() === "")
    ? [{ kind: "blank", span: null }]
    : [];
}

/**
 * Whether the statements never reach their end: the last statement that runs is a transfer or `exit`, or branches that
 * all are. Function declarations do not run in place.
 */
function terminates(statements: readonly IrStatement[]): boolean {
  const last = statements.findLast(
    (statement) => !["comment", "blank", "function"].includes(statement.kind),
  );
  switch (last?.kind) {
    case "goto":
    case "exit":
      return true;
    case "if":
      return last.else.length > 0 && terminates(last.then) && terminates(last.else);
    case "switch":
      return (
        last.default.length > 0 &&
        terminates(last.default) &&
        last.cases.every((item) => terminates(item.body))
      );
    default:
      return false;
  }
}

/** Like withPrelude, with `root` as the evaluation point for prompt placement. */
function withStatementRoot<T>(
  context: LowerContext,
  root: AstNode,
  lower: () => T,
): [IrStatement[], T] {
  const outerRoot = context.statementRoot;
  context.statementRoot = root;
  try {
    return withPrelude(context, lower);
  } finally {
    context.statementRoot = outerRoot;
  }
}

/** Lowers one statement of a statement list with the statements that must run right before and after it. */
function withSurroundings(
  context: LowerContext,
  statement: AstNode,
): [IrStatement[], IrStatement[], IrStatement[]] {
  const outer = { postlude: context.postlude, root: context.postludeRoot };
  context.postlude = [];
  context.postludeRoot = statement;
  try {
    const [prelude, lowered] = withPrelude(context, () => lowerStatement(statement, context));
    return [prelude, lowered, context.postlude];
  } finally {
    context.postlude = outer.postlude;
    context.postludeRoot = outer.root;
  }
}

/** Runs `lower` with an empty prelude and returns the prelude statements it produced. */
function withPrelude<T>(context: LowerContext, lower: () => T): [IrStatement[], T] {
  const outer = context.prelude;
  context.prelude = [];
  try {
    const result = lower();
    return [context.prelude, result];
  } finally {
    context.prelude = outer;
  }
}

/** Groovy omits positions on some expression statements; fall back to the expression. */
function statementSpan(node: AstNode): SourceSpan | null {
  return node.span ?? asNode(node.expression)?.span ?? null;
}

function endOf(span: SourceSpan): SourceSpan {
  return {
    line: span.endLine,
    column: span.endColumn,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}

function takeCommentsBefore(context: LowerContext, span: SourceSpan | null): SourceComment[] {
  if (span === null) return [];
  const queue = context.comments;
  const start = queue.next;
  while (queue.next < queue.items.length) {
    const comment = queue.items[queue.next]!;
    const before =
      comment.line < span.line || (comment.line === span.line && comment.column < span.column);
    if (!before) break;
    queue.next += 1;
  }
  return queue.items.slice(start, queue.next);
}

function commentStatement(comment: SourceComment, previousEndLine: number | null): IrStatement {
  return {
    kind: "comment",
    text: comment.text.replace(/\r\n?/gu, "\n"),
    trailing: previousEndLine !== null && comment.line === previousEndLine,
    span: {
      line: comment.line,
      column: comment.column,
      endLine: comment.endLine,
      endColumn: comment.column,
    },
  };
}

function lowerStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const outerRoot = context.statementRoot;
  context.statementRoot = node;
  try {
    return lowerStatementNode(node, context);
  } finally {
    context.statementRoot = outerRoot;
  }
}

function lowerStatementNode(node: AstNode, context: LowerContext): IrStatement[] {
  if (
    node.kind === "importerNote" &&
    typeof node.code === "string" &&
    typeof node.message === "string"
  ) {
    // Placed by an AST desugaring so the explanation renders next to the rewritten code.
    addDiagnostic(context, node.code, "warning", node.message, node.span);
    return [];
  }
  const conditional = lowerConditionalStatement(node, context);
  if (conditional !== null) return conditional;
  switch (node.kind) {
    case "empty":
      return [];
    case "expressionStatement":
      return lowerExpressionStatement(node, context);
    case "if":
      return lowerIf(node, context);
    case "while":
      return lowerWhile(node, context);
    case "for":
      return lowerFor(node, context);
    case "switch":
      return lowerSwitch(node, context);
    // A labelled block statement, `Check: { ... }`, runs its statements in place; one that declares variables keeps
    // them in a scope of their own, as `if true { ... }`.
    case "block": {
      const statements = lowerBlock(node, context);
      const declares = nodeArray(node.statements).some(
        (statement) =>
          statement.kind === "declaration" || asNode(statement.expression)?.kind === "declaration",
      );
      return declares
        ? [
            {
              kind: "if",
              condition: { kind: "literal", value: true },
              then: statements,
              else: [],
              span: node.span,
            },
          ]
        : statements;
    }
    case "return":
      return lowerReturnStatement(node, context);
    case "break":
    case "continue":
      if (typeof node.label === "string") {
        return [
          unsupportedStatement(
            context,
            node,
            "SX_LABELLED_JUMP",
            node.kind === "continue"
              ? `continue ${node.label} jumps to a labelled loop or statement, which Groovy also allowed outside any loop as a jump back to that statement; TeaseScript continue affects only the innermost loop. Restructure the code, for example with a loop and a flag.`
              : `break ${node.label} leaves an outer labelled loop; TeaseScript break affects only the innermost loop. Restructure the loops, for example with a flag.`,
          ),
        ];
      }
      return [{ kind: node.kind, span: node.span }];
    case "tryCatch": {
      const kept = tryBody(node, context);
      if (kept !== null) return kept;
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_STATEMENT",
          `Unsupported Groovy statement: ${node.kind}`,
        ),
      ];
    }
    default:
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_STATEMENT",
          `Unsupported Groovy statement: ${node.kind}`,
        ),
      ];
  }
}

/** Calls and constructions whose failure a legacy catch handled: number parsing, files, network, and programs. */
const FALLIBLE_CALLS = new Set([
  "parseInt",
  "parseDouble",
  "parseFloat",
  "parseLong",
  "valueOf",
  "toInteger",
  "toDouble",
  "toFloat",
  "toLong",
  "toBigDecimal",
  "toURL",
  "openConnection",
  "openStream",
  "readLines",
  "getText",
  "newReader",
  "withReader",
  "eachLine",
  "execute",
  "exitValue",
  "waitFor",
  "waitForOrKill",
  "getBytes",
  "decode",
]);

/**
 * A try block whose body has nothing that fails on purpose, such as waits, sounds, or device states: TeaseScript has no
 * exceptions, so the body runs in its own block without the catch, then the finally block, with a note. Null for a
 * body that may throw what the catch handled, or that does not convert.
 */
function tryBody(node: AstNode, context: LowerContext): IrStatement[] | null {
  const block = asNode(node.try);
  const after = asNode(node.finally);
  if (block?.kind !== "block") return null;
  let fallible = false;
  walkAst(block, (child) => {
    if (child.kind === "throw" || child.kind === "cast") fallible = true;
    if (child.kind === "methodCall" && FALLIBLE_CALLS.has(constantString(child.method) ?? ""))
      fallible = true;
    if (
      child.kind === "constructorCall" &&
      /URL|Reader|Stream|Socket|Process|File/u.test(String(child.type))
    )
      fallible = true;
  });
  if (fallible) return null;
  const diagnostics = context.diagnostics.length;
  const body = lowerBlock(block, context);
  if (context.diagnostics.slice(diagnostics).some(({ severity }) => severity === "error")) {
    context.diagnostics.length = diagnostics;
    return null;
  }
  const last = after?.kind === "block" ? lowerBlock(after, context) : [];
  addDiagnostic(
    context,
    "SX_TRY_WITHOUT_CATCH",
    "warning",
    "Legacy caught errors in this block; TeaseScript has no exceptions, so the block runs without its catch, and an error here stops the script.",
    node.span,
  );
  // The block keeps its own scope, as Groovy's try block did.
  return [
    {
      kind: "if",
      condition: { kind: "literal", value: true },
      then: body,
      else: [],
      span: node.span ?? null,
    },
    ...last,
  ];
}

/**
 * TeaseScript has no conditional expression. A statement holding a Groovy ternary or Elvis expression, or a `&&` /
 * `||` whose right side holds one or an input, is rewritten before lowering: a conditional variable value becomes one
 * assignment per branch; another expression statement is repeated in both branches where the condition may run
 * first, so nested conditionals become `else if` chains; anything else computes the conditional part into a
 * temporary first (hoistDeferred).
 */
function lowerConditionalStatement(node: AstNode, context: LowerContext): IrStatement[] | null {
  const root = asNode(
    node.kind === "return"
      ? node.value
      : node.kind === "expressionStatement"
        ? node.expression
        : node.kind === "if"
          ? node.condition
          : node.kind === "switch"
            ? node.expression
            : null,
  );
  const deferred = root === null ? null : findDeferred(root, context);
  if (root === null || deferred === null) return null;
  const span = node.span;
  // `x += c ? a : b` reads `x` first and writes it last: as `x = x + (c ? a : b)`, the read may move into a temporary
  // while the write stays with `x`.
  const compoundOperator =
    root.kind === "binary" && typeof root.operator === "string" ? root.operator : "";
  const compoundTarget = asNode(root.left);
  if (
    ["+=", "-=", "*=", "/="].includes(compoundOperator) &&
    node.kind === "expressionStatement" &&
    (compoundTarget?.kind === "variable" ||
      (compoundTarget !== null && isRepeatableIndex(compoundTarget)))
  ) {
    const expanded: AstNode = {
      kind: "binary",
      span: root.span,
      operator: "=",
      left: root.left,
      right: {
        kind: "binary",
        span: root.span,
        operator: compoundOperator.slice(0, -1),
        left: { ...asNode(root.left)! },
        right: root.right,
      },
    };
    return lowerStatement({ ...node, expression: expanded }, context);
  }
  // A menu converts in place where its loop may run before the statement.
  const menu = legacyApiCall(deferred, context)?.name === "getSelectedValue";
  const menuList = menu ? listPlusOperands(callParts(deferred)!.arguments[1]!).at(-1)! : null;
  if (menuList !== null && (deferred === root || isHoistable(node, deferred, context, menuList)))
    return null;

  const isAssignment =
    root.kind === "declaration" || (root.kind === "binary" && root.operator === "=");
  const target = isAssignment ? asNode(root.left) : null;
  // A collection loop that is a variable's whole value already becomes a loop for that variable, and a menu over
  // one converts as a statement's value.
  if (
    (isCollectionLoop(deferred, context) || menu) &&
    target !== null &&
    variableName(target) !== null &&
    (root.kind === "declaration" || root.operator === "=") &&
    asNode(root.right) === deferred
  )
    return null;
  if (
    regexWorkaround(deferred) !== null &&
    target !== null &&
    variableName(target) !== null &&
    (root.kind === "declaration" || root.operator === "=") &&
    asNode(root.right) === deferred
  ) {
    return (
      lowerRegexWorkaround(
        root.kind === "declaration",
        variableName(target)!,
        deferred,
        span,
        context,
        target,
      ) ?? [
        unsupportedStatement(
          context,
          deferred,
          "SX_STRING_METHOD",
          "This regular expression could not be converted.",
        ),
      ]
    );
  }
  const conditionalForm =
    deferred.kind === "ternary" ||
    deferred.kind === "elvis" ||
    (deferred.kind === "binary" && (deferred.operator === "&&" || deferred.operator === "||"));
  if (
    conditionalForm &&
    target !== null &&
    variableName(target) !== null &&
    asNode(root.right) === deferred
  ) {
    return lowerConditionalAssignment(root.kind === "declaration", target, deferred, span, context);
  }
  const conditional = deferred.kind === "ternary" || deferred.kind === "elvis";
  const statementForm = node.kind === "expressionStatement" || node.kind === "return";
  // Repeating the statement per branch evaluates the condition first, which is only equivalent when nothing
  // with side effects runs earlier in the statement. A declaration keeps one statement, so its type stays plain.
  const hoistedCondition = asNode(
    deferred.kind === "ternary" ? deferred.condition : deferred.boolean,
  );
  const split = conditional ? splitConditional(deferred) : null;
  if (
    statementForm &&
    root.kind !== "declaration" &&
    split !== null &&
    hoistedCondition !== null &&
    repeatsLittle(node, deferred, split, context) &&
    isHoistable(node, deferred, context, hoistedCondition)
  ) {
    return lowerStatement(
      syntheticIf(
        split.condition,
        substituteNode(node, deferred, split.whenTrue),
        substituteNode(node, deferred, split.whenFalse),
        span,
      ),
      context,
    );
  }
  return (
    hoistDeferred(node, root, deferred, context) ?? [
      unsupportedStatement(
        context,
        deferred,
        "SX_CONDITIONAL_POSITION",
        "This conditional expression cannot be computed first without changing behavior: a list or map read earlier in the statement may be changed by its side effects. Rewrite it with an explicit if.",
      ),
    ]
  );
}

/**
 * Whether repeating a statement per branch of its conditional stays small: a return, an update of one variable, or a
 * call with one argument, whose other conditionals, if any, sit inside the branches, as in a chain `a ? x : b ? y : z`.
 * A larger statement, such as a
 * dialogue call with several text fragments, computes its conditionals into temporaries instead, so its text is
 * written once (hoistDeferred).
 */
function repeatsLittle(
  statement: AstNode,
  deferred: AstNode,
  split: { whenTrue: AstNode; whenFalse: AstNode },
  context: LowerContext,
): boolean {
  if (statement.keepsWhole === true) return false;
  const expression = statement.kind === "return" ? null : asNode(statement.expression);
  const small =
    statement.kind === "return" ||
    // `c ? show(a) : speak(b)` as a statement is an if with a call per branch.
    expression === deferred ||
    (expression?.kind === "methodCall" &&
      nodeArray(asNode(expression.arguments)?.items).length <= 1) ||
    // `text += c ? a : b` updates one variable.
    (expression?.kind === "binary" &&
      ["=", "+=", "-=", "*=", "/="].includes(text(expression.operator) ?? "") &&
      variableName(expression.left) !== null);
  const inside = (branch: AstNode): boolean => {
    const rest = findDeferred(substituteNode(statement, deferred, branch), context);
    if (rest === null) return true;
    let found = false;
    walkAst(branch, (node) => (found ||= node === rest));
    return found;
  };
  return small && inside(split.whenTrue) && inside(split.whenFalse);
}

/**
 * The first part of an expression, in evaluation order, that TeaseScript cannot express inside a larger expression: a
 * ternary or Elvis expression (other than a dict fallback, dictDefault), or a `&&` / `||` whose right side holds one or
 * an input, which may run only when the left side allows it. Closure bodies are not evaluated in place.
 */
function findDeferred(
  node: AstNode,
  context: LowerContext,
  /** Whether a collection loop here is an input's options, which the input converts itself. */
  inputOptions = false,
): AstNode | null {
  if (node.kind === "closure") return null;
  // A collection method with a closure becomes a loop before the statement (lowerCollectionAssignment), as does a
  // regular expression with a workaround (lowerRegexWorkaround).
  if (!inputOptions && (isCollectionLoop(node, context) || regexWorkaround(node) !== null)) {
    // The receiver runs first, so a part of it that needs its own statement comes first.
    const receiver = asNode(node.object);
    return (receiver === null ? null : findDeferred(receiver, context)) ?? node;
  }
  if ((node.kind === "ternary" || node.kind === "elvis") && dictDefault(node, context) === null)
    return node;
  if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
    const right = asNode(node.right);
    if (right !== null && needsOwnStatement(right, context)) return node;
  }
  // A menu over a list that a loop builds converts at the start of its own statement (runtimeListSelectedValue).
  const call = node.kind === "methodCall" ? legacyApiCall(node, context) : null;
  const input = call?.name === "getSelectedValue";
  if (input && !inputOptions && isLoopMenu(node, context)) {
    // Its message, such as a ternary, is computed before the options.
    const message = nodeArray(asNode(node.arguments)?.items)[0];
    return (message === undefined ? null : findDeferred(message, context)) ?? node;
  }
  for (const child of evaluationChildren(node)) {
    const options = input && child.kind === "arguments" ? nodeArray(child.items) : [];
    const found =
      options.length > 0
        ? options.reduce<AstNode | null>(
            (first, item) => first ?? findDeferred(item, context, true),
            null,
          )
        : findDeferred(child, context);
    if (found !== null) return found;
  }
  // Groovy's logical & and | evaluate both sides, so a right side with effects runs before the `and`/`or`.
  const right = node.kind === "binary" ? asNode(node.right) : null;
  if (
    (node.operator === "&" || node.operator === "|") &&
    right !== null &&
    !isPure(right, context) &&
    isLogicalOperation(node, context)
  )
    return right;
  return null;
}

/**
 * Whether an expression is a Groovy collection method that lowerCollectionAssignment turns into a loop: `collect`,
 * `findAll`, `find`, `any`, `every`, or `sum` with a one-parameter closure that ends in its result (or `sum()`), on a
 * list or range.
 */
function isCollectionLoop(node: AstNode, context: LowerContext): boolean {
  const call = node.kind === "methodCall" ? callParts(node) : null;
  const receiver = asNode(node.object);
  if (call === null || call.inherited || receiver === null) return false;
  if (!["collect", "findAll", "find", "any", "every", "sum"].includes(call.name)) return false;
  if (receiver.kind !== "range" && !isKnownListExpression(receiver, context)) return false;
  if (call.name === "sum" && call.arguments.length === 0) return true;
  // `collect()` without a closure collects each element as it is.
  if (call.name === "collect" && call.arguments.length === 0) return true;
  const argument = closureArgument(call.arguments);
  return (
    argument !== null &&
    argument.parameters.length === 1 &&
    closureResult(argument.closure) !== null
  );
}

/** Whether a getSelectedValue() call takes its options from a collection loop, as `["Back"] + list.collect { }`. */
function isLoopMenu(node: AstNode, context: LowerContext): boolean {
  const optionsNode = callParts(node)?.arguments[1];
  const listNode = optionsNode === undefined ? undefined : listPlusOperands(optionsNode).at(-1);
  return listNode !== undefined && isCollectionLoop(listNode, context);
}

/** Whether an expression holds a conditional expression or an input, which need a statement of their own. */
function needsOwnStatement(node: AstNode, context: LowerContext): boolean {
  if (node.kind === "closure") return false;
  if (isCollectionLoop(node, context) || regexWorkaround(node) !== null) return true;
  if ((node.kind === "ternary" || node.kind === "elvis") && dictDefault(node, context) === null)
    return true;
  const call = node.kind === "methodCall" ? legacyApiCall(node, context) : null;
  if (call !== null && INPUT_CALLS.has(call.name)) return true;
  return nodeChildren(node).some((child) => needsOwnStatement(child, context));
}

/**
 * The parts of an expression in Groovy's evaluation order; an assignment's variable target, a method name, and the
 * implicit receiver of a script call are not evaluated, and an indexed target evaluates its list and position.
 */
function evaluationChildren(node: AstNode): AstNode[] {
  if (node.kind === "closure") return [];
  if (node.kind === "methodCall") {
    const receiver = node.implicitThis === true ? null : asNode(node.object);
    const args = asNode(node.arguments);
    return [...(receiver === null ? [] : [receiver]), ...(args === null ? [] : [args])];
  }
  if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) {
    const left = asNode(node.left);
    const right = asNode(node.right);
    const evaluated = left !== null && left.kind !== "variable" && left.kind !== "arguments";
    const targetParts =
      left !== null && left.kind === "binary" && left.operator === "["
        ? evaluationChildren(left)
        : evaluated
          ? [left]
          : [];
    return [...targetParts, ...(right === null ? [] : [right])];
  }
  return nodeChildren(node);
}

/** The nodes from `node` down to `target` along evaluated parts; null when `target` is not among them. */
function evaluationPath(node: AstNode, target: AstNode): AstNode[] | null {
  if (node === target) return [node];
  for (const child of evaluationChildren(node)) {
    const path = evaluationPath(child, target);
    if (path !== null) return [node, ...path];
  }
  return null;
}

/**
 * Computes the conditional part `deferred` of a statement into a temporary before it (`let conditional = ...`, with
 * one assignment per branch), and replaces it by the temporary. Parts Groovy evaluated earlier in the statement move
 * into temporaries first where order matters: those with side effects, and, when the conditional part has side
 * effects itself, every value it could change. Null when such a value is a list or map read, whose temporary would be
 * a copy (ADR 0014), or an assignment target.
 */
function hoistDeferred(
  statement: AstNode,
  root: AstNode,
  deferred: AstNode,
  context: LowerContext,
): IrStatement[] | null {
  const path = evaluationPath(root, deferred);
  if (path === null) return null;
  const earlier: AstNode[] = [];
  for (let index = 0; index + 1 < path.length; index += 1) {
    const children = evaluationChildren(path[index]!);
    earlier.push(...children.slice(0, children.indexOf(path[index + 1]!)));
  }
  // The list an indexed assignment writes into stays itself: a temporary would hold a copy (ADR 0014).
  const destinations = new Set(
    path.flatMap((node) => {
      const left = node.kind === "binary" && node.operator === "=" ? asNode(node.left) : null;
      return left?.kind === "binary" && left.operator === "[" && variableName(left.left) !== null
        ? [asNode(left.left)!]
        : [];
    }),
  );
  const moved = earlier.filter(
    (part) =>
      !destinations.has(part) &&
      (!isPure(part, context) || deferredMayChange(part, deferred, context)),
  );
  const assignmentTargets = new Set(
    path.flatMap((node) =>
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")
        ? [asNode(node.left)]
        : [],
    ),
  );
  if (
    moved.some(
      (part) =>
        assignmentTargets.has(part) ||
        ((part.kind === "variable" || part.kind === "property" || part.kind === "binary") &&
          isPure(part, context) &&
          (inferType(part, context.types) & (LIST | OBJECT)) !== 0),
    )
  )
    return null;
  const replacements = new Map<AstNode, AstNode>();
  const declarations: AstNode[] = [];
  const loop = isCollectionLoop(deferred, context) ? callParts(deferred) : null;
  for (const [base, part] of [
    ...moved.map((part) => ["earlier", part] as const),
    [
      loop !== null
        ? `${loop.name}Result`
        : regexWorkaround(deferred) === "words"
          ? "words"
          : regexWorkaround(deferred) === "tags"
            ? "withoutTags"
            : legacyApiCall(deferred, context)?.name === "getSelectedValue"
              ? "selected"
              : "conditional",
      deferred,
    ] as const,
  ]) {
    const name = freshName(base, context);
    // The temporary holds the part's value, so it has the part's legacy type, and the element type of a list that
    // findAll or collect builds.
    const variables = new Map(context.types.variables);
    variables.set(name, inferType(part, context.types));
    const listElements = new Map(context.types.listElements ?? []);
    const receiver = part === deferred ? asNode(deferred.object) : null;
    // collect() without a closure keeps each element as it is, as findAll keeps those it selects.
    const closure = loop?.name === "collect" ? closureArgument(loop.arguments) : null;
    const result = closure === null ? null : closureResult(closure.closure);
    const elements =
      (loop?.name === "findAll" || (loop?.name === "collect" && closure === null)) &&
      receiver !== null
        ? listElementType(receiver, context)
        : result !== null
          ? inferType(result.value, context.types)
          : UNKNOWN;
    if (part === deferred && elements !== UNKNOWN) listElements.set(name, elements);
    context.types = { ...context.types, variables, listElements };
    const span = part.span ?? statement.span;
    declarations.push(
      syntheticAssignment(
        true,
        syntheticVariable(name, span),
        substituteNodes(part, replacements),
        span,
      ),
    );
    replacements.set(part, syntheticVariable(name, span));
  }
  const result: IrStatement[] = [];
  // The rest of the statement computes its other conditionals first too, rather than repeating it per branch.
  const rest: AstNode = { ...substituteNodes(statement, replacements), keepsWhole: true };
  for (const item of [...declarations, rest]) {
    const [prelude, lowered, postlude] = withSurroundings(context, item);
    result.push(...prelude, ...lowered, ...postlude);
    // A part that could not be converted leaves its temporary undefined; the root cause is reported already.
    if (lowered.some((part) => part.kind === "unsupported")) break;
  }
  return result;
}

/**
 * Whether evaluating `deferred` may change what the pure expression `part` reads: it writes a variable `part` reads,
 * changes the list or map one holds, or calls a function (other than the SexScript API) while `part` reads a variable
 * that functions can reach, one that is not a local of the current function.
 */
function deferredMayChange(part: AstNode, deferred: AstNode, context: LowerContext): boolean {
  const reads = new Set<string>();
  const readNodes: AstNode[] = [];
  walkAst(part, (node) => {
    const name = node.kind === "variable" ? variableName(node) : null;
    if (name === null) return;
    reads.add(name);
    readNodes.push(node);
  });
  if (reads.size === 0) return false;
  let writes = false;
  let calls = false;
  walkAst(deferred, (node) => {
    if (node.kind === "closure") return;
    const written =
      node.kind === "postfix" || node.kind === "prefix"
        ? variableName(node.value)
        : hasOwnEffect(node, context) && node.kind === "binary"
          ? variableName(node.left)
          : node.kind === "declaration"
            ? variableName(node.left)
            : node.kind === "methodCall" &&
                hasOwnEffect(node, context) &&
                !READING_COLLECTION_METHODS.has(constantString(node.method) ?? "")
              ? variableName(node.object)
              : null;
    if (written !== null && reads.has(written)) writes = true;
    if (
      node.kind === "methodCall" &&
      legacyApiCall(node, context) === null &&
      hasOwnEffect(node, context) &&
      !READING_COLLECTION_METHODS.has(constantString(node.method) ?? "")
    )
      calls = true;
  });
  return writes || (calls && readNodes.some((node) => !outOfReach(node, context)));
}

/**
 * Whether no other function can read the variable a reference names: a generated temporary, or a local binding of
 * the current function (bindingKeys) that no closure inside it mentions. A script variable or object field is in
 * reach, also when a nested block declares a local of the same name.
 */
function outOfReach(node: AstNode, context: LowerContext): boolean {
  const name = variableName(node);
  if (name === null) return false;
  if (context.generatedNames.has(name)) return true;
  const key = bindingKey(node, context.bindings);
  const body = context.currentFunction?.body;
  if (key === null || key === name || body === undefined) return false;
  let captured = false;
  walkAst(body, (inner) => {
    if (inner.kind !== "closure") return;
    walkAst(inner.body, (reference) => {
      const call = reference.kind === "methodCall" ? callParts(reference) : null;
      if (variableName(reference) === name || (call?.inherited === true && call.name === name))
        captured = true;
    });
  });
  return !captured;
}

/**
 * Whether evaluating `node` may read the variable a `destination` reference names: it names it, or it calls a
 * function or a closure value (other than the SexScript API) while the variable is in reach of other functions
 * (outOfReach). A destination such a part may read must not hold a partial result.
 */
function mayReadDestination(node: AstNode, destination: AstNode, context: LowerContext): boolean {
  const name = variableName(destination);
  if (name === null) return true;
  let names = false;
  let calls = false;
  walkAst(node, (inner) => {
    const call = inner.kind === "methodCall" ? callParts(inner) : null;
    if (variableName(inner) === name || (call?.inherited === true && call.name === name))
      names = true;
    if (inner.kind === "methodCall" && legacyApiCall(inner, context) === null) {
      const method = constantString(inner.method) ?? "";
      const reading = PURE_OBJECT_METHODS.has(method) || READING_COLLECTION_METHODS.has(method);
      if (call === null || call.inherited || !reading) calls = true;
    }
  });
  return names || (calls && !outOfReach(destination, context));
}

/** Collection methods that read their receiver without changing it. */
const READING_COLLECTION_METHODS = new Set([
  "any",
  "collect",
  "contains",
  "every",
  "find",
  "findAll",
  "join",
  "size",
  "sum",
]);

/** A copy of `value` with each node of `replacements` replaced. */
function substituteNodes(value: AstNode, replacements: ReadonlyMap<AstNode, AstNode>): AstNode {
  const replaced = replacements.get(value);
  if (replaced !== undefined) return replaced;
  const result: AstNode = { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (isAstNode(child)) result[key] = substituteNodes(child, replacements);
    else if (Array.isArray(child)) {
      result[key] = child.map((item) =>
        isAstNode(item) ? substituteNodes(item, replacements) : item,
      );
    }
  }
  return result;
}

function lowerConditionalAssignment(
  declaration: boolean,
  target: AstNode,
  conditional: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const assign = (value: AstNode): AstNode => syntheticAssignment(declaration, target, value, span);
  const update = (value: AstNode): AstNode => syntheticAssignment(false, target, value, span);
  // The forms below store a first value in the variable before the rest runs; a rest that may read the variable
  // computes into a temporary, and the variable gets the result last.
  const targetName = variableName(target)!;
  const later =
    conditional.kind === "binary"
      ? asNode(conditional.right)
      : conditional.kind === "elvis" && variableName(asNode(conditional.boolean)) !== targetName
        ? asNode(conditional.false)
        : null;
  if (!declaration && later !== null && mayReadDestination(later, target, context)) {
    const temporary = freshName("conditional", context);
    const variables = new Map(context.types.variables);
    variables.set(temporary, inferType(conditional, context.types));
    context.types = { ...context.types, variables };
    const temporaryNode = syntheticVariable(temporary, span);
    return [
      ...lowerStatement(syntheticAssignment(true, temporaryNode, conditional, span), context),
      ...lowerStatement(update(temporaryNode), context),
    ];
  }
  if (
    conditional.kind === "binary" &&
    (conditional.operator === "&&" || conditional.operator === "||")
  ) {
    // `x = a && b` stores the truth of `a`, and the truth of `b` only when `a` is true (false for `||`), so the right
    // side, with its inputs, runs only then.
    const leftNode = asNode(conditional.left);
    const rightNode = asNode(conditional.right);
    const name = variableName(target);
    if (leftNode === null || rightNode === null || name === null) return [];
    // A left side that asks inside its own short circuit, as in `a && b && c`, stores its truth the same way first.
    const nested = hasGuardedInput(leftNode)
      ? lowerConditionalAssignment(declaration, target, leftNode, span, context)
      : null;
    const first = nested === null ? lowerCondition(leftNode, context) : null;
    const opening: IrStatement[] | null =
      nested ??
      (first === null
        ? null
        : [
            declaration
              ? { kind: "let", name, value: first, span }
              : {
                  kind: "assign",
                  target: { kind: "variable", name },
                  operator: "=",
                  value: first,
                  span,
                },
          ]);
    const facts = conditionFacts(leftNode, context, conditional.operator === "||");
    const variable: IrExpression = { kind: "variable", name };
    // An input on the right side asks inside the branch; a conditional expression there gets its own statements.
    const then = withPresentKeys(facts, rightNode, context, (): IrStatement[] | null => {
      if (findDeferred(rightNode, context) === null) {
        const [prelude, second] = withStatementRoot(context, rightNode, () =>
          lowerCondition(rightNode, context),
        );
        return second === null
          ? null
          : [...prelude, { kind: "assign", target: variable, operator: "=", value: second, span }];
      }
      const truth = onlyOf(inferType(rightNode, context.types), BOOLEAN)
        ? update(rightNode)
        : syntheticIf(
            rightNode,
            update(syntheticConstant(true, span)),
            update(syntheticConstant(false, span)),
            span,
          );
      const [prelude, lowered, postlude] = withSurroundings(context, truth);
      return [...prelude, ...lowered, ...postlude];
    });
    if (opening === null || then === null) {
      const legacySource = span === null ? [] : legacySourceLines(context, span);
      return [{ kind: "unsupported", legacySource, span }];
    }
    return [
      ...opening,
      {
        kind: "if",
        condition: conditional.operator === "&&" ? variable : negate(variable),
        then,
        else: [],
        span,
      },
    ];
  }
  if (conditional.kind === "elvis") {
    const value = asNode(conditional.boolean);
    const fallback = asNode(conditional.false);
    if (value === null || fallback === null) return [];
    // `x = x ?: d` needs no self-assignment before the check.
    const reassignsSelf = !declaration && variableName(value) === variableName(target);
    // With a plain fallback, the variable starts with it and takes the value only where that is true, tested through a
    // temporary, so the variable never holds the value's null: `let elvisValue = v`, `x = d`, then
    // `if elvisValue != null and ... { x = elvisValue }`. An assignment of a value that may be null needs it, since the
    // variable has its own type, and so does a value of unknown type, whose truth goes through a helper that proves the
    // variable non-null nowhere. A declaration of a value that may be null keeps that value's type, which later
    // assignments may need.
    const plainTruth = truthiness(
      { kind: "variable", name: variableName(target)! },
      inferType(value, context.types),
      true,
      target,
      context,
    );
    if (
      !reassignsSelf &&
      isSimpleValue(fallback) &&
      (plainTruth?.kind === "call" ||
        (!declaration && (inferType(value, context.types) & NULL) !== 0))
    ) {
      const temporary = freshName("elvisValue", context);
      const valueType = inferType(value, context.types);
      const variables = new Map(context.types.variables);
      variables.set(temporary, valueType);
      context.types = { ...context.types, variables };
      const temporaryNode = syntheticVariable(temporary, span);
      const kept = lowerStatement(syntheticAssignment(true, temporaryNode, value, span), context);
      const start = lowerStatement(assign(fallback), context);
      const temporaryValue: IrExpression = { kind: "variable", name: temporary };
      const truthy = truthiness(temporaryValue, valueType, true, temporaryNode, context);
      if (truthy === null) {
        const legacySource = span === null ? [] : legacySourceLines(context, span);
        return [{ kind: "unsupported", legacySource, span }];
      }
      const testsNull =
        truthy.kind === "binary" &&
        truthy.operator === "and" &&
        truthy.left.kind === "binary" &&
        truthy.left.operator === "!=" &&
        truthy.left.right.kind === "literal" &&
        truthy.left.right.value === null;
      const present: IrExpression =
        (valueType & NULL) === 0 || testsNull
          ? truthy
          : {
              kind: "binary",
              operator: "and",
              left: {
                kind: "binary",
                operator: "!=",
                left: temporaryValue,
                right: { kind: "literal", value: null },
              },
              right: truthy,
            };
      return [
        ...kept,
        ...start,
        {
          kind: "if",
          condition: present,
          then: [
            {
              kind: "assign",
              target: { kind: "variable", name: variableName(target)! },
              operator: "=",
              value: temporaryValue,
              span,
            },
          ],
          else: [],
          span,
        },
      ];
    }
    const stored = lowerStatement(assign(value), context);
    const fill = lowerStatement(update(fallback), context);
    // The check sees the value just stored, whose type can include null even when the variable's
    // overall type does not.
    const variable: IrExpression = { kind: "variable", name: variableName(target)! };
    const truthy = truthiness(variable, inferType(value, context.types), true, target, context);
    if (truthy === null) {
      const legacySource = span === null ? [] : legacySourceLines(context, span);
      return [{ kind: "unsupported", legacySource, span }];
    }
    return [
      ...(reassignsSelf ? [] : stored),
      { kind: "if", condition: negate(truthy), then: fill, else: [], span },
    ];
  }
  const condition = asNode(conditional.condition);
  const whenTrue = asNode(conditional.true);
  const whenFalse = asNode(conditional.false);
  if (condition === null || whenTrue === null || whenFalse === null) return [];
  if (!declaration) {
    return lowerStatement(
      syntheticIf(condition, update(whenTrue), update(whenFalse), span),
      context,
    );
  }
  // Start from a constant branch value so the result reads like ordinary TeaseScript; a variable could be
  // changed by the condition, so it is only read inside its branch.
  if (isSimpleValue(whenFalse)) {
    return [
      ...lowerStatement(assign(whenFalse), context),
      ...lowerStatement(syntheticIf(condition, update(whenTrue), null, span), context),
    ];
  }
  if (isSimpleValue(whenTrue)) {
    return [
      ...lowerStatement(assign(whenTrue), context),
      ...lowerStatement(
        syntheticIf(syntheticNot(condition), update(whenFalse), null, span),
        context,
      ),
    ];
  }
  // Both branches assign the variable, so it starts with its type's empty value where both give one plain type.
  const type = inferType(conditional, context.types);
  const start = type === BOOLEAN ? false : type === NUMBER ? 0 : type === STRING ? "" : null;
  return [
    ...lowerStatement(assign(syntheticConstant(start, span)), context),
    ...lowerStatement(syntheticIf(condition, update(whenTrue), update(whenFalse), span), context),
  ];
}

/** Returns the condition and branch values; an Elvis operand must be repeatable to serve as both. */
function splitConditional(
  conditional: AstNode,
): { condition: AstNode; whenTrue: AstNode; whenFalse: AstNode } | null {
  if (conditional.kind === "ternary") {
    const condition = asNode(conditional.condition);
    const whenTrue = asNode(conditional.true);
    const whenFalse = asNode(conditional.false);
    return condition === null || whenTrue === null || whenFalse === null
      ? null
      : { condition, whenTrue, whenFalse };
  }
  const value = asNode(conditional.boolean);
  const fallback = asNode(conditional.false);
  if (value === null || fallback === null) return null;
  if (!isRepeatableExpression(value)) return null;
  return { condition: value, whenTrue: value, whenFalse: fallback };
}

function substituteNode(value: AstNode, target: AstNode, replacement: AstNode): AstNode {
  if (value === target) return replacement;
  const result: AstNode = { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (isAstNode(child)) result[key] = substituteNode(child, target, replacement);
    else if (Array.isArray(child)) {
      result[key] = child.map((item) =>
        isAstNode(item) ? substituteNode(item, target, replacement) : item,
      );
    }
  }
  return result;
}

/** Constant values that are safe and readable as an unconditional initial value. */
/** Whether a value is literal data: constants, and lists and maps of them, which mean the same wherever evaluated. */
function isLiteralData(node: AstNode): boolean {
  if (node.kind === "constant") return true;
  if (node.kind === "unaryMinus") return asNode(node.value)?.kind === "constant";
  if (node.kind === "list") return nodeArray(node.items).every(isLiteralData);
  if (node.kind === "map")
    return nodeArray(node.entries).every((entry) => {
      const key = asNode(entry.key);
      const value = asNode(entry.value);
      return key?.kind === "constant" && value !== null && isLiteralData(value);
    });
  return false;
}

/**
 * The empty value of the kind a computed value plainly has, a list for `[...] - [...]` and text for text, so the
 * variable that waits for it does not start as null; null where the kind is not plain.
 */
function emptyValueLike(node: AstNode): AstNode | null {
  const base =
    node.kind === "binary" && ["+", "-"].includes(text(node.operator) ?? "")
      ? asNode(node.left)
      : node;
  if (base?.kind === "list") return { kind: "list", span: null, items: [] };
  if (base?.kind === "gstring" || (base?.kind === "constant" && typeof base.value === "string"))
    return { kind: "constant", span: null, value: "" };
  return null;
}

function isSimpleValue(node: AstNode): boolean {
  if (node.kind === "constant") return true;
  if (node.kind === "unaryMinus") return asNode(node.value)?.kind === "constant";
  if (node.kind === "list") return nodeArray(node.items).every(isSimpleValue);
  return false;
}

/**
 * Whether `target` may be evaluated (or have its prompt shown) at the start of statement `root` without
 * changing behavior: it must not sit behind a short-circuit or conditional guard, and nothing with side effects
 * may be evaluated before it. Closure bodies are not evaluated in place.
 */
function isHoistable(
  root: AstNode,
  target: AstNode,
  context: LowerContext,
  hoisted: AstNode = target,
): boolean {
  // A hoisted part with side effects must also not run before values the statement read earlier.
  const hoistedHasEffects = !isPure(hoisted, context);
  let effectsBefore = false;
  let readsBefore = false;
  let result: boolean | null = null;
  const visit = (node: AstNode, guarded: boolean): boolean => {
    if (node === target) {
      result = !guarded && !effectsBefore && !(hoistedHasEffects && readsBefore);
      return true;
    }
    if (node.kind === "closure") return false;
    const guardedChildren = new Set<unknown>();
    if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
      guardedChildren.add(node.right);
    } else if (node.kind === "ternary") {
      guardedChildren.add(node.true);
      guardedChildren.add(node.false);
    } else if (node.kind === "elvis") {
      guardedChildren.add(node.false);
    }
    // A plain assignment target is written after the value is computed, not read before it.
    const assignsVariable =
      (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) &&
      asNode(node.left)?.kind === "variable";
    for (const [key, value] of Object.entries(node)) {
      if (key === "span" || (key === "left" && assignsVariable)) continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (isAstNode(child) && visit(child, guarded || guardedChildren.has(value))) return true;
      }
    }
    if (hasOwnEffect(node, context)) effectsBefore = true;
    // The implicit receiver, the Math class, and variables assigned only by their declaration cannot change.
    const name = node.kind === "variable" ? variableName(node) : null;
    const stable =
      name === "this" ||
      name === "Math" ||
      (name !== null &&
        (context.types.singleAssignment?.has(name) === true || context.stableNames.has(name)));
    // A list element or a method's view of a value may change even when its variable cannot.
    const readsContent =
      (node.kind === "binary" && node.operator === "[") ||
      (node.kind === "methodCall" && node.implicitThis !== true);
    if ((node.kind === "variable" && !stable) || node.kind === "property" || readsContent)
      readsBefore = true;
    return false;
  };
  visit(root, false);
  return result === true;
}

/** The SexScript API call this node makes, unless a package function with that name shadows the API. */
function legacyApiCall(
  node: AstNode,
  context: LowerContext,
): { name: string; arguments: AstNode[] } | null {
  const call = callParts(node);
  if (call === null || !call.inherited) return null;
  if (callsHostOfOwnName(call.name, call.arguments.length, context)) return call;
  const shadowed =
    context.functions.has(call.name) ||
    context.packageFunctions.has(call.name) ||
    context.helperFunctions.has(call.name) ||
    isVisibleLocal(call.name, node, context);
  return shadowed ? null : call;
}

/**
 * Inside the closure a variable defines, the variable is not defined yet, so a call of its name with another number
 * of arguments than the closure takes called the SexScript method of that name, as in
 * `def getRandom = { low, high -> low + getRandom(high - low) }`.
 */
function callsHostOfOwnName(name: string, count: number, context: LowerContext): boolean {
  if (context.currentFunction?.name !== name) return false;
  const info = context.functions.get(name);
  return info !== undefined && (count < info.minArgs || count > info.maxArgs);
}

/** Whether a parameter or local of the current function, visible at `node`, has this name. */
function isVisibleLocal(name: string, node: AstNode, context: LowerContext): boolean {
  const enclosing = context.currentFunction;
  if (enclosing?.locals.has(name) !== true) return false;
  return (
    enclosing.body === undefined ||
    visibleLocals(enclosing.body, enclosing.parameters ?? [], node)?.has(name) !== false
  );
}

function hasOwnEffect(node: AstNode, context: LowerContext): boolean {
  if (node.kind === "postfix" || node.kind === "prefix" || node.kind === "constructorCall")
    return true;
  if (node.kind === "binary" && typeof node.operator === "string") {
    // `list << x` appends to the list.
    if (node.operator === "<<") return true;
    return node.operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(node.operator);
  }
  if (node.kind !== "methodCall") return false;
  const call = callParts(node);
  if (call === null) return true;
  if (call.inherited) return !DIRECT_STORAGE_LOADS.has(legacyApiCall(node, context)?.name ?? "");
  return !PURE_OBJECT_METHODS.has(call.name);
}

const PURE_OBJECT_METHODS = new Set([
  "contains",
  "equals",
  "isEmpty",
  "length",
  "size",
  "split",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
]);

/** Java Math methods without randomness; `Math.random()` is not one. */
const PURE_MATH_METHODS = new Set(["abs", "ceil", "floor", "max", "min", "pow", "round", "sqrt"]);

/** Expressions without interactions, randomness, waits, or writes, so they may be evaluated earlier. */
function isPure(node: AstNode, context: LowerContext): boolean {
  const pure = (child: AstNode): boolean => isPure(child, context);
  if (node.kind === "methodCall") {
    const call = callParts(node);
    if (call === null) return false;
    const target = asNode(node.object);
    const mathCall = target !== null && variableName(target) === "Math";
    // A record's field may hold a closure of the same name as a pure method, which `record.trim()` calls.
    const recordAction =
      target !== null &&
      context.java.text.closureFields.has(call.name) &&
      (inferType(target, context.types) & OBJECT) !== 0;
    const pureCall = call.inherited
      ? DIRECT_STORAGE_LOADS.has(legacyApiCall(node, context)?.name ?? "")
      : mathCall
        ? PURE_MATH_METHODS.has(call.name)
        : PURE_OBJECT_METHODS.has(call.name) && !recordAction;
    return (
      pureCall &&
      (call.inherited || mathCall || target === null || pure(target)) &&
      call.arguments.every(pure)
    );
  }
  if (node.kind === "binary" && node.operator === "<<") return false;
  if (node.kind === "binary" && typeof node.operator === "string" && node.operator.endsWith("=")) {
    return ["==", "!=", "<=", ">="].includes(node.operator) && nodeChildren(node).every(pure);
  }
  const pureKinds = new Set([
    "binary",
    "boolean",
    "cast",
    "constant",
    "elvis",
    "gstring",
    "list",
    "map",
    "mapEntry",
    "not",
    "property",
    "range",
    "readDefault",
    "ternary",
    "unaryMinus",
    "unaryPlus",
    "variable",
  ]);
  return pureKinds.has(node.kind) && nodeChildren(node).every(pure);
}

function nodeChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "span") continue;
    if (isAstNode(value)) children.push(value);
    else if (Array.isArray(value)) children.push(...value.filter(isAstNode));
  }
  return children;
}

function syntheticAssignment(
  declaration: boolean,
  target: AstNode,
  value: AstNode,
  span: SourceSpan | null,
): AstNode {
  const expression = declaration
    ? { kind: "declaration", span, left: target, right: value }
    : { kind: "binary", span, operator: "=", left: target, right: value };
  return { kind: "expressionStatement", span, expression };
}

function syntheticIf(
  condition: AstNode,
  then: AstNode,
  otherwise: AstNode | null,
  span: SourceSpan | null,
): AstNode {
  return { kind: "if", span, condition, then, else: otherwise ?? { kind: "empty", span } };
}

function syntheticNot(value: AstNode): AstNode {
  return { kind: "not", span: value.span, value };
}

function syntheticConstant(
  value: boolean | number | string | null,
  span: SourceSpan | null,
): AstNode {
  return { kind: "constant", span, value };
}

function lowerExpressionStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const expression = asNode(node.expression);
  if (expression === null)
    return [unsupportedStatement(context, node, "SX_MISSING_EXPRESSION", "Missing expression.")];

  if (expression.kind === "declaration") return lowerDeclaration(expression, node.span, context);
  // `new File(path)` alone only made a path object, which nothing used.
  if (
    isFileConstructor(expression) &&
    nodeArray(asNode(expression.arguments)?.items).every((argument) => isPure(argument, context))
  ) {
    addDiagnostic(
      context,
      "SX_DISCARDED_VALUE",
      "warning",
      "Groovy made a file path object here and discarded it, so the statement had no effect and is dropped.",
      node.span,
    );
    return [];
  }
  if (!isUncalledClosure(expression, context) && isPure(expression, context)) {
    addDiagnostic(
      context,
      "SX_DISCARDED_VALUE",
      "warning",
      "Groovy computed this value and discarded it, so the statement had no effect and is dropped. A comparison (==) here is often a mistake for an assignment (=).",
      node.span,
    );
    return [];
  }
  if (expression.kind === "binary") return lowerAssignment(expression, node.span, context);
  // As a statement, `++count` changes the variable as `count++` does.
  if (expression.kind === "postfix" || expression.kind === "prefix")
    return lowerPostfix(expression, node.span, context);
  if (expression.kind === "methodCall") return lowerCallStatement(expression, node.span, context);

  if (isUncalledClosure(expression, context)) {
    addDiagnostic(
      context,
      "SX_CLOSURE_NOT_CALLED",
      "warning",
      `Dropped the bare reference to closure ${variableName(expression)}: without () Groovy did not call it, so it had no effect. Add ${variableName(expression)}() manually if a call was intended.`,
      node.span,
    );
    return [];
  }
  const lowered = lowerExpression(expression, context);
  if (lowered === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_EXPRESSION_STATEMENT",
        "Expression statement could not be migrated safely.",
      ),
    ];
  }
  return [{ kind: "expression", expression: lowered, span: node.span }];
}

function lowerDeclaration(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const name = variableName(node.left);
  const right = asNode(node.right);
  // `def (x, y) = values` declares each variable with the element at its position, null past the end.
  const targets =
    asNode(node.left)?.kind === "arguments" ? nodeArray(asNode(node.left)!.items) : [];
  if (
    node.multipleAssignment === true &&
    right !== null &&
    targets.length > 0 &&
    targets.every((target) => variableName(target) !== null)
  ) {
    const values = lowerExpression(right, context);
    if (values === null) return [];
    const list = freshName("values", context);
    return [
      { kind: "let", name: list, value: values, span },
      ...targets.map((target, position): IrStatement => ({
        kind: "let",
        name: variableName(target)!,
        value: useHelper(context, "itemAt", [
          { kind: "variable", name: list },
          { kind: "literal", value: position },
        ]),
        span,
      })),
    ];
  }
  if (name === null || right === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_DECLARATION",
        "Only single-variable declarations are supported.",
      ),
    ];
  }
  if (right.kind === "closure") return lowerClosureDeclaration(name, right, span, context);
  // A file path object that only gives its byte size (SX_PHOTO_SIZE) is not needed.
  if (isFileConstructor(right) && onlySizeReads(name, context)) return [];
  const java = javaDeclaration(name, right, span, javaHost(context));
  if (java !== null) return java;
  if (context.classLoaderVariables.has(name) && isGroovyClassLoaderConstructor(right)) {
    addDiagnostic(
      context,
      "SX_LEGACY_HELPER_SETUP",
      "info",
      `Removed GroovyClassLoader setup variable ${name}; helper source is migrated separately.`,
      span,
    );
    return [];
  }
  const helperClass = context.legacyHelperClasses.get(name);
  if (helperClass !== undefined && isLegacyLoadClassCall(right, context.classLoaderVariables)) {
    addDiagnostic(
      context,
      "SX_LEGACY_HELPER_SETUP",
      "info",
      `Removed loadClass setup for ${helperClass}; helper calls remain explicit migration candidates.`,
      span,
    );
    return [];
  }
  const imageNames = imageNameFilter("declare", name, right, span, context);
  if (imageNames !== null) return imageNames;
  // A non-closure declaration that shares a closure's name is a nested local in Groovy; naming renames it.
  const collectionLoop = lowerCollectionAssignment(
    true,
    name,
    right,
    span,
    context,
    asNode(node.left) ?? undefined,
  );
  if (collectionLoop !== null) return collectionLoop;
  // `def x` without an initializer starts as null in Groovy; primitive declarations start at 0 or false.
  const declaredType = text(asNode(node.left)?.originType) ?? "";
  const value = isEmptyGroovyExpression(right)
    ? { kind: "literal" as const, value: PRIMITIVE_DEFAULTS.get(declaredType) ?? null }
    : right.kind === "map"
      ? namedMapLiteral(asNode(node.left)!, right, context)
      : lowerExpression(right, context);
  if (value === null) {
    // The variable stays declared with a neutral value of its type, so the code that uses it still compiles.
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_DECLARATION_VALUE",
        `Cannot safely migrate initializer for ${name}.`,
      ),
      {
        kind: "let",
        name,
        value: neutralValue(context.types.variables.get(name) ?? UNKNOWN),
        span,
      },
    ];
  }
  const key = bindingKey(asNode(node.left), context.bindings);
  const startsNull = value.kind === "literal" && value.value === null;
  // A list that starts as null starts empty where no code tests it for null: Groovy truth treats null and an empty list
  // alike, and without an optional type its reads need no null tests after the calls that cancel narrowing.
  // A range is no list, so a variable that later holds one keeps its null start.
  const holdsRange = (assigned: AstNode, depth = 0): boolean => {
    if (assigned.kind === "range") return true;
    const assignedKey = depth < 2 ? bindingKey(assigned, context.bindings) : null;
    return (
      assignedKey !== null &&
      assigned.kind === "variable" &&
      (context.assignedValues.get(assignedKey) ?? []).some((other) => holdsRange(other, depth + 1))
    );
  };
  if (
    startsNull &&
    key !== null &&
    !context.mapUses.nullTested.has(key) &&
    isListType(context.types.variables.get(name) ?? UNKNOWN) &&
    !(context.assignedValues.get(key) ?? []).some((assigned) => holdsRange(assigned))
  ) {
    const listType = nullableValueType(name, context);
    return [
      {
        kind: "let",
        name,
        value: { kind: "list", items: [] },
        span,
        ...(listType === null ? {} : { type: listType }),
      },
    ];
  }
  // A number that starts as null starts at 0 on the same condition: Groovy truth treats null and 0 alike.
  if (startsNull && key !== null && context.mapUses.zeroStartNumbers.has(key)) {
    if (context.mapUses.shownEarly.has(key))
      addDiagnostic(
        context,
        "SX_NULL_START_NUMBER",
        "warning",
        `Groovy showed ${name} as null until its first value; it starts at 0 here, so a text shown before then says 0.`,
        span,
      );
    return [{ kind: "let", name, value: { kind: "literal", value: 0 }, span }];
  }
  // A text or flag that starts as null on the same conditions, and that nothing passes on, starts empty.
  const empty = startsNull && key !== null ? context.mapUses.emptyStarts.get(key) : undefined;
  if (empty !== undefined) {
    if (context.mapUses.shownEarly.has(key!))
      addDiagnostic(
        context,
        "SX_NULL_START_EMPTY",
        "warning",
        `Groovy showed ${name} as null until its first value; it starts as ${empty === "" ? "the empty text" : "false"} here, so a text shown before then says ${empty === "" ? "nothing" : "false"}.`,
        span,
      );
    return [{ kind: "let", name, value: { kind: "literal", value: empty }, span }];
  }
  const optionalType = startsNull ? nullableValueType(name, context) : null;
  if (
    value.kind === "object" &&
    key !== null &&
    context.mapUses.clearedRecords.has(key) &&
    value.properties.some(
      (property) => property.value.kind !== "literal" || property.value.value !== null,
    )
  ) {
    // An object property keeps the type of its first value (ADR 0021 rule 1.4), so fields that clear() later sets to
    // null start as null and take their values right after, in the literal's order.
    const variable: IrExpression = { kind: "variable", name };
    return [
      {
        kind: "let",
        name,
        value: {
          ...value,
          properties: value.properties.map((property) => ({
            ...property,
            value: { kind: "literal", value: null },
          })),
        },
        span,
      },
      ...value.properties
        .filter((property) => property.value.kind !== "literal" || property.value.value !== null)
        .map((property): IrStatement => ({
          kind: "assign",
          target: { kind: "property", target: variable, name: property.name },
          operator: "=",
          value: property.value,
          span,
        })),
    ];
  }
  // A Groovy `double` or a decimal literal such as `0.0` takes fractions later, which a TeaseScript variable that starts
  // with a whole number does not, so its whole start is written as a decimal: `0.0`.
  const fractional =
    value.kind === "literal" &&
    typeof value.value === "number" &&
    Number.isInteger(value.value) &&
    (FRACTIONAL_TYPES.has(declaredType.replace(/^java\.(lang|math)\./u, "")) ||
      writtenDecimal(right, context));
  return [
    {
      kind: "let",
      name,
      value: TEXT_TYPES.has(declaredType)
        ? asStoredText(value, right, context)
        : fractional
          ? { ...value, decimal: true }
          : value,
      span,
      ...(optionalType === null ? {} : { type: `${optionalType}?` }),
      ...(INTEGER_TYPES.has(declaredType) ? { integer: true as const } : {}),
      ...(INTEGER_TYPES.has(declaredType) && mayBeText(right, context)
        ? { maybeText: true as const }
        : {}),
    },
  ];
}

/** Java types of numbers that hold fractions. */
const FRACTIONAL_TYPES = new Set(["float", "Float", "double", "Double", "BigDecimal", "Number"]);

/** Whether a Groovy number literal is written with a fraction or an exponent, as `0.0`, `-1.0`, or `1d`. */
function writtenDecimal(node: AstNode, context: LowerContext): boolean {
  const literal = node.kind === "unaryMinus" ? asNode(node.value) : node;
  const span = literal?.kind === "constant" ? literal.span : null;
  if (span === null || span === undefined) return false;
  // A negative literal's span may cover its sign only, so the literal is read from there on.
  const rest = context.sourceLines[span.line - 1]?.slice(span.column - 1) ?? "";
  return /^-?\s*(?:[0-9_]*\.[0-9_]+(?:[eE][-+]?[0-9]+)?[dDfFgG]?|[0-9_]+(?:[eE][-+]?[0-9]+[dDfFgG]?|[dDfF]))(?![\w.])/u.test(
    rest,
  );
}

/** Whether a Groovy value may be text, which an integer variable stored as a character code ("3" became 51). */
function mayBeText(value: AstNode, context: LowerContext): boolean {
  return (inferType(value, context.types) & STRING) !== 0;
}

/**
 * The type a null-initialized variable later receives when the evidence is unambiguous, such as `string` or
 * `string[]` (the emitted declaration adds `?`). Groovy numbers do not tell an integer from a fraction, so a number
 * variable gets no annotation: the type pass infers it from its first value (#504 decision 1a).
 */
function nullableValueType(name: string, context: LowerContext): string | null {
  const type = context.types.variables.get(name);
  if (type === undefined) return null;
  const scalar = (value: number): string | null => {
    if (onlyOf(value, STRING | NULL) && value & STRING) return "string";
    if (onlyOf(value, BOOLEAN | NULL) && value & BOOLEAN) return "boolean";
    return null;
  };
  if (onlyOf(type, LIST | NULL) && type & LIST) {
    const elements = context.types.listElements?.get(name);
    const element = elements === undefined || elements & NULL ? null : scalar(elements);
    return element === null ? null : `${element}[]`;
  }
  return scalar(type);
}

function isEmptyGroovyExpression(node: AstNode): boolean {
  return (
    node.kind === "unsupportedExpression" &&
    node.groovyType === "org.codehaus.groovy.ast.expr.EmptyExpression"
  );
}

function lowerClosureDeclaration(
  name: string,
  closure: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (context.functionDepth !== 0) {
    // A closure stored in a local variable inside a function becomes an action ID called via the dispatcher.
    // One that cannot convert stays declared without an action, so the code that uses it still compiles.
    const value = lowerClosureValue(closure, context, name);
    return value === null
      ? [
          unsupportedStatement(
            context,
            closure,
            "SX_NESTED_CLOSURE",
            "Nested Groovy closures are not lowered automatically.",
          ),
          { kind: "let", name, value: { kind: "literal", value: null }, span },
        ]
      : [{ kind: "let", name, value, span }];
  }
  const info = context.functions.get(name);
  if (info === undefined) {
    return [
      unsupportedStatement(
        context,
        closure,
        "SX_CLOSURE_DISCOVERY",
        `Closure ${name} is declared in a block of the script; as a function at the top, where TeaseScript declares functions, a name would mean something else: the closure reads a variable of such a block, or the script declares, binds, or uses its name elsewhere. Pass those values as parameters, or rename it.`,
      ),
    ];
  }

  const parameters: IrFunctionParameter[] = [];
  if (info.implicitParameter) {
    // Callers in other files may pass `it`, so a body that reads it declares it.
    if (info.maxArgs === 1 || readsOwnIt(closure))
      parameters.push({ name: "it", defaultValue: { kind: "literal", value: null } });
  } else {
    const closureParameters = groovyParameters(closure.parameters);
    if (closureParameters === null) {
      return [
        unsupportedStatement(
          context,
          closure,
          "SX_CLOSURE_PARAMETER",
          `Closure ${name} has an invalid parameter.`,
        ),
      ];
    }
    if (defaultBeforeRequired(closureParameters)) {
      return [
        unsupportedStatement(
          context,
          closure,
          "SX_PARAMETER_DEFAULT_ORDER",
          `Closure ${name} gives a parameter a default before a parameter without one; Groovy then fills the required parameters first, which TeaseScript parameters cannot express. Reorder the parameters.`,
        ),
      ];
    }
    for (const record of closureParameters) {
      const defaultNode = record.defaultValue;
      const defaultValue = defaultNode === null ? null : lowerExpression(defaultNode, context);
      if (defaultNode !== null && defaultValue === null) {
        return [
          unsupportedStatement(
            context,
            closure,
            "SX_CLOSURE_PARAMETER_DEFAULT",
            `Default value for ${record.name} could not be migrated.`,
          ),
        ];
      }
      // A `float` parameter with a whole default, `float t = 0.0`, takes fractions, which the default alone would not
      // allow in TeaseScript.
      const raw = (Array.isArray(closure.parameters) ? closure.parameters : []).find(
        (item: unknown) => isRecord(item) && item.name === record.name,
      );
      const declared = isRecord(raw) ? text(raw.type)?.replace(/^java\.(lang|math)\./u, "") : null;
      const fractional =
        declared !== null &&
        declared !== undefined &&
        ["float", "double", "Float", "Double", "BigDecimal", "Number"].includes(declared) &&
        defaultValue?.kind === "literal" &&
        typeof defaultValue.value === "number" &&
        Number.isInteger(defaultValue.value);
      parameters.push({
        name: record.name,
        defaultValue,
        ...(fractional ? { type: "number" } : {}),
      });
    }
  }

  const body = asNode(closure.body);
  if (body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        closure,
        "SX_CLOSURE_BODY",
        `Closure ${name} does not contain a normal block body.`,
      ),
    ];
  }
  // What the body cannot convert belongs to this function, which may turn out to be unreferenced (uncalledCode).
  const firstDiagnostic = context.diagnostics.length;
  const outerFunction = context.currentFunction;
  context.currentFunction = {
    name,
    locals: functionLocalNames(
      body,
      parameters.map((parameter) => parameter.name),
    ),
    body,
    parameters: parameters.map((parameter) => parameter.name),
  };
  context.functionDepth += 1;
  // A function body runs later, when keys known present here may be gone.
  const outerKeys = context.knownKeys.splice(0);
  try {
    const composed =
      composedImage(body, context) ??
      pixelCheck(body, closure, context) ??
      onlineFunction(body, closure, context);
    const lowered =
      composed ??
      lowerBlock(
        closure.implicitReturn === false || !context.resultUses.has(name)
          ? body
          : withImplicitReturn(body, context),
        context,
      );
    const ownDiagnostics = context.diagnostics.slice(firstDiagnostic);
    const declaration: IrStatement = {
      kind: "function",
      name,
      parameters,
      body: lowered,
      span,
      ...(ownDiagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? { ownDiagnostics }
        : {}),
    };
    // A closure of a block of the script moves to the top, before the first statement that uses it.
    if (info.nested === true) {
      context.closureFunctions.push(declaration);
      return [];
    }
    return [declaration];
  } finally {
    context.functionDepth -= 1;
    context.currentFunction = outerFunction;
    context.knownKeys.splice(0, context.knownKeys.length, ...outerKeys);
  }
}

/**
 * A function that inspects the pixels of a photo (`image.getRGB(x, y)`) and answers yes or no, such as a check whether
 * the camera gave a blank picture: a package cannot read pixels, so it answers false, as for a photo in which there is
 * nothing to detect (owner decision: reading photo pixels is skipped, with a note). Null for any other body.
 */
function pixelCheck(body: AstNode, node: AstNode, context: LowerContext): IrStatement[] | null {
  let readsPixels = false;
  let answers = true;
  walkAst(body, (child) => {
    if (child.kind === "methodCall" && constantString(child.method) === "getRGB")
      readsPixels = true;
    if (child.kind === "return") {
      const value = constantValue(asNode(child.value) ?? undefined);
      if (typeof value !== "boolean") answers = false;
    }
  });
  if (!readsPixels || !answers) return null;
  addDiagnostic(
    context,
    "SX_PHOTO_PIXELS",
    "warning",
    "This function read the pixels of a photo to answer yes or no; a package cannot read pixels, so it answers false, as for a photo in which there is nothing to detect.",
    node.span,
  );
  return [{ kind: "return", value: { kind: "literal", value: false }, span: node.span }];
}

/**
 * A function that makes a request to an online service, `new URL(address)` with `openStream()` or `openConnection()`,
 * such as a download into a file or a chat with a language model: a package cannot reach the service (owner decision),
 * so the function shows the request as a system notice, with its method and secret values hidden, and returns false,
 * or null, as when the request failed, or the empty text where it answered with text. Null for any other body.
 */
function onlineFunction(body: AstNode, node: AstNode, context: LowerContext): IrStatement[] | null {
  let address: AstNode | null = null;
  let opens = false;
  let writes = false;
  let answers = true;
  let method = "GET";
  const returned: Array<AstNode | null> = [];
  // The values the body sets each of its variables to, to tell what a returned variable holds.
  const bodyValues = new Map<string, AstNode[]>();
  walkAst(body, (child) => {
    if (
      child.kind === "constructorCall" &&
      (child.type === "URL" || child.type === "java.net.URL") &&
      address === null
    )
      address = nodeArray(asNode(child.arguments)?.items)[0] ?? null;
    const called = child.kind === "methodCall" ? constantString(child.method) : null;
    if (called === "openStream" || called === "openConnection") opens = true;
    const requested =
      called === "setRequestMethod"
        ? constantString(nodeArray(asNode(child.arguments)?.items)[0])
        : null;
    if (requested !== null) method = requested.toUpperCase();
    if (
      child.kind === "constructorCall" &&
      ["FileOutputStream", "java.io.FileOutputStream"].includes(String(child.type))
    )
      writes = true;
    if (child.kind === "return") {
      const value = constantValue(asNode(child.value) ?? undefined);
      if (typeof value !== "boolean") answers = false;
      returned.push(asNode(child.value));
    }
    const assignedName =
      child.kind === "declaration" || (child.kind === "binary" && child.operator === "=")
        ? variableName(child.left)
        : null;
    const assignedValue = assignedName === null ? null : asNode(child.right);
    if (assignedName !== null && assignedValue !== null)
      bodyValues.set(assignedName, [...(bodyValues.get(assignedName) ?? []), assignedValue]);
  });
  if (address === null || !opens) return null;
  // A function that answers with the response's text, as MandysBlackmail's `doSend` with `new String(buffer)`, reads
  // empty: its callers go on with the text, such as `doSend(...).trim()`.
  const isText = (value: AstNode | null, depth = 0): boolean => {
    if (value === null) return false;
    if (
      value.kind === "constructorCall" &&
      (value.type === "String" || value.type === "java.lang.String")
    )
      return true;
    const type = inferType(value, context.types);
    if (type !== 0 && onlyOf(type, STRING)) return true;
    const values =
      value.kind === "variable" ? bodyValues.get(variableName(value) ?? "") : undefined;
    return (
      depth < 2 &&
      values !== undefined &&
      values.length > 0 &&
      values.every((other) => isText(other, depth + 1))
    );
  };
  const readsText = !answers && returned.length > 0 && returned.every((value) => isText(value));
  // The body that declared a local address goes, so the notice shows its literal value, or no address.
  const addressName = variableName(address);
  let declared: AstNode | null | undefined;
  if (addressName !== null)
    walkAst(body, (child) => {
      if (
        declared === undefined &&
        child.kind === "declaration" &&
        variableName(child.left) === addressName
      ) {
        const value = asNode(child.right);
        declared = value !== null && isLiteralData(value) ? value : null;
      }
      // An address the body assigns again has no one literal value.
      if (
        child.kind === "binary" &&
        child.operator === "=" &&
        variableName(child.left) === addressName
      )
        declared = null;
    });
  const url = declared === null ? null : lowerExpression(declared ?? address, context);
  if (url === null && declared !== null) return null;
  addDiagnostic(
    context,
    "SX_ONLINE_REQUEST",
    "warning",
    `This function ${writes ? "downloaded a web address into a file" : "made a request to an online service"}, which a package cannot do; a system notice shows the request, with secret values hidden, and the function ${readsText ? "returns the empty text, as a request that read nothing" : "returns as when the request failed"}.`,
    node.span,
  );
  const shown =
    url === null
      ? null
      : url.kind === "literal" && typeof url.value === "string"
        ? { text: maskedUrl(url.value) }
        : { value: useHelper(context, "maskUrl", [url]) };
  return [
    systemSay(
      templateOrLiteral(
        shown === null
          ? [
              {
                text: `Online feature not available here. The original would have made a ${method} request.`,
              },
            ]
          : [
              {
                text: `Online feature not available here. The original would have requested: ${method} `,
              },
              shown,
            ],
      ),
      node.span,
      context,
    ),
    {
      kind: "return",
      value: { kind: "literal", value: answers ? false : readsText ? "" : null },
      span: node.span,
    },
  ];
}

const INPUT_CALLS = new Set([
  "getBoolean",
  "getFloat",
  "getInteger",
  "getSelectedValue",
  "getString",
]);

/** SexScript API calls that produce no value, so a trailing call stays a statement. */
const VOID_API_CALLS = new Set([
  "exit",
  "openCdTrays",
  "playBackgroundSound",
  "playSound",
  "save",
  "send",
  "setImage",
  "setInfos",
  "show",
  "sleep",
  "stopSoundThreads",
  "useEmailAddress",
  "useFile",
  "useUrl",
  "wait",
  "waitWithGauge",
]);

/** Collection calls used for their effect, whose trailing use is not a meaningful return value. */
const EFFECT_COLLECTION_CALLS = new Set([
  "add",
  "clear",
  "each",
  "eachWithIndex",
  "forEach",
  "push",
  "remove",
  "times",
]);

/**
 * Groovy closures and methods return the value of their last expression, including the last expression of each
 * `if`/`else` branch and of each `switch` case that ends with `break`. Makes those returns explicit for functions
 * whose result some caller uses; value-less API calls stay statements. A final assignment or declaration returns
 * the assigned variable; other final forms whose value Groovy returned get a note.
 */
function withImplicitReturn(block: AstNode, context: LowerContext): AstNode {
  const statements = nodeArray(block.statements);
  const last = statements.at(-1);
  if (last === undefined) return block;
  return { ...block, statements: [...statements.slice(0, -1), ...implicitReturn(last, context)] };
}

function implicitReturn(statement: AstNode, context: LowerContext): AstNode[] {
  const span = statement.span;
  const branch = (node: AstNode): AstNode => {
    const replaced = implicitReturn(node, context);
    return replaced.length === 1
      ? replaced[0]!
      : { kind: "block", span: node.span, statements: replaced };
  };
  if (statement.kind === "block") return [withImplicitReturn(statement, context)];
  if (statement.kind === "if") {
    const then = asNode(statement.then);
    const otherwise = asNode(statement.else);
    return [
      {
        ...statement,
        then: then === null ? null : branch(then),
        else: otherwise === null || otherwise.kind === "empty" ? otherwise : branch(otherwise),
      },
    ];
  }
  if (statement.kind === "switch") {
    // Groovy's ReturnAdder returns from a case that ends with break, and from the default case.
    const caseBody = (body: AstNode | null, isDefault: boolean): AstNode | null => {
      if (body?.kind !== "block") return body;
      const items = nodeArray(body.statements);
      const last = items.at(-1);
      if (last !== undefined && isSwitchBreak(last)) {
        const kept = items.slice(0, -1);
        const tail = kept.at(-1);
        if (tail === undefined) return body;
        // A case that no longer returns keeps its break.
        const replaced = implicitReturn(tail, context);
        const returns = replaced.at(-1)?.kind === "return";
        return {
          ...body,
          statements: [...kept.slice(0, -1), ...replaced, ...(returns ? [] : [last])],
        };
      }
      return isDefault ? withImplicitReturn(body, context) : body;
    };
    return [
      {
        ...statement,
        cases: nodeArray(statement.cases).map((item) => ({
          ...item,
          body: caseBody(asNode(item.body), false),
        })),
        default: caseBody(asNode(statement.default), true),
      },
    ];
  }
  if (statement.kind !== "expressionStatement") return [statement];
  const expression = asNode(statement.expression);
  if (expression === null) return [statement];
  const assigned =
    expression.kind === "declaration" ||
    (expression.kind === "binary" && expression.operator === "=") ||
    expression.kind === "prefix"
      ? variableName(expression.kind === "prefix" ? expression.value : expression.left)
      : null;
  if (assigned !== null) {
    return [statement, { kind: "return", span, value: { kind: "variable", span, name: assigned } }];
  }
  const call = expression.kind === "methodCall" ? callParts(expression) : null;
  const valueNote =
    expression.kind === "postfix" ||
    expression.kind === "prefix" ||
    (expression.kind === "binary" && !returnsValue(expression, context)) ||
    (call !== null && !call.inherited && (call.name === "each" || call.name === "forEach"));
  if (valueNote) {
    return [
      {
        kind: "importerNote",
        span,
        code: "SX_IMPLICIT_RETURN_VALUE",
        message:
          "Groovy returned the value of this last statement to callers that use the result; the converted function returns nothing here. Add an explicit return if the value matters.",
      },
      statement,
    ];
  }
  if (!returnsValue(expression, context)) return [statement];
  return [{ kind: "return", span, value: expression }];
}

function returnsValue(expression: AstNode, context: LowerContext): boolean {
  if (["declaration", "postfix", "prefix", "closure"].includes(expression.kind)) return false;
  if (expression.kind === "binary" && typeof expression.operator === "string") {
    const operator = expression.operator;
    const assignment = operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(operator);
    return !assignment && operator !== "<<";
  }
  if (expression.kind !== "methodCall") return true;
  const call = callParts(expression);
  if (call === null) return true;
  // A package function shadows the API name it shares.
  const api = legacyApiCall(expression, context);
  if (api !== null && VOID_API_CALLS.has(api.name)) return false;
  if (!call.inherited && call.name === "exit" && variableName(expression.object) === "System") {
    return false;
  }
  return call.inherited || !EFFECT_COLLECTION_CALLS.has(call.name);
}

/**
 * Names of functions whose result some caller uses: a call in a value position, a reference that keeps the function
 * as a value, or the last statement of a function whose own result is used. Calls are matched by name whatever their
 * receiver, which can only add returns.
 */
export function packageResultUses(files: readonly ParsedGroovyFile[]): Set<string> {
  const used = new Set<string>();
  const tails: Array<{ caller: string; callee: string }> = [];
  const tailOwners = new Map<AstNode, string>();
  const collectTails = (statement: AstNode | null, owner: string): void => {
    if (statement === null) return;
    if (statement.kind === "block")
      collectTails(nodeArray(statement.statements).at(-1) ?? null, owner);
    else if (statement.kind === "if") {
      collectTails(asNode(statement.then), owner);
      collectTails(asNode(statement.else), owner);
    } else if (statement.kind === "switch") {
      for (const item of nodeArray(statement.cases)) {
        const items = nodeArray(asNode(item.body)?.statements);
        const lastItem = items.at(-1);
        collectTails(
          lastItem !== undefined && isSwitchBreak(lastItem) ? (items.at(-2) ?? null) : null,
          owner,
        );
      }
      collectTails(asNode(statement.default), owner);
    } else if (statement.kind === "expressionStatement") tailOwners.set(statement, owner);
  };
  const named = (name: string | null, closure: AstNode | null): void => {
    if (name !== null && closure?.kind === "closure") collectTails(asNode(closure.body), name);
  };
  for (const file of files) {
    walkAst(file.root, (node) => {
      if (node.kind === "declaration") named(variableName(node.left), asNode(node.right));
      if (node.kind === "binary" && node.operator === "=") {
        const left = asNode(node.left);
        named(
          left?.kind === "property" ? constantString(left.property) : variableName(left),
          asNode(node.right),
        );
      }
      if (node.kind === "field" && typeof node.name === "string") {
        named(node.name, asNode(node.initialExpression));
      }
      if (
        typeof node.name === "string" &&
        node.returnType !== undefined &&
        node.returnType !== "void"
      ) {
        collectTails(asNode(node.body), node.name);
      }
    });
  }
  const visit = (node: AstNode, parent: AstNode | null): void => {
    if (node.kind === "methodCall") {
      const call = callParts(node);
      if (call !== null) {
        const owner = parent?.kind === "expressionStatement" ? tailOwners.get(parent) : undefined;
        if (parent?.kind !== "expressionStatement") used.add(call.name);
        else if (owner !== undefined) tails.push({ caller: owner, callee: call.name });
      }
    } else if (node.kind === "variable" || node.kind === "methodPointer") {
      const name = variableName(node) ?? constantString(node.method);
      if (name !== null) used.add(name);
    }
    // Declaring or assigning a name does not use a function's result.
    const assignsName =
      (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) &&
      asNode(node.left)?.kind === "variable";
    for (const [key, value] of Object.entries(node)) {
      if (key === "span" || (node.kind === "methodCall" && key === "method")) continue;
      if (key === "left" && assignsName) continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, node);
      }
    }
  };
  // The last statement of an unnamed closure is its value, which collect(), a list of callbacks, or a callee may use.
  const namedClosures = new Set<AstNode>();
  for (const file of files) {
    walkAst(file.root, (node) => {
      const value =
        node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")
          ? asNode(node.right)
          : node.kind === "field"
            ? asNode(node.initialExpression)
            : null;
      if (value?.kind === "closure") namedClosures.add(value);
    });
  }
  for (const file of files) {
    walkAst(file.root, (node) => {
      if (node.kind !== "closure" || namedClosures.has(node)) return;
      const last = nodeArray(asNode(node.body)?.statements).at(-1);
      const expression = last?.kind === "expressionStatement" ? asNode(last.expression) : null;
      const call = expression === null ? null : callParts(expression);
      if (call !== null) used.add(call.name);
    });
  }
  for (const file of files) if (file.root !== null) visit(file.root, null);
  for (let changed = true; changed;) {
    changed = false;
    for (const { caller, callee } of tails) {
      if (used.has(caller) && !used.has(callee)) {
        used.add(callee);
        changed = true;
      }
    }
  }
  return used;
}

/**
 * Local names visible at `target` inside a function body: parameters, declarations earlier in enclosing blocks,
 * loop variables, and parameters of enclosing closures. Null when `target` is not inside the body.
 */
function visibleLocals(
  body: AstNode,
  parameters: readonly string[],
  target: AstNode,
): Set<string> | null {
  const search = (node: AstNode, visible: ReadonlySet<string>): Set<string> | null => {
    if (node === target) return new Set(visible);
    let inner = visible;
    if (node.kind === "for" && typeof node.variable === "string") {
      // A C-style loop declares its counter in the first control expression.
      const initial = nodeArray(asNode(node.collection)?.items)[0];
      const counter = initial?.kind === "declaration" ? variableName(initial.left) : null;
      inner = new Set([...visible, node.variable, ...(counter === null ? [] : [counter])]);
    }
    if (node.kind === "closure") {
      const names = (groovyParameters(node.parameters) ?? []).map((parameter) => parameter.name);
      inner = new Set([...visible, ...(node.parameterSpecified === true ? names : ["it"])]);
    }
    if (node.kind === "block") {
      const scope = new Set(inner);
      for (const statement of nodeArray(node.statements)) {
        const found = search(statement, scope);
        if (found !== null) return found;
        const expression =
          statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
        const declared = expression?.kind === "declaration" ? variableName(expression.left) : null;
        if (declared !== null) scope.add(declared);
      }
      return null;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!isAstNode(child)) continue;
        const found = search(child, inner);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return search(body, new Set(parameters));
}

/** A call that leaves out a parameter whose default precedes a parameter without one (see HelperFunctionInfo). */
function defaultOrderCall(context: LowerContext, node: AstNode): null {
  return unsupportedExpression(
    context,
    node,
    "SX_PARAMETER_DEFAULT_ORDER",
    "This call leaves out a parameter that has a default before a parameter without one; Groovy then filled the required parameters first, which TeaseScript parameters cannot express. Pass every argument up to the last required parameter.",
  );
}

function defaultBeforeRequired(
  parameters: ReadonlyArray<{ defaultValue: AstNode | null }>,
): boolean {
  const firstDefault = parameters.findIndex((parameter) => parameter.defaultValue !== null);
  return (
    firstDefault >= 0 &&
    parameters.slice(firstDefault).some((parameter) => parameter.defaultValue === null)
  );
}

/** Parameter and declared local names of a function body, including nested blocks. */
function functionLocalNames(body: AstNode, parameters: readonly string[]): Set<string> {
  const names = new Set(parameters);
  walkAst(body, (node) => {
    if (node.kind === "declaration") {
      const name = variableName(node.left);
      if (name !== null) names.add(name);
    }
    if (node.kind === "for" && typeof node.variable === "string") names.add(node.variable);
    if (node.kind === "closure") {
      for (const parameter of groovyParameters(node.parameters) ?? []) names.add(parameter.name);
    }
  });
  return names;
}

/**
 * A closure used as a value (stored in data, passed as an argument, kept in a local) becomes a string action ID.
 * A closure that only forwards to a function (`{ f() }`, `{ a -> f(a) }`) uses that function's name; any other
 * closure body becomes a generated function. Calls of such values go through the package dispatcher. Closures
 * capturing local variables of their enclosing function are not converted.
 */
function lowerClosureValue(
  closure: AstNode,
  context: LowerContext,
  hint?: string,
): IrExpression | null {
  const body = asNode(closure.body);
  const parameters = groovyParameters(closure.parameters);
  if (body?.kind !== "block" || parameters === null) return null;
  const parameterNames =
    closure.parameterSpecified === true ? parameters.map((p) => p.name) : ["it"];
  const enclosing = context.currentFunction;
  const locals =
    (enclosing?.body === undefined
      ? null
      : visibleLocals(enclosing.body, enclosing.parameters ?? [], closure)) ??
    enclosing?.locals ??
    new Set<string>();
  const ownNames = functionLocalNames(body, parameterNames);
  const captured = new Set<string>();
  // Parameter defaults are evaluated in the closure too, so they capture as much as its body.
  const defaults = parameters.flatMap((parameter) =>
    parameter.defaultValue === null ? [] : [parameter.defaultValue],
  );
  walkAst([body, ...defaults], (node) => {
    // Calling a local closure by name captures it as much as reading it.
    const call = node.kind === "methodCall" ? callParts(node) : null;
    const name = variableName(node) ?? (call?.inherited === true ? call.name : null);
    if (name !== null && locals.has(name) && !ownNames.has(name)) captured.add(name);
  });
  if (captured.size > 0) {
    return unsupportedExpression(
      context,
      closure,
      "SX_CAPTURING_CLOSURE",
      `This closure value captures local ${[...captured].join(", ")} of its enclosing function; TeaseScript has no closures, so pass that state explicitly.`,
    );
  }
  if (defaultBeforeRequired(parameters)) {
    return unsupportedExpression(
      context,
      closure,
      "SX_PARAMETER_DEFAULT_ORDER",
      "This closure gives a parameter a default before a parameter without one; Groovy then fills the required parameters first, which TeaseScript parameters cannot express. Reorder the parameters.",
    );
  }
  // Forwarding keeps the target's own defaults, so the wrapper must not declare any.
  const hasDefaults = parameters.some((parameter) => parameter.defaultValue !== null);
  const forwarded = hasDefaults ? null : forwardedFunction(body, parameterNames, context);
  if (forwarded !== null) {
    context.actions.add(forwarded);
    return { kind: "literal", value: forwarded, action: true };
  }
  const base = hint ?? context.currentFunction?.name ?? "script";
  const name = `${base}Callback${context.closureFunctions.length + 1}`;
  const outerFunction = context.currentFunction;
  context.currentFunction = { name, locals: ownNames, body, parameters: parameterNames };
  context.functionDepth += 1;
  const outerKeys = context.knownKeys.splice(0);
  try {
    const implicit = closure.parameterSpecified !== true;
    const functionParameters: IrFunctionParameter[] = [];
    for (const parameter of implicit ? [] : parameters) {
      const defaultValue =
        parameter.defaultValue === null ? null : lowerExpression(parameter.defaultValue, context);
      if (parameter.defaultValue !== null && defaultValue === null) return null;
      functionParameters.push({ name: parameter.name, defaultValue });
    }
    if (implicit)
      functionParameters.push({ name: "it", defaultValue: { kind: "literal", value: null } });
    context.closureFunctions.push({
      kind: "function",
      name,
      parameters: functionParameters,
      // Callers reach a closure value through the dispatcher, whose result may be used.
      body: lowerBlock(withImplicitReturn(body, context), context),
      span: closure.span,
    });
  } finally {
    context.functionDepth -= 1;
    context.currentFunction = outerFunction;
    context.knownKeys.splice(0, context.knownKeys.length, ...outerKeys);
  }
  context.actions.add(name);
  return { kind: "literal", value: name, action: true };
}

/**
 * The functions made of closure values (lowerClosureValue), each placed just before the first statement that uses it,
 * so the file keeps the legacy order; one that nothing uses comes first.
 */
function withPlacedFunctions(lifted: IrStatement[], statements: IrStatement[]): IrStatement[] {
  if (lifted.length === 0) return statements;
  const functions = new Map(
    lifted.flatMap((statement): Array<[string, IrStatement]> =>
      statement.kind === "function" ? [[statement.name, statement]] : [],
    ),
  );
  const uses = (value: unknown, found: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) uses(item, found);
      return;
    }
    if (!isRecord(value)) return;
    const name =
      value.kind === "call" || (value.kind === "literal" && value.action === true)
        ? value.kind === "call"
          ? value.name
          : value.value
        : undefined;
    if (typeof name === "string" && functions.has(name)) found.add(name);
    for (const child of Object.values(value)) uses(child, found);
  };
  const placed = new Set<string>();
  const place = (statement: IrStatement): IrStatement[] => {
    const used = new Set<string>();
    uses(statement, used);
    const before: IrStatement[] = [];
    for (const name of used) {
      if (placed.has(name)) continue;
      placed.add(name);
      before.push(...place(functions.get(name)!));
    }
    return [...before, statement];
  };
  // The comments right before a statement stay with it, after the functions placed before it.
  const body: IrStatement[] = [];
  let comments: IrStatement[] = [];
  for (const statement of statements) {
    if (statement.kind === "blank" || (statement.kind === "comment" && !statement.trailing)) {
      comments.push(statement);
      continue;
    }
    const [own, ...before] = place(statement).reverse();
    body.push(...before.reverse(), ...comments, own!);
    comments = [];
  }
  body.push(...comments);
  return [
    ...lifted.filter((statement) => statement.kind !== "function" || !placed.has(statement.name)),
    ...body,
  ];
}

/**
 * Calls of a function's local closure variable that nothing assigns again call the closure's function directly, not
 * through the package dispatcher, when they pass it a number of arguments it takes. The variable goes where nothing
 * else reads it, and so does the action where nothing else names it.
 */
function withDirectClosureCalls(statements: IrStatement[], context: LowerContext): IrStatement[] {
  const functions = new Map(
    statements.flatMap((statement): Array<[string, Extract<IrStatement, { kind: "function" }>]> =>
      statement.kind === "function" ? [[statement.name, statement]] : [],
    ),
  );
  const replacedActions = new Set<string>();
  // A closure called where it is written, `x = { ... }()`, names its function's action itself.
  const directLiteral = (value: IrExpression): IrExpression => {
    const mapped = mapChildren(value, directLiteral);
    const action = mapped.kind === "call" ? mapped.positional[0] : undefined;
    const args = mapped.kind === "call" ? mapped.positional[1] : undefined;
    if (
      mapped.kind !== "call" ||
      mapped.name !== ACTION_DISPATCHER ||
      action?.kind !== "literal" ||
      action.action !== true ||
      typeof action.value !== "string" ||
      args?.kind !== "list"
    )
      return mapped;
    const target = functions.get(action.value);
    if (
      target === undefined ||
      args.items.length > target.parameters.length ||
      args.items.length <
        target.parameters.filter((parameter) => parameter.defaultValue === null).length
    )
      return mapped;
    replacedActions.add(action.value);
    return { kind: "call", name: action.value, positional: args.items, named: {}, local: true };
  };
  const literalCalls = (items: IrStatement[]): IrStatement[] =>
    items.map((item) =>
      item.kind === "function"
        ? { ...item, body: literalCalls(item.body) }
        : mapOwnExpressions(withNestedStatements(item, literalCalls), directLiteral),
    );
  const rewritten = literalCalls(statements).map((statement): IrStatement => {
    if (statement.kind !== "function") return statement;
    const declarations = new Map<string, number>();
    const actions = new Map<string, string>();
    const assigned = new Set<string>();
    const scan = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(scan);
      if (!isRecord(value)) return;
      if (value.kind === "let" && typeof value.name === "string") {
        declarations.set(value.name, (declarations.get(value.name) ?? 0) + 1);
        const initial = value.value;
        if (
          isRecord(initial) &&
          initial.kind === "literal" &&
          initial.action === true &&
          typeof initial.value === "string"
        )
          actions.set(value.name, initial.value);
      }
      if (value.kind === "for" && typeof value.variable === "string") assigned.add(value.variable);
      if (value.kind === "assign" && isRecord(value.target) && value.target.kind === "variable")
        assigned.add(String(value.target.name));
      Object.values(value).forEach(scan);
    };
    scan(statement.body);
    const direct = new Map(
      [...actions].filter(
        ([name, action]) =>
          declarations.get(name) === 1 && !assigned.has(name) && functions.has(action),
      ),
    );
    if (direct.size === 0) return statement;
    const deep = (value: IrExpression): IrExpression => {
      const mapped = mapChildren(value, deep);
      if (
        mapped.kind !== "call" ||
        mapped.name !== ACTION_DISPATCHER ||
        mapped.positional[0]?.kind !== "variable" ||
        mapped.positional[1]?.kind !== "list"
      )
        return mapped;
      const action = direct.get(mapped.positional[0].name);
      const target = action === undefined ? undefined : functions.get(action);
      const args = mapped.positional[1].items;
      if (
        action === undefined ||
        target === undefined ||
        args.length > target.parameters.length ||
        args.length <
          target.parameters.filter((parameter) => parameter.defaultValue === null).length
      )
        return mapped;
      replacedActions.add(action);
      return { kind: "call", name: action, positional: args, named: {}, local: true };
    };
    const convert = (items: IrStatement[]): IrStatement[] =>
      items.map((item) => mapOwnExpressions(withNestedStatements(item, convert), deep));
    const body = convert(statement.body);
    const read = new Set<string>();
    const reads = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(reads);
      if (!isRecord(value)) return;
      if (value.kind === "variable" && typeof value.name === "string") read.add(value.name);
      Object.values(value).forEach(reads);
    };
    reads(body);
    const unused = (item: IrStatement): boolean =>
      item.kind === "let" && direct.has(item.name) && !read.has(item.name);
    const prune = (items: IrStatement[]): IrStatement[] =>
      items.filter((item) => !unused(item)).map((item) => withNestedStatements(item, prune));
    return { ...statement, body: prune(body) };
  });
  if (replacedActions.size === 0) return rewritten;
  const named = new Set<string>();
  let dispatched = false;
  const names = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(names);
    if (!isRecord(value)) return;
    if (value.kind === "literal" && value.action === true && typeof value.value === "string")
      named.add(value.value);
    if (value.kind === "call" && value.name === ACTION_DISPATCHER) dispatched = true;
    Object.values(value).forEach(names);
  };
  names(rewritten);
  for (const action of replacedActions) if (!named.has(action)) context.actions.delete(action);
  if (!dispatched) context.actions.delete(ACTION_DISPATCHER_MARKER);
  return rewritten;
}

/**
 * A script variable that starts as null and that one statement of the script's own code later sets to a closure, as
 * BanjoRPG's world (`def worldTown`, then `worldTown = { ... }`), names that closure's function wherever it is
 * called once the statement ran: before it the script's own code calls nothing, so no call can find the variable
 * still null. Such calls call the function directly, and where nothing else reads the variable, the function takes its
 * name and the variable goes.
 */
function withSetUpActions(statements: IrStatement[], context: LowerContext): IrStatement[] {
  const functions = new Map(
    statements.flatMap((statement): Array<[string, Extract<IrStatement, { kind: "function" }>]> =>
      statement.kind === "function" ? [[statement.name, statement]] : [],
    ),
  );
  if (functions.size === 0) return statements;
  // Every declaration and assignment of a name anywhere, and every variable name the code reads or binds.
  const declared = new Map<string, number>();
  const assigned = new Map<string, number>();
  const bound = new Set<string>();
  const count = (map: Map<string, number>, name: string): void => {
    map.set(name, (map.get(name) ?? 0) + 1);
  };
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(scan);
    if (!isRecord(value)) return;
    if (value.kind === "let" && typeof value.name === "string") count(declared, value.name);
    if (value.kind === "assign" && isRecord(value.target) && value.target.kind === "variable")
      count(assigned, String(value.target.name));
    if (value.kind === "for" && typeof value.variable === "string") bound.add(value.variable);
    if (value.kind === "function" && Array.isArray(value.parameters))
      for (const parameter of value.parameters)
        if (isRecord(parameter) && typeof parameter.name === "string") bound.add(parameter.name);
    Object.values(value).forEach(scan);
  };
  scan(statements);
  const calls = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(calls);
    if (!isRecord(value)) return false;
    if (
      value.kind === "call" &&
      (value.name === ACTION_DISPATCHER || functions.has(String(value.name)))
    )
      return true;
    return Object.values(value).some(calls);
  };
  // The variables, by the action their one assignment gives them, where the script's own code ran nothing before it.
  const actions = new Map<string, string>();
  let ran = false;
  for (const statement of statements) {
    if (statement.kind === "function") continue;
    if (
      !ran &&
      statement.kind === "assign" &&
      statement.operator === "=" &&
      statement.target.kind === "variable" &&
      statement.value.kind === "literal" &&
      statement.value.action === true &&
      typeof statement.value.value === "string" &&
      functions.has(statement.value.value)
    ) {
      const name = statement.target.name;
      const start = statements.find(
        (item) => item.kind === "let" && item.name === name && item.global !== true,
      );
      if (
        start?.kind === "let" &&
        start.value.kind === "literal" &&
        start.value.value === null &&
        declared.get(name) === 1 &&
        assigned.get(name) === 1 &&
        !bound.has(name)
      )
        actions.set(name, statement.value.value);
    }
    ran ||= calls(statement);
  }
  if (actions.size === 0) return statements;
  // Each call passes a number of arguments the function takes.
  const direct = (value: IrExpression): IrExpression => {
    const mapped = mapChildren(value, direct);
    if (
      mapped.kind !== "call" ||
      mapped.name !== ACTION_DISPATCHER ||
      mapped.positional[0]?.kind !== "variable" ||
      mapped.positional[1]?.kind !== "list"
    )
      return mapped;
    const action = actions.get(mapped.positional[0].name);
    const target = action === undefined ? undefined : functions.get(action);
    const args = mapped.positional[1].items;
    if (
      action === undefined ||
      target === undefined ||
      args.length > target.parameters.length ||
      args.length < target.parameters.filter((parameter) => parameter.defaultValue === null).length
    )
      return mapped;
    return { kind: "call", name: action, positional: args, named: {}, local: true };
  };
  let rewritten = everywhere(statements, direct);
  // A variable that nothing reads any more goes, and its function takes its name, where nothing else names the
  // function and the name is free.
  const read = new Set<string>();
  const named = new Set<string>();
  let dispatched = false;
  const uses = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(uses);
    if (!isRecord(value)) return;
    if (value.kind === "variable" && typeof value.name === "string") read.add(value.name);
    if (value.kind === "literal" && value.action === true && typeof value.value === "string")
      named.add(value.value);
    if (value.kind === "call" && value.name === ACTION_DISPATCHER) dispatched = true;
    Object.values(value).forEach(uses);
  };
  const setUp = (item: IrStatement): boolean =>
    (item.kind === "let" && actions.has(item.name)) ||
    (item.kind === "assign" && item.target.kind === "variable" && actions.has(item.target.name));
  uses(rewritten.filter((item) => !setUp(item)));
  const renamed = new Map<string, string>();
  for (const [name, action] of actions)
    if (!read.has(name) && !named.has(action) && !functions.has(name)) renamed.set(action, name);
  const gone = new Set([...renamed.values()]);
  rewritten = rewritten.filter(
    (item) =>
      !(item.kind === "let" && gone.has(item.name)) &&
      !(item.kind === "assign" && item.target.kind === "variable" && gone.has(item.target.name)),
  );
  if (renamed.size > 0) {
    const call = (value: IrExpression): IrExpression => {
      const mapped = mapChildren(value, call);
      const name = mapped.kind === "call" ? renamed.get(mapped.name) : undefined;
      return mapped.kind === "call" && name !== undefined ? { ...mapped, name } : mapped;
    };
    rewritten = everywhere(rewritten, call).map((item) =>
      item.kind === "function" && renamed.has(item.name)
        ? { ...item, name: renamed.get(item.name)! }
        : item,
    );
    for (const action of renamed.keys()) context.actions.delete(action);
  }
  if (!dispatched) context.actions.delete(ACTION_DISPATCHER_MARKER);
  return rewritten;
}

/** The statements with every expression in them, also in function bodies and other blocks, mapped by `map`. */
function everywhere(
  statements: IrStatement[],
  map: (value: IrExpression) => IrExpression,
): IrStatement[] {
  return statements.map((item) =>
    mapOwnExpressions(
      withNestedBlocks(item, (body) => everywhere(body, map)),
      map,
    ),
  );
}

/** The function a closure body only forwards to, passing its own parameters unchanged. */
function forwardedFunction(
  body: AstNode,
  parameters: string[],
  context: LowerContext,
): string | null {
  const statements = nodeArray(body.statements);
  const only = statements.length === 1 ? statements[0] : undefined;
  const expression = asNode(only?.kind === "return" ? only.value : only?.expression);
  const call = expression === null ? null : callParts(expression);
  if (call === null || !call.inherited) return null;
  const isFunction = context.functions.has(call.name) || context.packageFunctions.has(call.name);
  if (!isFunction) return null;
  const names = call.arguments.map((argument) => variableName(argument));
  const expected = parameters[0] === "it" && names.length === 0 ? [] : parameters;
  return names.length === expected.length && names.every((name, index) => name === expected[index])
    ? call.name
    : null;
}

function lowerAssignment(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const java = javaAssignment(node, span, javaHost(context));
  if (java !== null) return java;
  const operator = text(node.operator);
  if (operator !== "=" && operator !== "<<" && neverAssigned(node.left, context))
    return [undefinedUpdate(node, context)];
  // `list = list << value` appends; assigning the list to itself adds nothing.
  const appended = asNode(node.right);
  if (
    operator === "=" &&
    appended?.kind === "binary" &&
    appended.operator === "<<" &&
    variableName(node.left) !== null &&
    variableName(appended.left) === variableName(node.left)
  )
    return lowerAssignment(appended, span, context);
  // A photo copied to a package image path keeps its reference under that path, where showing the path shows it.
  const copy = photoCopy(node);
  if (operator === "<<" && copy !== null) {
    const source = lowerExpression(copy.source, context);
    if (source === null) return [];
    addDiagnostic(
      context,
      "SX_PHOTO_COPY",
      "warning",
      `Legacy code copied this photo to images/${copy.path}, which a package cannot write; the photo's reference is saved for that path, and showing the path shows the photo.`,
      node.span,
    );
    return [
      {
        kind: "save",
        key: { kind: "literal", value: `${SENT_IMAGE_PREFIX}images/${copy.path}` },
        value: source,
        span,
      },
    ];
  }
  if (operator === "<<") {
    // Groovy `list << value` appends one element.
    const listNode = asNode(node.left);
    const valueNode = asNode(node.right);
    const known = listNode !== null && isKnownListExpression(listNode, context);
    if (
      listNode !== null &&
      valueNode !== null &&
      (known || mayAppendToUnprovenList(listNode, context))
    ) {
      const parameterWrite = parameterListWrite(listNode, node, context);
      if (parameterWrite !== null)
        return [unsupportedStatement(context, node, "SX_PARAMETER_LIST_WRITE", parameterWrite)];
      if (!known) {
        addDiagnostic(
          context,
          "SX_LEFT_SHIFT_RECEIVER",
          "warning",
          "Groovy << appended to a list, but this receiver is not proven to be one; on text, a number, or a map, << meant something else there (a text buffer, a bit shift, adding entries), and add() stops the script.",
          node.span,
        );
      }
      const target = lowerExpression(listNode, context);
      const value = lowerExpression(valueNode, context);
      if (target === null || value === null) return [];
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target, name: "add", arguments: [value] },
          span,
        },
      ];
    }
  }
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  const voidCall = leftNode === null ? null : legacyApiCall(leftNode, context);
  if (
    operator === "+" &&
    leftNode !== null &&
    rightNode !== null &&
    voidCall !== null &&
    VOID_API_CALLS.has(voidCall.name) &&
    isPure(rightNode, context) &&
    onlyOf(inferType(rightNode, context.types), STRING)
  ) {
    // `show(a) + (b)`: Groovy appended b to the call's null result and discarded it, so b was never shown.
    addDiagnostic(
      context,
      "SX_DISCARDED_CONCATENATION",
      "warning",
      `Groovy appended text to the result of ${voidCall.name}(), which returns nothing, and discarded it; the appended text was never shown and is dropped here.`,
      span,
    );
    return lowerStatement({ kind: "expressionStatement", span, expression: leftNode }, context);
  }
  if (
    operator !== "=" &&
    operator !== "+=" &&
    operator !== "-=" &&
    operator !== "*=" &&
    operator !== "/="
  ) {
    const lowered = lowerExpression(node, context);
    return lowered === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_BINARY_STATEMENT",
            `Unsupported binary statement operator ${operator ?? "?"}.`,
          ),
        ]
      : [{ kind: "expression", expression: lowered, span }];
  }
  const targetNode = asNode(node.left);
  const right = asNode(node.right);
  if (targetNode === null || right === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
        "Assignment target or value is missing.",
      ),
    ];
  }
  const variableTarget = variableName(targetNode);
  if ((operator === "=" || operator === "+=") && variableTarget !== null) {
    const imageNames = imageNameFilter(
      operator === "=" ? "assign" : "append",
      variableTarget,
      right,
      span,
      context,
    );
    if (imageNames !== null) return imageNames;
  }
  if (operator === "=" && variableTarget !== null) {
    const collectionLoop = lowerCollectionAssignment(
      false,
      variableTarget,
      right,
      span,
      context,
      targetNode,
    );
    if (collectionLoop !== null) return collectionLoop;
  }
  if (operator !== "=" && variableTarget === null && isRepeatableIndex(targetNode)) {
    // `items[i] += v` evaluates `items` and `i` twice harmlessly when both are plain references.
    const binaryOperator = operator.slice(0, -1);
    const expanded: AstNode = {
      kind: "binary",
      span: node.span,
      operator: binaryOperator,
      left: targetNode,
      right,
    };
    return lowerAssignment({ ...node, operator: "=", right: expanded }, span, context);
  }
  let target: IrExpression | null = null;
  if (variableTarget !== null) target = { kind: "variable", name: variableTarget };
  else if (operator === "=" && targetNode.kind === "binary" && targetNode.operator === "[") {
    const listNode = asNode(targetNode.left);
    const indexNode = asNode(targetNode.right);
    const fromEnd = indexNode === null ? null : negativeConstantIndex(indexNode);
    if (fromEnd !== null) {
      // `list[-1] = v` writes the last element; `.last` is not assignable, so the index counts from the length.
      const list =
        listNode !== null &&
        isRepeatableExpression(listNode) &&
        isKnownListExpression(listNode, context)
          ? lowerExpression(listNode, context)
          : null;
      target =
        list === null
          ? unsupportedExpression(
              context,
              targetNode,
              "SX_NEGATIVE_INDEX",
              "Groovy counted this negative index from the end; the receiver is not proven to be a list or cannot be evaluated twice. Index from the end explicitly.",
            )
          : {
              kind: "index",
              target: list,
              index: {
                kind: "binary",
                operator: "-",
                left: { kind: "property", target: list, name: "length" },
                right: { kind: "literal", value: fromEnd },
              },
            };
    } else {
      const written = writeChain(targetNode, context);
      target = lowerExpression(targetNode, context);
      for (const part of written) context.writeTargets.delete(part);
    }
    if (target !== null) noteSharedListWrite(asNode(targetNode.left), node, context);
    if (target?.kind === "index" && target.dict === true) noteSharedMapWrite(node.span, context);
  } else if (operator === "=" && targetNode.kind === "property") {
    const written = writeChain(targetNode, context);
    target = lowerExpression(targetNode, context);
    for (const part of written) context.writeTargets.delete(part);
    if (target !== null) noteSharedMapWrite(node.span, context);
  }
  if (target === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
        "Only local variables and indexed list targets are migrated automatically.",
      ),
    ];
  }
  const removesElement = context.elementRemovals.has(node);
  const targetType = inferType(targetNode, context.types);
  if (
    operator === "-=" &&
    variableTarget !== null &&
    (removesElement ||
      isListType(targetType) ||
      // A list literal is taken only from a list (lowerBinaryExpression).
      (right.kind === "list" && (targetType & LIST) !== 0 && (targetType & STRING) === 0))
  ) {
    const difference = lowerListDifference(
      { kind: "binary", span: node.span, operator: "-", left: targetNode, right },
      context,
      removesElement,
    );
    return difference === null
      ? []
      : [{ kind: "assign", target, operator: "=", value: difference, span }];
  }
  // Groovy `text -= part` dropped the first occurrence of the part, as `text - part` does (Banjo's gear).
  if (operator === "-=" && variableTarget !== null) {
    const removal = textRemoval(
      { kind: "binary", span: node.span, operator: "-", left: targetNode, right },
      context,
    );
    if (removal === null) return [];
    if (removal !== undefined)
      return [{ kind: "assign", target, operator: "=", value: removal, span }];
  }
  const value =
    right.kind === "map" && variableTarget !== null && operator === "="
      ? namedMapLiteral(targetNode, right, context)
      : lowerExpression(right, context);
  if (value === null) {
    const targetName = variableTarget ?? "indexed target";
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_ASSIGNMENT_VALUE",
        `Cannot safely migrate assignment to ${targetName}.`,
      ),
    ];
  }
  // Groovy `list[a..b] = values` replaced those elements by the values; the list becomes a new one without them.
  if (
    operator === "=" &&
    target.kind === "index" &&
    target.dict !== true &&
    target.index.kind === "range" &&
    target.target.kind === "variable"
  ) {
    context.syntheticHelpers.add("spliced");
    const range = target.index;
    // Groovy computed the values before the list and the range, so they come first unless neither has an effect.
    const rangeNode = targetNode.kind === "binary" ? asNode(targetNode.right) : null;
    const ends = [asNode(rangeNode?.from), asNode(rangeNode?.to)];
    const pure = [right, ...ends].every((item) => item === null || isPure(item, context));
    const first = pure ? null : freshName("values", context);
    return [
      ...(first === null ? [] : [{ kind: "let" as const, name: first, value, span }]),
      {
        kind: "assign",
        target: target.target,
        operator: "=",
        value: helperCall("spliced", [
          target.target,
          range.from,
          range.to,
          first === null ? value : { kind: "variable", name: first },
          ...exclusive(range),
        ]),
        span,
      },
    ];
  }
  // Groovy `list[[1, 3]] = value`, also written `list[1, 3] = value`, set each of those positions to the one value, as
  // campdrain's rounds do; those positions had to exist.
  if (
    operator === "=" &&
    target.kind === "index" &&
    target.dict !== true &&
    target.index.kind === "list" &&
    target.index.items.length > 0
  ) {
    const once = isPure(right, context) ? null : freshName("value", context);
    const position = freshName("position", context);
    return [
      ...(once === null ? [] : [{ kind: "let" as const, name: once, value, span }]),
      {
        kind: "for",
        variable: position,
        collection: target.index,
        body: [
          {
            kind: "assign",
            target: { ...target, index: { kind: "variable", name: position } },
            operator: "=",
            value: once === null ? value : { kind: "variable", name: once },
            span,
          },
        ],
        span,
      },
    ];
  }
  // A Java array of texts, as `split()` gives, kept the text of a number written into it: `bm2[0] = bm2.size() - 6`.
  const arrayKey =
    targetNode.kind === "binary" && targetNode.operator === "["
      ? bindingKey(asNode(targetNode.left), context.bindings)
      : null;
  const arrayValues = arrayKey === null ? [] : (context.assignedValues.get(arrayKey) ?? []);
  const valueType = inferType(right, context.types);
  if (
    operator === "=" &&
    target.kind === "index" &&
    arrayValues.length > 0 &&
    arrayValues.every(
      (assigned) => assigned.kind === "methodCall" && constantString(assigned.method) === "split",
    ) &&
    valueType !== 0 &&
    onlyOf(valueType, NUMBER | BOOLEAN)
  )
    return [
      {
        kind: "assign",
        target,
        operator: "=",
        // A whole number or a flag written as it is reads as its text, `"0"`.
        value:
          value.kind === "literal" &&
          (typeof value.value === "boolean" ||
            (typeof value.value === "number" && Number.isInteger(value.value) && !value.decimal))
            ? { kind: "literal", value: String(value.value) }
            : { kind: "template", parts: [{ value }] },
        span,
      },
    ];
  const grown =
    operator === "=" ? growingListWrite(targetNode, right, target, value, span, context) : null;
  if (grown !== null) return grown;
  if (operator === "*=" || operator === "/=") {
    if (variableTarget === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_ASSIGNMENT_TARGET",
          "Compound assignment to an indexed target requires single-evaluation rewriting.",
        ),
      ];
    }
    return [
      {
        kind: "assign",
        target,
        operator: "=",
        value: {
          kind: "binary",
          operator: operator === "*=" ? "*" : "/",
          left: { kind: "variable", name: variableTarget },
          right: value,
        },
        span,
      },
    ];
  }
  if (operator === "+=" && variableTarget !== null) {
    // Groovy `+=` joined text with any value; the append is lowered as the `+` it stands for.
    const sum = lowerPlus(
      { kind: "binary", span: node.span, operator: "+", left: targetNode, right },
      context,
    );
    if (sum === null) return [];
    if (sum.kind !== "binary") return [{ kind: "assign", target, operator: "=", value: sum, span }];
  }
  const textInteger =
    operator === "=" &&
    context.integerVariables.has(bindingKey(targetNode, context.bindings) ?? "") &&
    mayBeText(right, context);
  // A Java Integer[] truncated a number stored in it, as an int variable does.
  const array =
    targetNode.kind === "binary" && targetNode.operator === "[" ? asNode(targetNode.left) : null;
  const truncates =
    operator === "=" &&
    array !== null &&
    context.integerArrays.has(bindingKey(array, context.bindings) ?? "") &&
    mayBeFractional(right, context);
  const stored = truncates
    ? ({ kind: "call", name: "toInteger", positional: [value], named: {} } satisfies IrExpression)
    : operator === "=" && context.textVariables.has(bindingKey(targetNode, context.bindings) ?? "")
      ? asStoredText(value, right, context)
      : value;
  return [
    {
      kind: "assign",
      target,
      operator,
      value: stored,
      span,
      ...(textInteger ? { maybeText: true } : {}),
    },
  ];
}

function lowerPostfix(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const operator = text(node.operator);
  const targetNode = asNode(node.value);
  const name = variableName(node.value);
  if (operator !== "++" && operator !== "--") return [unsupportedPostfix(node, context)];
  if (name !== null && neverAssigned(node.value, context)) return [undefinedUpdate(node, context)];
  if (name !== null) {
    return [
      {
        kind: "assign",
        target: { kind: "variable", name },
        operator: operator === "++" ? "+=" : "-=",
        value: { kind: "literal", value: 1 },
        span,
      },
    ];
  }
  // `counts[i]++` and `player.score++` on plain references; an index counted from the end needs the list's length.
  const index = targetNode?.kind === "binary" ? asNode(targetNode.right) : null;
  // A computed index of a plain list or map, `seen[n - 1]++` or `counts[score(card)]++`, is computed once.
  const receiver =
    targetNode?.kind === "binary" && targetNode.operator === "[" ? asNode(targetNode.left) : null;
  const computed =
    receiver !== null &&
    index !== null &&
    isRepeatableExpression(receiver) &&
    !isRepeatableExpression(index);
  if (
    targetNode === null ||
    (!isRepeatableIndex(targetNode) && !computed) ||
    (index !== null && negativeConstantIndex(index) !== null)
  )
    return [unsupportedPostfix(node, context)];
  const written = writeChain(targetNode, context);
  let target = lowerExpression(targetNode, context);
  for (const part of written) context.writeTargets.delete(part);
  if (target === null) return [];
  const before: IrStatement[] = [];
  if (computed && !isPure(index, context)) {
    // An index with effects, such as a call, runs once, before the update.
    if (target.kind !== "index") return [unsupportedPostfix(node, context)];
    const name = freshName("index", context);
    before.push({ kind: "let", name, value: target.index, span });
    target = { ...target, index: { kind: "variable", name } };
  }
  if (targetNode.kind === "binary") noteSharedListWrite(asNode(targetNode.left), node, context);
  if (targetNode.kind === "property" || (target.kind === "index" && target.dict === true))
    noteSharedMapWrite(node.span, context);
  return [
    ...before,
    {
      kind: "assign",
      target,
      operator: operator === "++" ? "+=" : "-=",
      value: { kind: "literal", value: 1 },
      span,
    },
  ];
}

/**
 * Whether a variable that an update such as `+=` or `++` reads first is never declared, assigned, or a parameter in
 * this script or its package: Groovy looked it up as a property of the script and failed.
 */
function neverAssigned(target: unknown, context: LowerContext): boolean {
  const name = variableName(target);
  const key = bindingKey(target, context.bindings);
  return (
    name !== null &&
    key !== null &&
    context.checksUndefinedVariables &&
    // The methods of a helper class also share its static fields, which no method assigns.
    context.helperFunctions.size === 0 &&
    !context.assignedValues.has(key) &&
    !context.parameterBindings.has(key) &&
    !context.generatedNames.has(name) &&
    !context.packageFunctions.has(name) &&
    !isLegacyGetterProperty(name)
  );
}

function undefinedUpdate(node: AstNode, context: LowerContext): IrStatement {
  const name = variableName(node.left) ?? variableName(node.value) ?? "This variable";
  return unsupportedStatement(
    context,
    node,
    "SX_UNDEFINED_VARIABLE",
    `${name} is never assigned in this script or its package; SexScript failed with a missing property whenever this update ran.`,
  );
}

function unsupportedPostfix(node: AstNode, context: LowerContext): IrStatement {
  return unsupportedStatement(
    context,
    node,
    "SX_UNSUPPORTED_POSTFIX",
    "Only ++/-- statements on a variable, list element, or property are supported.",
  );
}

function lowerCallStatement(
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const call = callParts(node);
  const receiver = asNode(node.object);
  // A script manager lists the installed scripts to run, change, or delete them, which a package cannot do.
  if (
    call !== null &&
    receiver !== null &&
    ["eachFile", "eachFileRecurse", "eachDir", "eachFileMatch"].includes(call.name) &&
    isInstalledScriptsFolder(receiver, context)
  ) {
    addDiagnostic(
      context,
      "SX_SCRIPT_MANAGER",
      "warning",
      `${call.name}() went through the installed scripts of the legacy player to manage them, which a package cannot do; a system notice says so, and the session ends.`,
      node.span,
    );
    return [
      systemSay(
        {
          kind: "literal",
          value:
            "Managing the installed scripts is not available here: scripts cannot be listed, changed, or removed from a package.",
        },
        span,
        context,
      ),
      { kind: "exit", span },
    ];
  }
  // Going through the files of a package folder goes through the package's files there (listedFolderWalk), and through
  // an images folder through the folder's images (imageFolderWalk).
  const walkClosure = call?.arguments.at(-1);
  const recursive =
    call?.name === "eachFileRecurse"
      ? call.arguments.length === 1
        ? ("all" as const)
        : call.arguments.length === 2 && isFilesOnly(call.arguments[0]!, context)
          ? ("files" as const)
          : undefined
      : call?.name === "eachFile" && call.arguments.length === 1
        ? null
        : undefined;
  if (receiver !== null && walkClosure?.kind === "closure" && recursive !== undefined) {
    const listed =
      context.files === null
        ? undefined
        : listedFolderWalk(node, receiver, walkClosure, recursive, span, context);
    if (listed !== undefined) return listed;
    if (recursive === null && context.media !== null) {
      const walk = imageFolderWalk(node, receiver, walkClosure, span, context);
      if (walk !== undefined) return walk;
    }
  }
  // Looking through the player's pictures on the computer becomes asking for a photo (owner decision).
  if (
    call !== null &&
    receiver !== null &&
    FOLDER_WALKS.has(call.name) &&
    walksHome(receiver, context)
  ) {
    addDiagnostic(
      context,
      "SX_HOME_PICTURES",
      "warning",
      `${call.name}() looked through the files of a folder of the player's computer, such as the pictures in the home, Downloads, or Documents folder, which a package cannot see; the player is asked for a photo instead.`,
      node.span,
    );
    return [
      systemSay(
        {
          kind: "literal",
          value:
            "The original looked through the pictures on your computer. Take a photo to show here instead.",
        },
        span,
        context,
      ),
      {
        kind: "showImage",
        file: { kind: "call", name: "takePhoto", positional: [], named: {} },
        span,
      },
    ];
  }
  // Settings of the Java network stack, such as TLS options or the HTTP user agent, mean nothing in a package.
  const property = call?.name === "setProperty" ? constantString(call.arguments[0]) : null;
  if (
    variableName(receiver) === "System" &&
    property !== null &&
    /^(?:jsse|javax?\.net|https?|sun\.net|networkaddress)\./iu.test(property)
  ) {
    addDiagnostic(
      context,
      "SX_JVM_SETTING",
      "info",
      `System.setProperty("${property}") set up the Java network stack of the legacy player, which a package does not have; it is dropped.`,
      node.span,
    );
    return [];
  }
  if (call !== null && !call.inherited && receiver !== null && isDictionary(receiver, context)) {
    const dictionary = dictStatement(receiver, call, span, context);
    if (dictionary !== null) return dictionary;
  }
  // Groovy remove() of a key or value the map or list may not hold did nothing; TeaseScript reports a missing one, so
  // a receiver that is not proven a list tests it first, as it does for a dict.
  const removed = call?.arguments.length === 1 ? call.arguments[0]! : null;
  if (
    call !== null &&
    !call.inherited &&
    call.name === "remove" &&
    receiver !== null &&
    removed !== null &&
    variableName(receiver) !== null &&
    isRepeatableExpression(removed) &&
    !isKnownListExpression(receiver, context) &&
    !onlyOf(inferType(removed, context.types), NUMBER)
  ) {
    const collection = lowerExpression(receiver, context);
    const value = lowerExpression(removed, context);
    if (collection === null || value === null) return [];
    return [
      {
        kind: "if",
        condition: { kind: "methodCall", target: collection, name: "contains", arguments: [value] },
        then: [
          {
            kind: "expression",
            expression: {
              kind: "methodCall",
              target: collection,
              name: "remove",
              arguments: [value],
            },
            span,
          },
        ],
        else: [],
        span,
      },
    ];
  }
  if (call !== null && !call.inherited) {
    const java = javaCallStatement(node, call.name, call.arguments, span, javaHost(context));
    if (java !== null) return java;
  }
  // Deleting the file of a photo the script took: the reference is cleared, and the Player removes a photo that
  // nothing references (V30 §33).
  const deletedPath =
    call?.name === "delete" &&
    call.arguments.length === 0 &&
    receiver !== null &&
    isFileConstructor(receiver)
      ? variableName(nodeArray(asNode(receiver.arguments)?.items)[0])
      : null;
  if (deletedPath !== null && context.photoVariables.has(deletedPath)) {
    addDiagnostic(
      context,
      "SX_PHOTO_DELETE",
      "warning",
      "The legacy script deleted the file of a photo it took; the reference is cleared instead, and the Player removes a photo that nothing references any more (V30 §33).",
      span,
    );
    return [
      {
        kind: "assign",
        target: { kind: "variable", name: deletedPath },
        operator: "=",
        value: { kind: "literal", value: null },
        span,
      },
    ];
  }
  // Deleting another file clears what the package keeps under its path: the reference of a photo copied there
  // (photoCopy); making a folder does nothing in a package (owner decision).
  if (
    call !== null &&
    (call.name === "delete" || call.name === "mkdir" || call.name === "mkdirs") &&
    call.arguments.length === 0 &&
    receiver !== null &&
    isFileConstructor(receiver)
  ) {
    const pathNode = nodeArray(asNode(receiver.arguments)?.items)[0]!;
    if (call.name !== "delete") {
      addDiagnostic(
        context,
        "SX_FOLDER_CREATE",
        "warning",
        `${call.name}() made a folder on the player's computer; a package has no folders to make, so it is dropped.`,
        span,
      );
      return [];
    }
    const path = lowerExpression(pathNode, context);
    if (path === null) return [];
    addDiagnostic(
      context,
      "SX_FILE_DELETE",
      "warning",
      "delete() removed this file from the player's computer; a package keeps no files, so the reference stored under its path, such as a photo copied there, is cleared.",
      span,
    );
    return [
      {
        kind: "delete",
        key: templateOrLiteral([
          { text: SENT_IMAGE_PREFIX },
          ...(path.kind === "template"
            ? path.parts
            : [
                path.kind === "literal" && typeof path.value === "string"
                  ? { text: path.value }
                  : { value: path },
              ]),
        ]),
        span,
      },
    ];
  }
  const recordName = receiver === null ? null : variableName(receiver);
  if (
    call?.name === "clear" &&
    call.arguments.length === 0 &&
    !call.inherited &&
    recordName !== null &&
    receiver !== null &&
    isKnownMapExpression(receiver, context)
  ) {
    // Clearing a map that is an object: every field reads as null again, as Groovy's missing keys did.
    const fields = context.mapUses.recordFields.get(bindingKey(receiver, context.bindings)!) ?? [];
    noteSharedMapWrite(span, context);
    return [
      {
        kind: "assign",
        target: { kind: "variable", name: recordName },
        operator: "=",
        value: {
          kind: "object",
          properties: fields.map((field) => ({
            name: field,
            value: { kind: "literal", value: null },
          })),
        },
        span,
      },
    ];
  }
  if (call !== null && !call.inherited && (call.name === "each" || call.name === "forEach")) {
    return lowerEachStatement(node, call.arguments, span, context);
  }
  // An any() whose result goes unused runs its closure as a loop that a true result stops, as campdrain's drain loop.
  if (call !== null && !call.inherited && call.name === "any") {
    return lowerEachStatement(node, call.arguments, span, context, true);
  }
  const collectionStatement =
    call === null || call.inherited ? null : lowerCollectionStatement(node, call, span, context);
  if (collectionStatement !== null) return collectionStatement;
  const receiverName = variableName(node.object);
  if (
    call !== null &&
    receiverName !== null &&
    context.classLoaderVariables.has(receiverName) &&
    call.name === "addClasspath"
  ) {
    addDiagnostic(
      context,
      "SX_LEGACY_HELPER_SETUP",
      "info",
      "Removed GroovyClassLoader classpath setup; helper source is migrated separately.",
      span,
    );
    return [];
  }
  if (
    call !== null &&
    !call.inherited &&
    receiverName === "System" &&
    call.name === "exit" &&
    call.arguments.length <= 1 &&
    call.arguments.every((argument) => isPure(argument, context))
  ) {
    addDiagnostic(
      context,
      "SX_SYSTEM_EXIT",
      "warning",
      "System.exit() closed the legacy application; TeaseScript exit ends the session but leaves the Player open.",
      span,
    );
    return [{ kind: "exit", span }];
  }
  // `list.addAll(otherList)` appends the other list's elements in place, as TeaseScript addAll does (#609).
  if (call !== null && !call.inherited && call.name === "addAll" && call.arguments.length === 1) {
    const receiver = asNode(node.object);
    if (
      receiver !== null &&
      isKnownListExpression(receiver, context) &&
      isListType(inferType(call.arguments[0]!, context.types))
    ) {
      const parameterWrite = parameterListWrite(receiver, node, context);
      if (parameterWrite !== null)
        return [unsupportedStatement(context, node, "SX_PARAMETER_LIST_WRITE", parameterWrite)];
      const target = lowerExpression(receiver, context);
      const value = lowerExpression(call.arguments[0]!, context);
      if (target === null || value === null) return [];
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target, name: "addAll", arguments: [value] },
          span,
        },
      ];
    }
  }
  if (call !== null && !call.inherited && (call.name === "push" || call.name === "leftShift")) {
    // `list.leftShift(value)` is `list << value`; Groovy 2.5 List.push inserts at the front, as a stack's push.
    const receiver = asNode(node.object);
    if (
      receiver !== null &&
      isKnownListExpression(receiver, context) &&
      call.arguments.length === 1 &&
      (call.name === "leftShift" || receiver.kind === "variable")
    ) {
      const parameterWrite = parameterListWrite(receiver, node, context);
      if (parameterWrite !== null)
        return [unsupportedStatement(context, node, "SX_PARAMETER_LIST_WRITE", parameterWrite)];
      const target = lowerExpression(receiver, context);
      const value = lowerExpression(call.arguments[0]!, context);
      if (target === null || value === null) return [];
      if (call.name === "push") {
        return [
          {
            kind: "assign",
            target,
            operator: "=",
            value: {
              kind: "binary",
              operator: "+",
              left: { kind: "list", items: [value] },
              right: target,
            },
            span,
          },
        ];
      }
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target, name: "add", arguments: [value] },
          span,
        },
      ];
    }
  }
  // Deleting a package image a photo was copied to forgets the photo (SX_PHOTO_COPY).
  const copyDeleted = asNode(node.object);
  const copyDeletePath =
    call?.name === "delete" &&
    call.arguments.length === 0 &&
    copyDeleted !== null &&
    isFileConstructor(copyDeleted)
      ? constantString(nodeArray(asNode(copyDeleted.arguments)?.items)[0])
      : null;
  if (
    copyDeletePath !== null &&
    /^images\//iu.test(copyDeletePath) &&
    context.copiedImages.has(copyDeletePath.slice(7))
  ) {
    return [
      {
        kind: "delete",
        key: { kind: "literal", value: `${SENT_IMAGE_PREFIX}${copyDeletePath}` },
        span,
      },
    ];
  }
  // Java `TimeUnit.SECONDS.sleep(n)` blocks the script thread like a hidden wait.
  const unit = asNode(node.object);
  const unitName = unit?.kind === "property" ? constantString(unit.property) : null;
  if (
    call !== null &&
    call.name === "sleep" &&
    call.arguments.length === 1 &&
    unitName !== null &&
    ["MILLISECONDS", "SECONDS", "MINUTES"].includes(unitName) &&
    /(?:^|\.)TimeUnit$/u.test(
      variableName(asNode(unit!.object)) ?? text(asNode(unit!.object)?.type) ?? "",
    )
  ) {
    return oneArgumentStatement(call.arguments, context, node, (duration) => ({
      kind: "wait",
      duration:
        unitName === "MINUTES"
          ? { kind: "binary", operator: "*", left: duration, right: { kind: "literal", value: 60 } }
          : duration,
      visible: false,
      unit: unitName === "MILLISECONDS" ? "ms" : "s",
      span,
    }));
  }
  if (call === null || !call.inherited) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_CALL",
            "Method call is not a supported SexScript call.",
          ),
        ]
      : [{ kind: "expression", expression, span }];
  }
  if (call.name === "sleep" && legacyApiCall(node, context) !== null) {
    // Groovy's sleep(milliseconds) blocks the script thread like a hidden wait.
    return oneArgumentStatement(call.arguments, context, node, (duration) => ({
      kind: "wait",
      duration,
      visible: false,
      unit: "ms",
      span,
    }));
  }
  if (
    context.functions.has(call.name) ||
    context.packageFunctions.has(call.name) ||
    context.helperFunctions.has(call.name)
  ) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_HELPER_CALL",
            `Helper call ${call.name}() could not be migrated.`,
          ),
        ]
      : [{ kind: "expression", expression, span }];
  }
  if (
    context.helperMainParameter !== null &&
    variableName(node.object) !== context.helperMainParameter
  ) {
    const expression = lowerExpression(node, context);
    return expression === null
      ? [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_HELPER_CALL",
            `Unqualified helper call ${call.name}() could not be migrated.`,
          ),
        ]
      : [{ kind: "expression", expression, span }];
  }

  const args = call.arguments;
  if (INPUT_CALLS.has(call.name)) {
    // An input whose result the legacy statement ignored: TeaseScript allows only calls as expression
    // statements, so the answer goes into a variable (a yes/no answer without its comparison).
    const expression = lowerExpression(node, context);
    if (expression === null) return [];
    if (expression.kind === "call") return [{ kind: "expression", expression, span }];
    const answer =
      expression.kind === "binary" && expression.left.kind === "choice"
        ? expression.left
        : expression;
    context.ignoredInputs += 1;
    const value = answer.kind === "input" ? { ...answer, unread: true as const } : answer;
    return [{ kind: "let", name: `ignoredAnswer${context.ignoredInputs}`, value, span }];
  }
  switch (call.name) {
    case "setInfos":
      extractMetadata(args, context, node.span);
      return [];
    case "show":
      if (args.length === 0 || isNullConstant(args[0]) || constantString(args[0])?.trim() === "") {
        // show(null) and show("") cleared the legacy text area; a TeaseScript transcript keeps its history.
        addDiagnostic(
          context,
          "SX_SHOW_CLEAR",
          "info",
          'Dropped show(null) or show("") with empty text, which only cleared the legacy text area.',
          span,
        );
        return [];
      }
      noteUnintendedMarkup(args[0], context);
      if (args.length === 1) {
        // `say list` shows code-like notation (PR #515); Groovy showed `[a, b]`.
        const listParts = listText(args[0]!, context);
        if (listParts === null) {
          return [
            unsupportedStatement(
              context,
              node,
              "SX_UNSUPPORTED_ARGUMENT",
              "Argument could not be migrated.",
            ),
          ];
        }
        if (listParts !== undefined)
          return [{ kind: "say", value: templateOrLiteral(listParts), span }];
      }
      return oneArgumentStatement(args, context, node, (value) => ({ kind: "say", value, span }));
    case "wait":
      return oneArgumentStatement(args, context, node, (duration) => ({
        kind: "wait",
        duration,
        visible: false,
        unit: "s",
        span,
      }));
    case "waitWithGauge":
      return oneArgumentStatement(args, context, node, (duration) => ({
        kind: "wait",
        duration,
        visible: true,
        unit: "s",
        span,
      }));
    case "showButton": {
      if (args.length < 1 || args.length > 2) {
        return [
          unsupportedStatement(
            context,
            node,
            "SX_BUTTON_ARITY",
            "showButton() must have one or two arguments.",
          ),
        ];
      }
      const label = lowerExpression(args[0]!, context);
      const timeout = args[1] === undefined ? null : lowerExpression(args[1], context);
      if (label === null || (args[1] !== undefined && timeout === null)) {
        return [
          unsupportedStatement(
            context,
            node,
            "SX_UNSUPPORTED_BUTTON_ARGUMENT",
            "showButton() arguments could not be migrated.",
          ),
        ];
      }
      const legacyTimeout = buttonTimeout(args[1], node, context);
      if (legacyTimeout === null)
        return [unsupportedStatement(context, node, "SX_BUTTON_TIMEOUT", NEGATIVE_TIMEOUT)];
      if (legacyTimeout === "computed")
        return [{ kind: "expression", expression: helperCall("button", [label, timeout!]), span }];
      return [{ kind: "showButton", label, timeout: legacyTimeout ?? timeout, span }];
    }
    case "showPopup":
      return oneArgumentStatement(args, context, node, (message) =>
        popupStatements(message, span, context),
      );
    case "useUrl":
      return oneArgumentStatement(args, context, node, (url) => urlStatements(url, span, context));
    case "setImage": {
      // A function given an image that it draws into a frame and shows, such as a zoom-in, shows the image itself.
      const given = args.length === 2 ? givenImage(context) : null;
      if (given !== null) {
        addDiagnostic(
          context,
          "SX_IMAGE_COMPOSITION",
          "warning",
          "The legacy function drew the image it was given into a frame in memory and showed the frame; TeaseScript cannot compose images yet, so the image itself is shown.",
          node.span,
        );
        return [{ kind: "showImage", file: mediaFile(given, "images", node, context), span }];
      }
      if (args.length !== 1)
        return [
          unsupportedStatement(
            context,
            node,
            "SX_SET_IMAGE_ARITY",
            "setImage byte-array overload is not automatically migrated.",
          ),
        ];
      // setImage(null), and an empty or blank path, cleared the picture.
      if (isNullConstant(args[0]) || constantString(args[0])?.trim() === "")
        return [{ kind: "hideImage", span }];
      // A path a photo was copied to shows the photo (SX_PHOTO_COPY), or else the package's file of that name.
      const copied = constantString(args[0]);
      if (copied !== null && context.copiedImages.has(copied)) {
        addDiagnostic(
          context,
          "SX_PHOTO_COPY",
          "warning",
          `A script copied the player's photo to images/${copied}; showing the path shows that photo.`,
          node.span,
        );
        return [
          {
            kind: "showImage",
            file: {
              kind: "load",
              key: { kind: "literal", value: `${SENT_IMAGE_PREFIX}images/${copied}` },
              defaultValue: { kind: "literal", value: copied },
            },
            span,
          },
        ];
      }
      return oneArgumentStatement(args, context, node, (file) => ({
        kind: "showImage",
        file: mediaFile(file, "images", node, context),
        span,
      }));
    }
    case "playSound":
      // A null file stopped every background sound, as stopSoundThreads() did (FirstTimeCuckold, tutorial).
      if (args.length === 1 && isNullConstant(args[0])) return [{ kind: "stopAudio", span }];
      return oneArgumentStatement(args, context, node, (file) => ({
        kind: "playAudio",
        file: mediaFile(file, "sounds", node, context),
        async: false,
        repeatCount: null,
        span,
      }));
    case "playBackgroundSound":
      return lowerBackgroundSound(args, node, span, context);
    case "stopSoundThreads":
      if (args.length !== 0)
        return [
          unsupportedStatement(
            context,
            node,
            "SX_STOP_SOUND_ARITY",
            "stopSoundThreads() must have no arguments.",
          ),
        ];
      return [{ kind: "stopAudio", span }];
    case "save":
      return lowerSave(args, node, span, context);
    case "send":
      addDiagnostic(context, "SX_ONLINE_STORAGE", "warning", ONLINE_STORAGE_NOTE, node.span);
      return lowerSave(args, node, span, context);
    case "useFile":
      return useFileStatements(args, node, span, context);
    case "useEmailAddress": {
      if (args.length !== 1)
        return [
          unsupportedStatement(
            context,
            node,
            "SX_CALL_ARITY",
            "useEmailAddress() must have one argument.",
          ),
        ];
      const address = lowerExpression(args[0]!, context);
      if (address === null) return [];
      addDiagnostic(
        context,
        "SX_EMAIL",
        "warning",
        "useEmailAddress() opened the computer's email program with this address, which a browser package cannot do: the player's email address is asked once as the system speaker, and a system notice says that the email is not sent.",
        node.span,
      );
      return [
        {
          kind: "expression",
          expression: useHelper(context, "askOnce", [
            { kind: "literal", value: "system.emailAddress" },
            { kind: "literal", value: "What is your email address?" },
          ]),
          span,
        },
        systemSay(
          templateOrLiteral([
            {
              text: "Sending email is not available here. The original would have opened an email to ",
            },
            address.kind === "literal" && typeof address.value === "string"
              ? { text: address.value }
              : { value: address },
            { text: " in your email program." },
          ]),
          span,
          context,
        ),
      ];
    }
    case "openCdTrays":
      addDiagnostic(
        context,
        "SX_DEVICE_STATE",
        "warning",
        "openCdTrays() opened the CD trays of the player's computer, which a package cannot do; a permanent button shows the open tray, and clicking it closes the tray.",
        node.span,
      );
      return [{ kind: "expression", expression: useHelper(context, "openTray", []), span }];
    case "exit":
      if (args.length !== 0)
        return [
          unsupportedStatement(context, node, "SX_EXIT_ARITY", "exit() must have no arguments."),
        ];
      return [{ kind: "exit", span }];
    default: {
      const expression = lowerExpression(node, context);
      return expression === null
        ? [
            unsupportedStatement(
              context,
              node,
              "SX_UNSUPPORTED_CALL",
              `Unsupported SexScript call: ${call.name}`,
            ),
          ]
        : [{ kind: "expression", expression, span }];
    }
  }
}

/**
 * `target = list.collect { x -> f(x) }` and its relatives become an initial value plus an ordinary loop:
 * collect/findAll build a list, find picks the first match, any/every compute a flag, and sum adds up.
 */
function lowerCollectionAssignment(
  declaration: boolean,
  target: string,
  right: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
  /** The reference the value is assigned to, which tells whether other functions can read the variable. */
  destination: AstNode = syntheticVariable(target, span),
): IrStatement[] | null {
  const call = callParts(right);
  const receiver = asNode(right.object);
  if (call === null || call.inherited || receiver === null) return null;
  if (
    call.name === "sort" &&
    call.arguments.length === 0 &&
    !declaration &&
    variableName(receiver) === target &&
    isKnownListExpression(receiver, context)
  ) {
    // `list = list.sort()` sorts the list in place, which TeaseScript sort() does as well.
    const parameterWrite = parameterListWrite(receiver, right, context);
    if (parameterWrite !== null)
      return [unsupportedStatement(context, right, "SX_PARAMETER_LIST_WRITE", parameterWrite)];
    const list: IrExpression = { kind: "variable", name: target };
    return [
      {
        kind: "expression",
        expression: { kind: "methodCall", target: list, name: "sort", arguments: [] },
        span,
      },
    ];
  }
  if (!["collect", "findAll", "find", "any", "every", "sum"].includes(call.name)) return null;
  if (receiver.kind !== "range" && !isKnownListExpression(receiver, context)) return null;
  // `collect()` without a closure collects each element as it is, as `collect { item -> item }`.
  const identity = call.name === "collect" && call.arguments.length === 0;
  const argument =
    call.arguments.length === 0 && (call.name === "sum" || identity)
      ? null
      : closureArgument(call.arguments);
  if (argument === null && !(call.name === "sum" && call.arguments.length === 0) && !identity)
    return null;
  if (argument !== null && argument.parameters.length !== 1) return null;
  const variable = argument?.parameters[0] ?? "item";
  const result = argument === null ? null : closureResult(argument.closure);
  if (argument !== null && result === null) return null;
  // Groovy sum() adds numbers (it joins text) and returns null for an empty list.
  const summand =
    result === null ? listElementType(receiver, context) : inferType(result.value, context.types);
  const nonEmpty =
    (receiver.kind === "list" && nodeArray(receiver.items).length > 0) ||
    (receiver.kind === "range" &&
      constantValue(asNode(receiver.from) ?? undefined) !== undefined &&
      constantValue(asNode(receiver.to) ?? undefined) !== undefined);
  if (
    call.name === "sum" &&
    (!onlyOf(summand, NUMBER) ||
      (!nonEmpty && !isRepeatableExpression(receiver)) ||
      (argument !== null &&
        variableName(receiver) !== null &&
        closureUsesName(argument.closure, variableName(receiver)!)))
  ) {
    return null;
  }

  // From here on the idiom is recognized; an inner failure keeps its own root diagnostic, and a declared variable
  // stays declared with a neutral value of its type, so the code that uses it still compiles.
  const failed = (): IrStatement[] => [
    unsupportedStatement(
      context,
      right,
      "SX_UNSUPPORTED_DECLARATION_VALUE",
      `Cannot safely migrate the ${call.name}() loop for ${target}.`,
    ),
    ...(declaration
      ? [
          {
            kind: "let" as const,
            name: target,
            value: neutralValue(context.types.variables.get(target) ?? UNKNOWN),
            span,
          },
        ]
      : []),
  ];
  const collection = lowerExpression(receiver, context);
  if (collection === null) return failed();
  // A loop body that reads the target sees its old value only through a separate result variable.
  // The loop reads the receiver and runs the closure after the result starts; when either may read the
  // destination, a separate variable collects the result, which the destination gets last.
  // A sum that may be of no element, null in Groovy, adds up in a separate whole number, so the additions need no
  // null test.
  const nullableSum =
    call.name === "sum" &&
    !(
      (receiver.kind === "list" && nodeArray(receiver.items).length > 0) ||
      (receiver.kind === "range" &&
        constantValue(asNode(receiver.from) ?? undefined) !== undefined &&
        constantValue(asNode(receiver.to) ?? undefined) !== undefined)
    );
  const readsTarget =
    nullableSum ||
    mayReadDestination(receiver, destination, context) ||
    (argument !== null && mayReadDestination(argument.closure, destination, context));
  const accumulator = readsTarget
    ? freshName(nullableSum ? "sumTotal" : `${call.name}Result`, context)
    : target;
  const targetVariable: IrExpression = { kind: "variable", name: accumulator };
  const item: IrExpression = { kind: "variable", name: variable };
  const prefix = result === null ? [] : lowerStatementList(result.statements, null, context);
  const assign = (value: IrExpression): IrStatement => ({
    kind: "assign",
    target: targetVariable,
    operator: "=",
    value,
    span,
  });
  const add = (value: IrExpression): IrStatement => ({
    kind: "expression",
    expression: { kind: "methodCall", target: targetVariable, name: "add", arguments: [value] },
    span,
  });
  const condition = (): IrExpression | null =>
    result === null ? null : lowerCondition(result.value, context);
  let initial: IrExpression;
  let body: IrStatement[];
  // A closure value with a part that needs its own statement, such as a ternary inside a text, is computed into a
  // temporary first.
  const computed = (node: AstNode): { statements: IrStatement[]; value: IrExpression } | null => {
    if (findDeferred(node, context) === null) {
      const value = lowerExpression(node, context);
      return value === null ? null : { statements: [], value };
    }
    const temporary = freshName("value", context);
    const variables = new Map(context.types.variables);
    variables.set(temporary, inferType(node, context.types));
    context.types = { ...context.types, variables };
    const statements = lowerStatement(
      syntheticAssignment(true, syntheticVariable(temporary, span), node, span),
      context,
    );
    return { statements, value: { kind: "variable", name: temporary } };
  };
  switch (call.name) {
    case "collect": {
      initial = { kind: "list", items: [] };
      if (identity) {
        body = [add(item)];
        break;
      }
      const value = computed(result!.value);
      if (value === null) return failed();
      body = [...prefix, ...value.statements, add(value.value)];
      break;
    }
    case "findAll": {
      const test = condition();
      if (test === null) return failed();
      initial = { kind: "list", items: [] };
      body = [...prefix, { kind: "if", condition: test, then: [add(item)], else: [], span }];
      break;
    }
    case "find":
    case "any":
    case "every": {
      const test = condition();
      if (test === null) return failed();
      const found =
        call.name === "find" ? item : { kind: "literal" as const, value: call.name === "any" };
      initial = { kind: "literal", value: call.name === "find" ? null : call.name === "every" };
      body = [
        ...prefix,
        {
          kind: "if",
          condition: call.name === "every" ? negate(test) : test,
          then: [assign(found), { kind: "break", span }],
          else: [],
          span,
        },
      ];
      break;
    }
    default: {
      const value = result === null ? item : lowerExpression(result.value, context);
      if (value === null) return failed();
      initial = { kind: "literal", value: 0 };
      body = [...prefix, { kind: "assign", target: targetVariable, operator: "+=", value, span }];
    }
  }
  const start: IrStatement =
    declaration || readsTarget
      ? { kind: "let", name: accumulator, value: initial, span }
      : assign(initial);
  const loop: IrStatement = { kind: "for", variable, collection, body, span };
  const empty: IrStatement[] =
    call.name === "sum" && !nonEmpty
      ? [
          {
            kind: "if",
            condition: {
              kind: "binary",
              operator: "==",
              left: { kind: "property", target: collection, name: "length" },
              right: { kind: "literal", value: 0 },
            },
            then: [
              {
                kind: "assign",
                target: { kind: "variable", name: target },
                operator: "=",
                value: { kind: "literal", value: null },
                span,
              },
            ],
            else: [],
            span,
          },
        ]
      : [];
  if (!readsTarget) return [start, loop, ...empty];
  const accumulated: IrExpression = { kind: "variable", name: accumulator };
  const store: IrStatement = declaration
    ? { kind: "let", name: target, value: accumulated, span }
    : {
        kind: "assign",
        target: { kind: "variable", name: target },
        operator: "=",
        value: accumulated,
        span,
      };
  return [start, loop, store, ...empty];
}

/** A generated variable name that no variable of the file and no earlier generated name uses. */
function freshName(base: string, context: LowerContext): string {
  let candidate = base;
  for (
    let suffix = 2;
    context.types.variables.has(candidate) || context.generatedNames.has(candidate);
    suffix += 1
  ) {
    candidate = `${base}${suffix}`;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

/** Element type of a range, list literal, or list variable with known elements. */
function listElementType(node: AstNode, context: LowerContext): number {
  if (node.kind === "range") return NUMBER;
  if (node.kind === "list") {
    return nodeArray(node.items).reduce((type, item) => type | inferType(item, context.types), 0);
  }
  return context.types.listElements?.get(variableName(node) ?? "") ?? UNKNOWN;
}

/** A closure body ending in an expression (or `return expression`) with no other returns. */
function closureResult(closure: AstNode): { statements: AstNode[]; value: AstNode } | null {
  const statements = nodeArray(asNode(closure.body)?.statements);
  const last = statements.at(-1);
  const value = asNode(
    last?.kind === "return"
      ? last.value
      : last?.kind === "expressionStatement"
        ? last.expression
        : null,
  );
  if (value === null) return null;
  const leading = statements.slice(0, -1);
  if (leading.some((statement) => containsReturnForCurrentClosure(statement))) return null;
  return { statements: leading, value };
}

/** Single closure argument with its loop variable name (`it` when the closure declares none). */
/**
 * The names of an images folder's files that pass a name test, `listing.findAll { f -> f.name.endsWith(".jpg") }.name`
 * over the listing of an images folder (imageFolderListing): a loop over the package paths of its images that keeps
 * the file name of each one that passes. Null for other shapes.
 */
function imageNameFilter(
  mode: "declare" | "assign" | "append",
  target: string,
  right: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | null {
  if (right.kind !== "property" || constantString(right.property) !== "name") return null;
  const filter = asNode(right.object);
  const call = filter === null ? null : callParts(filter);
  const listing = filter === null ? null : asNode(filter.object);
  if (call?.name !== "findAll" || call.inherited || listing === null) return null;
  if (!holdsImageListing(listing, context)) return null;
  const closure = closureArgument(call.arguments);
  const result = closure === null ? null : closureResult(closure.closure);
  if (
    closure === null ||
    closure.parameters.length !== 1 ||
    result === null ||
    result.statements.length > 0
  )
    return null;
  const test = callParts(result.value);
  const subject = asNode(result.value.object);
  const suffix = test?.arguments.length === 1 ? constantValue(test.arguments[0]) : undefined;
  if (
    test === null ||
    test.inherited ||
    !["endsWith", "startsWith", "contains"].includes(test.name) ||
    typeof suffix !== "string" ||
    subject?.kind !== "property" ||
    constantString(subject.property) !== "name" ||
    variableName(asNode(subject.object)) !== closure.parameters[0]
  )
    return null;
  const images = lowerExpression(listing, context);
  if (images === null) return null;
  const imageName = freshName("image", context);
  const fileNameName = freshName("fileName", context);
  const image: IrExpression = { kind: "variable", name: imageName };
  const fileName: IrExpression = { kind: "variable", name: fileNameName };
  const list: IrExpression = { kind: "variable", name: target };
  const empty: IrExpression = { kind: "list", items: [] };
  const start: IrStatement[] =
    mode === "append"
      ? []
      : mode === "declare"
        ? [{ kind: "let", name: target, value: empty, span }]
        : [{ kind: "assign", target: list, operator: "=", value: empty, span }];
  return [
    ...start,
    {
      kind: "for",
      variable: imageName,
      collection: images,
      body: [
        {
          kind: "let",
          name: fileNameName,
          value: {
            kind: "methodCall",
            target: image,
            name: "substring",
            arguments: [
              {
                kind: "binary",
                operator: "+",
                left: {
                  kind: "methodCall",
                  target: image,
                  name: "lastIndexOf",
                  arguments: [{ kind: "literal", value: "/" }],
                },
                right: { kind: "literal", value: 1 },
              },
            ],
          },
          span,
        },
        {
          kind: "if",
          condition: {
            kind: "methodCall",
            target: fileName,
            name: test.name,
            arguments: [{ kind: "literal", value: suffix }],
          },
          then: [
            {
              kind: "expression",
              expression: { kind: "methodCall", target: list, name: "add", arguments: [fileName] },
              span,
            },
          ],
          else: [],
          span,
        },
      ],
      span,
    },
  ];
}

/** A form field's label from a variable name: `TakePics` and `maxTime` as "Take pics" and "Max time". */
function fieldLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/_/gu, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `x = getBooleans(...)` followed by `if (x != null) { ... } else { ... }`, or `x == null` with the branches the other
 * way round: the legacy dialog's Cancel gave null, so the form offers Cancel (V30 §20), and x takes the answers only
 * when the player did not cancel, so it keeps its list type. `def x = getBooleans(...)` followed by such a test
 * declares x with the answers, null after a Cancel. Null for other statements.
 */
function cancelledBooleans(
  statements: readonly AstNode[],
  index: number,
  context: LowerContext,
): IrStatement[] | null {
  const statement = statements[index]!;
  const next = statements[index + 1];
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  const declared = expression?.kind === "declaration";
  if (
    (!declared && (expression?.kind !== "binary" || text(expression.operator) !== "=")) ||
    next?.kind !== "if"
  )
    return null;
  const name = variableName(asNode(expression.left));
  const right = asNode(expression.right);
  const call = right === null ? null : legacyApiCall(right, context);
  if (
    name === null ||
    right === null ||
    call?.name !== "getBooleans" ||
    call.arguments.length !== 3
  )
    return null;
  // A declared x keeps the test as written, so it may also start a chain such as `x == null || !x[0]`.
  let condition = asNode(next.condition);
  while (
    declared &&
    condition?.kind === "binary" &&
    (condition.operator === "||" || condition.operator === "&&")
  )
    condition = asNode(condition.left);
  const operator = condition?.kind === "binary" ? text(condition.operator) : null;
  const left = asNode(condition?.left);
  const other = asNode(condition?.right);
  const tested =
    operator !== "!=" && operator !== "=="
      ? null
      : isNullConstant(other ?? undefined)
        ? left
        : isNullConstant(left ?? undefined)
          ? other
          : null;
  if (variableName(tested) !== name) return null;
  // The whole statement lowers, so parts computed first, such as a collect() of the texts, stay before the ask.
  const diagnostics = context.diagnostics.length;
  context.cancelBooleans = true;
  let prelude: IrStatement[], lowered: IrStatement[], postlude: IrStatement[];
  try {
    [prelude, lowered, postlude] = withSurroundings(context, statement);
  } finally {
    delete context.cancelBooleans;
  }
  lowered = [...prelude, ...lowered];
  const asked = lowered.at(-1);
  // A variable declared with the answers has no earlier value to keep, so it may be null after a Cancel.
  const assigned =
    !declared &&
    asked?.kind === "assign" &&
    asked.operator === "=" &&
    asked.target.kind === "variable" &&
    asked.target.name === name
      ? asked
      : null;
  const shaped = declared ? asked?.kind === "let" && asked.name === name : assigned !== null;
  if (postlude.length > 0 || !shaped) {
    context.diagnostics.splice(diagnostics);
    return null;
  }
  const askedEnd = statementSpan(statement)?.endLine ?? null;
  const between = takeCommentsBefore(context, statementSpan(next)).map((comment) =>
    commentStatement(comment, askedEnd),
  );
  if (assigned === null) return [...lowered, ...between, ...withSurroundings(context, next).flat()];
  const answers = freshName("answers", context);
  const answered = asNode(operator === "!=" ? next.then : next.else);
  const cancelled = asNode(operator === "!=" ? next.else : next.then);
  return [
    ...lowered.slice(0, -1),
    { kind: "let", name: answers, value: assigned.value, span: statement.span ?? null },
    ...between,
    {
      kind: "if",
      condition: {
        kind: "binary",
        operator: "!=",
        left: { kind: "variable", name: answers },
        right: { kind: "literal", value: null },
      },
      then: [
        {
          kind: "assign",
          target: { kind: "variable", name },
          operator: "=",
          value: { kind: "variable", name: answers },
          span: statement.span ?? null,
        },
        ...(answered === null ? [] : lowerBranch(answered, context)),
      ],
      else: cancelled === null ? [] : lowerBranch(cancelled, context),
      span: next.span ?? null,
    },
  ];
}

/** One ask of a legacy settings run (settingsRun): the variable it sets, the ask's text, and the saves after it. */
interface SettingsAsk {
  target: AstNode;
  name: string;
  text: AstNode;
  /** The true and false labels of a getBoolean; absent for a getInteger. */
  labels?: readonly [string, string];
  saves: AstNode[];
  first: AstNode;
}

/**
 * A legacy settings run, which asks one setting after another and saves each right away: `x = getBoolean(text, "on",
 * "off")` or `n = getInteger(text, n)`, each followed by `save(key, x)`. Two or more such asks become one form
 * (lowerSettingsForm). Null for other statements.
 */
function settingsRun(
  statements: readonly AstNode[],
  index: number,
  context: LowerContext,
): { asks: SettingsAsk[]; count: number } | null {
  const expressionOf = (statement: AstNode): AstNode | null =>
    statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  const ask = (statement: AstNode): Omit<SettingsAsk, "saves"> | null => {
    const expression = expressionOf(statement);
    if (expression?.kind !== "binary" || text(expression.operator) !== "=") return null;
    const target = asNode(expression.left);
    const name = variableName(target);
    const right = asNode(expression.right);
    const call = right === null ? null : legacyApiCall(right, context);
    if (target?.kind !== "variable" || name === null || call === null) return null;
    const [question, first, second] = call.arguments;
    if (question === undefined) return null;
    if (call.name === "getBoolean" && call.arguments.length === 3) {
      const yes = constantString(first);
      const no = constantString(second);
      return yes === null || no === null
        ? null
        : { target, name, text: question, labels: [yes, no], first: statement };
    }
    if (call.name === "getInteger" && call.arguments.length === 2 && first?.kind === "variable")
      return variableName(first) === name
        ? { target, name, text: question, first: statement }
        : null;
    return null;
  };
  const saves = (statement: AstNode, name: string): boolean => {
    const expression = expressionOf(statement);
    const call = expression === null ? null : legacyApiCall(expression, context);
    const value = call?.arguments[1];
    return (
      call?.name === "save" &&
      call.arguments.length === 2 &&
      value?.kind === "variable" &&
      variableName(value) === name
    );
  };
  const asks: SettingsAsk[] = [];
  let position = index;
  while (position < statements.length) {
    const found = ask(statements[position]!);
    if (found === null) break;
    let next = position + 1;
    const saved: AstNode[] = [];
    while (next < statements.length && saves(statements[next]!, found.name)) {
      saved.push(statements[next]!);
      next += 1;
    }
    if (saved.length === 0) break;
    asks.push({ ...found, saves: saved });
    position = next;
  }
  if (asks.length < 2 || new Set(asks.map((item) => item.name)).size !== asks.length) return null;
  return { asks, count: position - index };
}

/**
 * A legacy settings run as one form (V30 §20 Forms): a toggle with the ask's labels for each getBoolean, an integer
 * field for each getInteger, each with the ask's text as its description and its variable's value as its start; then
 * each variable takes its answer and is saved as before. Null when a part cannot be lowered.
 */
function lowerSettingsForm(
  asks: readonly SettingsAsk[],
  context: LowerContext,
): IrStatement[] | null {
  const properties: Array<{ name: string; value: IrExpression }> = [];
  const before: IrStatement[] = [];
  const firstDiagnostic = context.diagnostics.length;
  for (const ask of asks) {
    const description = formText(ask.text, "description", before, context);
    const start =
      ask.labels === undefined
        ? lowerExpression(ask.target, context)
        : lowerCondition(ask.target, context);
    if (description === null || start === null) {
      context.diagnostics.splice(firstDiagnostic);
      return null;
    }
    const literal = (value: string | boolean): IrExpression => ({ kind: "literal", value });
    const descriptor: Array<{ name: string; value: IrExpression }> = [
      { name: "type", value: literal(ask.labels === undefined ? "integer" : "boolean") },
      { name: "value", value: start },
      { name: "text", value: literal(fieldLabel(ask.name)) },
      ...(ask.labels === undefined
        ? []
        : [
            {
              name: "options",
              value: {
                kind: "list" as const,
                items: [
                  {
                    kind: "object" as const,
                    properties: [
                      { name: "value", value: literal(true) },
                      { name: "text", value: literal(ask.labels[0]) },
                    ],
                  },
                  {
                    kind: "object" as const,
                    properties: [
                      { name: "value", value: literal(false) },
                      { name: "text", value: literal(ask.labels[1]) },
                    ],
                  },
                ],
              },
            },
          ]),
      { name: "description", value: description },
    ];
    properties.push({ name: ask.name, value: { kind: "object", properties: descriptor } });
  }
  addDiagnostic(
    context,
    "SX_SETTINGS_FORM",
    "warning",
    `The legacy script asked these ${asks.length} settings one after the other and saved each; one form asks them together, with each question as the field's description.`,
    asks[0]!.first.span,
  );
  const form = freshName("settings", context);
  const statements: IrStatement[] = [
    ...before,
    {
      kind: "let",
      name: form,
      value: { kind: "input", input: "askForm", fields: { kind: "object", properties } },
      span: asks[0]!.first.span ?? null,
    },
  ];
  for (const ask of asks) {
    statements.push({
      kind: "assign",
      target: { kind: "variable", name: ask.name },
      operator: "=",
      value: { kind: "property", target: { kind: "variable", name: form }, name: ask.name },
      span: ask.first.span ?? null,
    });
    statements.push(...lowerStatementList(ask.saves, null, context));
  }
  return statements;
}

/** Constant assignments, also chained (`a = b = 1`), as one assignment per variable. */
function resetAssignments(statements: readonly AstNode[], span: SourceSpan | null): IrStatement[] {
  const result: IrStatement[] = [];
  for (const statement of statements) {
    const names: string[] = [];
    let expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    while (expression?.kind === "binary" && text(expression.operator) === "=") {
      const name = variableName(asNode(expression.left));
      if (name !== null) names.push(name);
      expression = asNode(expression.right);
    }
    const value = expression === null ? undefined : constantValue(expression);
    if (value === undefined) continue;
    for (const name of names)
      result.push({
        kind: "assign",
        target: { kind: "variable", name },
        operator: "=",
        value: { kind: "literal", value },
        span,
      });
  }
  return result;
}

/**
 * A form's question or a field's description; a text with a part that needs its own statement, such as a ternary, is
 * computed into a temporary first, whose statements go to `before`.
 */
function formText(
  node: AstNode,
  base: string,
  before: IrStatement[],
  context: LowerContext,
): IrExpression | null {
  if (findDeferred(node, context) === null) return lowerExpression(node, context);
  const temporary = freshName(base, context);
  const variables = new Map(context.types.variables);
  variables.set(temporary, inferType(node, context.types));
  context.types = { ...context.types, variables };
  const span = node.span ?? null;
  before.push(
    ...lowerStatement(
      syntheticAssignment(true, syntheticVariable(temporary, span), node, span),
      context,
    ),
  );
  return { kind: "variable", name: temporary };
}

/**
 * A legacy settings menu, `while (menu) { switch (getSelectedValue(text, [labels])) { ... } }`, whose cases each
 * toggle one variable (`v = !v`), except one that leaves (sets the loop's variable to a false value, or the default)
 * and at most one that resets the toggled variables to constants. It becomes one form of toggles with the menu text as
 * its question and the leave label as its submit button; a reset is a separate choice before the form, since it sets
 * constants, not the form's starting values. Null for other loops.
 */
function lowerMenuForm(node: AstNode, context: LowerContext): IrStatement[] | null {
  const condition = asNode(node.condition);
  const flag = condition?.kind === "variable" ? variableName(condition) : null;
  const body = switchBodyStatements(asNode(node.body))?.filter((item) => item.kind !== "empty");
  const menu = body?.length === 1 ? body[0]! : null;
  if (flag === null || menu?.kind !== "switch") return null;
  const subject = asNode(menu.expression);
  const call = subject === null ? null : legacyApiCall(subject, context);
  const options = call?.arguments[1];
  const question = call?.arguments[0];
  if (call?.name !== "getSelectedValue" || options?.kind !== "list" || question === undefined)
    return null;
  const labels = nodeArray(options.items).map((item) => constantString(item));
  if (labels.some((label) => label === null)) return null;
  const caseNodes = nodeArray(menu.cases);
  const defaultSource = switchBodyStatements(asNode(menu.default));
  if (defaultSource === null) return null;
  const expressionOf = (statement: AstNode): AstNode | null =>
    statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  const toggled = (statements: AstNode[]): string | null => {
    const expression = statements.length === 1 ? expressionOf(statements[0]!) : null;
    const target =
      expression?.kind === "binary" && text(expression.operator) === "="
        ? asNode(expression.left)
        : null;
    const value = expression === null ? null : asNode(expression.right);
    const name = target?.kind === "variable" ? variableName(target) : null;
    return name !== null && value?.kind === "not" && variableName(asNode(value.value)) === name
      ? name
      : null;
  };
  // Constant assignments, also chained (`a = b = 1`), as their targets.
  const constants = (statements: AstNode[]): string[] | null => {
    const names: string[] = [];
    for (const statement of statements) {
      let expression = expressionOf(statement);
      while (expression?.kind === "binary" && text(expression.operator) === "=") {
        const target = asNode(expression.left);
        const name = target?.kind === "variable" ? variableName(target) : null;
        if (name === null) return null;
        names.push(name);
        expression = asNode(expression.right);
      }
      if (expression === null || constantValue(expression) === undefined) return null;
    }
    return names.length > 0 ? names : null;
  };
  const leaves = (statements: AstNode[]): boolean => {
    const names = constants(statements);
    const value = statements.length === 1 ? asNode(expressionOf(statements[0]!)?.right) : null;
    return names?.length === 1 && names[0] === flag && (value === null || !constantValue(value));
  };
  const fields: Array<{ name: string; label: string }> = [];
  let leave: { label: string; statements: AstNode[] } | null = null;
  let reset: { label: string; statements: AstNode[] } | null = null;
  for (let index = 0; index < caseNodes.length; index += 1) {
    const position = constantValue(asNode(caseNodes[index]!.expression) ?? undefined);
    const path = collectSwitchPath(caseNodes, index, defaultSource);
    if (typeof position !== "number" || path === null || labels[position] === undefined)
      return null;
    const label = labels[position]!;
    const name = toggled(path);
    if (name !== null) fields.push({ name, label });
    else if (leaves(path) && leave === null) leave = { label, statements: path };
    else if (constants(path) !== null && reset === null) reset = { label, statements: path };
    else return null;
  }
  // The default path leaves for the one label no case names, "Back" after the cases.
  const named = new Set(
    caseNodes.map((item) => constantValue(asNode(item.expression) ?? undefined)),
  );
  const unnamed = labels.flatMap((label, position) => (named.has(position) ? [] : [label!]));
  const defaultPath = withoutTerminalBreak(defaultSource);
  if (leave === null && unnamed.length === 1 && leaves(defaultPath))
    leave = { label: unnamed[0]!, statements: defaultPath };
  else if (unnamed.length > 0) return null;
  if (leave === null || fields.length < 2) return null;
  if (
    reset !== null &&
    !constants(reset.statements)!.every((name) => fields.some((field) => field.name === name))
  )
    return null;
  const firstDiagnostic = context.diagnostics.length;
  const before: IrStatement[] = [];
  const asked = formText(question, "question", before, context);
  const fail = (): null => {
    context.diagnostics.splice(firstDiagnostic);
    return null;
  };
  if (asked === null) return fail();
  const properties: Array<{ name: string; value: IrExpression }> = [];
  for (const field of fields) {
    const variable = syntheticVariable(field.name, node.span ?? null);
    const start = lowerCondition(variable, context);
    if (start === null) return fail();
    properties.push({
      name: field.name,
      value: {
        kind: "object",
        properties: [
          { name: "type", value: { kind: "literal", value: "boolean" } },
          { name: "value", value: start },
          { name: "text", value: { kind: "literal", value: field.label } },
        ],
      },
    });
  }
  addDiagnostic(
    context,
    "SX_MENU_FORM",
    "warning",
    `The legacy menu switched ${fields.length} settings one click at a time until "${leave.label}"; one form of toggles asks them together${reset === null ? "" : `, after a choice that offers "${reset.label}" first, since that sets fixed values`}.`,
    node.span,
  );
  const form = freshName("settings", context);
  const statements: IrStatement[] = [];
  if (reset !== null)
    statements.push({
      kind: "if",
      condition: {
        kind: "binary",
        operator: "==",
        left: {
          kind: "choice",
          options: [
            { kind: "literal", value: "Change" },
            { kind: "literal", value: reset.label },
          ],
          labels: ["change", "reset"],
        },
        right: { kind: "literal", value: "reset" },
      },
      then: resetAssignments(reset.statements, node.span ?? null),
      else: [],
      span: node.span ?? null,
    });
  statements.push(...before, {
    kind: "let",
    name: form,
    value: {
      kind: "input",
      input: "askForm",
      question: asked,
      fields: { kind: "object", properties },
      submit: { kind: "literal", value: leave.label },
    },
    span: node.span ?? null,
  });
  for (const field of fields)
    statements.push({
      kind: "assign",
      target: { kind: "variable", name: field.name },
      operator: "=",
      value: { kind: "property", target: { kind: "variable", name: form }, name: field.name },
      span: node.span ?? null,
    });
  statements.push(...lowerStatementList(leave.statements, null, context));
  return statements;
}

function closureArgument(args: AstNode[]): { closure: AstNode; parameters: string[] } | null {
  const closure = args.length === 1 && args[0]!.kind === "closure" ? args[0]! : null;
  if (closure === null || asNode(closure.body)?.kind !== "block") return null;
  const parameters = groovyParameters(closure.parameters);
  if (parameters === null) return null;
  return {
    closure,
    parameters: closure.parameterSpecified === true ? parameters.map((p) => p.name) : ["it"],
  };
}

/**
 * Statement-level Groovy collection idioms that become ordinary loops or helper assignments:
 * `n.times { }`, `list.eachWithIndex { item, i -> }`, `Collections.shuffle(list)`, `list.unique()`, and
 * `list.remove(i)` with a numeric position.
 */
function lowerCollectionStatement(
  node: AstNode,
  call: { name: string; arguments: AstNode[] },
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | null {
  const receiver = asNode(node.object);
  if (receiver === null) return null;
  const body = (closure: AstNode): AstNode => asNode(closure.body)!;
  // Groovy has times() only on numbers, so a receiver of unknown type is a number whenever the call ran.
  if (call.name === "times" && (inferType(receiver, context.types) & NUMBER) !== 0) {
    const argument = closureArgument(call.arguments);
    // A return ends only the current iteration, as in each().
    const returns = argument === null ? [] : closureReturns(body(argument.closure));
    if (
      argument === null ||
      argument.parameters.length > 1 ||
      returns.some(
        ({ insideLoop, value }) => insideLoop || (value !== null && !isPure(value, context)),
      )
    ) {
      return null;
    }
    const lowered = lowerExpression(receiver, context);
    if (lowered === null) return null;
    // Groovy runs n.times for the integer part of n and not at all below one; `repeat` needs a whole count, so
    // other counts loop over a range, which is empty for a count of zero or less.
    const count =
      lowered.kind === "literal" && typeof lowered.value === "number"
        ? { ...lowered, value: Math.max(0, Math.trunc(lowered.value)) }
        : lowered;
    const wholeCount =
      count.kind === "literal" || (count.kind === "property" && count.name === "length");
    if (returns.length > 0) noteReturnAsContinue(returns[0]!.node, context);
    const block = lowerBlock(body(argument.closure), context);
    const loopBody = returns.length > 0 ? withoutFinalContinue(returnsAsContinue(block)) : block;
    const variable = argument.parameters[0]!;
    const usesIndex = closureUsesName(argument.closure, variable) || !wholeCount;
    return usesIndex
      ? [
          {
            kind: "for",
            variable,
            collection: {
              kind: "range",
              from: { kind: "literal", value: 0 },
              to: count,
              inclusive: false,
              count: true,
            },
            body: loopBody,
            span,
          },
        ]
      : [{ kind: "repeat", count, body: loopBody, span }];
  }
  // `(a..b).eachWithIndex { v, i -> }` goes through the range, counting its position.
  if (call.name === "eachWithIndex" && receiver.kind === "range") {
    const argument = closureArgument(call.arguments);
    if (
      argument === null ||
      argument.parameters.length !== 2 ||
      containsReturnForCurrentClosure(body(argument.closure))
    ) {
      return null;
    }
    const range = lowerExpression(receiver, context);
    if (range === null) return null;
    const item = argument.parameters[0]!;
    const index = argument.parameters[1]!;
    return [
      { kind: "let", name: index, value: { kind: "literal", value: 0 }, span },
      {
        kind: "for",
        variable: item,
        collection: range,
        body: [
          ...lowerBlock(body(argument.closure), context),
          {
            kind: "assign",
            target: { kind: "variable", name: index },
            operator: "+=",
            value: { kind: "literal", value: 1 },
            span,
          },
        ],
        span,
      },
    ];
  }
  if (
    call.name === "eachWithIndex" &&
    isKnownListExpression(receiver, context) &&
    isRepeatableExpression(receiver)
  ) {
    const argument = closureArgument(call.arguments);
    if (
      argument === null ||
      argument.parameters.length !== 2 ||
      containsReturnForCurrentClosure(body(argument.closure))
    ) {
      return null;
    }
    const list = lowerExpression(receiver, context);
    if (list === null) return null;
    const item = argument.parameters[0]!;
    const index = argument.parameters[1]!;
    return [
      {
        kind: "for",
        variable: index,
        collection: {
          kind: "range",
          from: { kind: "literal", value: 0 },
          to: { kind: "property", target: list, name: "length" },
          inclusive: false,
        },
        body: [
          {
            kind: "let",
            name: item,
            value: { kind: "index", target: list, index: { kind: "variable", name: index } },
            span,
          },
          ...lowerBlock(body(argument.closure), context),
        ],
        span,
      },
    ];
  }
  const shuffledList =
    variableName(receiver) === "Collections" && call.name === "shuffle"
      ? call.arguments[0]
      : undefined;
  const listTarget = shuffledList ?? receiver;
  const listName = variableName(listTarget);
  if (listName === null || !isKnownListExpression(listTarget, context)) return null;
  const list: IrExpression = { kind: "variable", name: listName };
  // Each form below changes the list in place in Groovy.
  const parameterWrite = (): IrStatement[] | null => {
    const reason = parameterListWrite(listTarget, node, context);
    return reason === null
      ? null
      : [unsupportedStatement(context, node, "SX_PARAMETER_LIST_WRITE", reason)];
  };
  const reassign = (value: IrExpression): IrStatement[] =>
    parameterWrite() ?? [{ kind: "assign", target: list, operator: "=", value, span }];
  if (shuffledList !== undefined && call.arguments.length === 1) {
    return reassign(useHelper(context, "shuffled", [list]));
  }
  if (call.name === "unique" && call.arguments.length === 0)
    return reassign(useHelper(context, "unique", [list]));
  if (call.name === "sort" && call.arguments.length === 0) {
    // Groovy sort() sorts the list in place, as TeaseScript sort() does.
    const blocked = parameterWrite();
    if (blocked !== null) return blocked;
    return [
      {
        kind: "expression",
        expression: { kind: "methodCall", target: list, name: "sort", arguments: [] },
        span,
      },
    ];
  }
  if (call.name === "remove" && call.arguments.length === 1) {
    // Groovy remove(int) removes a position and remove(Object) the first equal element; TeaseScript list equality
    // is structural like Groovy's equals (#517).
    const argument = call.arguments[0]!;
    const argumentType = inferType(argument, context.types);
    const byPosition = onlyOf(argumentType, NUMBER);
    if (byPosition || onlyOf(argumentType, STRING | BOOLEAN | LIST | OBJECT)) {
      const blocked = parameterWrite();
      if (blocked !== null) return blocked;
      const value = lowerExpression(argument, context);
      if (value === null) return null;
      const name = byPosition ? "removeAt" : "remove";
      return [
        {
          kind: "expression",
          expression: { kind: "methodCall", target: list, name, arguments: [value] },
          span,
        },
      ];
    }
  }
  if (call.name === "clear" && call.arguments.length === 0) {
    return (
      parameterWrite() ?? [
        {
          kind: "expression",
          expression: { kind: "methodCall", target: list, name: "clear", arguments: [] },
          span,
        },
      ]
    );
  }
  return null;
}

/** Whether a closure reads its implicit parameter, outside nested closures that have their own. */
function readsOwnIt(closure: AstNode): boolean {
  let reads = false;
  const visit = (node: AstNode): void => {
    if (node !== closure && node.kind === "closure") return;
    if (variableName(node) === "it") reads = true;
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (isAstNode(child)) visit(child);
    }
  };
  visit(closure);
  return reads;
}

function closureUsesName(closure: AstNode, name: string): boolean {
  let used = false;
  walkAst(closure.body, (node) => {
    if (variableName(node) === name) used = true;
  });
  return used;
}

function lowerEachStatement(
  node: AstNode,
  args: AstNode[],
  span: SourceSpan | null,
  context: LowerContext,
  stops = false,
): IrStatement[] {
  const receiverNode = asNode(node.object);
  if (receiverNode === null || args.length !== 1 || args[0]?.kind !== "closure") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_SHAPE",
        "Groovy each() needs one inline closure for automatic migration.",
      ),
    ];
  }
  if (
    receiverNode.kind !== "range" &&
    !isKnownListExpression(receiverNode, context) &&
    !onlyOf(inferType(receiverNode, context.types), STRING | NULL)
  ) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_RECEIVER",
        "Groovy each() is migrated automatically only for a proven list or numeric range receiver.",
      ),
    ];
  }

  const closure = args[0];
  const body = asNode(closure.body);
  if (body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_BODY",
        "Groovy each() closure does not contain a normal block body.",
      ),
    ];
  }
  const returns = closureReturns(body);
  if (
    returns.some(
      ({ insideLoop, value }) => insideLoop || (value !== null && !isPure(value, context)),
    )
  ) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_RETURN",
        "Groovy return inside each() ends only the current iteration; here it sits in a nested loop or returns a value with side effects, so it needs a manual rewrite.",
      ),
    ];
  }
  // In any(), the closure's result, returned or its last statement's value, stops the loop where it is true.
  const anyBody = stops ? anyLoopBody(body) : null;
  if (stops && anyBody === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_ANY_RETURN",
        "Groovy any() stops at the first true result of its closure; here a result's truth is known only at runtime, so it needs a manual rewrite.",
      ),
    ];
  }

  const parameterSpecified = closure.parameterSpecified === true;
  const closureParameters = groovyParameters(closure.parameters);
  if (closureParameters === null || (parameterSpecified && closureParameters.length !== 1)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_PARAMETERS",
        "Only one-parameter list/range each() closures are migrated automatically.",
      ),
    ];
  }
  const variable = parameterSpecified ? closureParameters[0]!.name : "it";

  const iterated = lowerIterated(receiverNode, context);
  const collection =
    iterated === null
      ? null
      : plainCharacters(
          iterated,
          body,
          closure.parameterSpecified === true ? (closureParameters[0]?.name ?? "it") : "it",
          context,
        );
  if (collection === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EACH_RECEIVER",
        "Groovy each() receiver could not be migrated safely.",
      ),
    ];
  }
  if (anyBody !== null)
    addDiagnostic(
      context,
      "SX_ANY_LOOP",
      "info",
      "Groovy any() ran its closure for each element until one returned a true value, and its result went unused; it becomes a for loop that a true result breaks and a false one continues.",
      span,
    );
  else if (returns.length > 0) noteReturnAsContinue(returns[0]!.node, context);
  const loopBody = lowerBlock(anyBody ?? body, context);
  return [
    {
      kind: "for",
      variable,
      collection,
      body:
        anyBody === null && returns.length > 0
          ? withoutFinalContinue(returnsAsContinue(loopBody))
          : loopBody,
      span,
    },
  ];
}

/**
 * The body of an any() closure as a loop body: a return of a true value becomes break and one of a false value or
 * none continue, and a last statement whose value is true, such as campdrain's `drainSpeed = 5`, is followed by a
 * break (Groovy returns the value of the closure's last statement, also at the end of an if branch). Null where a
 * result's truth is known only at runtime, or where a break would leave a switch instead.
 */
function anyLoopBody(body: AstNode): AstNode | null {
  let known = true;
  const truth = (value: AstNode | null): boolean | null => {
    if (value === null) return false;
    const constant = constantValue(value);
    return constant === undefined
      ? null
      : constant !== null && constant !== false && constant !== 0 && constant !== "";
  };
  const jump = (stops: boolean, span: SourceSpan | null): AstNode => ({
    kind: stops ? "break" : "continue",
    span,
    label: null,
  });
  const returns = (node: AstNode, inSwitch: boolean): AstNode => {
    if (node.kind === "closure") return node;
    if (node.kind === "return") {
      const stops = truth(asNode(node.value));
      if (stops === null || (stops && inSwitch)) known = false;
      return jump(stops === true, node.span);
    }
    const result: AstNode = { ...node };
    const nested = inSwitch || node.kind === "switch";
    for (const [key, value] of Object.entries(node)) {
      if (isAstNode(value)) result[key] = returns(value, nested);
      else if (Array.isArray(value))
        result[key] = value.map((item) => (isAstNode(item) ? returns(item, nested) : item));
    }
    return result;
  };
  // The statements ending with the closure's last one, with a break after a last value that is true.
  const last = (statements: AstNode[]): AstNode[] => {
    const tail = statements.at(-1);
    if (tail === undefined) return statements;
    const before = statements.slice(0, -1);
    const branch = (value: unknown): AstNode | null => {
      const node = asNode(value);
      return node === null || node.kind === "empty"
        ? node
        : { kind: "block", span: node.span, statements: last(branchStatements(node)) };
    };
    switch (tail.kind) {
      case "block":
        return [...before, { ...tail, statements: last(nodeArray(tail.statements)) }];
      case "if":
        return [...before, { ...tail, then: branch(tail.then), else: branch(tail.else) }];
      case "expressionStatement": {
        const expression = asNode(tail.expression);
        const value =
          expression?.kind === "binary" && expression.operator === "="
            ? asNode(expression.right)
            : expression;
        const stops = value === null ? null : truth(value);
        if (stops === null) known = false;
        return stops === true ? [...statements, jump(true, tail.span)] : statements;
      }
      case "break":
      case "continue":
      case "for":
      case "while":
      case "empty":
        return statements;
      default:
        known = false;
        return statements;
    }
  };
  const rewritten = returns(body, false);
  const result: AstNode = { ...rewritten, statements: last(nodeArray(rewritten.statements)) };
  return known ? result : null;
}

function noteReturnAsContinue(node: AstNode, context: LowerContext): void {
  addDiagnostic(
    context,
    "SX_EACH_RETURN_CONTINUE",
    "warning",
    "Groovy return inside each() or times() ended only the current iteration and discarded its value; it becomes continue. Check whether leaving the enclosing function was intended.",
    node.span,
  );
}

/** Return statements of a closure body, outside nested closures, and whether a loop encloses them. */
function closureReturns(
  body: AstNode,
): Array<{ node: AstNode; value: AstNode | null; insideLoop: boolean }> {
  const found: Array<{ node: AstNode; value: AstNode | null; insideLoop: boolean }> = [];
  const visit = (node: AstNode, insideLoop: boolean): void => {
    if (node.kind === "closure") return;
    if (node.kind === "return") found.push({ node, value: asNode(node.value), insideLoop });
    const loop = node.kind === "for" || node.kind === "while";
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, insideLoop || loop);
      }
    }
  };
  visit(body, false);
  return found;
}

/** A continue at the end of a loop body, also at the end of a final if branch, does nothing. */
function withoutFinalContinue(statements: IrStatement[]): IrStatement[] {
  const last = statements.at(-1);
  if (last?.kind === "continue") return statements.slice(0, -1);
  if (last?.kind !== "if") return statements;
  return [
    ...statements.slice(0, -1),
    { ...last, then: withoutFinalContinue(last.then), else: withoutFinalContinue(last.else) },
  ];
}

/** At script level a lowered return is a script transfer or end; inside each() it only ended the iteration. */
function returnsAsContinue(
  statements: IrStatement[],
  kind: "continue" | "break" = "continue",
): IrStatement[] {
  return statements.map((statement): IrStatement => {
    switch (statement.kind) {
      case "return":
      case "goto":
        return { kind, span: statement.span };
      case "exit":
        return statement.returned === true ? { kind, span: statement.span } : statement;
      case "if":
        return {
          ...statement,
          then: returnsAsContinue(statement.then, kind),
          else: returnsAsContinue(statement.else, kind),
        };
      case "switch":
        return {
          ...statement,
          cases: statement.cases.map((item) => ({
            ...item,
            body: returnsAsContinue(item.body, kind),
          })),
          default: returnsAsContinue(statement.default, kind),
        };
      default:
        return statement;
    }
  });
}

function containsReturnForCurrentClosure(node: AstNode, root = true): boolean {
  if (!root && node.kind === "closure") return false;
  if (node.kind === "return") return true;
  for (const value of Object.values(node)) {
    if (isAstNode(value) && containsReturnForCurrentClosure(value, false)) return true;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item) && containsReturnForCurrentClosure(item, false)) return true;
      }
    }
  }
  return false;
}

function lowerBackgroundSound(
  args: AstNode[],
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  // A null file stopped every background sound. stopAudio also stops the other sounds playing, which no corpus package
  // that stops them has: its only async sounds are its background sounds.
  if (args.length === 1 && isNullConstant(args[0])) return [{ kind: "stopAudio", span }];
  if (args.length < 1 || args.length > 2 || isNullConstant(args[0])) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_BACKGROUND_SOUND_CONTROL",
        "This background sound call needs manual migration.",
      ),
    ];
  }
  const lowered = lowerExpression(args[0]!, context);
  const file = lowered === null ? null : mediaFile(lowered, "sounds", node, context);
  const repeatCount = args[1] === undefined ? null : lowerExpression(args[1], context);
  if (file === null || (args[1] !== undefined && repeatCount === null)) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_BACKGROUND_SOUND_ARGUMENT",
        "Background sound arguments could not be migrated.",
      ),
    ];
  }
  const fixedPasses =
    repeatCount === null ||
    (repeatCount.kind === "literal" &&
      typeof repeatCount.value === "number" &&
      Number.isInteger(repeatCount.value) &&
      repeatCount.value >= 1);
  // A count computed at runtime plays nothing below one pass, which `repeat: n times` rejects (PainStacks' and
  // ShockJack's shock length).
  if (!fixedPasses) {
    const play: IrStatement = { kind: "playAudio", file, async: true, repeatCount, span };
    const enough: IrExpression = {
      kind: "binary",
      operator: ">=",
      left: repeatCount!,
      right: { kind: "literal", value: 1 },
    };
    return [{ kind: "if", condition: enough, then: [play], else: [], span }];
  }
  // One pass is the plain form. A file computed at runtime that is null would have stopped all sounds; ShockReflex can
  // compute one, only right after a stop.
  const passes = repeatCount?.kind === "literal" && repeatCount.value === 1 ? null : repeatCount;
  return [{ kind: "playAudio", file, async: true, repeatCount: passes, span }];
}

function lowerSave(
  args: AstNode[],
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (args.length !== 2)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_SAVE_ARITY",
        "save() must have exactly two arguments.",
      ),
    ];
  const key = lowerExpression(args[0]!, context);
  if (key === null)
    return [
      unsupportedStatement(context, node, "SX_SAVE_ARGUMENT", "save() key could not be migrated."),
    ];
  // Legacy save(key, null) deleted the key. Generated reads compare with null explicitly, so a stored null and a
  // missing key behave alike; only a literal null needs the explicit delete.
  if (isNullConstant(args[1])) return [{ kind: "delete", key, span }];
  const value = lowerExpression(args[1]!, context);
  if (value === null)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_SAVE_ARGUMENT",
        "save() value could not be migrated.",
      ),
    ];
  return [{ kind: "save", key, value, span }];
}

function lowerIf(node: AstNode, context: LowerContext): IrStatement[] {
  const conditionNode = asNode(node.condition);
  const thenNode = asNode(node.then);
  const elseNode = asNode(node.else);
  const condition = conditionNode === null ? null : lowerCondition(conditionNode, context);
  if (condition === null || thenNode === null || thenNode.kind === "empty") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_IF",
        "if condition or body could not be migrated safely.",
      ),
    ];
  }
  // A branch that a key test guards may read the key (#536).
  const then = withPresentKeys(conditionFacts(conditionNode!, context), thenNode, context, () =>
    lowerBranch(thenNode, context),
  );
  const otherwise =
    elseNode === null
      ? []
      : withPresentKeys(conditionFacts(conditionNode!, context, true), elseNode, context, () =>
          lowerBranch(elseNode, context),
        );
  return [{ kind: "if", condition, then, else: otherwise, span: node.span }];
}

function lowerBranch(node: AstNode, context: LowerContext): IrStatement[] {
  if (node.kind === "empty") return [];
  if (node.kind === "block") return lowerBlock(node, context);
  const [prelude, lowered, postlude] = withSurroundings(context, node);
  return [...prelude, ...lowered, ...postlude];
}

function lowerWhile(node: AstNode, context: LowerContext): IrStatement[] {
  // A legacy settings menu becomes one form of toggles (lowerMenuForm).
  const menuForm = lowerMenuForm(node, context);
  if (menuForm !== null) return menuForm;
  const conditionNode = asNode(node.condition);
  const body = asNode(node.body);
  const always: IrExpression = { kind: "literal", value: true };
  const effect = conditionNode?.kind === "binary" ? asNode(conditionNode.left) : null;
  if (
    body !== null &&
    effect !== null &&
    conditionNode?.operator === "||" &&
    isTrueConstant(asNode(conditionNode.right))
  ) {
    // `while (effect() || true)` performs the effect before every iteration of an endless loop.
    const statement: AstNode = {
      kind: "expressionStatement",
      span: effect.span,
      expression: effect,
    };
    return [
      {
        kind: "while",
        condition: always,
        body: [...lowerBranch(statement, context), ...lowerBranch(body, context)],
        span: node.span,
      },
    ];
  }
  const [prelude, condition] = withPrelude(context, () =>
    conditionNode === null ? null : lowerCondition(conditionNode, context),
  );
  if (condition !== null && body !== null && prelude.length > 0) {
    // The prompt must be shown before every evaluation of the condition, not once before the loop.
    return [
      {
        kind: "while",
        condition: always,
        body: [...prelude, breakUnless(condition), ...lowerBranch(body, context)],
        span: node.span,
      },
    ];
  }
  if (condition === null || body === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_WHILE",
        "while condition or body could not be migrated safely.",
      ),
    ];
  }
  return [{ kind: "while", condition, body: lowerBranch(body, context), span: node.span }];
}

function breakUnless(condition: IrExpression): IrStatement {
  return {
    kind: "if",
    condition: negate(condition),
    then: [{ kind: "break", span: null }],
    else: [],
    span: null,
  };
}

function negate(condition: IrExpression): IrExpression {
  if (condition.kind === "unary" && condition.operator === "not") return condition.value;
  if (
    condition.kind === "binary" &&
    (condition.operator === "and" || condition.operator === "or")
  ) {
    // De Morgan keeps generated null/zero/empty checks readable: `x == null or x == 0`.
    return {
      kind: "binary",
      operator: condition.operator === "and" ? "or" : "and",
      left: negate(condition.left),
      right: negate(condition.right),
    };
  }
  if (condition.kind === "binary" && condition.operator === "==") {
    return { ...condition, operator: "!=" };
  }
  if (condition.kind === "binary" && condition.operator === "!=") {
    return { ...condition, operator: "==" };
  }
  return { kind: "unary", operator: "not", value: condition };
}

function lowerFor(node: AstNode, context: LowerContext): IrStatement[] {
  const variable = text(node.variable);
  const collectionNode = asNode(node.collection);
  const loopBody = asNode(node.body);
  if (variable === "forLoopDummyParameter" && collectionNode?.kind === "list") {
    return lowerCStyleFor(node, collectionNode, loopBody, context);
  }
  // A single statement as the body is a block of one statement.
  const block =
    loopBody !== null && loopBody.kind !== "block" && loopBody.kind !== "empty"
      ? { kind: "block", span: loopBody.span, statements: [loopBody] }
      : loopBody;
  // Groovy iterated a map's entries; a dict loop visits its keys, so `entry.key` is the key, and `entry.value` the
  // loop's value variable (#639), or a lookup where the body changes the map and Groovy's entry saw the change.
  const isMapLoop =
    block !== null &&
    variable !== null &&
    collectionNode !== null &&
    variableName(collectionNode) !== null &&
    isDictionary(collectionNode, context);
  const valueName =
    isMapLoop && !changesMap(block!, variableName(collectionNode!)!)
      ? entryValueName(block!, variable!)
      : null;
  const entries = isMapLoop ? withEntryReads(block!, variable!, collectionNode!, valueName) : null;
  const readsValue =
    entries !== null &&
    valueName !== null &&
    JSON.stringify(entries).includes(`"name":"${valueName}"`);
  if (readsValue) context.generatedNames.add(valueName!);
  const body = entries ?? block;
  // A loop that removes its element from the collection proves it a list (elementRemovals).
  let removes = false;
  if (body !== null) walkAst(body, (child) => (removes ||= context.elementRemovals.has(child)));
  const iterated = collectionNode === null ? null : lowerIterated(collectionNode, context, removes);
  const collection =
    iterated === null || body === null || variable === null
      ? iterated
      : plainCharacters(iterated, body, variable, context);
  if (variable === null || collection === null || body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_FOR",
        "for loop could not be migrated safely.",
      ),
    ];
  }
  // A loop over a dict's keys reads each key while it is present (#536).
  const keysOf =
    entries !== null
      ? collectionNode
      : collectionNode?.kind === "methodCall" &&
          constantString(collectionNode.method) === "keySet" &&
          nodeArray(asNode(collectionNode.arguments)?.items).length === 0
        ? asNode(collectionNode.object)
        : null;
  const dict =
    keysOf !== null && isDictionary(keysOf, context) ? bindingKey(keysOf, context.bindings) : null;
  const loopId = bindingSpanId(node);
  const loopKey =
    context.bindings.get(node) ?? (loopId === null ? undefined : context.bindings.get(loopId));
  const facts = dict === null ? [] : [`${dict}\u0000$${loopKey ?? variable}`];
  const loweredBody = withPresentKeys(facts, body, context, () => lowerBlock(body, context));
  return [
    {
      kind: "for",
      variable,
      ...(readsValue ? { valueVariable: valueName! } : {}),
      collection,
      body: loweredBody,
      span: node.span,
    },
  ];
}

/** The name of an entry loop's value variable: `value`, unless the body names something so. */
function entryValueName(body: AstNode, entry: string): string {
  let taken = false;
  walkAst(
    body,
    (node) => (taken ||= variableName(node) === "value" || text(node.name) === "value"),
  );
  return taken || entry === "value" ? `${entry}Value` : "value";
}

/** Whether a loop body writes into the map a variable names: an index or property write, or put/remove/clear. */
function changesMap(body: AstNode, map: string): boolean {
  let changes = false;
  walkAst(body, (node) => {
    const operator = text(node.operator) ?? "";
    const target =
      node.kind === "binary" &&
      operator.endsWith("=") &&
      !["==", "!=", "<=", ">="].includes(operator)
        ? asNode(node.left)
        : null;
    if (
      target !== null &&
      (target.kind === "property" || (target.kind === "binary" && target.operator === "[")) &&
      variableName(asNode(target.kind === "property" ? target.object : target.left)) === map
    )
      changes = true;
    if (
      node.kind === "methodCall" &&
      variableName(asNode(node.object)) === map &&
      ["put", "putAll", "putAt", "remove", "clear"].includes(constantString(node.method) ?? "")
    )
      changes = true;
  });
  return changes;
}

/**
 * A map loop's body that reads the entry only as `entry.key` and `entry.value` (also `getKey()` and `getValue()`),
 * rewritten to read the key, which a dict loop visits, and `map[key]`; null when the body uses the entry otherwise.
 */
function withEntryReads(
  body: AstNode,
  variable: string,
  map: AstNode,
  /** The loop's value variable (#639), which `entry.value` reads where the body does not change the map. */
  valueName: string | null = null,
): AstNode | null {
  let other = false;
  const key = (span: SourceSpan | null | undefined): AstNode => ({
    kind: "variable",
    span: span ?? null,
    name: variable,
    type: "java.lang.Object",
  });
  const rewrite = (node: AstNode): AstNode => {
    const member =
      node.kind === "property"
        ? constantString(node.property)
        : node.kind === "methodCall" && nodeArray(asNode(node.arguments)?.items).length === 0
          ? ENTRY_GETTERS.get(constantString(node.method) ?? "")
          : undefined;
    if (variableName(asNode(node.object)) === variable && (member === "key" || member === "value"))
      return member === "key"
        ? key(node.span)
        : valueName !== null
          ? { kind: "variable", span: node.span, name: valueName, type: "java.lang.Object" }
          : {
              kind: "binary",
              span: node.span,
              operator: "[",
              left: structuredClone(map),
              right: key(node.span),
            };
    if (variableName(node) === variable) other = true;
    const result: AstNode = { ...node };
    for (const [name, child] of Object.entries(node)) {
      if (name === "span") continue;
      if (isAstNode(child)) result[name] = rewrite(child);
      else if (Array.isArray(child))
        result[name] = child.map((item: unknown) => (isAstNode(item) ? rewrite(item) : item));
    }
    return result;
  };
  const rewritten = rewrite(body);
  return other ? null : rewritten;
}

const ENTRY_GETTERS = new Map([
  ["getKey", "key"],
  ["getValue", "value"],
]);

/**
 * A collection a loop iterates. Groovy iterated a range up to the last whole step within a fractional upper bound,
 * where TeaseScript needs a whole bound (#689), so a bound that may hold a fraction is floored, or for an exclusive
 * range raised to the first whole number past it (`0..<2.5` went through 0, 1, and 2).
 */
function lowerIterated(
  node: AstNode,
  context: LowerContext,
  provenList = false,
): IrExpression | null {
  const collection = lowerExpression(node, context);
  if (collection === null) return null;
  // Groovy iterated text by character.
  const type = node.kind === "range" || provenList ? 0 : inferType(node, context.types);
  if ((type & STRING) !== 0) {
    if (onlyOf(type, STRING))
      return {
        kind: "methodCall",
        target: collection,
        name: "split",
        arguments: [{ kind: "literal", value: "" }],
      };
    addDiagnostic(
      context,
      "SX_ITEMS_OF_TEXT",
      "info",
      "Groovy iterated text by character, a list by element, and null not at all; this value is not proven to be one of them, so a helper splits text into its characters and makes null an empty list.",
      node.span,
    );
    return useHelper(context, "items", [collection]);
  }
  const toNode = node.kind === "range" ? asNode(node.to) : null;
  if (collection.kind !== "range" || toNode === null || !mayBeFractional(toNode, context))
    return collection;
  addDiagnostic(
    context,
    "SX_RANGE_FLOOR",
    "info",
    "Groovy iterated this range up to the last whole step within its upper bound, which may hold a fraction; the bound is rounded to that step, floor for an inclusive range and ceil for an exclusive one.",
    node.span,
  );
  const name = collection.inclusive ? "floor" : "ceil";
  return { ...collection, to: { kind: "call", name, positional: [collection.to], named: {} } };
}

/**
 * The characters of a text that a loop shows one by one, as a typewriter effect does: the text holds message markup
 * (markup.ts) that would show as markers until its span closes, so the loop goes through the text without them. Other
 * collections stay as they are.
 */
function plainCharacters(
  collection: IrExpression,
  body: AstNode,
  variable: string,
  context: LowerContext,
): IrExpression {
  // The loop shows the text so far: it adds each character to a text it shows.
  let shows = false;
  let adds = false;
  walkAst(body, (child) => {
    shows ||= child.kind === "methodCall" && legacyApiCall(child, context)?.name === "show";
    if (child.kind !== "binary" || (child.operator !== "+=" && child.operator !== "=")) return;
    walkAst(asNode(child.right), (part) => (adds ||= variableName(part) === variable));
  });
  if (!shows || !adds) return collection;
  const characters =
    collection.kind === "methodCall" &&
    collection.name === "split" &&
    collection.arguments.length === 1 &&
    collection.arguments[0]!.kind === "literal" &&
    collection.arguments[0]!.value === "";
  const items = collection.kind === "call" && collection.name === "sexscriptLegacyItems";
  if (!characters && !items) return collection;
  addDiagnostic(
    context,
    "SX_TYPEWRITER_MARKUP",
    "info",
    "This loop shows a text character by character; message markup in the text would show as markers until its span closes, so the loop goes through the text without markup.",
    body.span,
  );
  if (collection.kind === "methodCall")
    return { ...collection, target: useHelper(context, "plainText", [collection.target]) };
  if (collection.kind === "call")
    return {
      ...collection,
      positional: [useHelper(context, "plainText", [collection.positional[0]!])],
    };
  return collection;
}

/**
 * Whether a position in the list `target` can be one past its end: a random position plus a positive number,
 * `getRandom(n) + 1` for a 1-based pick, a list's size, a menu choice from the list followed by written options
 * (DungeonTrials' `getSelectedValue(text, weapons + ["No weapon"])`, whose last option is past the end), or a variable
 * assigned one of these.
 */
function mayIndexPastEnd(
  node: AstNode,
  context: LowerContext,
  target: AstNode | null = null,
  seen = new Set<string>(),
): boolean {
  if (node.kind === "binary" && text(node.operator) === "+") {
    const [left, right] = [asNode(node.left), asNode(node.right)];
    const random = (side: AstNode | null): boolean =>
      side?.kind === "methodCall" &&
      ["getRandom", "nextInt"].includes(constantString(side.method) ?? "");
    const positive = (side: AstNode | null): boolean => {
      const value = side === null ? undefined : constantValue(side);
      return typeof value === "number" && value > 0;
    };
    return (random(left) && positive(right)) || (random(right) && positive(left));
  }
  if (node.kind === "methodCall" && constantString(node.method) === "size") return true;
  if (node.kind === "property" && ["size", "length"].includes(constantString(node.property) ?? ""))
    return true;
  if (node.kind === "methodCall" && legacyApiCall(node, context)?.name === "getSelectedValue") {
    const options = nodeArray(asNode(node.arguments)?.items)[1];
    const written =
      options?.kind === "binary" && text(options.operator) === "+" ? asNode(options.right) : null;
    const listName = target === null ? null : variableName(target);
    return (
      written?.kind === "list" &&
      nodeArray(written.items).length > 0 &&
      listName !== null &&
      variableName(asNode(options!.left)) === listName
    );
  }
  if (node.kind === "variable") {
    const key = bindingKey(node, context.bindings);
    if (key === null || seen.has(key)) return false;
    seen.add(key);
    return (context.assignedValues.get(key) ?? []).some((value) =>
      mayIndexPastEnd(value, context, target, seen),
    );
  }
  return false;
}

/** Whether a variable used as a list position is ever assigned a negative number, such as -1 for "none yet". */
function mayIndexNegative(node: AstNode, context: LowerContext): boolean {
  // `choice - 1` after a menu whose first button gave 0, such as a "Back" button.
  if (node.kind === "binary" && node.operator === "-") {
    const right = constantValue(asNode(node.right) ?? undefined);
    const left = asNode(node.left);
    return typeof right === "number" && right > 0 && left !== null && mayBeZero(left, context);
  }
  if (node.kind !== "variable") return false;
  const key = bindingKey(node, context.bindings);
  return (
    key !== null &&
    (context.assignedValues.get(key) ?? []).some((value) => negativeConstantIndex(value) !== null)
  );
}

/** Whether a value may be 0: a menu selection or random draw, which start at 0, or a variable holding one or a 0. */
function mayBeZero(node: AstNode, context: LowerContext, seen = new Set<string>()): boolean {
  if (constantValue(node) === 0) return true;
  if (node.kind === "methodCall") {
    const name = legacyApiCall(node, context)?.name ?? "";
    return name === "getSelectedValue" || name === "getRandom";
  }
  if (node.kind !== "variable") return false;
  const key = bindingKey(node, context.bindings);
  if (key === null || seen.has(key)) return false;
  seen.add(key);
  return (context.assignedValues.get(key) ?? []).some((value) => mayBeZero(value, context, seen));
}

/**
 * Whether a value may be a missing storage value, which Groovy read as null: a storage read, or a variable that starts
 * with one or with null.
 */
function mayReadNull(node: AstNode, context: LowerContext): boolean {
  if (node.kind === "methodCall") {
    const name = legacyApiCall(node, context)?.name ?? "";
    if (DIRECT_STORAGE_LOADS.has(name) || ONLINE_LOADS.has(name)) return true;
    // A function of the package whose returns include null, such as a stored value or a `return null`.
    const call = callParts(node);
    if (
      call?.inherited !== true ||
      !(context.functions.has(call.name) || context.packageFunctions.has(call.name))
    )
      return false;
    const type = inferType(node, context.types);
    return type !== UNKNOWN && (type & NULL) !== 0;
  }
  if (node.kind !== "variable") return false;
  const key = bindingKey(node, context.bindings);
  const first = key === null ? undefined : context.assignedValues.get(key)?.[0];
  return first !== undefined && (isNullConstant(first) || mayReadNull(first, context));
}

/** Methods whose results are whole numbers. */
const WHOLE_NUMBER_METHODS = new Set([
  "size",
  "length",
  "getRandom",
  "round",
  "intdiv",
  "toInteger",
  "intValue",
  "indexOf",
  "count",
  "floor",
  "ceil",
]);

/**
 * Whether a Groovy number may hold a fraction: a fractional literal, a division (which gave a decimal where it did not
 * divide evenly), a value of unknown origin such as a parameter, or a variable assigned one of these.
 */
function mayBeFractional(node: AstNode, context: LowerContext, seen = new Set<string>()): boolean {
  switch (node.kind) {
    case "constant":
      return typeof node.value !== "number" || !Number.isInteger(node.value);
    case "unaryMinus":
    case "unaryPlus": {
      const value = asNode(node.value);
      return value === null || mayBeFractional(value, context, seen);
    }
    case "binary": {
      const operator = text(node.operator) ?? "";
      const left = asNode(node.left);
      const right = asNode(node.right);
      // An element of a Java array of whole numbers is whole.
      if (operator === "[" && left !== null)
        return !context.integerArrays.has(bindingKey(left, context.bindings) ?? "");
      if (!["+", "-", "*", "%"].includes(operator) || left === null || right === null) return true;
      return mayBeFractional(left, context, seen) || mayBeFractional(right, context, seen);
    }
    case "property":
      return !["size", "length"].includes(constantString(node.property) ?? "");
    case "methodCall":
      return !WHOLE_NUMBER_METHODS.has(constantString(node.method) ?? "");
    case "variable": {
      const key = bindingKey(node, context.bindings);
      if (key === null) return true;
      if (context.integerVariables.has(key) || seen.has(key)) return false;
      const values = context.assignedValues.get(key);
      if (values === undefined || values.length === 0) return true;
      seen.add(key);
      return [...values, ...(context.compoundValues.get(key) ?? [])].some((value) =>
        mayBeFractional(value, context, seen),
      );
    }
    default:
      return true;
  }
}

function lowerCStyleFor(
  node: AstNode,
  collection: AstNode,
  loopBody: AstNode | null,
  context: LowerContext,
): IrStatement[] {
  const parts = nodeArray(collection.items);
  // A single statement as the body is a block of one statement.
  const body =
    loopBody !== null && loopBody.kind !== "block" && loopBody.kind !== "empty"
      ? { kind: "block", span: loopBody.span, statements: [loopBody] }
      : loopBody;
  if (parts.length !== 3 || body?.kind !== "block") {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_FOR",
        "C-style for loop shape is not supported.",
      ),
    ];
  }
  const initial = parts[0]!;
  const conditionNode = parts[1]!;
  const update = parts[2]!;
  // Each control expression is its own evaluation point, so input prompts stay next to it.
  const [initialPrelude, initialStatements] = withStatementRoot(context, initial, () =>
    lowerForControlExpression(initial, context),
  );
  // `for (;;)` has no condition, so it loops until a break.
  const [prelude, condition] = withStatementRoot(context, conditionNode, () =>
    conditionNode.groovyType === "org.codehaus.groovy.ast.expr.EmptyExpression"
      ? ({ kind: "literal", value: true } as const)
      : lowerCondition(conditionNode, context),
  );
  const [updatePrelude, updateStatements] = withStatementRoot(context, update, () =>
    lowerForControlExpression(update, context),
  );
  if (
    condition === null ||
    prelude.length > 0 ||
    initialStatements === null ||
    updateStatements === null
  ) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_FOR",
        "C-style for loop control expressions could not be migrated safely.",
      ),
    ];
  }

  const step = [...updatePrelude, ...updateStatements];
  return [
    ...initialPrelude,
    ...initialStatements.map((statement): IrStatement =>
      statement.kind === "let" ? { ...statement, loopCounter: true } : statement,
    ),
    {
      kind: "while",
      condition,
      // `continue` in a for loop still runs the update step.
      body: [
        ...withStepBeforeContinue(withoutFinalContinue(lowerBlock(body, context)), step),
        ...step,
      ],
      span: node.span,
    },
  ];
}

function withStepBeforeContinue(statements: IrStatement[], step: IrStatement[]): IrStatement[] {
  return statements.flatMap((statement): IrStatement[] => {
    switch (statement.kind) {
      case "continue":
        return [...structuredClone(step), statement];
      case "if":
        return [
          {
            ...statement,
            then: withStepBeforeContinue(statement.then, step),
            else: withStepBeforeContinue(statement.else, step),
          },
        ];
      case "switch":
        return [
          {
            ...statement,
            cases: statement.cases.map((item) => ({
              ...item,
              body: withStepBeforeContinue(item.body, step),
            })),
            default: withStepBeforeContinue(statement.default, step),
          },
        ];
      default:
        // A continue inside a nested loop belongs to that loop.
        return [statement];
    }
  });
}

/** Groovy conversion methods of numbers and text, by the TeaseScript conversion that reads the same value. */
const CONVERSION_METHODS = new Map([
  ["toInteger", "toInteger"],
  ["toLong", "toInteger"],
  ["toFloat", "toNumber"],
  ["toDouble", "toNumber"],
  ["toBigDecimal", "toNumber"],
]);

/** Java's static number parsers, by the TeaseScript conversion that reads the same value. */
const STATIC_CONVERSIONS = new Map([
  ["Integer.parseInt", "toInteger"],
  ["Integer.valueOf", "toInteger"],
  ["Long.parseLong", "toInteger"],
  ["Double.parseDouble", "toNumber"],
  ["Double.valueOf", "toNumber"],
  ["Float.parseFloat", "toNumber"],
]);

function lowerForControlExpression(node: AstNode, context: LowerContext): IrStatement[] | null {
  if (node.kind === "declaration") return lowerDeclaration(node, node.span, context);
  if (node.kind === "binary") return lowerAssignment(node, node.span, context);
  if (node.kind === "postfix" || node.kind === "prefix")
    return lowerPostfix(node, node.span, context);
  // An omitted part, or a bare variable as in `for (count; count > 0; count--)`, does nothing.
  if (
    node.kind === "variable" ||
    node.groovyType === "org.codehaus.groovy.ast.expr.EmptyExpression"
  )
    return [];
  return null;
}

function lowerSwitch(node: AstNode, context: LowerContext): IrStatement[] {
  const valueNode = asNode(node.expression);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  if (value === null)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_SWITCH_VALUE",
        "switch value could not be migrated.",
      ),
    ];

  const caseNodes = nodeArray(node.cases);
  const defaultNode = asNode(node.default);
  const defaultSource = switchBodyStatements(defaultNode);
  if (defaultSource === null) {
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_SWITCH_CASE",
        "Switch default body could not be migrated safely.",
      ),
    ];
  }

  const cases: IrSwitchCase[] = [];
  const matchNodes: AstNode[] = [];
  for (let index = 0; index < caseNodes.length; index += 1) {
    const caseNode = caseNodes[index]!;
    if (caseNode.kind !== "case")
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_SWITCH_CASE",
          "Unexpected Groovy switch case node.",
        ),
      ];
    const matchNode = asNode(caseNode.expression);
    // A closure case is a condition on the switched value (closureCaseTest), tested in the if chain.
    const match =
      matchNode === null
        ? null
        : closureCaseTest(matchNode) !== null
          ? ({ kind: "literal", value: null } satisfies IrExpression)
          : lowerExpression(matchNode, context);
    if (match === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_SWITCH_CASE",
          "Switch case could not be migrated safely.",
        ),
      ];
    }
    const sourceStatements = collectSwitchPath(caseNodes, index, defaultSource);
    if (sourceStatements === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_SWITCH_CASE",
          "Switch case body could not be migrated safely.",
        ),
      ];
    }
    // A case for a value the switched storage key never holds never runs.
    const known = valueNode === null ? null : storedValues(valueNode, context);
    const caseValue = constantString(matchNode ?? undefined);
    const outer = context.unreachable;
    context.unreachable ||= known !== null && caseValue !== null && !known.has(caseValue);
    const loweredBody = lowerStatementList(eliminateSwitchBreaks(sourceStatements), null, context);
    context.unreachable = outer;
    cases.push({ span: caseNode.span, matches: [match], body: loweredBody });
    matchNodes.push(matchNode!);
  }

  const defaultStatements = lowerStatementList(
    eliminateSwitchBreaks(withoutTerminalBreak(defaultSource)),
    null,
    context,
  );
  // A text case matched any subject whose text equals it (`"1"` matches 1); TeaseScript compares values.
  const subjectType = valueNode === null ? UNKNOWN : inferType(valueNode, context.types);
  const textCase = matchNodes.findIndex((matchNode) =>
    onlyOf(inferType(matchNode, context.types), STRING | NULL),
  );
  if (textCase >= 0 && onlyOf(subjectType, NUMBER | BOOLEAN | NULL) && subjectType !== NULL) {
    return [
      unsupportedStatement(
        context,
        matchNodes[textCase]!,
        "SX_SWITCH_CASE_MATCH",
        "Groovy matched this text case against the text of a non-text switch value; rewrite the case with the value's own type.",
      ),
    ];
  }
  // A Groovy list case matches any of its elements, which a case with several values expresses (#528).
  const valueCases = cases.map((switchCase, index) => {
    const [match] = switchCase.matches;
    // Only scalar literals: a range inside a list case is an element that `contains` compares, not a range case.
    const listCase =
      match?.kind === "list" &&
      match.items.length > 0 &&
      match.items.every((item) => item.kind === "literal" && item.value !== null) &&
      onlyOf(inferType(matchNodes[index]!, context.types), LIST);
    return listCase ? { ...switchCase, matches: match.items } : switchCase;
  });
  const closureCases = matchNodes.map((matchNode) => closureCaseTest(matchNode));
  if (closureCases.every((test) => test === null) && isAcceptedSwitch(valueCases)) {
    return [
      { kind: "switch", value, cases: valueCases, default: defaultStatements, span: node.span },
    ];
  }
  // Accepted switch cases are distinct literals or ranges; other Groovy cases become an equivalent if chain when
  // their isCase meaning is known from the case value: membership for lists and literal ranges, equality for
  // scalars. Groovy evaluated the switch value once, so case expressions with effects need a temporary.
  const listCases: boolean[] = [];
  for (let index = 0; index < cases.length; index += 1) {
    const match = cases[index]!.matches[0]!;
    const matchNode = matchNodes[index]!;
    const type = inferType(matchNode, context.types);
    // A Groovy range runs in either direction; bounds evaluated twice must be plain values. A text range holds only
    // the texts its iteration reaches ("a".."c" holds "b" but not "ba"), which a bounds test cannot express; for a
    // number subject, a bound of unknown type is a number or never matches, which TeaseScript rejects.
    const boundTypes =
      matchNode.kind === "range"
        ? [matchNode.from, matchNode.to].map((bound) => inferType(asNode(bound), context.types))
        : [];
    const textRange =
      boundTypes.some((type) => onlyOf(type, STRING)) ||
      (boundTypes.some((type) => (type & STRING) !== 0) && !onlyOf(subjectType, NUMBER));
    if (match.kind === "range" && textRange) {
      return [
        unsupportedStatement(
          context,
          matchNode,
          "SX_SWITCH_CASE_MATCH",
          'Groovy matched this range case by the values its iteration reaches, which for text ("a".."c" holds "b" but not "ba") a bounds test cannot express. Rewrite the case as an explicit condition.',
        ),
      ];
    }
    const boundsRepeatable = match.kind === "range" && [match.from, match.to].every(isPlainValue);
    const known =
      closureCases[index] !== null ||
      match.kind === "list" ||
      boundsRepeatable ||
      (match.kind !== "range" &&
        (onlyOf(type, LIST) || onlyOf(type, STRING | NUMBER | BOOLEAN | NULL)));
    if (!known) {
      return [
        unsupportedStatement(
          context,
          matchNodes[index]!,
          "SX_SWITCH_CASE_MATCH",
          "This switch case's Groovy isCase meaning depends on its runtime value (a list, a range in either direction, a class, a pattern, or a closure); rewrite the case as an explicit condition.",
        ),
      ];
    }
    listCases.push(match.kind !== "range" && onlyOf(type, LIST));
  }
  const subjectName = valueNode === null ? null : variableName(valueNode);
  const stableSubject =
    valueNode?.kind === "constant" ||
    (subjectName !== null &&
      (context.types.singleAssignment?.has(subjectName) === true ||
        context.stableNames.has(subjectName)));
  const repeatable =
    valueNode !== null &&
    isRepeatableExpression(valueNode) &&
    (stableSubject || matchNodes.every((matchNode) => isPure(matchNode, context)));
  context.switchValues += 1;
  const subject: IrExpression = repeatable
    ? value
    : { kind: "variable", name: `switchValue${context.switchValues}` };
  if (subject.kind === "variable" && !repeatable) context.generatedNames.add(subject.name);
  let chain: IrStatement[] = defaultStatements;
  for (let index = cases.length - 1; index >= 0; index -= 1) {
    const switchCase = cases[index]!;
    const test = closureCases[index];
    // Groovy called a closure case with the switched value and took the truth of its result.
    const condition =
      test === null || test === undefined
        ? caseMatches(subject, switchCase.matches[0]!, listCases[index]!)
        : lowerCondition(
            replaceVariable(
              test.expression,
              test.parameter,
              repeatable && valueNode !== null
                ? valueNode
                : {
                    kind: "variable",
                    span: null,
                    name: subject.kind === "variable" ? subject.name : "switchValue",
                    type: "java.lang.Object",
                  },
            ),
            context,
          );
    if (condition === null)
      return [
        unsupportedStatement(
          context,
          matchNodes[index]!,
          "SX_SWITCH_CASE_MATCH",
          "This closure case's condition could not be converted; rewrite the case as an explicit condition.",
        ),
      ];
    chain = [{ kind: "if", condition, then: switchCase.body, else: chain, span: switchCase.span }];
  }
  return repeatable
    ? chain
    : [
        {
          kind: "let",
          name: subject.kind === "variable" ? subject.name : "switchValue",
          value,
          span: node.span,
        },
        ...chain,
      ];
}

/** A closure case's one expression and its parameter (`case { it < 2 }`), or null for any other case. */
function closureCaseTest(node: AstNode | null): { expression: AstNode; parameter: string } | null {
  if (node?.kind !== "closure") return null;
  const parameters = groovyParameters(node.parameters);
  if (parameters === null || parameters.length > 1) return null;
  const parameter = node.parameterSpecified === true ? parameters[0]?.name : "it";
  const statements = nodeArray(asNode(node.body)?.statements);
  const only = statements.length === 1 ? statements[0]! : null;
  const expression =
    only?.kind === "expressionStatement"
      ? asNode(only.expression)
      : only?.kind === "return"
        ? asNode(only.value)
        : null;
  return parameter === undefined || expression === null ? null : { expression, parameter };
}

/** A copy of an expression with each read of a variable replaced by another expression. */
function replaceVariable(node: AstNode, name: string, replacement: AstNode): AstNode {
  if (node.kind === "variable" && variableName(node) === name) return replacement;
  if (node.kind === "closure") return node;
  const result: AstNode = { ...node };
  for (const [key, child] of Object.entries(node)) {
    if (key === "span") continue;
    if (isAstNode(child)) result[key] = replaceVariable(child, name, replacement);
    else if (Array.isArray(child))
      result[key] = child.map((item: unknown) =>
        isAstNode(item) ? replaceVariable(item, name, replacement) : item,
      );
  }
  return result;
}

/**
 * Accepted switch cases are literal values or ranges (#528); a value or range that another case already covers is a
 * compile error, so such a switch stays an if chain, which keeps Groovy's first match.
 */
function isAcceptedSwitch(cases: IrSwitchCase[]): boolean {
  const seen = new Set<string>();
  const ranges: Array<{ low: number; high: number; inclusive: boolean }> = [];
  const numbers: number[] = [];
  const literal = (expression: IrExpression): boolean =>
    expression.kind === "literal" && expression.value !== null;
  for (const match of cases.flatMap((switchCase) => switchCase.matches)) {
    // A range case is an ascending, non-empty range of numbers (#528); Groovy also matched descending and text
    // ranges, which the if chain tests.
    const ascending =
      match.kind === "range" &&
      match.from.kind === "literal" &&
      match.to.kind === "literal" &&
      typeof match.from.value === "number" &&
      typeof match.to.value === "number" &&
      (match.inclusive ? match.from.value <= match.to.value : match.from.value < match.to.value);
    const valid = literal(match) || ascending;
    const key = JSON.stringify(match);
    if (!valid || seen.has(key)) return false;
    seen.add(key);
    if (match.kind === "literal" && typeof match.value === "number") numbers.push(match.value);
    if (
      match.kind === "range" &&
      match.from.kind === "literal" &&
      match.to.kind === "literal" &&
      typeof match.from.value === "number" &&
      typeof match.to.value === "number"
    ) {
      ranges.push({ low: match.from.value, high: match.to.value, inclusive: match.inclusive });
    }
  }
  const covers = (range: (typeof ranges)[number], value: number): boolean =>
    value >= range.low && (range.inclusive ? value <= range.high : value < range.high);
  return ranges.every(
    (range, index) =>
      !numbers.some((value) => covers(range, value)) &&
      ranges
        .slice(index + 1)
        .every((other) => !covers(range, other.low) && !covers(other, range.low)),
  );
}

/** Literals, variables, properties, and arithmetic on them: values that may be evaluated twice. */
function isPlainValue(expression: IrExpression): boolean {
  switch (expression.kind) {
    case "literal":
    case "variable":
      return true;
    case "property":
      return isPlainValue(expression.target);
    case "unary":
      return isPlainValue(expression.value);
    case "binary":
      return isPlainValue(expression.left) && isPlainValue(expression.right);
    default:
      return false;
  }
}

/** Groovy `isCase`: list membership, range bounds, or equality. */
function caseMatches(subject: IrExpression, match: IrExpression, isList = false): IrExpression {
  if (match.kind === "list" || isList)
    return { kind: "methodCall", target: match, name: "contains", arguments: [subject] };
  if (match.kind === "range") {
    const within = (low: IrExpression, high: IrExpression, upward: boolean): IrExpression => ({
      kind: "binary",
      operator: "and",
      left: { kind: "binary", operator: upward ? ">=" : "<=", left: subject, right: low },
      right: {
        kind: "binary",
        operator: upward ? (match.inclusive ? "<=" : "<") : match.inclusive ? ">=" : ">",
        left: subject,
        right: high,
      },
    });
    const { from, to } = match;
    if (from.kind === "literal" && to.kind === "literal") {
      const upward =
        typeof from.value === "number" && typeof to.value === "number"
          ? from.value <= to.value
          : true;
      return within(from, to, upward);
    }
    // A bound known only at runtime may make the range descend.
    return {
      kind: "binary",
      operator: "or",
      left: within(from, to, true),
      right: within(from, to, false),
    };
  }
  return { kind: "binary", operator: "==", left: subject, right: match };
}

/**
 * A Groovy `break` inside a switch case leaves the switch, also from inside an `if`. TeaseScript switch cases have
 * no `break`, so statements after an `if` that may break move into the paths that do not break; statements after
 * an unconditional `break` are unreachable.
 */
function eliminateSwitchBreaks(statements: AstNode[], rest: AstNode[] = []): AstNode[] {
  const result: AstNode[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    if (isSwitchBreak(statement)) return result;
    if (statement.kind === "block" && containsSwitchBreak(statement)) {
      return [
        ...result,
        ...eliminateSwitchBreaks(
          [...nodeArray(statement.statements), ...statements.slice(index + 1)],
          rest,
        ),
      ];
    }
    if (statement.kind === "if" && containsSwitchBreak(statement)) {
      const continuation = [...statements.slice(index + 1), ...rest];
      const branch = (node: unknown): AstNode => ({
        kind: "block",
        span: asNode(node)?.span ?? statement.span,
        statements: eliminateSwitchBreaks(branchStatements(node), continuation),
      });
      return [
        ...result,
        { ...statement, then: branch(statement.then), else: branch(statement.else) },
      ];
    }
    result.push(statement);
  }
  // The statements that follow in the case, or in the cases it falls through to, may hold breaks of their own.
  return [...result, ...(rest.length === 0 ? [] : eliminateSwitchBreaks(rest))];
}

function branchStatements(node: unknown): AstNode[] {
  const branch = asNode(node);
  if (branch === null || branch.kind === "empty") return [];
  return branch.kind === "block" ? nodeArray(branch.statements) : [branch];
}

/** A `break` that belongs to the enclosing switch, not to a nested loop, switch, or closure. */
function containsSwitchBreak(node: AstNode): boolean {
  if (isSwitchBreak(node)) return true;
  if (["for", "while", "switch", "closure"].includes(node.kind)) return false;
  return nodeChildren(node).some(containsSwitchBreak);
}

function collectSwitchPath(
  caseNodes: AstNode[],
  start: number,
  defaultSource: AstNode[],
): AstNode[] | null {
  const result: AstNode[] = [];
  for (let index = start; index < caseNodes.length; index += 1) {
    const body = switchBodyStatements(asNode(caseNodes[index]?.body));
    if (body === null) return null;
    const terminal = body.at(-1);
    result.push(...withoutTerminalBreak(body));
    if (leavesCase(terminal)) return result;
  }
  result.push(...withoutTerminalBreak(defaultSource));
  return result;
}

/**
 * Whether a case's last statement never lets it fall through to the next case: a return, break, continue, or throw,
 * also at the end of both branches of an if, as in Domme3's menu, whose cases go to the popup or their script.
 */
function leavesCase(statement: AstNode | undefined): boolean {
  if (statement === undefined) return false;
  if (["return", "break", "continue", "throw"].includes(statement.kind)) return true;
  if (statement.kind === "block") return leavesCase(nodeArray(statement.statements).at(-1));
  return (
    statement.kind === "if" &&
    branchStatements(statement.else).length > 0 &&
    leavesCase(branchStatements(statement.then).at(-1)) &&
    leavesCase(branchStatements(statement.else).at(-1))
  );
}

function switchBodyStatements(node: AstNode | null): AstNode[] | null {
  if (node === null || node.kind === "empty") return [];
  return node.kind === "block" ? nodeArray(node.statements) : [node];
}

/** An unlabelled break, which leaves the innermost switch; a labelled break leaves an outer loop. */
function isSwitchBreak(node: AstNode): boolean {
  return node.kind === "break" && typeof node.label !== "string";
}

function withoutTerminalBreak(statements: AstNode[]): AstNode[] {
  const last = statements.at(-1);
  return last !== undefined && isSwitchBreak(last) ? statements.slice(0, -1) : statements;
}

function lowerReturnStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const valueNode = asNode(node.value);
  if (context.functionDepth > 0) {
    if (valueNode === null) return [{ kind: "return", value: null, span: node.span }];
    const value = lowerExpression(valueNode, context);
    if (value === null) {
      return [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_FUNCTION_RETURN",
          "Function return value could not be migrated.",
        ),
      ];
    }
    return [{ kind: "return", value, span: node.span }];
  }

  // A null or empty script name ended the legacy chain.
  const ends: IrStatement = { kind: "exit", returned: true, span: node.span };
  if (valueNode === null || isNullConstant(valueNode) || constantValue(valueNode) === "")
    return [ends];
  const script = lowerExpression(valueNode, context);
  if (script === null)
    return [
      unsupportedStatement(
        context,
        node,
        "SX_UNSUPPORTED_SCRIPT_RETURN",
        "Script return value could not be migrated.",
      ),
    ];
  if (script.kind === "literal" && typeof script.value === "string") {
    const path = scriptPath(script.value, context);
    if (path !== null) return [{ kind: "goto", target: { kind: "file", path }, span: node.span }];
    const legacyName = script.value
      .replaceAll("\\", "/")
      .replace(/\.groovy$/iu, "")
      .toLowerCase();
    if (legacyName === "welcome" || legacyName === "exit" || legacyName.startsWith("system/")) {
      addDiagnostic(
        context,
        "SX_DESKTOP_SCRIPT",
        "warning",
        `Legacy chained to "${script.value}", a script of the legacy desktop player (its menu, settings, or restart), which a package does not contain; the session ends here.`,
        node.span,
      );
      return [ends];
    }
    if (context.unreachable) {
      addDiagnostic(
        context,
        "SX_UNREACHABLE_BRANCH",
        "warning",
        `This branch never runs: the value it tests is never stored by the package. Its chain to "${script.value}", which the package lacks, becomes exit.`,
        node.span,
      );
      return [ends];
    }
    addDiagnostic(
      context,
      "SX_MISSING_SCRIPT",
      "warning",
      `Legacy chained to the script "${script.value}", which is not part of this package; the legacy player ended the chain when it found no such file, so the script exits here.`,
      node.span,
    );
    return [ends];
  }
  addDiagnostic(
    context,
    "SX_DYNAMIC_SCRIPT",
    "warning",
    context.scriptPaths !== null
      ? "Legacy chained to the script this value names, and ended the chain when the value was null or empty or named no file; the name is looked up among the package's scripts, and a name of no script ends the chain here too."
      : 'Legacy chained to the script this value names, and ended the chain when the value was null or empty or named no file; its ".groovy" becomes ".tease" here, and script() fails at runtime for a name that is no file of the package.',
    node.span,
  );
  // In a package, the name is looked up among its scripts, by the legacy name in lower case without ".groovy", and a
  // name of no script ends the chain, as the legacy player did.
  if (context.scriptPaths !== null) {
    const next = freshName("nextScript", context);
    const paths = [...context.scriptPaths].sort(([left], [right]) => left.localeCompare(right));
    // A null name reads "null", which names no script, so the chain ends as for an empty name.
    const key: IrExpression = {
      kind: "methodCall",
      target: {
        kind: "methodCall",
        target: { kind: "template", parts: [{ value: script }] },
        name: "lowercase",
        arguments: [],
      },
      name: "replace",
      arguments: [
        { kind: "literal", value: ".groovy" },
        { kind: "literal", value: "" },
      ],
    };
    return [
      {
        kind: "let",
        name: next,
        value: {
          kind: "methodCall",
          target: {
            kind: "object",
            dict: true,
            properties: paths.map(([name, path]) => ({
              name,
              key: { kind: "literal", value: name },
              value: { kind: "literal", value: path },
            })),
          },
          name: "get",
          arguments: [key, { kind: "literal", value: "" }],
          dict: true,
        },
        span: node.span,
      },
      {
        kind: "if",
        condition: {
          kind: "binary",
          operator: "==",
          left: { kind: "variable", name: next },
          right: { kind: "literal", value: "" },
        },
        then: [ends],
        else: [],
        span: node.span,
      },
      {
        kind: "goto",
        target: { kind: "script", path: { kind: "variable", name: next } },
        span: node.span,
      },
    ];
  }
  // A legacy script name such as "rooms/hall.groovy" names the converted file "rooms/hall.tease".
  const path: IrExpression = {
    kind: "methodCall",
    target: script,
    name: "replace",
    arguments: [
      { kind: "literal", value: ".groovy" },
      { kind: "literal", value: ".tease" },
    ],
  };
  const transfer: IrStatement = { kind: "goto", target: { kind: "script", path }, span: node.span };
  if (!isRepeatableExpression(valueNode)) return [transfer];
  return [
    {
      kind: "if",
      condition: {
        kind: "binary",
        operator: "or",
        left: {
          kind: "binary",
          operator: "==",
          left: script,
          right: { kind: "literal", value: null },
        },
        right: {
          kind: "binary",
          operator: "==",
          left: script,
          right: { kind: "literal", value: "" },
        },
      },
      then: [ends],
      else: [],
      span: node.span,
    },
    transfer,
  ];
}

/**
 * The TeaseScript path a legacy script name chains to: the package's file of that name (its entry is `main.tease`),
 * or null when the package has none. The legacy player also looked for a localized variant first (`name_de`), which
 * the converted package does not choose by language. Without package context, the name keeps its path.
 */
function scriptPath(name: string, context: LowerContext): string | null {
  if (context.scriptPaths === null) return migrateScriptPath(name);
  const key = name
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/|\/)+/u, "")
    .replace(/\.groovy$/iu, "")
    .toLowerCase();
  return context.scriptPaths.get(key) ?? null;
}

function lowerExpression(node: AstNode, context: LowerContext): IrExpression | null {
  switch (node.kind) {
    case "constant":
      return isLiteral(node.value)
        ? { kind: "literal", value: node.value }
        : unsupportedExpression(
            context,
            node,
            "SX_UNSUPPORTED_CONSTANT",
            "Unsupported Groovy constant value.",
          );
    case "variable": {
      const name = variableName(node);
      if (name === null)
        return unsupportedExpression(
          context,
          node,
          "SX_INVALID_VARIABLE",
          "Variable is missing a name.",
        );
      if (name === "this") {
        return unsupportedExpression(
          context,
          node,
          "SX_OBJECT_THIS",
          "The legacy script object (this) cannot become a TeaseScript value.",
        );
      }
      if (context.helperMainParameter !== null && name === context.helperMainParameter) {
        return unsupportedExpression(
          context,
          node,
          "SX_HELPER_MAIN_VALUE",
          "The legacy SexScript host object cannot become an authored TeaseScript value.",
        );
      }
      if (
        context.functions.has(name) &&
        !context.shadowingReferences.has(node) &&
        !isVisibleLocal(name, node, context)
      ) {
        // A function used as a value becomes its action ID, like a closure value.
        context.actions.add(name);
        return { kind: "literal", value: name, action: true };
      }
      if (
        context.checksUndefinedVariables &&
        !context.types.variables.has(name) &&
        !context.generatedNames.has(name) &&
        !context.packageFunctions.has(name) &&
        !isLegacyGetterProperty(name)
      ) {
        // No declaration, assignment, parameter, or package global defines it, and no SexScript getter: Groovy
        // looked it up as a property of the script and failed (MissingPropertyException).
        return unsupportedExpression(
          context,
          node,
          "SX_UNDEFINED_VARIABLE",
          `${name} is never assigned in this script or its package; SexScript failed with a missing property whenever this ran.`,
        );
      }
      return { kind: "variable", name };
    }
    case "list": {
      const items: IrExpression[] = [];
      for (const child of nodeArray(node.items)) {
        const value = lowerExpression(child, context);
        if (value === null) return null;
        items.push(value);
      }
      return { kind: "list", items: withAllRecordFields(items) };
    }
    case "map":
      return lowerMapExpression(node, context);
    case "gstring":
      return lowerGString(node, context);
    case "array":
      return lowerArrayExpression(node, context);
    case "constructorCall": {
      const java = javaConstructor(node, javaHost(context));
      if (java !== undefined) return java;
      if (isCurrentDateConstructor(node)) {
        return { kind: "call", name: "getDateTime", positional: [], named: {} };
      }
      if (context.fileValues.has(node)) {
        const pathNode = nodeArray(asNode(node.arguments)?.items)[0];
        if (pathNode !== undefined && isHomePath(pathNode)) {
          // A folder of the player's home, where the legacy script looked for pictures; walks through it ask for a
          // photo (homePictures), so the path only names it.
          addDiagnostic(
            context,
            "SX_HOME_FOLDER",
            "warning",
            "The legacy script named a folder of the player's home on the computer, which a package cannot see; the path only names it, as ~ and the folder below the home.",
            node.span,
          );
          return { kind: "literal", value: `~${homeSuffix(pathNode)}` };
        }
        return pathNode === undefined ? null : lowerExpression(pathNode, context);
      }
      return unsupportedExpression(
        context,
        node,
        "SX_JAVA_CONSTRUCTOR",
        `Java object construction (new ${text(node.type) ?? "?"}) has no TeaseScript equivalent.`,
      );
    }
    case "closure":
      return lowerClosureValue(node, context);
    case "property":
      return lowerPropertyExpression(node, context);
    case "range": {
      const fromNode = asNode(node.from);
      const toNode = asNode(node.to);
      // `"A".."Z"` ranged over characters, which a TeaseScript range does not: the characters are written out.
      const first = constantString(fromNode ?? undefined);
      const last = constantString(toNode ?? undefined);
      if (first !== null && last !== null && [...first].length === 1 && [...last].length === 1) {
        // A Groovy range runs in either direction, and an exclusive one stops before its last character.
        const start = first.codePointAt(0)!;
        const stop = last.codePointAt(0)!;
        const step = stop < start ? -1 : 1;
        const end = node.inclusive === true ? stop : stop - step;
        const items: IrExpression[] = [];
        for (let code = start; step * (end - code) >= 0 && items.length < 1000; code += step)
          items.push({ kind: "literal", value: String.fromCodePoint(code) });
        return { kind: "list", items };
      }
      const from = fromNode === null ? null : lowerExpression(fromNode, context);
      const to = toNode === null ? null : lowerExpression(toNode, context);
      if (from === null || to === null) return null;
      return { kind: "range", from, to, inclusive: node.inclusive === true };
    }
    case "binary":
      return lowerBinaryExpression(node, context);
    case "boolean":
      return asNode(node.value) === null ? null : lowerExpression(asNode(node.value)!, context);
    case "cast":
      return lowerCast(node, context);
    case "not": {
      const valueNode = asNode(node.value);
      const value = valueNode === null ? null : lowerCondition(valueNode, context);
      return value === null ? null : negate(value);
    }
    case "unaryMinus":
      return lowerUnary(node, "-", context);
    case "unaryPlus":
      return lowerUnary(node, "+", context);
    case "methodCall":
      return lowerMethodCallExpression(node, context);
    case "postfix":
      return lowerPostfixValue(node, context);
    case "prefix":
      return lowerPrefixValue(node, context);
    case "readDefault":
      return lowerReadDefault(node, context);
    case "elvis":
    case "ternary": {
      const found = dictDefault(node, context);
      if (found !== null) return lowerDictDefault(node, found, context);
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_EXPRESSION",
        `Unsupported Groovy expression: ${node.kind}`,
      );
    }
    default:
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_EXPRESSION",
        `Unsupported Groovy expression: ${node.kind}`,
      );
  }
}

/**
 * `save("k", count++)` uses the old value and then increments. When nothing else in the statement can observe the
 * variable, the value is the variable itself and the increment follows the statement. Where a function the statement
 * calls afterwards may read it, as Domme2's `showDynamically(rules[i++])`, the old value is kept first and the
 * increment comes before the statement, as Groovy made it before the call.
 */
function lowerPostfixValue(node: AstNode, context: LowerContext): IrExpression | null {
  const name = variableName(asNode(node.value));
  const operator = node.operator === "++" ? "+=" : node.operator === "--" ? "-=" : null;
  const root = context.statementRoot;
  const after =
    name !== null &&
    operator !== null &&
    root !== null &&
    root === context.postludeRoot &&
    root.kind === "expressionStatement" &&
    incrementsAfterStatement(root, node, name, context);
  if (
    !after &&
    name !== null &&
    operator !== null &&
    root !== null &&
    onlyRead(root, node, name) &&
    isHoistable(root, node, context)
  ) {
    const old = freshName(`${name}Before`, context);
    const variables = new Map(context.types.variables);
    variables.set(old, inferType(asNode(node.value)!, context.types));
    context.types = { ...context.types, variables };
    context.prelude.push(
      { kind: "let", name: old, value: { kind: "variable", name }, span: node.span },
      {
        kind: "assign",
        target: { kind: "variable", name },
        operator,
        value: { kind: "literal", value: 1 },
        span: node.span,
      },
    );
    return { kind: "variable", name: old };
  }
  if (!after || name === null || operator === null) {
    return unsupportedExpression(
      context,
      node,
      "SX_INCREMENT_POSITION",
      "This ++/-- result is used where the increment cannot simply follow the statement: the variable is used again in the statement, the increment is guarded by && / || / ?:, or a function called in the statement could read the variable. Move the increment to its own statement.",
    );
  }
  context.postlude.push({
    kind: "assign",
    target: { kind: "variable", name },
    operator,
    value: { kind: "literal", value: 1 },
    span: node.span,
  });
  return { kind: "variable", name };
}

/** `++x` and `--x` used as a value: the variable changes before the statement, which then reads it. */
function lowerPrefixValue(node: AstNode, context: LowerContext): IrExpression | null {
  const name = variableName(asNode(node.value));
  const operator = node.operator === "++" ? "+=" : node.operator === "--" ? "-=" : null;
  const root = context.statementRoot;
  // The change may move before the statement when nothing else in it reads the variable or calls a local function;
  // the variable a plain assignment sets, as ShockReflex's `powerLevel = Math.min(++powerLevel, max)`, is written last.
  let localCalls = false;
  if (root !== null)
    walkAst(root, (child) => {
      if (child.kind === "methodCall" && child.implicitThis === true)
        localCalls ||= context.functions.has(constantString(child.method) ?? "");
    });
  if (
    name === null ||
    operator === null ||
    root === null ||
    !onlyRead(root, node, name) ||
    localCalls ||
    !isHoistable(root, node, context)
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_INCREMENT_POSITION",
      "This ++/-- changes the variable where the change cannot simply come before the statement: the variable is used again in the statement, the change is guarded by && / || / ?:, or a function called in the statement could read the variable. Move the change to its own statement.",
    );
  }
  context.prelude.push({
    kind: "assign",
    target: { kind: "variable", name },
    operator,
    value: { kind: "literal", value: 1 },
    span: node.span,
  });
  return { kind: "variable", name };
}

/**
 * A compound assignment used as a value, `save("k", total -= 5)`: Groovy changed the variable and used its new value,
 * so the change comes first, as its own statement, and the statement uses the variable. As for `++x`, this needs a
 * statement that reads the variable nowhere else and calls no local function.
 */
function lowerCompoundValue(node: AstNode, context: LowerContext): IrExpression | null {
  const name = variableName(asNode(node.left));
  const root = context.statementRoot;
  let uses = 0;
  let localCalls = false;
  if (root !== null)
    walkAst(root, (child) => {
      if (variableName(child) === name && child.kind === "variable") uses += 1;
      if (child.kind === "methodCall" && child.implicitThis === true)
        localCalls ||= context.functions.has(constantString(child.method) ?? "");
    });
  if (
    name === null ||
    root === null ||
    uses !== 1 ||
    localCalls ||
    !isHoistable(root, node, context)
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_ASSIGNMENT_VALUE",
      "A compound assignment is used as a value where the change cannot simply come before the statement: the variable is used again in the statement, the change is guarded by && / || / ?:, or a function called in the statement could read the variable. Move the assignment to its own statement.",
    );
  }
  const statements = lowerAssignment(node, node.span, context);
  if (statements.some((statement) => statement.kind === "unsupported")) return null;
  context.prelude.push(...statements);
  return { kind: "variable", name };
}

/**
 * Whether the variable `name` occurs in statement `root` only as the operand of `target`, apart from the variable that
 * a plain assignment or declaration as the statement sets, which Groovy writes after computing the value.
 */
function onlyRead(root: AstNode, target: AstNode, name: string): boolean {
  const expression = root.kind === "expressionStatement" ? asNode(root.expression) : root;
  const assigned =
    expression !== null &&
    (expression.kind === "declaration" ||
      (expression.kind === "binary" && expression.operator === "="))
      ? asNode(expression.left)
      : null;
  const operand = asNode(target.value);
  let others = 0;
  walkAst(root, (child) => {
    if (
      child.kind === "variable" &&
      variableName(child) === name &&
      child !== operand &&
      child !== assigned
    )
      others += 1;
  });
  return others === 0;
}

/**
 * Marks a written place and the lists and objects it lies in as write targets, so that `shots[x][y] = 1` writes into
 * `shots` itself rather than into a copy that a reading helper returned (TeaseScript lists are values). Returns them,
 * for the caller to unmark after lowering.
 */
function writeChain(target: AstNode, context: LowerContext): AstNode[] {
  const written: AstNode[] = [];
  for (let part: AstNode | null = target; part !== null;) {
    const index = part.kind === "binary" && part.operator === "[";
    // A range or a list of positions read a new list, as Groovy did, so a write into it stays there.
    const position = index ? asNode(part.right) : null;
    if (part !== target && (position?.kind === "range" || position?.kind === "list")) break;
    if (part !== target && !index && part.kind !== "property") break;
    context.writeTargets.add(part);
    written.push(part);
    part = asNode(index ? part.left : part.object);
  }
  return written;
}

function incrementsAfterStatement(
  root: AstNode,
  target: AstNode,
  name: string,
  context: LowerContext,
): boolean {
  const local = context.currentFunction?.locals.has(name) === true;
  let safe = true;
  let found = false;
  const visit = (node: AstNode, guarded: boolean): void => {
    if (node === target) {
      found = true;
      if (guarded) safe = false;
      return;
    }
    if (node.kind === "closure") {
      safe = false;
      return;
    }
    if (variableName(node) === name) safe = false;
    if (node.kind === "methodCall") {
      const call = callParts(node);
      const helperClass = context.legacyHelperClasses.has(variableName(asNode(node.object)) ?? "");
      const readsScriptVariables =
        call === null ||
        (call.inherited
          ? legacyApiCall(node, context) === null
          : !helperClass && !PURE_OBJECT_METHODS.has(call.name));
      // Other functions can see the variable only when it is not a local of the current function.
      if (readsScriptVariables && !local) safe = false;
    }
    const guardedChildren = new Set<unknown>();
    if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
      guardedChildren.add(node.right);
    } else if (node.kind === "ternary") {
      guardedChildren.add(node.true);
      guardedChildren.add(node.false);
    } else if (node.kind === "elvis") {
      guardedChildren.add(node.false);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, guarded || guardedChildren.has(value));
      }
    }
  };
  visit(root, false);
  return found && safe;
}

/** Groovy GString `"a ${b} c"` interleaves constant strings and values, starting with a string. */
function lowerGString(node: AstNode, context: LowerContext): IrExpression | null {
  const strings = Array.isArray(node.strings) ? node.strings : [];
  const values = nodeArray(node.values);
  const parts: Array<{ text: string } | { value: IrExpression }> = [];
  for (let index = 0; index < Math.max(strings.length, values.length); index += 1) {
    const text: unknown = strings[index];
    if (typeof text === "string" && text !== "") parts.push({ text });
    const valueNode = values[index];
    if (valueNode === undefined) continue;
    const listParts = listText(valueNode, context);
    if (listParts === null) return null;
    if (listParts !== undefined) {
      parts.push(...listParts);
      continue;
    }
    const value = lowerExpression(valueNode, context);
    if (value === null) return null;
    parts.push({ value });
  }
  return templateOrLiteral(parts);
}

/** A map literal stored in a variable: a dict for a dict variable, else an object that declares every used field. */
function namedMapLiteral(
  target: AstNode,
  node: AstNode,
  context: LowerContext,
): IrExpression | null {
  const key = bindingKey(target, context.bindings) ?? "";
  const uses = context.mapUses;
  if (!uses.dictionaries.has(key))
    return lowerMapExpression(node, context, false, uses.recordFields.get(key) ?? []);
  if (
    !isSingleValueType((uses.dictionaryValues.get(key) ?? 0) & ~NULL) ||
    !isSingleValueType((uses.dictionaryElements.get(key) ?? 0) & ~NULL)
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_DICT_VALUE_TYPE",
      `The map ${bindingName(key)} holds values of different types; a dict has one value type (#536) and union types are not accepted yet. Split the map, or give its values one type.`,
    );
  }
  return lowerMapExpression(node, context, true);
}

/**
 * A Groovy map literal: an object when every key is a name (with `fields` added as null, so reads of fields assigned
 * later find them, as Groovy returned null), else, or with `asDict`, a dict literal (#536).
 */
function lowerMapExpression(
  node: AstNode,
  context: LowerContext,
  asDict = false,
  fields: readonly string[] = [],
): IrExpression | null {
  const entries = nodeArray(node.entries);
  if (entries.some((entry) => entry.kind !== "mapEntry")) {
    return unsupportedExpression(
      context,
      node,
      "SX_MAP_ENTRY",
      "Groovy map contains an invalid entry.",
    );
  }
  const names = entries.map((entry) => constantString(entry.key));
  if (!asDict && names.every((name) => name !== null && isTeaseObjectPropertyName(name))) {
    const properties: Array<{ name: string; value: IrExpression }> = [];
    for (const [index, entry] of entries.entries()) {
      const valueNode = asNode(entry.value);
      const value = valueNode === null ? null : lowerExpression(valueNode, context);
      if (value === null) return null;
      properties.push({ name: names[index]!, value });
    }
    for (const field of fields) {
      if (!properties.some((property) => property.name === field))
        properties.push({ name: field, value: { kind: "literal", value: null } });
    }
    return { kind: "object", properties };
  }
  return dictLiteral(node, entries, context);
}

/**
 * A Groovy map used as a lookup table as a dict literal (#536): keys are text, so a number key becomes text with a
 * note; a repeated literal key keeps its first position and its last value, as in Groovy, with a note; and the
 * values must share one type, since a dict has one value type.
 */
function dictLiteral(
  node: AstNode,
  entries: AstNode[],
  context: LowerContext,
): IrExpression | null {
  const properties: Array<{ name: string; value: IrExpression; key: IrExpression }> = [];
  const literalKeys = new Map<string, number>();
  let valueTypes = 0;
  let elementTypes = 0;
  let textKeys = false;
  for (const entry of entries) {
    const keyNode = asNode(entry.key);
    const valueNode = asNode(entry.value);
    const literal = keyNode === null ? undefined : constantValue(keyNode);
    let key: IrExpression | null;
    if (
      typeof literal === "string" ||
      typeof literal === "number" ||
      typeof literal === "boolean"
    ) {
      textKeys ||= typeof literal !== "string";
      key = { kind: "literal", value: String(literal) };
    } else {
      key = keyNode === null ? null : dictKey(keyNode, entry, context);
    }
    const value = valueNode === null ? null : lowerExpression(valueNode, context);
    if (key === null || value === null) return null;
    const valueType = inferType(valueNode, context.types);
    if (valueType !== UNKNOWN) valueTypes |= valueType & ~NULL;
    for (const item of valueNode?.kind === "list" ? nodeArray(valueNode.items) : [])
      elementTypes |= inferType(item, context.types) & ~NULL;
    const text = key.kind === "literal" && typeof key.value === "string" ? key.value : null;
    const earlier = text === null ? undefined : literalKeys.get(text);
    if (earlier !== undefined) {
      addDiagnostic(
        context,
        "SX_DICT_DUPLICATE_KEY",
        "warning",
        `Groovy kept the first position and the last value of the repeated key ${JSON.stringify(text)}; a dict literal may not repeat a key (#536), so the entries are merged.`,
        entry.span,
      );
      properties[earlier] = { ...properties[earlier]!, value };
      continue;
    }
    if (text !== null) literalKeys.set(text, properties.length);
    properties.push({ name: "", key, value });
  }
  if (textKeys) noteDictKeyText(node, context);
  if (!isSingleValueType(valueTypes) || !isSingleValueType(elementTypes)) {
    return unsupportedExpression(
      context,
      node,
      "SX_DICT_VALUE_TYPE",
      "This map holds values of different types; a dict has one value type (#536) and union types are not accepted yet. Split the map, or give its values one type.",
    );
  }
  return { kind: "object", properties, dict: true };
}

/** Whether a legacy type set holds at most one kind of value (null aside). */
function isSingleValueType(type: number): boolean {
  return [STRING, NUMBER, BOOLEAN, LIST, OBJECT].filter((kind) => (type & kind) !== 0).length <= 1;
}

/**
 * A dict key (#536): text. A number key becomes text, with a note where the dict also has text keys, since Groovy
 * kept 1 and "1" apart; on a dict with number keys, a key of unknown type becomes text too. A key that may be null
 * becomes text as well: null is "null", a key no dict of the script holds, so a null key finds nothing, as in Groovy.
 */
function dictKey(
  keyNode: AstNode,
  node: AstNode,
  context: LowerContext,
  /** Legacy types of the dict's other keys (dictKeyTypes), which decide. */
  keyTypes = 0,
): IrExpression | null {
  const numberKeys = (keyTypes & (NUMBER | BOOLEAN)) !== 0;
  // A written number key is visibly the same text key; the literal that created it carries the note, unless text
  // keys reach the same dict.
  const literal = constantValue(keyNode);
  if (typeof literal === "number" || typeof literal === "boolean") {
    if (numberKeys && (keyTypes & STRING) !== 0) noteDictKeyText(node, context);
    return { kind: "literal", value: String(literal) };
  }
  const keyType = inferType(keyNode, context.types);
  const key = lowerExpression(keyNode, context);
  if (key === null) return null;
  if (onlyOf(keyType, STRING) || (keyType === UNKNOWN && !numberKeys)) return key;
  if (!onlyOf(keyType, STRING | NULL)) noteDictKeyText(node, context);
  return templateOrLiteral([{ value: key }]);
}

/** Legacy types of the keys that reach a dict variable. */
function dictKeyTypes(receiver: AstNode, context: LowerContext): number {
  return context.mapUses.dictionaryKeys.get(bindingKey(receiver, context.bindings) ?? "") ?? 0;
}

function noteDictKeyText(node: AstNode, context: LowerContext): void {
  addDiagnostic(
    context,
    "SX_DICT_KEY_TEXT",
    "warning",
    'Groovy kept this key\'s type, so 1 and "1" were different keys; dict keys are text (#536).',
    node.span,
  );
}

function isTeaseObjectPropertyName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** The TeaseScript types of Java classes that `instanceof` tests (#530): a Groovy map is a dict or an object. */
const INSTANCE_TYPES: ReadonlyMap<string, readonly string[]> = new Map([
  ...[
    "Number",
    "Integer",
    "Long",
    "Double",
    "Float",
    "Short",
    "Byte",
    "BigDecimal",
    "BigInteger",
  ].map((name): [string, string[]] => [name, ["number"]]),
  ...["String", "GString", "CharSequence"].map((name): [string, string[]] => [name, ["string"]]),
  ...["Boolean"].map((name): [string, string[]] => [name, ["boolean"]]),
  ...["List", "ArrayList", "Collection", "Object[]"].map((name): [string, string[]] => [
    name,
    ["list"],
  ]),
  ...["Map", "HashMap", "LinkedHashMap", "TreeMap"].map((name): [string, string[]] => [
    name,
    ["dict", "object"],
  ]),
]);

/** Groovy `x instanceof Number` as a type test, `x is number`; undefined for another class. */
function instanceTest(node: AstNode, context: LowerContext): IrExpression | null | undefined {
  const right = asNode(node.right);
  const leftNode = asNode(node.left);
  const name = (text(right?.type) ?? "").replace(/^java\.(?:lang|util|math)\./u, "");
  const types = right?.kind === "classExpression" ? INSTANCE_TYPES.get(name) : undefined;
  if (types === undefined || leftNode === null) return undefined;
  if (types.length > 1 && !isRepeatableExpression(leftNode)) return undefined;
  const value = lowerExpression(leftNode, context);
  if (value === null) return null;
  return types
    .map((type): IrExpression => ({ kind: "typeTest", value, type }))
    .reduce((left, right): IrExpression => ({ kind: "binary", operator: "or", left, right }));
}

/**
 * Groovy `text * n` and `list * n`: the text, or the list's elements, `n` times over, with a fractional count cut to
 * whole times as Groovy did. Undefined for other operands.
 */
function repetition(node: AstNode, context: LowerContext): IrExpression | null | undefined {
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  if (leftNode === null || rightNode === null) return undefined;
  const left = inferType(leftNode, context.types);
  const text = onlyOf(left, STRING) && left !== 0;
  const list = onlyOf(left, LIST) && left !== 0;
  // Groovy repeated text and lists only by a number, so a count of unknown type, or one that may be null, is taken as
  // a number.
  const count = inferType(rightNode, context.types);
  if (
    (!text && !list) ||
    !(onlyOf(count, NUMBER | NULL) || count === UNKNOWN) ||
    ((count & NUMBER) === 0 && count !== UNKNOWN)
  )
    return undefined;
  const value = lowerExpression(leftNode, context);
  const times = lowerExpression(rightNode, context);
  if (value === null || times === null) return null;
  const whole: IrExpression = mayBeFractional(rightNode, context)
    ? { kind: "call", name: "toInteger", positional: [times], named: {} }
    : times;
  return text
    ? { kind: "methodCall", target: value, name: "repeat", arguments: [whole] }
    : useHelper(context, "repeatList", [value, whole]);
}

function lowerBinaryExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const java = javaBinary(node, javaHost(context));
  if (java !== undefined) return java;
  const operator = text(node.operator);
  if (operator === "==~") {
    const matched = tailMatch(node, context);
    if (matched !== undefined) return matched;
  }
  if (operator === "*") {
    const repeated = repetition(node, context);
    if (repeated !== undefined) return repeated;
    // A part or a result whose type the importer cannot tell may be text or a list, which Groovy repeated; a count that
    // may hold a fraction, which a repetition rarely takes, multiplies a number.
    const leftNode = asNode(node.left);
    const rightNode = asNode(node.right);
    if (
      leftNode !== null &&
      rightNode !== null &&
      leftNode.kind !== "variable" &&
      leftNode.kind !== "constant" &&
      inferType(leftNode, context.types) === UNKNOWN &&
      (inferType(rightNode, context.types) & NUMBER) !== 0 &&
      !mayBeFractional(rightNode, context)
    ) {
      const value = lowerExpression(leftNode, context);
      const count = lowerExpression(rightNode, context);
      if (value === null || count === null) return null;
      return useHelper(context, "times", [value, count]);
    }
  }
  if (operator === "instanceof") {
    const test = instanceTest(node, context);
    if (test !== undefined) return test;
  }
  if (operator === "==" || operator === "!=") {
    // A listing of a missing folder was null; the images of a folder (imageFolderListing) are an empty list then.
    const left = asNode(node.left);
    const right = asNode(node.right);
    const listing =
      right !== null && isNullConstant(right)
        ? left
        : left !== null && isNullConstant(left)
          ? right
          : null;
    if (listing !== null && holdsImageListing(listing, context)) {
      const list = lowerExpression(listing, context);
      if (list === null) return null;
      return {
        kind: "binary",
        operator: operator === "==" ? "==" : ">",
        left: { kind: "property", target: list, name: "length" },
        right: { kind: "literal", value: 0 },
      };
    }
  }
  if (operator === "[") {
    const targetNode = asNode(node.left);
    const indexNode = asNode(node.right);
    // A part of a split read at a fixed position, `text.split(",")[1]`, is the same with or without trailing empty parts
    // where Java had it; within the trailing empty parts Java dropped, where Java failed, TeaseScript reads an empty
    // part, and farther positions fail in both.
    const fixed = indexNode === null ? undefined : constantValue(indexNode);
    if (
      targetNode?.kind === "methodCall" &&
      constantString(targetNode.method) === "split" &&
      typeof fixed === "number" &&
      Number.isInteger(fixed) &&
      fixed >= 0
    )
      context.indexedSplits.add(targetNode);
    // A map literal indexed in place is a lookup table (#536).
    const inlineTable = targetNode?.kind === "map";
    const target =
      targetNode === null
        ? null
        : inlineTable
          ? lowerMapExpression(targetNode, context, true)
          : lowerExpression(targetNode, context);
    if (target === null || indexNode === null) return null;
    if (inlineTable) {
      const keyTypes = nodeArray(targetNode.entries).reduce((types, entry) => {
        const literal = constantValue(asNode(entry.key) ?? undefined);
        return (
          types | (typeof literal === "number" ? NUMBER : typeof literal === "string" ? STRING : 0)
        );
      }, 0);
      const key = dictKey(indexNode, node, context, keyTypes);
      return key === null ? null : { kind: "index", target, index: key, dict: true };
    }
    const negativeIndex = negativeConstantIndex(indexNode);
    // Groovy `value[a..b]` is the part of a list or text from a through b, also counted from the end or backwards.
    const slice = (): IrExpression | null => {
      const range = lowerExpression(indexNode, context);
      if (range?.kind !== "range") return null;
      context.syntheticHelpers.add("slice");
      return helperCall("slice", [target, range.from, range.to, ...exclusive(range)]);
    };
    if (
      targetNode !== null &&
      indexNode.kind === "range" &&
      !context.writeTargets.has(node) &&
      onlyOf(inferType(targetNode, context.types), STRING | NULL) &&
      (inferType(targetNode, context.types) & STRING) !== 0
    ) {
      const range = textRange(targetNode, target, indexNode, context);
      if (range !== undefined) return range;
    }
    if (indexNode.kind === "range" && !context.writeTargets.has(node)) {
      const part = slice();
      if (part !== null) return part;
    }
    // Groovy `list[[0, 2]]` is the list of the elements at those positions, as Concentration's `allScores[[0, 1, 2, 3]]`.
    const listed = indexNode.kind === "list" ? nodeArray(indexNode.items).map(constantValue) : [];
    const positions = listed.filter(
      (position): position is number =>
        typeof position === "number" && Number.isInteger(position) && position >= 0,
    );
    if (
      targetNode !== null &&
      !context.writeTargets.has(node) &&
      positions.length > 0 &&
      positions.length === listed.length &&
      // A parameter of unknown type, as Concentration's, was given a list.
      (isKnownListExpression(targetNode, context) ||
        inferType(targetNode, context.types) === UNKNOWN) &&
      isRepeatableExpression(targetNode)
    )
      return {
        kind: "list",
        items: positions.map((position) => ({
          kind: "index",
          target,
          index: { kind: "literal", value: position },
        })),
      };
    // Groovy `text[i]` is the character at i, also counted from the end; TeaseScript text takes `substring`.
    if (
      targetNode !== null &&
      !context.writeTargets.has(node) &&
      onlyOf(inferType(targetNode, context.types), STRING | NULL) &&
      (inferType(targetNode, context.types) & STRING) !== 0 &&
      indexNode.kind !== "range"
    ) {
      const index = lowerExpression(indexNode, context);
      if (index === null) return null;
      const length: IrExpression = { kind: "property", target, name: "length" };
      const start: IrExpression | null =
        negativeIndex !== null
          ? isRepeatableExpression(targetNode)
            ? {
                kind: "binary",
                operator: "-",
                left: length,
                right: { kind: "literal", value: negativeIndex },
              }
            : null
          : isRepeatableExpression(indexNode)
            ? index
            : null;
      if (start !== null) {
        // The last character runs to the end; a literal position adds its 1 at once.
        const end: IrExpression | null =
          negativeIndex === 1
            ? null
            : start.kind === "literal" && typeof start.value === "number"
              ? { kind: "literal", value: start.value + 1 }
              : {
                  kind: "binary",
                  operator: "+",
                  left: start,
                  right: { kind: "literal", value: 1 },
                };
        return {
          kind: "methodCall",
          target,
          name: "substring",
          arguments: end === null ? [start] : [start, end],
        };
      }
    }
    if (
      negativeIndex !== null &&
      targetNode !== null &&
      isKnownListExpression(targetNode, context)
    ) {
      // Groovy negative indexes count from the end; TeaseScript indexes start at 0 only.
      if (negativeIndex === 1) return { kind: "property", target, name: "last" };
      if (isRepeatableExpression(targetNode) || isPure(targetNode, context)) {
        return {
          kind: "index",
          target,
          index: {
            kind: "binary",
            operator: "-",
            left: { kind: "property", target, name: "length" },
            right: { kind: "literal", value: negativeIndex },
          },
        };
      }
    }
    if (negativeIndex !== null) {
      return unsupportedExpression(
        context,
        node,
        "SX_NEGATIVE_INDEX",
        "Groovy counted this negative index from the end; the receiver is not proven to be a list or cannot be evaluated twice. Index from the end explicitly.",
      );
    }
    // `date[Calendar.MONTH]` reads a date field only on a current date; elsewhere the constant is a number.
    const calendarIndex = calendarConstant(indexNode);
    if (calendarIndex !== null && targetNode !== null && isCurrentDateValue(targetNode, context)) {
      return dateTimeField(calendarIndex, target, node, context);
    }
    if (targetNode !== null && isRandomIndexOf(indexNode, targetNode, context)) {
      // `items[getRandom(items.size())]` picks one element uniformly, which is TeaseScript `items.random`.
      return { kind: "property", target, name: "random" };
    }
    if (targetNode !== null && isDictionary(targetNode, context)) {
      // A lookup in a map used as a lookup table: a dict (#536).
      const key = dictKey(indexNode, node, context, dictKeyTypes(targetNode, context));
      if (key !== null)
        noteMissingKey(node, { receiver: targetNode, key: indexNode, name: null }, context);
      return key === null ? null : { kind: "index", target, index: key, dict: true };
    }
    const propertyName = constantString(indexNode);
    if (propertyName !== null) {
      if (!isTeaseObjectPropertyName(propertyName)) {
        return unsupportedExpression(
          context,
          node,
          "SX_DYNAMIC_MAP_KEY",
          `Groovy map key ${JSON.stringify(propertyName)} is not a TeaseScript object property name, and this map is not held in a variable that the importer converts to a dict (#536).`,
        );
      }
      return { kind: "property", target, name: propertyName };
    }
    if (
      targetNode !== null &&
      (isKnownMapExpression(targetNode, context) ||
        onlyOf(inferType(indexNode, context.types), STRING))
    ) {
      // A runtime key on a map that is not a dict variable: objects have fixed properties (#536). A text key cannot
      // index a list, so its receiver is a map too.
      return unsupportedExpression(
        context,
        node,
        "SX_DYNAMIC_MAP_ACCESS",
        "Groovy looked up this map key at runtime; TeaseScript objects have fixed properties, and only a map held in a variable converts to a dict (#536). Keep the map in a variable, or write the property out.",
      );
    }
    const index = lowerExpression(indexNode, context);
    if (index === null) return null;
    // A menu position that names an element of the list the menu offered reads it as it is (menu-indexes.ts).
    if (context.menuIndexes.has(node)) return { kind: "index", target, index };
    // Groovy read null past the end of a list, which code that picks `getRandom(size) + 1` relies on, or that tests a
    // position for null.
    if (
      !context.writeTargets.has(node) &&
      (mayIndexPastEnd(indexNode, context, targetNode) || nullComparedReads.has(node))
    ) {
      addDiagnostic(
        context,
        "SX_INDEX_PAST_END",
        "warning",
        "This position can be one past the end of the list, where Groovy read null; a helper reads null there too.",
        node.span,
      );
      return useHelper(context, "itemAt", [target, index]);
    }
    // A variable that may hold a negative position, such as a -1 for "none yet": Groovy counted it from the end.
    if (
      !context.writeTargets.has(node) &&
      targetNode !== null &&
      isKnownListExpression(targetNode, context) &&
      mayIndexNegative(indexNode, context)
    ) {
      addDiagnostic(
        context,
        "SX_NEGATIVE_INDEX",
        "warning",
        "This position can be negative, where Groovy counted from the end of the list; a helper does that too.",
        node.span,
      );
      return useHelper(context, "itemAt", [target, index]);
    }
    return { kind: "index", target, index };
  }
  if (operator === "&&" || operator === "||") {
    const leftNode = asNode(node.left);
    const rightNode = asNode(node.right);
    const left = leftNode === null ? null : lowerCondition(leftNode, context);
    // The right side runs only after the left side was true (&&) or false (||), which may prove a key present.
    const facts = leftNode === null ? [] : conditionFacts(leftNode, context, operator === "||");
    const right =
      rightNode === null
        ? null
        : withPresentKeys(facts, rightNode, context, () => lowerCondition(rightNode, context));
    if (left === null || right === null) return null;
    return { kind: "binary", operator: operator === "&&" ? "and" : "or", left, right };
  }
  if (operator === "+") return lowerPlus(node, context);
  if (context.elementRemovals.has(node)) return lowerListDifference(node, context, true);
  if (operator === "-" && isListType(inferType(asNode(node.left), context.types)))
    return lowerListDifference(node, context);
  // Groovy took a list literal only from a list, so a left side that may be a list is one: a variable that starts as a
  // 0 placeholder (Banjo's `locationActions - ["Work"]`).
  const leftType = operator === "-" ? inferType(asNode(node.left), context.types) : 0;
  if (
    operator === "-" &&
    asNode(node.right)?.kind === "list" &&
    (leftType & LIST) !== 0 &&
    (leftType & STRING) === 0
  )
    return lowerListDifference(node, context);
  if (operator === "-") {
    const removed = textRemoval(node, context);
    if (removed !== undefined) return removed;
  }
  if (operator === "in") return lowerMembership(node, context);
  if ((operator === "&" || operator === "|") && isBooleanOperation(node, context)) {
    // Groovy & and | on booleans evaluate both sides; with a side-effect-free right side that equals and/or.
    const left = lowerCondition(asNode(node.left)!, context);
    const right = lowerCondition(asNode(node.right)!, context);
    if (left === null || right === null) return null;
    return { kind: "binary", operator: operator === "&" ? "and" : "or", left, right };
  }
  const mapped = operator;
  if (operator !== null && ["+=", "-=", "*=", "/=", "%="].includes(operator))
    return lowerCompoundValue(node, context);
  if (operator === "=") {
    return unsupportedExpression(
      context,
      node,
      "SX_ASSIGNMENT_VALUE",
      "An assignment is used as a value here (Groovy assigned, then used the assigned value, for example as a condition); this is often a mistake for ==. Make the assignment its own statement.",
    );
  }
  if (
    mapped === null ||
    !new Set(["==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "and", "or"]).has(mapped)
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_UNSUPPORTED_OPERATOR",
      `Groovy operator ${operator ?? "?"} is not safely mapped yet.`,
    );
  }
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  // Groovy ordered null below every value, where TeaseScript stops at an ordering of null (TSR009).
  if (
    ["<", "<=", ">", ">="].includes(mapped) &&
    leftNode !== null &&
    rightNode !== null &&
    (mayReadNull(leftNode, context) || mayReadNull(rightNode, context))
  ) {
    const left = lowerExpression(leftNode, context);
    const right = lowerExpression(rightNode, context);
    if (left === null || right === null) return null;
    addDiagnostic(
      context,
      "SX_NULL_ORDER",
      "info",
      "A side of this comparison may be null, such as a missing storage value or a function's null result; Groovy ordered null below every value, so a helper compares the sides as Groovy did.",
      node.span,
    );
    return {
      kind: "binary",
      operator: mapped,
      left: useHelper(context, "compare", [left, right]),
      right: { kind: "literal", value: 0 },
    };
  }
  if ((mapped === "==" || mapped === "!=") && leftNode !== null && rightNode !== null) {
    // Groovy read a missing key as null; a dict reports it, so the comparison tests the key.
    const [lookupNode, other] = isNullConstant(rightNode)
      ? [leftNode, rightNode]
      : [rightNode, leftNode];
    // Without stored nulls the test only asks for the key, so any key expression is evaluated once.
    const tested = isNullConstant(other) ? dictLookupParts(lookupNode, context) : null;
    const once =
      tested !== null &&
      !context.mapUses.nullableValues.has(bindingKey(tested.receiver, context.bindings) ?? "");
    const lookup = isNullConstant(other) ? dictLookup(lookupNode, context, once) : undefined;
    if (lookup === null) return null;
    if (lookup !== undefined) {
      const missing: IrExpression = { kind: "unary", operator: "not", value: lookup };
      const parts = dictLookupParts(lookupNode, context)!;
      if (!context.mapUses.nullableValues.has(bindingKey(parts.receiver, context.bindings)!))
        return mapped === "!=" ? lookup : missing;
      // A stored null compared like a missing key: the lookup runs only for a key that is present.
      const fact = presenceFact(parts, context);
      const value = withPresentKeys(fact === null ? [] : [fact], null, context, () =>
        lowerExpression(lookupNode, context),
      );
      if (value === null) return null;
      const compared: IrExpression = {
        kind: "binary",
        operator: mapped,
        left: value,
        right: { kind: "literal", value: null },
      };
      return mapped === "!="
        ? { kind: "binary", operator: "and", left: lookup, right: compared }
        : { kind: "binary", operator: "or", left: missing, right: compared };
    }
    // A list position compared with null was tested for being past the end, where Groovy read null.
    if (
      isNullConstant(other) &&
      lookupNode.kind === "binary" &&
      lookupNode.operator === "[" &&
      onlyOf(inferType(asNode(lookupNode.right)!, context.types), NUMBER)
    )
      nullComparedReads.add(lookupNode);
    // A dict never equals an object (#536): a map literal compared with a dict is a dict, and other maps are reported.
    const dictSide = isDictionary(leftNode, context) || isDictionary(rightNode, context);
    const otherNode = isDictionary(leftNode, context) ? rightNode : leftNode;
    if (dictSide && !isDictionary(otherNode, context)) {
      if (otherNode.kind === "map") {
        const dict = lowerMapExpression(otherNode, context, true);
        const known = lowerExpression(otherNode === leftNode ? rightNode : leftNode, context);
        if (dict === null || known === null) return null;
        return otherNode === leftNode
          ? { kind: "binary", operator: mapped, left: dict, right: known }
          : { kind: "binary", operator: mapped, left: known, right: dict };
      }
      if ((inferType(otherNode, context.types) & OBJECT) !== 0) {
        return unsupportedExpression(
          context,
          node,
          "SX_DICT_EQUALITY",
          "Groovy compared these maps by their entries; one is a dict and the other may be an object, and a dict never equals an object (#536). Make both dicts, or compare the entries.",
        );
      }
    }
  }
  const left = leftNode === null ? null : lowerExpression(leftNode, context);
  const right = rightNode === null ? null : lowerExpression(rightNode, context);
  return left === null || right === null ? null : { kind: "binary", operator: mapped, left, right };
}

/**
 * Lowers a Groovy condition to an explicitly boolean TeaseScript expression. Groovy treats null, zero, empty
 * strings, and empty collections as false; TeaseScript conditions must already be boolean.
 */
function lowerCondition(node: AstNode, context: LowerContext): IrExpression | null {
  if (node.kind === "boolean") {
    const inner = asNode(node.value);
    return inner === null ? null : lowerCondition(inner, context);
  }
  if (isUncalledClosure(node, context)) {
    addDiagnostic(
      context,
      "SX_CLOSURE_NOT_CALLED",
      "warning",
      `Groovy treated closure ${variableName(node)} itself as true here because it was not called; kept as true. Use ${variableName(node)}() if a call was intended.`,
      node.span,
    );
    return { kind: "literal", value: true };
  }
  const legacyLoad = typedLegacyLoad(node, context);
  if (legacyLoad !== null && isPure(legacyLoad.key, context)) {
    // A missing key (or a stored null) reads as null, which Groovy treats like the type's false value.
    const key = lowerExpression(legacyLoad.key, context);
    if (key === null) return null;
    // The read keeps the type legacy read, which its default takes (storage-keys.ts).
    const typed =
      legacyLoad.falseValue.value === false
        ? { read: "boolean" as const }
        : legacyLoad.falseValue.value === ""
          ? { read: "string" as const }
          : {};
    const read = (): IrExpression => ({ kind: "load", key, ...typed });
    if (legacyLoad.falseValue.value === false) {
      return {
        kind: "binary",
        operator: "==",
        left: read(),
        right: { kind: "literal", value: true },
      };
    }
    return {
      kind: "binary",
      operator: "and",
      left: {
        kind: "binary",
        operator: "!=",
        left: read(),
        right: { kind: "literal", value: null },
      },
      right: { kind: "binary", operator: "!=", left: read(), right: legacyLoad.falseValue },
    };
  }
  const lookup = dictLookup(node, context);
  if (lookup !== undefined) {
    // A missing key read as null, which is false; a dict reports a missing key, so the test comes first.
    if (lookup === null) return null;
    const value = withPresentKeys(conditionFacts(node, context), null, context, () =>
      lowerExpression(node, context),
    );
    if (value === null) return null;
    const truth = truthiness(value, inferType(node, context.types), true, node, context);
    return truth === null ? null : { kind: "binary", operator: "and", left: lookup, right: truth };
  }
  const value = lowerExpression(node, context);
  if (value === null) return null;
  return truthiness(
    value,
    inferType(node, context.types),
    isRepeatableExpression(node) || isRepeatableIndex(node),
    node,
    context,
  );
}

/** The dict and the key of a Groovy lookup `map[key]`, `map.key`, or `map.get(key)` on a dict; null otherwise. */
interface DictLookupParts {
  receiver: AstNode;
  /** The key expression; null for `map.key`, whose key is `name`. */
  key: AstNode | null;
  name: string | null;
}

function dictLookupParts(node: AstNode, context: LowerContext): DictLookupParts | null {
  let receiver: AstNode | null = null;
  let key: AstNode | null = null;
  let name: string | null = null;
  if (node.kind === "binary" && node.operator === "[") {
    receiver = asNode(node.left);
    key = asNode(node.right);
  } else if (node.kind === "property") {
    receiver = asNode(node.object);
    name = constantString(node.property);
  } else if (node.kind === "methodCall" && constantString(node.method) === "get") {
    const args = nodeArray(asNode(node.arguments)?.items);
    receiver = args.length === 1 ? asNode(node.object) : null;
    key = args[0] ?? null;
  }
  if (receiver === null || (key === null && name === null) || !isDictionary(receiver, context))
    return null;
  return { receiver, key, name };
}

/**
 * The fact that a dict holds a key, as `dict<NUL>key`: for a literal key, or a key variable or a property of one,
 * which names the same entry wherever it is read; null for other keys.
 */
function presenceFact(parts: DictLookupParts, context: LowerContext): string | null {
  const identity = (key: AstNode | null): string | null => {
    const literal = key === null ? undefined : constantValue(key);
    if (literal !== undefined && literal !== null) return `=${String(literal)}`;
    const variable = bindingKey(key, context.bindings);
    if (variable !== null) return `$${variable}`;
    const property = key?.kind === "property" ? constantString(key.property) : null;
    const object = property === null ? null : identity(asNode(key!.object));
    return object === null ? null : `${object}.${property}`;
  };
  const dict = bindingKey(parts.receiver, context.bindings);
  const key = parts.name === null ? identity(parts.key) : `=${parts.name}`;
  return dict === null || key === null ? null : `${dict}\u0000${key}`;
}

/**
 * The keys a Groovy condition proves present when it is true (`negated` false) or false: `containsKey` and `in`
 * tests, null tests and truth tests of lookups, joined by `&&` (or `||` when negated).
 */
function conditionFacts(node: AstNode, context: LowerContext, negated = false): string[] {
  const fact = (parts: DictLookupParts | null): string[] => {
    const found = parts === null ? null : presenceFact(parts, context);
    return found === null ? [] : [found];
  };
  if (node.kind === "boolean") {
    const inner = asNode(node.value);
    return inner === null ? [] : conditionFacts(inner, context, negated);
  }
  if (node.kind === "not") {
    const inner = asNode(node.value);
    return inner === null ? [] : conditionFacts(inner, context, !negated);
  }
  if (node.kind === "binary" && node.operator === (negated ? "||" : "&&")) {
    return [asNode(node.left), asNode(node.right)].flatMap((side) =>
      side === null ? [] : conditionFacts(side, context, negated),
    );
  }
  if (node.kind === "binary" && node.operator === (negated ? "==" : "!=")) {
    const [left, right] = [asNode(node.left), asNode(node.right)];
    const lookup = isNullConstant(right ?? undefined)
      ? left
      : isNullConstant(left ?? undefined)
        ? right
        : null;
    return fact(lookup === null ? null : dictLookupParts(lookup, context));
  }
  if (negated) return [];
  if (node.kind === "methodCall" && constantString(node.method) === "containsKey") {
    const receiver = asNode(node.object);
    const [key] = nodeArray(asNode(node.arguments)?.items);
    return receiver !== null && key !== undefined && isDictionary(receiver, context)
      ? fact({ receiver, key, name: null })
      : [];
  }
  if (node.kind === "binary" && node.operator === "in") {
    const [key, receiver] = [asNode(node.left), asNode(node.right)];
    return receiver !== null && key !== null && isDictionary(receiver, context)
      ? fact({ receiver, key, name: null })
      : [];
  }
  return fact(dictLookupParts(node, context));
}

/**
 * The facts that `region` cannot undo: it assigns neither the dict nor the key variable, and removes no entries of
 * the dict.
 */
function keptFacts(
  facts: readonly string[],
  region: AstNode | null,
  context: LowerContext,
): string[] {
  const changed = new Set<string>();
  if (region !== null) {
    walkAst(region, (node) => {
      const operator = typeof node.operator === "string" ? node.operator : "";
      const assigns =
        node.kind === "declaration" ||
        (node.kind === "binary" &&
          operator.endsWith("=") &&
          !["==", "!=", "<=", ">="].includes(operator));
      const assigned = assigns
        ? bindingKey(node.left, context.bindings)
        : node.kind === "postfix" || node.kind === "prefix"
          ? bindingKey(node.value, context.bindings)
          : null;
      if (assigned !== null) changed.add(assigned);
      const method = node.kind === "methodCall" ? (constantString(node.method) ?? "") : "";
      const receiver = bindingKey(node.object, context.bindings);
      if (receiver !== null && /^(remove|retain|clear)/u.test(method)) changed.add(receiver);
    });
  }
  return facts.filter((fact) => {
    const [dict = "", key = ""] = fact.split("\u0000");
    const keyVariable = key.startsWith("$") ? key.slice(1).split(".")[0]! : null;
    return !changed.has(dict) && (keyVariable === null || !changed.has(keyVariable));
  });
}

/** Lowers with the keys of `facts` known present, except those `region` may undo (keptFacts). */
function withPresentKeys<T>(
  facts: readonly string[],
  region: AstNode | null,
  context: LowerContext,
  lower: () => T,
): T {
  const kept = keptFacts(facts, region, context);
  context.knownKeys.push(...kept);
  try {
    return lower();
  } finally {
    context.knownKeys.splice(context.knownKeys.length - kept.length, kept.length);
  }
}

/**
 * Dict keys a statement leaves present for the statements after it (#536): a write of the key, or an `if` whose
 * branches both leave it present, where a branch that returns, breaks, or continues leaves nothing to follow.
 */
function factsAfter(statement: AstNode, context: LowerContext): string[] {
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  if (expression?.kind === "binary" && expression.operator === "=") {
    const target = asNode(expression.left);
    const parts = target === null ? null : dictLookupParts(target, context);
    const fact = parts === null ? null : presenceFact(parts, context);
    return fact === null ? [] : [fact];
  }
  if (expression?.kind === "methodCall" && constantString(expression.method) === "put") {
    const receiver = asNode(expression.object);
    const [key] = nodeArray(asNode(expression.arguments)?.items);
    const fact =
      receiver === null || key === undefined || !isDictionary(receiver, context)
        ? null
        : presenceFact({ receiver, key, name: null }, context);
    return fact === null ? [] : [fact];
  }
  if (statement.kind === "block")
    return branchFacts(nodeArray(statement.statements), [], context) ?? [];
  const condition = statement.kind === "if" ? asNode(statement.condition) : null;
  if (condition === null) return [];
  const thenFacts = branchFacts(
    branchStatements(statement.then),
    conditionFacts(condition, context),
    context,
  );
  const elseFacts = branchFacts(
    branchStatements(statement.else),
    conditionFacts(condition, context, true),
    context,
  );
  if (thenFacts === null) return elseFacts ?? [];
  if (elseFacts === null) return thenFacts;
  return thenFacts.filter((fact) => elseFacts.includes(fact));
}

/** The facts `known` at the start of a branch plus those its statements add; null when it never falls through. */
function branchFacts(
  statements: AstNode[],
  known: string[],
  context: LowerContext,
): string[] | null {
  const last = statements.at(-1);
  if (last !== undefined && ["return", "break", "continue", "throw"].includes(last.kind))
    return null;
  const added = statements.flatMap((statement) => factsAfter(statement, context));
  return keptFacts([...known, ...added], { kind: "block", span: null, statements }, context);
}

/**
 * Groovy read a missing key as null; a dict lookup of a missing key stops the script (#536). Notes a read whose key
 * is not known present: a literal key every value of the dict holds, or a key a surrounding test found.
 */
function noteMissingKey(node: AstNode, parts: DictLookupParts, context: LowerContext): void {
  if (context.writeTargets.has(node)) return;
  const dict = bindingKey(parts.receiver, context.bindings) ?? "";
  const literal = parts.name ?? (parts.key === null ? undefined : constantValue(parts.key));
  if (
    literal !== undefined &&
    literal !== null &&
    context.mapUses.presentKeys.get(dict)?.has(String(literal)) === true
  )
    return;
  const fact = presenceFact(parts, context);
  if (fact !== null && context.knownKeys.includes(fact)) return;
  addDiagnostic(
    context,
    "SX_DICT_MISSING_KEY",
    "warning",
    "Groovy read a missing key as null; a dict lookup of a missing key stops the script (#536). The key is not proven present here; test contains() first, or use get(key, default:).",
    node.span,
  );
}

/**
 * `dict.contains(key)` for a Groovy lookup `map[key]`, `map.key`, or `map.get(key)` on a dict with a key that may be
 * evaluated twice, or any key where the caller evaluates it only `once`; undefined for any other expression.
 */
function dictLookup(
  node: AstNode,
  context: LowerContext,
  once = false,
): IrExpression | null | undefined {
  const parts = dictLookupParts(node, context);
  if (parts === null || (!once && parts.key !== null && !isRepeatableExpression(parts.key)))
    return undefined;
  const dict = lowerExpression(parts.receiver, context);
  const key: IrExpression | null =
    parts.key === null
      ? { kind: "literal", value: parts.name }
      : dictKey(parts.key, node, context, dictKeyTypes(parts.receiver, context));
  return dict === null || key === null
    ? null
    : { kind: "methodCall", target: dict, name: "contains", arguments: [key], dict: true };
}

/** Whether evaluating an expression has no effect: pure (isPure), or text operations on such values. */
function sideEffectFree(node: AstNode, context: LowerContext): boolean {
  if (isPure(node, context)) return true;
  const call = node.kind === "methodCall" ? callParts(node) : null;
  const receiver = asNode(node.object);
  return (
    call !== null &&
    !call.inherited &&
    receiver !== null &&
    (STRING_METHODS.has(call.name) || TEXT_ONLY_METHODS.has(call.name)) &&
    sideEffectFree(receiver, context) &&
    call.arguments.every((argument) => sideEffectFree(argument, context))
  );
}

/**
 * A Groovy fallback for a dict key as `dict.get(key, default: value)` (#536): `m[k] ?: d`,
 * `m.containsKey(k) ? m[k] : d`, and `m[k] != null ? m[k] : d`, also with the test negated and the branches swapped.
 * `exact` is false where Groovy also replaced a stored null, or, with a truth test, a stored false, 0, or empty value
 * other than the default itself. Null for any other expression, and for a null default, which `get` does not take.
 */
function dictDefault(
  node: AstNode,
  context: LowerContext,
): { parts: DictLookupParts; fallback: AstNode; exact: boolean } | null {
  let read: AstNode | null = null;
  let fallback: AstNode | null = null;
  let test: "contains" | "null" | "truth" = "truth";
  if (node.kind === "elvis") {
    read = asNode(node.boolean);
    fallback = asNode(node.false);
  } else if (node.kind === "ternary") {
    const condition = asNode(node.condition);
    const tested = condition === null ? null : keyTest(condition, context);
    if (tested === null) return null;
    const [whenPresent, whenMissing] = tested.negated
      ? [asNode(node.false), asNode(node.true)]
      : [asNode(node.true), asNode(node.false)];
    const readParts = whenPresent === null ? null : dictLookupParts(whenPresent, context);
    const fact = readParts === null ? null : presenceFact(readParts, context);
    if (fact === null || fact !== presenceFact(tested.parts, context)) return null;
    read = whenPresent;
    fallback = whenMissing;
    test = tested.test;
  }
  const parts = read === null ? null : dictLookupParts(read, context);
  // `default:` always evaluates its value, which Groovy evaluated only for a missing key: a fallback with effects
  // keeps the conditional.
  if (
    parts === null ||
    fallback === null ||
    isNullConstant(fallback) ||
    !sideEffectFree(fallback, context)
  )
    return null;
  const dict = bindingKey(parts.receiver, context.bindings) ?? "";
  // The default has the dict's value type (#536); another fallback keeps the conditional.
  if (!dictDefaultFits(parts, fallback, context)) return null;
  let exact = test === "contains" || !context.mapUses.nullableValues.has(dict);
  if (exact && test === "truth") {
    // Groovy's truth test also replaced the value type's false, 0, or empty value, which is exact only as default.
    const values = (context.mapUses.dictionaryValues.get(dict) ?? 0) & ~NULL;
    const literal = constantValue(fallback);
    exact =
      (values === NUMBER && literal === 0) ||
      (values === STRING && literal === "") ||
      (values === BOOLEAN && literal === false) ||
      (values === LIST && fallback.kind === "list" && nodeArray(fallback.items).length === 0);
  }
  return { parts, fallback, exact };
}

/** Whether a fallback may be a dict's `get` default: not of a type other than the dict's values (#536). */
function dictDefaultFits(
  parts: DictLookupParts,
  fallback: AstNode,
  context: LowerContext,
): boolean {
  const dict = bindingKey(parts.receiver, context.bindings) ?? "";
  const values = (context.mapUses.dictionaryValues.get(dict) ?? 0) & ~NULL;
  const fallbackType = inferType(fallback, context.types) & ~NULL;
  return (
    values === 0 ||
    fallbackType === 0 ||
    fallbackType === (UNKNOWN & ~NULL) ||
    (fallbackType & ~values) === 0
  );
}

/** A key test of a Groovy condition: `containsKey` or `in`, a null test, or a truth test of a lookup. */
function keyTest(
  node: AstNode,
  context: LowerContext,
): { parts: DictLookupParts; test: "contains" | "null" | "truth"; negated: boolean } | null {
  if (node.kind === "boolean") {
    const inner = asNode(node.value);
    return inner === null ? null : keyTest(inner, context);
  }
  if (node.kind === "not") {
    const inner = asNode(node.value);
    const tested = inner === null ? null : keyTest(inner, context);
    return tested === null ? null : { ...tested, negated: !tested.negated };
  }
  if (node.kind === "binary" && (node.operator === "==" || node.operator === "!=")) {
    const [left, right] = [asNode(node.left), asNode(node.right)];
    const lookup = isNullConstant(right ?? undefined)
      ? left
      : isNullConstant(left ?? undefined)
        ? right
        : null;
    const parts = lookup === null ? null : dictLookupParts(lookup, context);
    return parts === null ? null : { parts, test: "null", negated: node.operator === "==" };
  }
  const [receiver, key] =
    node.kind === "methodCall" && constantString(node.method) === "containsKey"
      ? [asNode(node.object), nodeArray(asNode(node.arguments)?.items)[0] ?? null]
      : node.kind === "binary" && node.operator === "in"
        ? [asNode(node.right), asNode(node.left)]
        : [null, null];
  if (receiver !== null && key !== null && isDictionary(receiver, context))
    return { parts: { receiver, key, name: null }, test: "contains", negated: false };
  const parts = dictLookupParts(node, context);
  return parts === null ? null : { parts, test: "truth", negated: false };
}

/** `dict.get(key, default: value)` (#536) for a Groovy dict fallback (dictDefault); null when it cannot be lowered. */
function lowerDictDefault(
  node: AstNode,
  found: { parts: DictLookupParts; fallback: AstNode; exact: boolean },
  context: LowerContext,
): IrExpression | null {
  const { parts, fallback, exact } = found;
  const dict = lowerExpression(parts.receiver, context);
  const key: IrExpression | null =
    parts.key === null
      ? { kind: "literal", value: parts.name }
      : dictKey(parts.key, node, context, dictKeyTypes(parts.receiver, context));
  const value = lowerExpression(fallback, context);
  if (dict === null || key === null || value === null) return null;
  if (!exact) {
    addDiagnostic(
      context,
      "SX_DICT_DEFAULT",
      "warning",
      "Groovy also used the fallback for a stored null, or with ?: for a stored false, 0, or empty value; get(key, default:) uses it only for a missing key (#536).",
      node.span,
    );
  }
  return { kind: "methodCall", target: dict, name: "get", arguments: [key, value], dict: true };
}

/**
 * Groovy read-then-default code, `x = read` followed by `if (x == null) x = d`, as one read with a default: a dict
 * lookup becomes `dict.get(key, default: d)` (#536), a typed storage read `load key, default: d` (#541), which is
 * exact since storage holds no null (#484). Generic `load()` also read a stored "null" text as null, so it keeps the
 * explicit test. Returns the merged assignment, or null when the statements do not have this form.
 */
function readThenDefault(
  statement: AstNode,
  next: AstNode | undefined,
  context: LowerContext,
  adjacent = true,
): AstNode | null {
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  const assigns =
    expression !== null &&
    (expression.kind === "declaration" ||
      (expression.kind === "binary" && expression.operator === "="));
  const name = assigns ? variableName(expression.left) : null;
  const read = assigns ? asNode(expression.right) : null;
  const otherwise = next === undefined ? null : asNode(next.else);
  if (
    name === null ||
    read === null ||
    next?.kind !== "if" ||
    (otherwise !== null && otherwise.kind !== "empty")
  )
    return null;
  const condition = asNode(next.condition);
  const [only, ...others] = branchStatements(next.then);
  const fill = only?.kind === "expressionStatement" ? asNode(only.expression) : null;
  const tested =
    condition?.kind === "binary" && condition.operator === "=="
      ? isNullConstant(asNode(condition.right) ?? undefined)
        ? asNode(condition.left)
        : isNullConstant(asNode(condition.left) ?? undefined)
          ? asNode(condition.right)
          : null
      : null;
  const fallback = fill?.kind === "binary" && fill.operator === "=" ? asNode(fill.right) : null;
  if (
    others.length > 0 ||
    variableName(tested) !== name ||
    variableName(fill?.left) !== name ||
    fallback === null ||
    isNullConstant(fallback) ||
    !isPure(fallback, context) ||
    // The default runs after the read stored null in the variable.
    mayReadDestination(fallback, asNode(expression!.left)!, context) ||
    !(
      dictLookupParts(read, context) !== null ||
      TYPED_STORAGE_LOADS.has(legacyApiCall(read, context)?.name ?? "") ||
      // The online service's typed reads are storage reads too (SX_ONLINE_STORAGE).
      TYPED_ONLINE_LOADS.has(legacyApiCall(read, context)?.name ?? "")
    ) ||
    // A dict's default has its value type, as for `?:` (dictDefaultFits).
    (dictLookupParts(read, context) !== null &&
      !dictDefaultFits(dictLookupParts(read, context)!, fallback, context))
  )
    return null;
  const merged: AstNode = { kind: "readDefault", span: read.span, read, fallback };
  // A default that moved up from further down keeps the read's own lines.
  const span =
    !adjacent || statement.span === null || next.span === null
      ? statement.span
      : { ...statement.span, endLine: next.span.endLine, endColumn: next.span.endColumn };
  return { ...statement, span, expression: { ...expression!, right: merged } };
}

/**
 * The position of the null default that a typed storage read gets further down, for readThenDefault: settings code
 * often reads several values first and defaults them after (`a = loadInteger(ka)`, `b = loadInteger(kb)`, then
 * `if (a == null) a = 1`). The statements between may neither use the variable, nor call script code that could read
 * it, nor leave the block, so the default can move to its read. -1 when there is none.
 */
function laterReadDefault(
  statements: readonly AstNode[],
  index: number,
  consumed: ReadonlySet<number>,
  context: LowerContext,
): number {
  const read = typedReadAssignment(statements[index]!, context);
  if (read === null) return -1;
  for (let later = index + 1; later < statements.length; later += 1) {
    if (consumed.has(later)) continue;
    const statement = statements[later]!;
    const found = nullDefault(statement);
    if (found?.name === read.name)
      // The default moves up to the read, before the code between, which must not declare or set what it reads.
      return statements
        .slice(index + 1, later)
        .some((between) => setsFallback(between, found.fallback))
        ? -1
        : later;
    if (seesBeforeDefault(statement, read.name, context)) return -1;
  }
  return -1;
}

/**
 * Typed reads in the branch of an `if` that the null default after the `if` completes, as shockblackjack's
 * `if (...) { lives = loadInteger(k) }` and then `if (lives == null) lives = 6`: a fixed default joins each read in the
 * branch, where readThenDefault merges them, under laterReadDefault's conditions on the code between. The default after
 * the `if` goes too where nothing else gives the variable null; it stays where it still sees such a value. Null when
 * the `if` has no such reads.
 */
function branchReadDefaults(
  statements: readonly AstNode[],
  index: number,
  consumed: Set<number>,
  context: LowerContext,
): AstNode | null {
  const statement = statements[index]!;
  const otherwise = asNode(statement.else);
  if (statement.kind !== "if" || (otherwise !== null && otherwise.kind !== "empty")) return null;
  const branch = [...branchStatements(statement.then)];
  let changed = false;
  for (let position = branch.length - 1; position >= 0; position -= 1) {
    const read = typedReadAssignment(branch[position]!, context);
    const rest = branch.slice(position + 1);
    if (read === null || rest.some((after) => seesBeforeDefault(after, read.name, context)))
      continue;
    for (let later = index + 1; later < statements.length; later += 1) {
      if (consumed.has(later)) continue;
      const found = nullDefault(statements[later]!);
      if (found?.name !== read.name) {
        if (seesBeforeDefault(statements[later]!, read.name, context)) break;
        continue;
      }
      // Only a fixed default moves into the branch; another read, as tutorial's chain of loads, stays where it is.
      const fixed = constantValue(found.fallback);
      if (fixed === undefined || fixed === null) break;
      const between = [...rest, ...statements.slice(index + 1, later)];
      if (between.some((other) => setsFallback(other, found.fallback))) break;
      // The copy carries no position, so that the merged read keeps its own lines.
      branch.splice(position + 1, 0, { ...statements[later]!, span: null });
      changed = true;
      if (onlyNonNullOtherwise(read, context)) consumed.add(later);
      break;
    }
  }
  if (!changed) return null;
  const block = asNode(statement.then);
  return {
    ...statement,
    then: { kind: "block", span: block?.span ?? statement.span, statements: branch },
  };
}

/** Whether every value the variable of a typed read gets elsewhere is one of a known type without null. */
function onlyNonNullOtherwise(
  read: { name: string; read: AstNode; target: AstNode },
  context: LowerContext,
): boolean {
  const key = bindingKey(read.target, context.bindings);
  const values = key === null ? undefined : context.assignedValues.get(key);
  return (
    values !== undefined &&
    values.every((value) => {
      if (value === read.read) return true;
      const type = inferType(value, context.types);
      return type !== 0 && type !== UNKNOWN && (type & NULL) === 0;
    })
  );
}

/**
 * Whether code between a read and its null default could see the variable before its default, or skip the default:
 * it uses the variable, leaves the block, or calls script code. A branch that never runs, `if (debug)` with a flag the
 * script declares false and never sets (jackoffrace), sees nothing.
 */
function seesBeforeDefault(statement: AstNode, name: string, context: LowerContext): boolean {
  if (neverRuns(statement, context)) return false;
  let found = false;
  walkAst(statement, (child) => {
    if (child.kind === "variable" && variableName(child) === name) found = true;
    else if (["return", "break", "continue", "throw"].includes(child.kind)) found = true;
    else if (child.kind === "methodCall" && callParts(child)?.inherited === true)
      found ||= legacyApiCall(child, context) === null;
  });
  return found;
}

/** `if (flag) { ... }` without an else, where the script declares the flag false and never sets it again. */
function neverRuns(statement: AstNode, context: LowerContext): boolean {
  const otherwise = asNode(statement.else);
  if (statement.kind !== "if" || (otherwise !== null && otherwise.kind !== "empty")) return false;
  const condition = asNode(statement.condition);
  const tested = condition?.kind === "boolean" ? asNode(condition.value) : condition;
  const key = tested?.kind === "variable" ? bindingKey(tested, context.bindings) : null;
  const values = key === null ? undefined : context.assignedValues.get(key);
  return values?.length === 1 && constantValue(values[0]!) === false;
}

/** Whether a statement declares or sets a variable that a null default's value reads. */
function setsFallback(statement: AstNode, fallback: AstNode): boolean {
  const reads = new Set<string>();
  walkAst(fallback, (child) => {
    const name = child.kind === "variable" ? variableName(child) : null;
    if (name !== null) reads.add(name);
  });
  let found = false;
  walkAst(statement, (child) => {
    const assigns =
      child.kind === "declaration" ||
      (child.kind === "binary" &&
        typeof child.operator === "string" &&
        /=$/u.test(child.operator) &&
        !["==", "!=", "<=", ">="].includes(child.operator));
    const name = assigns ? variableName(child.left) : null;
    if (name !== null && reads.has(name)) found = true;
  });
  return found;
}

/** `x = loadInteger(k)` and the other typed storage and online reads, as the variable and the read; else null. */
function typedReadAssignment(
  statement: AstNode,
  context: LowerContext,
): { name: string; read: AstNode; target: AstNode } | null {
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  if (
    expression === null ||
    !(
      expression.kind === "declaration" ||
      (expression.kind === "binary" && expression.operator === "=")
    )
  )
    return null;
  const target = asNode(expression.left);
  const name = variableName(target);
  const read = asNode(expression.right);
  const call = read === null ? null : (legacyApiCall(read, context)?.name ?? null);
  if (target === null || name === null || read === null || call === null) return null;
  return TYPED_STORAGE_LOADS.has(call) || TYPED_ONLINE_LOADS.has(call)
    ? { name, read, target }
    : null;
}

/** `if (x == null) x = d` without an else, as the variable and the default; else null. */
function nullDefault(statement: AstNode): { name: string; fallback: AstNode } | null {
  if (statement.kind !== "if") return null;
  const otherwise = asNode(statement.else);
  if (otherwise !== null && otherwise.kind !== "empty") return null;
  const condition = asNode(statement.condition);
  const tested =
    condition?.kind === "binary" && condition.operator === "=="
      ? isNullConstant(asNode(condition.right) ?? undefined)
        ? asNode(condition.left)
        : isNullConstant(asNode(condition.left) ?? undefined)
          ? asNode(condition.right)
          : null
      : null;
  const [only, ...others] = branchStatements(statement.then);
  const fill = only?.kind === "expressionStatement" ? asNode(only.expression) : null;
  const name = variableName(tested);
  if (others.length > 0 || name === null || fill?.kind !== "binary" || fill.operator !== "=")
    return null;
  const fallback = asNode(fill.right);
  return variableName(fill.left) === name && fallback !== null ? { name, fallback } : null;
}

/** A read with a default (readThenDefault): `dict.get(key, default: d)` or `load key, default: d`. */
function lowerReadDefault(node: AstNode, context: LowerContext): IrExpression | null {
  const read = asNode(node.read)!;
  const fallback = asNode(node.fallback)!;
  const parts = dictLookupParts(read, context);
  if (parts !== null) {
    const dict = bindingKey(parts.receiver, context.bindings) ?? "";
    const exact = !context.mapUses.nullableValues.has(dict);
    return lowerDictDefault(node, { parts, fallback, exact }, context);
  }
  const load = lowerExpression(read, context);
  const value = lowerExpression(fallback, context);
  if (load === null || value === null) return null;
  return load.kind === "load" ? { ...load, defaultValue: value } : null;
}

/** Groovy truth of a lowered value of the given legacy type, as an explicit boolean expression. */
function truthiness(
  value: IrExpression,
  type: number,
  repeatable: boolean,
  node: AstNode,
  context: LowerContext,
): IrExpression | null {
  if (onlyOf(type, BOOLEAN) || (value.kind === "literal" && typeof value.value === "boolean"))
    return value;
  const compare = (operator: string, right: IrExpression): IrExpression => ({
    kind: "binary",
    operator,
    left: value,
    right,
  });
  const notNull = compare("!=", { kind: "literal", value: null });
  const and = (left: IrExpression, right: IrExpression): IrExpression => ({
    kind: "binary",
    operator: "and",
    left,
    right,
  });
  if (onlyOf(type, BOOLEAN | NULL)) return compare("==", { kind: "literal", value: true });
  if (type === NULL) return notNull;
  // A variable that holds a flag or a number, `menu = true` and later `menu = 0`: Groovy treated 0 as false.
  if (
    repeatable &&
    (type & BOOLEAN) !== 0 &&
    (type & NUMBER) !== 0 &&
    onlyOf(type, BOOLEAN | NUMBER | NULL)
  )
    return {
      kind: "binary",
      operator: "or",
      left: and(
        { kind: "typeTest", value, type: "boolean" },
        compare("==", { kind: "literal", value: true }),
      ),
      right: and(
        { kind: "typeTest", value, type: "number" },
        compare("!=", { kind: "literal", value: 0 }),
      ),
    };
  if (isDictionary(node, context)) {
    // A dict is false when it is empty, as a Groovy map was, and also when it may be null, as a missing stored map.
    const filled: IrExpression = {
      kind: "binary",
      operator: ">",
      left: { kind: "property", target: value, name: "length", dict: true },
      right: { kind: "literal", value: 0 },
    };
    return repeatable && (type & NULL) !== 0 ? and(notNull, filled) : filled;
  }
  if ((type & OBJECT) !== 0 && onlyOf(type, OBJECT | NULL)) {
    // Groovy treats an empty map as false; objects compare structurally (#517), so `{}` is the empty map.
    const empty = compare("!=", { kind: "object", properties: [] });
    if (onlyOf(type, OBJECT)) return empty;
    if (repeatable) return and(notNull, empty);
    return unsupportedExpression(
      context,
      node,
      "SX_MAP_TRUTHINESS",
      "Groovy treats a null or empty map as false; testing both here would evaluate this expression twice. Keep the map in a variable and test it.",
    );
  }
  if (onlyOf(type, NUMBER)) return compare("!=", { kind: "literal", value: 0 });
  if (onlyOf(type, STRING)) return compare("!=", { kind: "literal", value: "" });
  if (onlyOf(type, LIST)) {
    return {
      kind: "binary",
      operator: ">",
      left: { kind: "property", target: value, name: "length" },
      right: { kind: "literal", value: 0 },
    };
  }
  if (repeatable && onlyOf(type, NUMBER | NULL)) {
    return and(notNull, compare("!=", { kind: "literal", value: 0 }));
  }
  if (repeatable && onlyOf(type, STRING | NULL)) {
    return and(notNull, compare("!=", { kind: "literal", value: "" }));
  }
  if (repeatable && isListType(type)) {
    return and(notNull, {
      kind: "binary",
      operator: ">",
      left: { kind: "property", target: value, name: "length" },
      right: { kind: "literal", value: 0 },
    });
  }
  // A value of unproven type is tested as Groovy did, by its value at runtime.
  return useHelper(context, "truth", [value]);
}

/** Typed legacy loads whose missing-key null maps to the type's false value in a condition. */
function typedLegacyLoad(
  node: AstNode,
  context: LowerContext,
): { key: AstNode; falseValue: { kind: "literal"; value: boolean | number | string } } | null {
  const call = legacyApiCall(node, context);
  if (call === null || call.arguments.length !== 1) return null;
  const falseValues: Record<string, boolean | number | string> = {
    loadBoolean: false,
    loadInteger: 0,
    loadFloat: 0,
    loadString: "",
  };
  const falseValue = falseValues[call.name];
  return falseValue === undefined
    ? null
    : { key: call.arguments[0]!, falseValue: { kind: "literal", value: falseValue } };
}

function isRepeatableIndex(node: AstNode): boolean {
  if (node.kind === "property") return isRepeatableExpression(node);
  const target = asNode(node.left);
  const index = asNode(node.right);
  return (
    node.kind === "binary" &&
    node.operator === "[" &&
    target !== null &&
    index !== null &&
    isRepeatableExpression(target) &&
    isRepeatableExpression(index)
  );
}

/** Expressions that may be evaluated twice without changing behavior or readability much. */
/** List positions that the code compares with null, which read past the end as null (see lowerIndex). */
const nullComparedReads = new WeakSet<AstNode>();

/** Arithmetic of plain values, such as `i * 52 + j`, which can be evaluated twice with the same result. */
function isPlainArithmetic(node: AstNode): boolean {
  if (isRepeatableExpression(node)) return true;
  if (node.kind === "unaryMinus") {
    const value = asNode(node.value);
    return value !== null && isPlainArithmetic(value);
  }
  const left = asNode(node.left);
  const right = asNode(node.right);
  return (
    node.kind === "binary" &&
    ["+", "-", "*", "/", "%"].includes(text(node.operator) ?? "") &&
    left !== null &&
    right !== null &&
    isPlainArithmetic(left) &&
    isPlainArithmetic(right)
  );
}

function isRepeatableExpression(node: AstNode): boolean {
  if (node.kind === "variable" || node.kind === "constant") return true;
  if (node.kind === "property") {
    const target = asNode(node.object);
    return target !== null && isRepeatableExpression(target);
  }
  return false;
}

/**
 * Groovy `+` concatenates when either operand is a string, with any value; TeaseScript `+` joins only two texts (or
 * adds two numbers, or joins two lists), so string concatenation becomes interpolation. Left-associative chains such as
 * `1 + 2 + "x"` keep their numeric prefix.
 */
function lowerPlus(node: AstNode, context: LowerContext): IrExpression | null {
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  if (leftNode === null || rightNode === null) return null;
  if (onlyOf(inferType(node, context.types), STRING)) {
    const parts = concatenationParts(node, context);
    return parts === null ? null : templateOrLiteral(parts);
  }
  const leftType = inferType(leftNode, context.types);
  const rightType = inferType(rightNode, context.types);
  if (isListType(leftType)) {
    // Decided before lowering, so each operand is lowered (and its prompts emitted) exactly once.
    // TeaseScript `+` joins two lists into a new one (#609); an appended element becomes a one-element list.
    const lists = listConcatenationOperands(node, context);
    if (lists === null) return null;
    // A range is no list for TeaseScript `+`, so the concatenation helper appends its numbers.
    if (lists.some((item) => item.kind === "range"))
      return useHelper(context, "concat", [{ kind: "list", items: lists }]);
    return lists.reduce((left, right) => ({ kind: "binary", operator: "+", left, right }));
  }
  const left = lowerExpression(leftNode, context);
  const right = lowerExpression(rightNode, context);
  if (left === null || right === null) return null;
  // `month - 1 + 1` arises from Java's zero-based Calendar.MONTH idiom; keep the plain value.
  if (
    left.kind === "binary" &&
    left.operator === "-" &&
    left.left.kind === "property" &&
    left.left.name === "month" &&
    left.right.kind === "literal" &&
    right.kind === "literal" &&
    typeof right.value === "number" &&
    left.right.value === right.value
  ) {
    return left.left;
  }
  // A null operand fails in both languages, so only non-numeric possibilities need review.
  if (!onlyOf(leftType, NUMBER | NULL) || !onlyOf(rightType, NUMBER | NULL)) {
    addDiagnostic(
      context,
      "SX_PLUS_OPERAND_TYPE",
      "warning",
      "Groovy + operands are not proven numeric; TeaseScript + adds two numbers or joins two texts or two lists, not mixed values. Use interpolation if this joins text.",
      node.span,
    );
  }
  return { kind: "binary", operator: "+", left, right };
}

/**
 * The removals of a loop's element from the collection it iterates, `for (item in items) { items -= item }` or
 * `items = items - item` (LowerContext.elementRemovals).
 */
function elementRemovals(body: AstNode): Set<AstNode> {
  const removals = new Set<AstNode>();
  walkAst(body, (loop) => {
    const collection = loop.kind === "for" ? variableName(loop.collection) : null;
    const element = typeof loop.variable === "string" ? loop.variable : null;
    if (collection === null || element === null || element === "forLoopDummyParameter") return;
    walkAst(loop.body, (node) => {
      if (node.kind !== "binary" || variableName(node.right) !== element) return;
      if (
        (node.operator === "-=" || node.operator === "-") &&
        variableName(node.left) === collection
      )
        removals.add(node);
    });
  });
  return removals;
}

/** Groovy `text - part`, which drops the first occurrence of the part's text; undefined where the left is no text. */
function textRemoval(node: AstNode, context: LowerContext): IrExpression | null | undefined {
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  if (leftNode === null || rightNode === null) return undefined;
  const left = inferType(leftNode, context.types);
  // A null left side failed in Groovy, so text or null is text (Banjo's `gear` after a loadString).
  if (!onlyOf(left, STRING | NULL) || (left & STRING) === 0) return undefined;
  const text = lowerExpression(leftNode, context);
  const part = lowerExpression(rightNode, context);
  if (text === null || part === null) return null;
  const partText: IrExpression = onlyOf(inferType(rightNode, context.types), STRING)
    ? part
    : { kind: "template", parts: [{ value: part }] };
  return useHelper(context, "textMinus", [text, partText]);
}

/**
 * Groovy `list - value` and `list - otherList` drop every element equal to the value or to an element of the other
 * list, as `difference` does (V30 §16); `difference` also keeps each remaining element once.
 */
function lowerListDifference(
  node: AstNode,
  context: LowerContext,
  /** The right side is an element of the list, such as the element of a loop over it. */
  element = false,
): IrExpression | null {
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  if (leftNode === null || rightNode === null) return null;
  const rightType = inferType(rightNode, context.types);
  const removesList = !element && isListType(rightType);
  const removesElement = element || onlyOf(rightType, NUMBER | STRING | BOOLEAN | NULL);
  const left = lowerExpression(leftNode, context);
  const right = lowerExpression(rightNode, context);
  if (left === null || right === null) return null;
  // Groovy `list - other` kept every element that `other` (a list, or else one value) does not hold, repeated ones too;
  // a value not proven to be one or the other is decided at runtime.
  const removed: IrExpression = removesList
    ? right
    : removesElement
      ? { kind: "list", items: [right] }
      : useHelper(context, "listPart", [right]);
  return useHelper(context, "listMinus", [left, removed]);
}

/** A null list operand fails in Groovy and TeaseScript alike, so "list or null" counts as a list. */
function isListType(type: number): boolean {
  return onlyOf(type, LIST | NULL) && (type & LIST) !== 0;
}

/** Flattens `a + b + c` on lists into one operand list for the concatenation helper. */
function listConcatenationOperands(node: AstNode, context: LowerContext): IrExpression[] | null {
  if (node.kind === "binary" && node.operator === "+") {
    const leftNode = asNode(node.left);
    const rightNode = asNode(node.right);
    if (leftNode !== null && rightNode !== null && isListType(inferType(leftNode, context.types))) {
      // Groovy `list + element` appends one element and `list + otherList` all elements (a null right side is
      // appended as an element); a right side not proven to be one or the other is decided at runtime.
      const rightType = inferType(rightNode, context.types);
      const rightIsList = onlyOf(rightType, LIST);
      const rightIsElement = (rightType & (LIST | NULL)) === 0 && rightType !== 0;
      const left = listConcatenationOperands(leftNode, context);
      const right = lowerExpression(rightNode, context);
      if (left === null || right === null) return null;
      return [
        ...left,
        rightIsList
          ? right
          : rightIsElement
            ? { kind: "list", items: [right] }
            : useHelper(context, "listPart", [right]),
      ];
    }
  }
  const value = lowerExpression(node, context);
  return value === null ? null : [value];
}

type TemplatePart = { text: string } | { value: IrExpression };

function concatenationParts(node: AstNode, context: LowerContext): TemplatePart[] | null {
  if (node.kind === "binary" && node.operator === "+") {
    const leftNode = asNode(node.left);
    const rightNode = asNode(node.right);
    if (
      leftNode !== null &&
      rightNode !== null &&
      (onlyOf(inferType(node, context.types), STRING) || startsWithText(node, context))
    ) {
      const left = concatenationParts(leftNode, context);
      const right = concatenationParts(rightNode, context);
      return left === null || right === null ? null : [...left, ...right];
    }
  }
  const listParts = listText(node, context);
  if (listParts !== undefined) return listParts;
  const value = lowerExpression(node, context);
  if (value === null) return null;
  if (value.kind === "literal" && typeof value.value === "string") return [{ text: value.value }];
  if (value.kind === "template") return value.parts;
  return [{ value }];
}

/**
 * Whether a `+` chain inside a text join starts with a variable that holds text: one the script starts with text, as
 * `def dialog = ""`, and never gives a number, so Groovy joined every later part to it as text.
 */
function startsWithText(node: AstNode, context: LowerContext): boolean {
  let first = node;
  while (first.kind === "binary" && first.operator === "+" && asNode(first.left) !== null)
    first = asNode(first.left)!;
  const key = first.kind === "variable" ? bindingKey(first, context.bindings) : null;
  const values = key === null ? undefined : context.assignedValues.get(key);
  if (values === undefined || values.length === 0) return false;
  const text = (value: AstNode): boolean =>
    value.kind === "gstring" || (value.kind === "constant" && typeof value.value === "string");
  const number = (value: AstNode): boolean =>
    (value.kind === "constant" && typeof value.value === "number") ||
    onlyOf(inferType(value, context.types), NUMBER);
  return values.some(text) && !values.some(number);
}

/**
 * Groovy shows a list in text as `[a, b]`, while TeaseScript `${list}` selects one element (V30 §16): a list of text,
 * numbers, and booleans becomes `[${list.join(", ")}]`. Returns undefined for a value that is not a list.
 */
function listText(node: AstNode, context: LowerContext): TemplatePart[] | null | undefined {
  const type = inferType(node, context.types);
  if (!(onlyOf(type, LIST | NULL) && type & LIST)) return undefined;
  const elements = listElementType(node, context);
  if (!onlyOf(type, LIST) || !onlyOf(elements, STRING | NUMBER | BOOLEAN | NULL)) {
    return unsupportedExpression(
      context,
      node,
      "SX_COLLECTION_TEXT",
      "Groovy turned this list into text like [a, b]; TeaseScript ${...} selects one element, and join() shows only text, numbers, and booleans, which this list is not proven to hold. Format the list explicitly.",
    );
  }
  const list = lowerExpression(node, context);
  if (list === null) return null;
  return [
    { text: "[" },
    { value: listJoin(list, { kind: "literal", value: ", " }) },
    { text: "]" },
  ];
}

function templateOrLiteral(parts: TemplatePart[]): IrExpression {
  const merged: TemplatePart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if ("text" in part && previous !== undefined && "text" in previous) {
      merged[merged.length - 1] = { text: previous.text + part.text };
    } else if (!("text" in part) || part.text !== "") {
      merged.push(part);
    }
  }
  if (merged.length === 0) return { kind: "literal", value: "" };
  const only = merged[0];
  if (merged.length === 1 && only !== undefined && "text" in only) {
    return { kind: "literal", value: only.text };
  }
  return { kind: "template", parts: merged };
}

function isBooleanOperation(node: AstNode, context: LowerContext): boolean {
  const right = asNode(node.right);
  return right !== null && isPure(right, context) && isLogicalOperation(node, context);
}

/**
 * Whether Groovy's `&` or `|` is logical here: its left side is a boolean, so it is Groovy's Boolean `and`/`or`, which
 * reads a null right side as false and failed for other values; a right side of unknown type is tested as a condition.
 */
function isLogicalOperation(node: AstNode, context: LowerContext): boolean {
  const left = asNode(node.left);
  const right = asNode(node.right);
  if (left === null || right === null) return false;
  const leftType = inferType(left, context.types);
  const rightType = inferType(right, context.types);
  // A side of unknown type, such as a stored flag, is tested as a condition; a proven number is bitwise.
  const flag = (type: number): boolean => onlyOf(type, BOOLEAN | NULL) || type === UNKNOWN;
  return flag(leftType) && flag(rightType) && (leftType !== UNKNOWN || rightType !== UNKNOWN);
}

/** `x in list` tests membership; `x in a..b` tests the range bounds. */
function lowerMembership(node: AstNode, context: LowerContext): IrExpression | null {
  const leftNode = asNode(node.left);
  const rightNode = asNode(node.right);
  if (leftNode === null || rightNode === null) return null;
  const value = lowerExpression(leftNode, context);
  if (value === null) return null;
  if (rightNode.kind === "range" && isRepeatableExpression(leftNode)) {
    const from = asNode(rightNode.from);
    const to = asNode(rightNode.to);
    const lower = from === null ? null : lowerExpression(from, context);
    const upper = to === null ? null : lowerExpression(to, context);
    if (lower === null || upper === null) return null;
    return {
      kind: "binary",
      operator: "and",
      left: { kind: "binary", operator: ">=", left: value, right: lower },
      right: {
        kind: "binary",
        operator: rightNode.inclusive === true ? "<=" : "<",
        left: value,
        right: upper,
      },
    };
  }
  if (isKnownListExpression(rightNode, context)) {
    const list = lowerExpression(rightNode, context);
    return list === null
      ? null
      : { kind: "methodCall", target: list, name: "contains", arguments: [value] };
  }
  return unsupportedExpression(
    context,
    node,
    "SX_UNSUPPORTED_OPERATOR",
    "Groovy `in` is only converted for lists and ranges.",
  );
}

/** `-n` as an index literal (Groovy parses it as unary minus applied to a constant). */
/**
 * `text[a..b]` and `text[a..<b]` as `substring`, with negative bounds counted from the end. Undefined where a bound
 * counted from the end needs the text twice and the text is no variable, or a range of literals runs backwards, which
 * Groovy read reversed.
 */
function textRange(
  targetNode: AstNode,
  target: IrExpression,
  range: AstNode,
  context: LowerContext,
): IrExpression | null | undefined {
  const fromNode = asNode(range.from);
  const toNode = asNode(range.to);
  if (fromNode === null || toNode === null) return undefined;
  const length: IrExpression = { kind: "property", target, name: "length" };
  const fromEnd = (node: AstNode): number | null => negativeConstantIndex(node);
  if (
    (fromEnd(fromNode) !== null || fromEnd(toNode) !== null) &&
    !isRepeatableExpression(targetNode)
  )
    return undefined;
  const first = constantValue(fromNode);
  const last = constantValue(toNode);
  // `substring` takes a part that runs forwards whatever the text's length: both ends whole positions from the start,
  // or both from the end, in order, or from a position to the last character (`n..-1`), which Groovy read forwards or
  // failed on. Another range, also one with a computed end, reads through the slice helper.
  const backFrom = fromEnd(fromNode);
  const backTo = fromEnd(toNode);
  const fromStart = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;
  const inclusive = range.inclusive === true;
  const back = (value: number | null): value is number => value !== null && Number.isInteger(value);
  // An exclusive range with equal ends is empty, also past the end, where `substring` fails.
  const forwards =
    (fromStart(first) && fromStart(last) && (first < last || (first === last && inclusive))) ||
    (fromStart(first) && backTo === 1 && inclusive) ||
    (back(backFrom) && back(backTo) && (backFrom > backTo || (backFrom === backTo && inclusive)));
  if (!forwards) return undefined;
  const bound = (node: AstNode, offset: number): IrExpression | null => {
    const back = fromEnd(node);
    if (back !== null)
      return back === offset
        ? length
        : {
            kind: "binary",
            operator: "-",
            left: length,
            right: { kind: "literal", value: back - offset },
          };
    const value = constantValue(node);
    if (typeof value === "number") return { kind: "literal", value: value + offset };
    const lowered = lowerExpression(node, context);
    if (lowered === null) return null;
    return offset === 0
      ? lowered
      : { kind: "binary", operator: "+", left: lowered, right: { kind: "literal", value: offset } };
  };
  const start = bound(fromNode, 0);
  const end = bound(toNode, range.inclusive === true ? 1 : 0);
  if (start === null || end === null) return null;
  // The end of the text needs no end position.
  const toEnd = end === length;
  return {
    kind: "methodCall",
    target,
    name: "substring",
    arguments: toEnd ? [start] : [start, end],
  };
}

function negativeConstantIndex(node: AstNode): number | null {
  const value = node.kind === "unaryMinus" ? asNode(node.value) : null;
  if (value?.kind === "constant" && typeof value.value === "number" && value.value > 0)
    return value.value;
  if (node.kind === "constant" && typeof node.value === "number" && node.value < 0)
    return -node.value;
  return null;
}

/** Recognizes `getRandom(list.size)`, `getRandom(list.size())`, or `getRandom(list.length)` for `list`. */
function isRandomIndexOf(index: AstNode, list: AstNode, context: LowerContext): boolean {
  const call = legacyApiCall(index, context);
  if (call === null || call.name !== "getRandom" || call.arguments.length !== 1) return false;
  const bound = call.arguments[0]!;
  const sizeName =
    bound.kind === "property"
      ? constantString(bound.property)
      : callParts(bound)?.arguments.length === 0
        ? constantString(bound.method)
        : null;
  if (sizeName !== "size" && sizeName !== "length") return false;
  const receiver = asNode(bound.object);
  return receiver !== null && sameReference(receiver, list);
}

/** Whether `value` reads `list` at a position written the same way as `index`. */
function readsPosition(value: AstNode, list: AstNode, index: AstNode): boolean {
  const same = (left: AstNode | null, right: AstNode | null): boolean => {
    if (left === null || right === null || left.kind !== right.kind) return false;
    if (left.kind === "variable") return variableName(left) === variableName(right);
    if (left.kind === "constant") return constantValue(left) === constantValue(right);
    if (left.kind === "binary")
      return (
        text(left.operator) === text(right.operator) &&
        same(asNode(left.left), asNode(right.left)) &&
        same(asNode(left.right), asNode(right.right))
      );
    return false;
  };
  let found = false;
  walkAst(value, (node) => {
    if (node.kind !== "binary" || text(node.operator) !== "[") return;
    const target = asNode(node.left);
    if (target !== null && sameReference(target, list) && same(asNode(node.right), index))
      found = true;
  });
  return found;
}

function sameReference(left: AstNode, right: AstNode): boolean {
  if (left.kind === "variable" && right.kind === "variable") {
    return variableName(left) === variableName(right);
  }
  if (left.kind === "property" && right.kind === "property") {
    const leftObject = asNode(left.object);
    const rightObject = asNode(right.object);
    return (
      constantString(left.property) === constantString(right.property) &&
      leftObject !== null &&
      rightObject !== null &&
      sameReference(leftObject, rightObject)
    );
  }
  return false;
}

function lowerCast(node: AstNode, context: LowerContext): IrExpression | null {
  const valueNode = asNode(node.value);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  if (value === null) return null;
  switch (text(node.type)) {
    case "int":
    case "Integer":
    case "long":
    case "Long":
      return { kind: "call", name: "toInteger", positional: [value], named: {} };
    case "float":
    case "Float":
    case "double":
    case "Double":
    case "BigDecimal":
      return { kind: "call", name: "toNumber", positional: [value], named: {} };
    case "String":
    case "java.lang.String": {
      // Groovy's cast keeps text as it is and null as null; a known list or object keeps a plain `toString`, which
      // the compiler checks, as its text has no faithful form yet.
      const type = inferType(valueNode!, context.types);
      if (onlyOf(type, STRING) && type !== 0) return value;
      const collection = type !== UNKNOWN && (type & (LIST | OBJECT)) !== 0;
      return (type & NULL) !== 0 && !collection
        ? useHelper(context, "castText", [value])
        : { kind: "call", name: "toString", positional: [value], named: {} };
    }
    case "Boolean":
    case "boolean":
      return { kind: "call", name: "toBoolean", positional: [value], named: {} };
    case "List":
    case "java.util.List":
      return value.kind === "list"
        ? value
        : unsupportedExpression(
            context,
            node,
            "SX_UNSUPPORTED_CAST",
            "Only literal-list List casts are erased safely.",
          );
    default:
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_CAST",
        `Groovy cast to ${text(node.type) ?? "unknown"} is not mapped.`,
      );
  }
}

function lowerUnary(
  node: AstNode,
  operator: "not" | "+" | "-",
  context: LowerContext,
): IrExpression | null {
  const valueNode = asNode(node.value);
  const value = valueNode === null ? null : lowerExpression(valueNode, context);
  return value === null ? null : { kind: "unary", operator, value };
}

function lowerPropertyExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const targetNode = asNode(node.object);
  const property = constantString(node.property);
  if (targetNode === null || property === null) {
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_PROPERTY",
      "Dynamic Groovy property access is not lowered automatically.",
    );
  }
  const folder = playerFolder(targetNode, property, node, context);
  if (folder !== undefined) return folder;
  const image = listedImageMember(targetNode, property, context);
  if (image !== undefined) return image;
  if (property === "text") {
    const request = onlineRequest(targetNode, node, context);
    if (request !== undefined) return request;
  }
  const java = javaProperty(node, property, javaHost(context));
  if (java !== undefined) return java;
  // Groovy on the legacy Java read a list's private `size` field, and an array's `length`; no other legacy value had
  // such a property, apart from a map key, so a receiver not proven to be a map is a list.
  if (
    (property === "size" || property === "length") &&
    (isKnownListExpression(targetNode, context) || !isDictionary(targetNode, context))
  ) {
    const target = lowerExpression(targetNode, context);
    return target === null ? null : { kind: "property", target, name: "length" };
  }
  if (isDictionary(targetNode, context)) {
    // Groovy `map.name` reads the key "name"; a dict reads it as `map["name"]` (#536).
    const target = lowerExpression(targetNode, context);
    if (target === null) return null;
    noteMissingKey(node, { receiver: targetNode, key: null, name: property }, context);
    return { kind: "index", target, index: { kind: "literal", value: property }, dict: true };
  }
  if (!isRecordFieldAccess(targetNode, property, context)) {
    return unsupportedExpression(
      context,
      node,
      "SX_UNSUPPORTED_PROPERTY",
      `Groovy property .${property} is not safely mapped for this receiver.`,
    );
  }
  const target = lowerExpression(targetNode, context);
  if (target === null) return null;
  if (!onlyOf(inferType(targetNode, context.types), OBJECT | NULL)) {
    addDiagnostic(
      context,
      "SX_FIELD_ASSUMED",
      "info",
      `Read .${property} as an object field; a missing field fails in TeaseScript where a Groovy map returned null.`,
      node.span,
    );
  }
  return { kind: "property", target, name: property };
}

/**
 * The records of a list literal, each with every field that another record of the list has: Groovy read a key that a
 * map left out as null, such as a `notifflag` that only some permissions set, so a record gets each field it leaves
 * out as null. Other lists are returned as they are.
 */
function withAllRecordFields(items: IrExpression[]): IrExpression[] {
  const records = items.flatMap((item) =>
    item.kind === "object" &&
    item.dict !== true &&
    item.properties.every((field) => field.key === undefined)
      ? [item]
      : [],
  );
  if (records.length < 2 || records.length !== items.length) return items;
  const names = [
    ...new Set(records.flatMap((record) => record.properties.map((field) => field.name))),
  ];
  return records.map((record) => {
    const missing = names.filter((name) => !record.properties.some((field) => field.name === name));
    return missing.length === 0
      ? record
      : {
          ...record,
          properties: [
            ...record.properties,
            ...missing.map((name) => ({ name, value: { kind: "literal" as const, value: null } })),
          ],
        };
  });
}

/**
 * Groovy `value.name` on a map (the importer's object/record representation) is a field read. Class-like
 * receivers (`Calendar.MONTH`, `System.out`) and lists are not records.
 */
function isRecordFieldAccess(target: AstNode, property: string, context: LowerContext): boolean {
  if (!isTeaseObjectPropertyName(property)) return false;
  const receiver = variableName(target);
  if (receiver !== null && /^[A-Z]/u.test(receiver) && !context.types.variables.has(receiver))
    return false;
  if (target.kind === "constructorCall" || target.kind === "classExpression") return false;
  const type = inferType(target, context.types);
  return (type & OBJECT) !== 0 && !onlyOf(type, LIST | NULL);
}

function lowerObjectMethodCallExpression(
  node: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null {
  const targetNode = asNode(node.object);
  // Groovy asBoolean() is the Groovy truth of its receiver.
  if (name === "asBoolean" && argumentsNodes.length === 0 && targetNode !== null)
    return lowerCondition(targetNode, context);
  if (
    name === "getLanguage" &&
    argumentsNodes.length === 0 &&
    targetNode?.kind === "methodCall" &&
    variableName(targetNode.object) === "Locale" &&
    constantString(targetNode.method) === "getDefault"
  ) {
    // The distribution only checks whether its fonts support the player's language.
    addDiagnostic(
      context,
      "SX_LOCALE_WORKAROUND",
      "warning",
      'Workaround: TeaseScript has no query for the player\'s language yet (the localization question in COMPATIBILITY-GAPS.md), so the conversion assumes English, "en", where Groovy read the system language.',
      node.span,
    );
    return { kind: "literal", value: "en" };
  }
  const systemProperty =
    name === "getProperty" && variableName(targetNode) === "System" && argumentsNodes.length === 1
      ? constantString(argumentsNodes[0])
      : null;
  if (systemProperty === "user.name" || systemProperty === "user.home") {
    const [key, question, what] =
      systemProperty === "user.name"
        ? ["intro.name", "What is your name?", "the player's account name"]
        : ["system.homeFolder", "Which folder is your home folder?", "the player's home folder"];
    addDiagnostic(
      context,
      "SX_OS_INFO",
      "warning",
      `System.getProperty("${systemProperty}") read ${what} from the computer, which a browser does not provide; the player is asked once, as the system speaker, and the answer is saved as "${key}".`,
      node.span,
    );
    return useHelper(context, "askOnce", [
      { kind: "literal", value: key },
      { kind: "literal", value: question },
    ]);
  }
  if (targetNode !== null && argumentsNodes.length === 0) {
    const image = listedImageMember(targetNode, name, context);
    if (image !== undefined) return image;
  }
  if (
    (name === "getAbsolutePath" || name === "getCanonicalPath") &&
    argumentsNodes.length === 0 &&
    targetNode !== null
  ) {
    const folder = playerFolder(targetNode, name, node, context);
    if (folder !== undefined) return folder;
  }
  if (
    (name === "getText" || name === "readLines" || name === "openStream") &&
    argumentsNodes.length === 0 &&
    targetNode !== null
  ) {
    const request = onlineRequest(targetNode, node, context);
    if (request !== undefined) return request;
  }
  if (name === "collect" && targetNode !== null && isNetworkInterfaces(targetNode)) {
    addDiagnostic(
      context,
      "SX_OS_INFO",
      "warning",
      "The legacy script read the network hardware addresses of the computer as an ID, which a browser does not provide; a random ID, made once and saved, stands in for them.",
      node.span,
    );
    return { kind: "list", items: [useHelper(context, "deviceId", [])] };
  }
  if (
    name === "getProperty" &&
    targetNode !== null &&
    argumentsNodes.length === 1 &&
    constantString(argumentsNodes[0]) === "user.dir" &&
    isDataFolder(node)
  ) {
    addDiagnostic(
      context,
      "SX_DATA_FOLDER",
      "warning",
      "System.getProperty(\"user.dir\") was the legacy player's folder on the player's computer; package paths start at the package root, so it is empty text here.",
      node.span,
    );
    return { kind: "literal", value: "" };
  }
  if (
    name === "getProperty" &&
    variableName(targetNode) === "System" &&
    argumentsNodes.length === 1 &&
    constantString(argumentsNodes[0]) === "user.language"
  ) {
    addDiagnostic(
      context,
      "SX_LOCALE_WORKAROUND",
      "warning",
      'Workaround: TeaseScript has no query for the player\'s language yet (the localization question in COMPATIBILITY-GAPS.md), so the conversion assumes English, "en", where Groovy read the system language.',
      node.span,
    );
    return { kind: "literal", value: "en" };
  }
  if (name === "execute" && argumentsNodes.length === 0 && targetNode !== null) {
    const switched = switchCommand(targetNode, node, context);
    if (switched !== undefined) return switched;
  }
  const receiverName = targetNode === null ? null : variableName(targetNode);
  const helperClass =
    receiverName === null ? undefined : context.legacyHelperClasses.get(receiverName);
  if (helperClass !== undefined) {
    const helperInfo = context.packageHelperRegistry.get(helperClass)?.get(name);
    if (helperInfo === undefined) {
      return unsupportedExpression(
        context,
        node,
        "SX_LEGACY_HELPER_CALL",
        `Legacy helper ${helperClass}.${name}() has no discovered package-local method to migrate.`,
      );
    }
    let argumentNodes = argumentsNodes;
    if (helperInfo.stripsMain) {
      if (variableName(argumentNodes[0]) !== "this") {
        return unsupportedExpression(
          context,
          node,
          "SX_HELPER_MAIN_ARGUMENT",
          `Legacy helper ${helperClass}.${name}() is called without the script host (this) as its first argument; no method matched, so SexScript failed here at runtime.`,
        );
      }
      argumentNodes = argumentNodes.slice(1);
    }
    if (
      argumentNodes.length >= helperInfo.requiredArgs &&
      argumentNodes.length < helperInfo.minArgs
    )
      return defaultOrderCall(context, node);
    if (argumentNodes.length < helperInfo.minArgs || argumentNodes.length > helperInfo.maxArgs) {
      return unsupportedExpression(
        context,
        node,
        "SX_FUNCTION_ARITY",
        `Call to ${helperClass}.${name} has ${argumentNodes.length} authored arguments; expected ${helperInfo.minArgs}..${helperInfo.maxArgs}, so SexScript failed here at runtime.`,
      );
    }
    const args = lowerArguments(argumentNodes, context);
    return args === null ? null : { kind: "call", name, positional: args, named: {}, local: true };
  }

  if (name === "call" && targetNode !== null) {
    const action = lowerExpression(targetNode, context);
    const args = lowerArguments(argumentsNodes, context);
    return action === null || args === null ? null : actionCall(action, args, context);
  }
  // Groovy tokenize() exists only for text: the parts between any of the delimiter characters, without empty parts.
  if (name === "tokenize" && argumentsNodes.length <= 1 && targetNode !== null) {
    const text = lowerExpression(targetNode, context);
    const delimiters =
      argumentsNodes.length === 0
        ? ({ kind: "literal", value: " \t\n\r\f" } as const)
        : lowerExpression(argumentsNodes[0]!, context);
    if (text === null || delimiters === null) return null;
    return useHelper(context, "tokenize", [text, delimiters]);
  }
  if (name === "format" && receiverName === "String" && argumentsNodes.length >= 1) {
    const formatted = formatText(argumentsNodes, node, context);
    if (formatted !== undefined) return formatted;
  }
  if (name === "toString" && argumentsNodes.length === 0 && targetNode !== null) {
    const listParts = listText(targetNode, context);
    if (listParts !== undefined) return listParts === null ? null : templateOrLiteral(listParts);
    const value = lowerExpression(targetNode, context);
    return value === null ? null : templateOrLiteral([{ value }]);
  }
  // Groovy number conversions (`x.toInteger()`, `Integer.parseInt(text)`) as TeaseScript conversions (V30 §13): both
  // fail on text that is no number and drop a number's fraction toward zero; only Groovy rejects integer text "2.7".
  const conversion =
    argumentsNodes.length === 0 && targetNode !== null
      ? CONVERSION_METHODS.get(name)
      : argumentsNodes.length === 1 && receiverName !== null
        ? STATIC_CONVERSIONS.get(`${receiverName}.${name}`)
        : undefined;
  if (conversion !== undefined) {
    const value = lowerExpression(
      argumentsNodes.length === 0 ? targetNode! : argumentsNodes[0]!,
      context,
    );
    return value === null
      ? null
      : { kind: "call", name: conversion, positional: [value], named: {} };
  }
  if (receiverName === "Math") {
    const helper = MATH_HELPERS.get(name);
    if (helper !== undefined && argumentsNodes.length === helper.arity) {
      const args = lowerArguments(argumentsNodes, context);
      if (args === null) return null;
      // Java took numbers only, as the built-ins do (V30 §13), and a null fails in both; the helper stays for an operand
      // that may be anything else.
      const numeric = argumentsNodes.every((argument) =>
        onlyOf(inferType(argument, context.types), NUMBER | NULL),
      );
      return numeric
        ? { kind: "call", name, positional: args, named: {} }
        : useHelper(context, helper.name, args);
    }
    if ((name === "ceil" || name === "floor" || name === "abs") && argumentsNodes.length === 1) {
      const args = lowerArguments(argumentsNodes, context);
      return args === null ? null : { kind: "call", name, positional: args, named: {} };
    }
    if (name === "round" && argumentsNodes.length === 1) {
      const args = lowerArguments(argumentsNodes, context);
      if (args === null) return null;
      addDiagnostic(
        context,
        "SX_ROUNDING_TIES",
        "warning",
        "Java Math.round() rounds .5 toward positive infinity (-1.5 becomes -1); TeaseScript round() rounds ties away from zero (-1.5 becomes -2, V30 §13).",
        node.span,
      );
      return { kind: "call", name: "round", positional: args, named: {} };
    }
  }
  const calendarField = name === "get" ? calendarGetField(targetNode, argumentsNodes) : null;
  if (calendarField !== null)
    return dateTimeField(
      calendarField,
      { kind: "call", name: "getDateTime", positional: [], named: {} },
      node,
      context,
    );
  if (receiverName === "System" && name === "exit") {
    return unsupportedExpression(
      context,
      node,
      "SX_JVM_PROCESS_CONTROL",
      "System.exit() terminates the legacy JVM process and is not automatically equivalent to TeaseScript exit.",
    );
  }
  if (
    JAVA_REFLECTION_METHODS.has(name) ||
    (name === "forName" && receiverName === "Class") ||
    (name === "get" && targetNode?.kind === "methodCall")
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_REFLECTION",
      "Java reflection has no TeaseScript equivalent; reimplement the intended behavior manually.",
    );
  }
  if (
    name === "format" &&
    targetNode !== null &&
    (targetNode.kind === "constructorCall" || isCurrentDateConstructor(targetNode))
  ) {
    return dateFormat(node, targetNode, argumentsNodes, context);
  }
  if (
    name === "listFiles" &&
    argumentsNodes.length === 0 &&
    targetNode !== null &&
    context.media !== null
  ) {
    const listed = imageFolderListing(targetNode, node, context);
    if (listed !== undefined) return listed;
  }
  if (name === "exists" && argumentsNodes.length === 0 && targetNode !== null) {
    const pathNode = isFileConstructor(targetNode)
      ? nodeArray(asNode(targetNode.arguments)?.items)[0]
      : context.fileVariables.has(variableName(targetNode) ?? "")
        ? targetNode
        : undefined;
    if (pathNode !== undefined && context.files !== null)
      return fileExists(pathNode, node, context, context.files);
  }
  const java = javaMethodCall(node, name, argumentsNodes, javaHost(context));
  if (java !== undefined) return java;
  if (targetNode?.kind === "constructorCall") {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_OBJECT_CALL",
      `Method ${name}() on a constructed Java object requires manual or helper migration.`,
    );
  }

  if (context.media !== null) {
    const counted = imageCount(node, name, argumentsNodes, context, context.media);
    if (counted !== undefined) return counted;
  }
  // The byte size of a file, which legacy photo code compared with a threshold to detect a broken webcam picture.
  if (
    (name === "size" &&
      argumentsNodes.length === 0 &&
      targetNode?.kind === "methodCall" &&
      constantString(targetNode.method) === "getBytes" &&
      isFileValue(asNode(targetNode.object), context)) ||
    (name === "length" && argumentsNodes.length === 0 && isFileValue(targetNode, context))
  ) {
    addDiagnostic(
      context,
      "SX_PHOTO_SIZE",
      "warning",
      "Legacy code read the byte size of a file, which photo code compared with a threshold to detect a broken webcam picture; a package cannot read file sizes, and a photo the player took counts as valid, so the size reads as 1000000 bytes.",
      node.span,
    );
    return { kind: "literal", value: 1000000 };
  }
  // Groovy `a.equals(b)` compares values as `==` does for text, numbers, lists, and maps.
  if (name === "equals" && argumentsNodes.length === 1 && targetNode !== null) {
    const left = lowerExpression(targetNode, context);
    const right = lowerExpression(argumentsNodes[0]!, context);
    return left === null || right === null ? null : { kind: "binary", operator: "==", left, right };
  }
  if (targetNode !== null && isDictionary(targetNode, context)) {
    const operation = dictOperation(node, targetNode, name, argumentsNodes, context);
    if (operation !== undefined) return operation;
  }
  // A null receiver fails in Groovy and TeaseScript alike, so "text or null" counts as text.
  const receiverType = targetNode === null ? UNKNOWN : inferType(targetNode, context.types);
  const textReceiver =
    targetNode !== null &&
    (TEXT_ONLY_METHODS.has(name) || STRING_METHODS.has(name)) &&
    onlyOf(receiverType, STRING | NULL) &&
    (receiverType & STRING) !== 0;
  if (
    targetNode !== null &&
    (textReceiver || (STRING_METHODS.has(name) && !isKnownListExpression(targetNode, context)))
  ) {
    const operation = textOperation(node, targetNode, name, argumentsNodes, context);
    if (operation !== undefined) return operation;
    return unsupportedExpression(
      context,
      node,
      "SX_STRING_METHOD",
      name === "size" || name === "length"
        ? `Groovy ${name}() counted the entries of this map, which is an object with fixed properties here; objects have no length. Use the map as a dict (#536) if it is a lookup table.`
        : name === "count"
          ? "Groovy count() counted every occurrence of a text, overlapping ones too; it converts where the searched value and the counted one are both proven text, and here one of them is not."
          : `Groovy string method ${name}() has no TeaseScript text operation in this form: regular expressions and tokenize() need manual work (a future .ts text library).`,
    );
  }
  if (targetNode !== null && !isKnownListExpression(targetNode, context)) {
    const operation = unprovenReceiverOperation(node, targetNode, name, argumentsNodes, context);
    if (operation !== undefined) return operation;
  }
  if (targetNode === null || !isKnownListExpression(targetNode, context)) {
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_OR_OBJECT_CALL",
      "Object/dynamic Groovy method calls are not lowered by the first slice.",
    );
  }
  const changes =
    (name === "add" && argumentsNodes.length === 1) ||
    (name === "pop" && argumentsNodes.length === 0) ||
    (name === "remove" &&
      argumentsNodes.length === 1 &&
      onlyOf(inferType(argumentsNodes[0]!, context.types), NUMBER));
  const parameterWrite = changes ? parameterListWrite(targetNode, node, context) : null;
  if (parameterWrite !== null)
    return unsupportedExpression(context, node, "SX_PARAMETER_LIST_WRITE", parameterWrite);
  const target = lowerExpression(targetNode, context);
  if (target === null) return null;
  if (name === "size" && argumentsNodes.length === 0) {
    return { kind: "property", target, name: "length" };
  }
  if ((name === "contains" || name === "add") && argumentsNodes.length === 1) {
    const args = lowerArguments(argumentsNodes, context);
    return args === null ? null : { kind: "methodCall", target, name, arguments: args };
  }
  if (name === "indexOf" && argumentsNodes.length === 1) {
    const args = lowerArguments(argumentsNodes, context);
    if (args === null) return null;
    return useHelper(context, "indexOf", [target, args[0]!]);
  }
  if (name === "count" && argumentsNodes.length === 1 && argumentsNodes[0]!.kind !== "closure") {
    // Groovy count(value) counts the elements equal to the value.
    const args = lowerArguments(argumentsNodes, context);
    return args === null ? null : useHelper(context, "count", [target, args[0]!]);
  }
  if (
    name === "remove" &&
    argumentsNodes.length === 1 &&
    onlyOf(inferType(argumentsNodes[0]!, context.types), NUMBER)
  ) {
    // Groovy remove(int) returns the removed element, as removeAt does (#517).
    const args = lowerArguments(argumentsNodes, context);
    return args === null ? null : { kind: "methodCall", target, name: "removeAt", arguments: args };
  }
  if (argumentsNodes.length === 0) {
    switch (name) {
      case "pop":
        // Groovy 2.5 pop() removes and returns the first element, as removeFirst() does.
        return { kind: "methodCall", target, name: "removeFirst", arguments: [] };
      case "isEmpty":
        return {
          kind: "binary",
          operator: "==",
          left: { kind: "property", target, name: "length" },
          right: { kind: "literal", value: 0 },
        };
      case "first":
      case "last":
        return { kind: "property", target, name };
      // Lists copy on assignment, so a copy or an array of the elements is the list itself.
      case "toList":
      case "clone":
      case "toArray":
        return target;
      case "max":
        return useHelper(context, "listMax", [target]);
      case "min":
        return useHelper(context, "listMin", [target]);
      case "sum":
        // Groovy sum() joins text; the helper adds numbers only.
        if (!onlyOf(listElementType(targetNode, context), NUMBER)) {
          return unsupportedExpression(
            context,
            node,
            "SX_LIST_SUM_TYPE",
            "Groovy sum() adds numbers but joins text and other values; this list is not proven to hold only numbers. Add the elements explicitly.",
          );
        }
        return useHelper(context, "listSum", [target]);
      case "unique":
        // Groovy unique() also deduplicates the receiver in place; as an expression only the result is kept.
        return useHelper(context, "unique", [target]);
      case "join":
        // Groovy join() has no separator; TeaseScript's default separator is ", ".
        if (!joinableElements(targetNode, node, context)) return null;
        return listJoin(target, { kind: "literal", value: "" });
    }
  }
  if (name === "join" && argumentsNodes.length === 1) {
    if (!joinableElements(targetNode, node, context)) return null;
    const separator = lowerExpression(argumentsNodes[0]!, context);
    return separator === null ? null : listJoin(target, separator);
  }
  // `toArray(new String[0])` only names the array type.
  if (name === "toArray" && argumentsNodes.length === 1 && isPure(argumentsNodes[0]!, context))
    return target;
  return unsupportedExpression(
    context,
    node,
    "SX_UNSUPPORTED_LIST_METHOD",
    `Groovy list method ${name}() is not safely mapped yet.`,
  );
}

/**
 * Groovy join() printed nested lists and maps as `[a, b]` and `[k:v]`, while TeaseScript join() shows only text,
 * numbers, booleans, and null (PR #518); a list known to hold composites is reported. Elements of unknown type are
 * checked when join runs.
 */
function joinableElements(listNode: AstNode, node: AstNode, context: LowerContext): boolean {
  const elements = listElementType(listNode, context);
  if (elements === UNKNOWN) {
    addDiagnostic(
      context,
      "SX_LIST_JOIN",
      "warning",
      "The element types of this list are not proven; if it holds lists or maps, TeaseScript join() stops the script, where Groovy printed them as [a, b].",
      node.span,
    );
    return true;
  }
  if ((elements & (LIST | OBJECT)) === 0) return true;
  unsupportedExpression(
    context,
    node,
    "SX_LIST_JOIN",
    "Groovy join() printed the lists or maps in this list as [a, b]; TeaseScript join() shows only text, numbers, booleans, and null. Join the inner values explicitly.",
  );
  return false;
}

/** Accepted list `join` (PR #518), which shows each element as `${...}` does. */
function listJoin(list: IrExpression, separator: IrExpression): IrExpression {
  return { kind: "methodCall", target: list, name: "join", arguments: [separator] };
}

/**
 * List and text methods on a receiver the importer cannot prove to be a list or text, such as a parameter, a list
 * element, or a function result. TeaseScript members follow the runtime value, and a value of unknown type is
 * checked when the member runs (#520), so a method converts as is when Groovy gave it the same meaning on every kind
 * of value it exists for, and failed on the others as TeaseScript does: `contains` on lists, sets, and text; `add`,
 * `join`, `remove(value)`, `clear`, `sort`, `min`, `max`, and `pop` (the first element in Groovy 2.5) on lists and sets;
 * `count` of a value that is not text, which Groovy counted only in lists. `indexOf` converts as the text operation,
 * which fails on a list, with a note. A method that changes the list must be a statement on a variable, element, or
 * field. Returns undefined for
 * methods whose meaning depends on the receiver's kind, such as `remove(number)` (a position in a list, a value in a
 * set) or `count(text)` (substrings of text, elements of a list).
 */
function unprovenReceiverOperation(
  node: AstNode,
  targetNode: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null | undefined {
  if (argumentsNodes.some((argument) => argument.kind === "closure")) return undefined;
  const type = inferType(targetNode, context.types);
  const mayBeList = (type & LIST) !== 0;
  const mayBeText = (type & STRING) !== 0;
  const argumentType =
    argumentsNodes.length === 1 ? inferType(argumentsNodes[0]!, context.types) : 0;
  const statement = context.statementRoot?.kind === "expressionStatement";
  const whole = statement && asNode(context.statementRoot!.expression) === node;
  const call = (method: string, args: IrExpression[], target: IrExpression): IrExpression => ({
    kind: "methodCall",
    target,
    name: method,
    arguments: args,
  });
  let changes = false;
  let position = false;
  switch (name) {
    // Lists copy on assignment, so a copy or an array of the elements is the list itself.
    case "clone":
    case "toArray":
      if (!mayBeList || argumentsNodes.length > 1) return undefined;
      if (
        argumentsNodes.length === 1 &&
        (name !== "toArray" || !isPure(argumentsNodes[0]!, context))
      )
        return undefined;
      break;
    case "contains":
    case "indexOf":
      if (argumentsNodes.length !== 1 || !(mayBeList || mayBeText)) return undefined;
      if (name === "indexOf" && mayBeList && mayBeText) {
        addDiagnostic(
          context,
          "SX_INDEX_OF_RECEIVER",
          "warning",
          "Groovy indexOf() found a text in text or an element in a list; this receiver is not proven to be text, and if it holds a list, indexOf() stops the script, since TeaseScript lists have no indexOf.",
          node.span,
        );
      }
      break;
    case "join":
      if (argumentsNodes.length > 1 || !mayBeList) return undefined;
      break;
    case "count":
      if (argumentsNodes.length !== 1 || !mayBeList || (argumentType & STRING) !== 0)
        return undefined;
      break;
    case "min":
    case "max":
      if (argumentsNodes.length !== 0 || !mayBeList) return undefined;
      break;
    case "pop":
      if (argumentsNodes.length !== 0 || !mayBeList) return undefined;
      changes = true;
      break;
    case "add":
      if (argumentsNodes.length !== 1 || !mayBeList || !whole) return undefined;
      changes = true;
      break;
    case "remove":
      // Groovy remove(int) removes a position from a list and returns the element, as removeAt does; with another
      // value, it removes the value.
      if (argumentsNodes.length !== 1 || !mayBeList) return undefined;
      position = onlyOf(argumentType, NUMBER) && argumentType !== 0;
      if (!position && (!whole || !onlyOf(argumentType, STRING | BOOLEAN | LIST | OBJECT)))
        return undefined;
      changes = true;
      break;
    case "clear":
    case "sort":
      if (argumentsNodes.length !== 0 || !mayBeList || !whole) return undefined;
      changes = true;
      break;
    default:
      return undefined;
  }
  if (changes) {
    if (placeRoot(targetNode) === null) return undefined;
    const parameterWrite = parameterListWrite(targetNode, node, context);
    if (parameterWrite !== null)
      return unsupportedExpression(context, node, "SX_PARAMETER_LIST_WRITE", parameterWrite);
  }
  if (name === "join" && !joinableElements(targetNode, node, context)) return null;
  const target = lowerExpression(targetNode, context);
  const args = lowerArguments(argumentsNodes, context);
  if (target === null || args === null) return null;
  switch (name) {
    case "indexOf":
      // Text has indexOf; a list that cannot be text needs the helper.
      return mayBeText
        ? call("indexOf", args, target)
        : useHelper(context, "indexOf", [target, args[0]!]);
    case "count":
      return useHelper(context, "count", [target, args[0]!]);
    case "min":
      return useHelper(context, "listMin", [target]);
    case "max":
      return useHelper(context, "listMax", [target]);
    case "join":
      // Groovy join() has no separator; TeaseScript's default separator is ", ".
      return listJoin(target, args[0] ?? { kind: "literal", value: "" });
    case "pop":
      return call("removeFirst", [], target);
    case "clone":
    case "toArray":
      return target;
    case "remove":
      return call(position ? "removeAt" : "remove", args, target);
    default:
      return call(name, args, target);
  }
}

/**
 * Groovy string methods as accepted TeaseScript text operations (V30 §8 as accepted in PR #518): `text.length`,
 * `uppercase()`, `trim()`, and so on. Text operations follow Unicode code points and full case mapping, which differ
 * from Java only for rare text (see COMPATIBILITY-GAPS.md). The length also counts list elements and dict entries, so
 * a receiver needs no proof unless it is known to be an object. Returns undefined for methods or arguments without a
 * text operation (regular expressions, tokenize).
 */
function textOperation(
  node: AstNode,
  targetNode: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null | undefined {
  const member = (operation: string, args: IrExpression[], target: IrExpression): IrExpression => ({
    kind: "methodCall",
    target,
    name: operation,
    arguments: args,
  });
  const literalText = (argument: AstNode | undefined): string | null => {
    const value = argument === undefined ? undefined : constantValue(argument);
    return typeof value === "string" ? value : null;
  };
  // Java counted UTF-16 units where TeaseScript counts code points (#518); the counts differ only for characters
  // outside the Basic Multilingual Plane, which a note marks where a literal shows one.
  const noteCodePoints = (): void => {
    if (!["size", "length", "substring", "indexOf", "lastIndexOf"].includes(name)) return;
    const texts = [targetNode, ...argumentsNodes].map((argument) => literalText(argument) ?? "");
    if (!texts.some((text) => /[\u{10000}-\u{10FFFF}]/u.test(text))) return;
    addDiagnostic(
      context,
      "SX_TEXT_CODE_POINTS",
      "warning",
      `Java counted this text in UTF-16 units, so a character such as an emoji counted twice; TeaseScript ${name === "size" || name === "length" ? "length" : `${name}()`} counts code points, which changes the result here.`,
      node.span,
    );
  };
  let operation: string;
  switch (name) {
    case "size":
    case "length":
    case "isEmpty": {
      if (argumentsNodes.length !== 0) return undefined;
      // Text, lists, and dicts have a length (#536); an object with fixed properties does not.
      if (isKnownMapExpression(targetNode, context)) return undefined;
      const target = lowerExpression(targetNode, context);
      if (target === null) return null;
      if (name !== "isEmpty") noteCodePoints();
      if (
        (inferType(targetNode, context.types) & OBJECT) !== 0 &&
        !isDictionary(targetNode, context)
      ) {
        addDiagnostic(
          context,
          "SX_LENGTH_RECEIVER",
          "warning",
          `Groovy ${name}() also worked on a map; text, lists, and dicts have a length, but if this value is an object with fixed properties, length stops the script.`,
          node.span,
        );
      }
      const length: IrExpression = { kind: "property", target, name: "length" };
      return name === "isEmpty"
        ? { kind: "binary", operator: "==", left: length, right: { kind: "literal", value: 0 } }
        : length;
    }
    case "toUpperCase":
    case "toLowerCase":
    case "capitalize":
    case "trim":
      if (argumentsNodes.length !== 0) return undefined;
      operation = TEXT_OPERATION_NAMES.get(name) ?? name;
      break;
    case "contains":
    case "indexOf":
    case "lastIndexOf":
    case "startsWith":
    case "endsWith":
    case "replace":
      if (argumentsNodes.length !== (name === "replace" ? 2 : 1)) return undefined;
      operation = name;
      break;
    case "replaceAll": {
      // Java replaceAll() takes a regular expression and a replacement pattern; the regular expressions that text
      // operations express (regex-subset.ts) convert, with a replacement of plain text or a computed text.
      const pattern = literalText(argumentsNodes[0]);
      const subset = pattern === null ? null : parseRegexSubset(pattern);
      if (argumentsNodes.length !== 2 || subset === null) return undefined;
      const replacementText = literalText(argumentsNodes[1]);
      const plain = replacementText === null ? null : javaReplacementText(replacementText);
      if (replacementText !== null && plain === null) return undefined;
      const target = lowerExpression(targetNode, context);
      const computed = plain === null ? lowerExpression(argumentsNodes[1]!, context) : null;
      if (target === null || (plain === null && computed === null)) return null;
      const replacement: IrExpression =
        plain !== null
          ? { kind: "literal", value: plain }
          : onlyOf(inferType(argumentsNodes[1]!, context.types), STRING)
            ? computed!
            : { kind: "template", parts: [{ value: computed! }] };
      if (subset.kind === "literal")
        return member("replace", [{ kind: "literal", value: subset.text }, replacement], target);
      if (subset.kind === "alternatives")
        return subset.texts.reduce<IrExpression>(
          (text, search) =>
            member("replace", [{ kind: "literal", value: search }, replacement], text),
          target,
        );
      addDiagnostic(
        context,
        "SX_REGEX_CHARACTERS",
        "info",
        "Java replaced the characters this character class matched; a helper replaces them character by character.",
        node.span,
      );
      return useHelper(context, "replaceChars", [
        target,
        { kind: "literal", value: subset.chars },
        { kind: "literal", value: subset.negated },
        replacement,
        { kind: "literal", value: subset.runs },
      ]);
    }
    case "split": {
      // Java split() takes a regular expression and drops trailing empty parts.
      const separator = literalText(argumentsNodes[0]);
      if (argumentsNodes.length !== 1 || separator === null || separator === "") return undefined;
      // Plain characters, and metacharacters escaped as in the patterns `\|` or `\.`, match themselves.
      if (!/^(?:[^\\^$.|?*+()[\]{}]|\\[^A-Za-z0-9])+$/u.test(separator)) return undefined;
      const target = lowerExpression(targetNode, context);
      if (target === null) return null;
      const plain: IrExpression = { kind: "literal", value: separator.replace(/\\(.)/gu, "$1") };
      // A part read at a fixed position is the same where Java had it, and a written text that does not end with the
      // separator has no trailing empty part; elsewhere a helper drops the trailing empty parts that Java dropped.
      const written = literalText(targetNode);
      const separatorText = String(plain.value);
      if (
        context.indexedSplits.has(node) ||
        (written !== null && written !== "" && !written.endsWith(separatorText))
      )
        return member("split", [plain], target);
      addDiagnostic(
        context,
        "SX_SPLIT_TRAILING_EMPTY",
        "info",
        "Java split() dropped trailing empty parts, which TeaseScript split() keeps; a helper drops them.",
        node.span,
      );
      return useHelper(context, "split", [target, plain]);
    }
    case "substring":
      if (argumentsNodes.length !== 1 && argumentsNodes.length !== 2) return undefined;
      operation = "substring";
      break;
    case "count": {
      // Groovy counted every occurrence, overlapping ones too; the parts between occurrences that split() finds count
      // all of them when no start of the text is also its end, as "aa" is in "aaa".
      const part = literalText(argumentsNodes[0]);
      if (argumentsNodes.length !== 1 || part === null || part === "" || overlapsItself(part))
        return undefined;
      const target = lowerExpression(targetNode, context);
      if (target === null) return null;
      return {
        kind: "binary",
        operator: "-",
        left: {
          kind: "property",
          target: member("split", [{ kind: "literal", value: part }], target),
          name: "length",
        },
        right: { kind: "literal", value: 1 },
      };
    }
    case "equalsIgnoreCase": {
      // TeaseScript has no case-insensitive comparison (owner, #508): both sides are lowercased. Groovy returns
      // false for a null argument, which lowercase() would not survive.
      if (argumentsNodes.length !== 1) return undefined;
      if (!onlyOf(inferType(argumentsNodes[0]!, context.types), STRING)) return undefined;
      const left = lowerExpression(targetNode, context);
      const right = lowerExpression(argumentsNodes[0]!, context);
      if (left === null || right === null) return null;
      return {
        kind: "binary",
        operator: "==",
        left: member("lowercase", [], left),
        right: member("lowercase", [], right),
      };
    }
    default:
      return undefined;
  }
  const target = lowerExpression(targetNode, context);
  if (target === null) return null;
  const lowered = lowerArguments(argumentsNodes, context);
  if (lowered === null) return null;
  noteCodePoints();
  return member(operation, lowered, target);
}

/** Whether occurrences of a text can overlap: some proper start of it is also its end. */
function overlapsItself(text: string): boolean {
  for (let length = 1; length < text.length; length += 1) {
    if (text.slice(0, length) === text.slice(text.length - length)) return true;
  }
  return false;
}

/** Groovy/Java string method names whose TeaseScript text operation has another name. */
const TEXT_OPERATION_NAMES = new Map([
  ["toUpperCase", "uppercase"],
  ["toLowerCase", "lowercase"],
  ["capitalize", "uppercaseFirst"],
]);

/** Groovy/Java string methods; `size`/`length` also measure lists, which are handled when proven. */
const STRING_METHODS = new Set([
  "capitalize",
  "endsWith",
  "equalsIgnoreCase",
  "isEmpty",
  "length",
  "replace",
  "replaceAll",
  "size",
  "split",
  "startsWith",
  "substring",
  "toLowerCase",
  "toUpperCase",
  "tokenize",
  "trim",
]);

/** Methods that lists have too, converted as text operations only on receivers proven to be text. */
const TEXT_ONLY_METHODS = new Set(["contains", "count", "indexOf", "lastIndexOf"]);

/** Java Math helpers for operands not proven numeric, which the built-ins `max` and `min` reject. */
const MATH_HELPERS = new Map<string, { name: HelperName; arity: number }>([
  ["max", { name: "max", arity: 2 }],
  ["min", { name: "min", arity: 2 }],
]);

/** Groovy declared types that store whole numbers: a stored number truncates toward zero, like `toInteger`. */
const INTEGER_TYPES = new Set(["byte", "Byte", "short", "Short", "int", "Integer", "long", "Long"]);

/** Java default values: null for object types, zero or false for primitives. */
const PRIMITIVE_DEFAULTS = new Map<string, number | boolean>([
  ["boolean", false],
  ["byte", 0],
  ["double", 0],
  ["float", 0],
  ["int", 0],
  ["long", 0],
  ["short", 0],
]);

/** Arrays whose writes keep their values as a list does (a boolean array rejects other values). */
const LIST_LIKE_ARRAY_TYPES = new Set(["boolean", "Boolean", "Object", "double", "Double"]);
/** Arrays that convert written values (numbers truncate or round, values become text); converted with a note. */
const CONVERTING_ARRAY_TYPES = new Set([
  "byte",
  "Byte",
  "float",
  "Float",
  "int",
  "Integer",
  "long",
  "Long",
  "short",
  "Short",
  "String",
]);

function lowerArrayExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const sizes = nodeArray(node.sizes);
  const items = nodeArray(node.items);
  if (sizes.length === 0) {
    const values = lowerArguments(items, context);
    return values === null ? null : { kind: "list", items: values };
  }
  if (sizes.length !== 1 || items.length > 0) {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_ARRAY",
      "Multi-dimensional Java arrays are not converted automatically.",
    );
  }
  const elementType = (text(node.elementType) ?? "").replace(/^java\.lang\./u, "");
  if (CONVERTING_ARRAY_TYPES.has(elementType)) {
    addDiagnostic(
      context,
      "SX_JAVA_ARRAY_CONVERSION",
      "warning",
      `A Java ${elementType}[] converted every written value to its element type (truncating or rounding numbers, turning values into text); this list keeps values as written.`,
      node.span,
    );
  } else if (!LIST_LIKE_ARRAY_TYPES.has(elementType)) {
    return unsupportedExpression(
      context,
      node,
      "SX_JAVA_ARRAY_TYPE",
      `A Java ${elementType}[] converts every written value to its element type; a TeaseScript list keeps values as written. Use a list and convert values explicitly.`,
    );
  }
  const size = lowerExpression(sizes[0]!, context);
  if (size === null) return null;
  const defaultValue = PRIMITIVE_DEFAULTS.get(elementType) ?? null;
  return useHelper(context, "array", [size, { kind: "literal", value: defaultValue }]);
}

function isCurrentDateValue(node: AstNode, context: LowerContext): boolean {
  const name = variableName(node);
  return name === null ? isCurrentDate(node) : context.dateValues.has(name);
}

function isCurrentDate(node: AstNode): boolean {
  const call = callParts(node);
  const calendar =
    call !== null &&
    call.name === "getInstance" &&
    call.arguments.length === 0 &&
    variableName(node.object) === "Calendar";
  return calendar || isCurrentDateConstructor(node);
}

function noteSharedListWrite(list: AstNode | null, node: AstNode, context: LowerContext): void {
  const name = list === null ? null : variableName(list);
  if (name === null || !context.aliasedLists.has(name)) return;
  addDiagnostic(
    context,
    "SX_SHARED_LIST_WRITE",
    "warning",
    `Groovy shared the list in ${name} with another variable assigned from it, so this change affected both; in TeaseScript the variables hold separate copies (ADR 0014).`,
    node.span,
  );
}

/**
 * Checks a list method that changes the list in `receiver` (`add`, `remove`, `sort`, `<<`, ...). Groovy lists are
 * shared references and TeaseScript lists are values (ADR 0014). A change through a closure parameter or loop
 * variable, or through a list or object it holds, changed the caller's list or the iterated element in Groovy but
 * would change only a copy here; the reason is returned for the caller to report. A variable assigned from another
 * variable, a list element, or a field shared its list with that place, which a note marks. Returns null when the
 * change converts.
 */
function parameterListWrite(
  receiver: AstNode,
  node: AstNode,
  context: LowerContext,
): string | null {
  const root = placeRoot(receiver);
  const name = root === null ? null : variableName(root);
  if (root === null || name === null) return null;
  const key = bindingKey(root, context.bindings) ?? name;
  if (context.parameterBindings.has(key)) {
    return `Groovy changed the list that ${name} refers to, which the caller or the iterated collection shares; in TeaseScript ${name} holds a copy (ADR 0014), so the change would be lost. Return the changed list and store it where it is kept.`;
  }
  if (context.aliasedLists.has(name)) {
    noteSharedListWrite(root, node, context);
  } else if ((context.assignedValues.get(key) ?? []).some((value) => sharesList(value, context))) {
    addDiagnostic(
      context,
      "SX_SHARED_LIST_WRITE",
      "warning",
      `Groovy shared the list in ${name} with the variable, list element, or field it was assigned from, so this change affected that place too; in TeaseScript ${name} holds a separate copy (ADR 0014).`,
      node.span,
    );
  }
  return null;
}

/**
 * Whether `<<` may append to the value of `receiver` although it is not proven to be a list: a variable, element, or
 * field that may hold a list, and no assignment of the variable is a Java object (a file or text buffer, which `<<`
 * writes to).
 */
function mayAppendToUnprovenList(receiver: AstNode, context: LowerContext): boolean {
  if ((inferType(receiver, context.types) & LIST) === 0) return false;
  const root = placeRoot(receiver);
  if (root === null) return false;
  if (root !== receiver) return true;
  const key = bindingKey(root, context.bindings) ?? variableName(root)!;
  return !(context.assignedValues.get(key) ?? []).some((value) => value.kind === "constructorCall");
}

/** The variable a place (`v`, `v[i]`, `v.field`, and chains of them) starts from; null for any other expression. */
function placeRoot(node: AstNode): AstNode | null {
  let current: AstNode | null = node;
  while (
    current !== null &&
    (current.kind === "property" || (current.kind === "binary" && current.operator === "["))
  )
    current = asNode(current.kind === "property" ? current.object : current.left);
  return current !== null && current.kind === "variable" ? current : null;
}

/** Whether an assigned value may be a list that Groovy kept shared with a variable, list element, or field. */
function sharesList(value: AstNode, context: LowerContext): boolean {
  switch (value.kind) {
    case "variable":
    case "property":
      return (inferType(value, context.types) & LIST) !== 0;
    case "binary":
      return value.operator === "[" && (inferType(value, context.types) & LIST) !== 0;
    case "ternary":
      return [value.true, value.false].some(
        (branch) => asNode(branch) !== null && sharesList(asNode(branch)!, context),
      );
    case "elvis":
      return [value.boolean, value.false].some(
        (branch) => asNode(branch) !== null && sharesList(asNode(branch)!, context),
      );
    case "cast":
      return asNode(value.value) !== null && sharesList(asNode(value.value)!, context);
    default:
      return false;
  }
}

function aliasedListVariables(body: AstNode, types: TypeEnvironment): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    const target = assigns ? variableName(node.left) : null;
    const source = assigns ? variableName(node.right) : null;
    if (target === null || source === null) return;
    if (onlyOf(types.variables.get(source) ?? UNKNOWN, LIST | NULL)) {
      names.add(target);
      names.add(source);
    }
  });
  return names;
}

/** Groovy map methods that use a map as a lookup table (#536); `clear`, `size`, and `isEmpty` alone do not. */
const LOOKUP_METHODS = new Set([
  "containsKey",
  "keySet",
  "values",
  "entrySet",
  "put",
  "get",
  "remove",
  "each",
  "eachWithIndex",
  "findAll",
  "collect",
  "any",
  "every",
  "find",
]);

/**
 * Variables that hold a Groovy map used as a lookup table, which becomes a `dict` (#536): looked up by a runtime key,
 * given lookup methods or a loop, or built with computed or non-name keys. Other maps stay objects with fixed
 * properties. A map assigned to, from, or compared with a dict variable is a dict too, since a dict never equals an
 * object.
 */
function dictionaryVariables(
  body: AstNode,
  types: TypeEnvironment,
  keys: BindingKeys,
): Set<string> {
  const names = new Set<string>();
  const keyOf = (node: unknown): string | null => bindingKey(node, keys);
  const typeOf = (node: unknown): number =>
    types.variables.get(variableName(node) ?? "") ?? UNKNOWN;
  const maybeMap = (node: unknown): boolean => (typeOf(node) & OBJECT) !== 0;
  const knownMap = (node: unknown): boolean => {
    const type = typeOf(node);
    return onlyOf(type, OBJECT | NULL) && (type & OBJECT) !== 0;
  };
  const lookupKey = (key: AstNode | null): boolean => {
    if (key === null) return false;
    const literal = constantValue(key);
    if (typeof literal === "string") return !isTeaseObjectPropertyName(literal);
    return literal !== undefined || onlyOf(inferType(key, types), STRING);
  };
  const aliases: Array<[string, string]> = [];
  walkAst(body, (node) => {
    if (node.kind === "binary" && node.operator === "[") {
      const name = keyOf(node.left);
      const key = asNode(node.right);
      // A runtime text key cannot index a list; on a map, a runtime or non-name key needs a dict.
      const runtimeKey = key !== null && constantValue(key) === undefined;
      if (
        name !== null &&
        ((runtimeKey && onlyOf(inferType(key, types), STRING)) ||
          (knownMap(node.left) && (runtimeKey || lookupKey(key))))
      )
        names.add(name);
    }
    if (node.kind === "methodCall") {
      const name = keyOf(node.object);
      const method = constantString(node.method);
      if (name !== null && method !== null && LOOKUP_METHODS.has(method)) {
        const mapOnly = ["containsKey", "keySet", "entrySet", "put"].includes(method);
        if (knownMap(node.object) || (mapOnly && maybeMap(node.object))) names.add(name);
      }
      // `a.equals(b)` compares like `a == b`.
      const [argument] = nodeArray(asNode(node.arguments)?.items);
      const other = keyOf(argument);
      if (method === "equals" && name !== null && other !== null && maybeMap(node.object))
        aliases.push([name, other]);
    }
    if (node.kind === "for") {
      const name = keyOf(node.collection);
      if (name !== null && knownMap(node.collection)) names.add(name);
    }
    if (node.kind === "binary" && (node.operator === "==" || node.operator === "!=")) {
      const [left, right] = [keyOf(node.left), keyOf(node.right)];
      if (left !== null && right !== null && maybeMap(node.left) && maybeMap(node.right))
        aliases.push([left, right]);
    }
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    const target = assigns ? keyOf(node.left) : null;
    const value = assigns ? asNode(node.right) : null;
    if (target === null || value === null) return;
    if (value.kind === "map") {
      for (const entry of nodeArray(value.entries)) {
        const key = constantString(entry.key);
        if (key === null || !isTeaseObjectPropertyName(key)) names.add(target);
      }
    }
    const source = keyOf(value);
    if (source !== null) aliases.push([target, source]);
  });
  for (let changed = true; changed;) {
    changed = false;
    for (const [target, source] of aliases) {
      if (names.has(target) !== names.has(source)) {
        names.add(target);
        names.add(source);
        changed = true;
      }
    }
  }
  return names;
}

/**
 * Splits scratch variables: a script variable that holds values of several types, where every write and read of it is
 * a statement of one straight-line stretch of the block that declares it (no loop, switch, `break`, `continue`, or
 * `return` between them) and no function, mixin module, or helper class writes or reads it. Each read then sees the value of the write before it, so
 * each value type gets its own variable, declared next to the original with its type's empty value, which no read can
 * see. Anything else is a type change the type pass reports.
 */
function splitScratchVariables(body: AstNode, context: LowerContext): AstNode {
  // Mixin modules and helper classes reach script variables by name.
  if (
    body.kind !== "block" ||
    context.mixinModules.length > 0 ||
    context.packageHelperRegistry.size > 0
  )
    return body;
  const types = context.types;
  const statements = nodeArray(body.statements);
  const kindOf = (value: AstNode | null): string | null => {
    const type = inferType(value, types);
    if (onlyOf(type, STRING)) return "Text";
    if (onlyOf(type, BOOLEAN)) return "Boolean";
    if (onlyOf(type, NUMBER)) return "Number";
    if (onlyOf(type, LIST)) return "List";
    return null;
  };
  const replacements = new Map<AstNode, AstNode>();
  const added: AstNode[] = [];
  for (const [declarationIndex, declaration] of statements.entries()) {
    const declared =
      declaration.kind === "expressionStatement" ? asNode(declaration.expression) : null;
    const name = declared?.kind === "declaration" ? variableName(declared.left) : null;
    const initial = asNode(declared?.right);
    if (name === null || initial === null || initial.kind === "closure") continue;
    // Every occurrence of the script variable, by the top-level statement that holds it.
    const occurrences = new Map<AstNode, number>();
    let elsewhere = false;
    for (const [index, statement] of statements.entries()) {
      walkAst(statement, (node) => {
        if (variableName(node) !== name || bindingKey(node, context.bindings) !== name) return;
        if (node === declared!.left) return;
        occurrences.set(node, index);
      });
    }
    // Occurrences inside a closure, a nested block, or a branch are not straight-line code here; an `if` condition
    // runs in line.
    for (const [node, index] of occurrences) {
      const statement = statements[index]!;
      const holder =
        statement.kind === "expressionStatement"
          ? asNode(statement.expression)
          : statement.kind === "if"
            ? asNode(statement.condition)
            : null;
      let nested = holder === null || !closureContains(holder, node);
      walkAst(holder, (inner) => {
        if (inner.kind === "closure" && closureContains(inner, node)) nested = true;
      });
      if (nested) elsewhere = true;
    }
    if (elsewhere || occurrences.size === 0) continue;
    const last = Math.max(...occurrences.values());
    // A loop, switch, break, continue, or return anywhere in between, also nested in a branch, crosses the stretch;
    // a closure body does not run in place.
    const jumps = (node: AstNode): boolean =>
      node.kind !== "closure" &&
      (["for", "while", "switch", "break", "continue", "return"].includes(node.kind) ||
        nodeChildren(node).some(jumps));
    if (statements.slice(declarationIndex + 1, last + 1).some(jumps)) continue;
    // Walk the stretch in order: each read takes the kind of the write before it.
    const writes = new Map<AstNode, string>();
    const reads = new Map<AstNode, string>();
    let current = kindOf(initial);
    let valid = current !== null;
    const visit = (node: AstNode): void => {
      if (!valid) return;
      if ((node.kind === "binary" && node.operator === "=") || node.kind === "declaration") {
        const right = asNode(node.right);
        if (right !== null) visit(right);
        const target = asNode(node.left);
        if (target !== null && occurrences.has(target)) {
          current = kindOf(right);
          if (current === null) valid = false;
          else writes.set(target, current);
        } else if (target !== null) visit(target);
        return;
      }
      if (occurrences.has(node)) {
        // A compound assignment or increment both reads and writes; it keeps the kind only for numbers or text.
        reads.set(node, current!);
        return;
      }
      for (const child of evaluationChildren(node)) visit(child);
    };
    for (const statement of statements.slice(declarationIndex + 1, last + 1)) {
      const holder =
        statement.kind === "expressionStatement"
          ? asNode(statement.expression)
          : statement.kind === "if"
            ? asNode(statement.condition)
            : null;
      if (holder !== null) visit(holder);
    }
    const initialKind = kindOf(initial);
    if (!valid || initialKind === null) continue;
    const kinds = new Set([...writes.values(), initialKind]);
    if (kinds.size < 2) continue;
    if (occurrences.size !== writes.size + reads.size) continue;
    const names = new Map<string, string>([[initialKind, name]]);
    for (const kind of kinds) {
      if (kind === initialKind) continue;
      const split = freshName(`${name}${kind}`, context);
      names.set(kind, split);
      const empty: AstNode =
        kind === "List"
          ? { kind: "list", span: declaration.span, items: [] }
          : {
              kind: "constant",
              span: declaration.span,
              value: kind === "Boolean" ? false : kind === "Number" ? 0 : "",
            };
      added.push(
        syntheticAssignment(
          true,
          syntheticVariable(split, declaration.span),
          empty,
          declaration.span,
        ),
      );
    }
    for (const [node, kind] of [...reads, ...writes]) {
      if (kind !== initialKind)
        replacements.set(node, syntheticVariable(names.get(kind)!, node.span));
    }
    addDiagnostic(
      context,
      "SX_SCRATCH_VARIABLE",
      "info",
      `Groovy reused '${name}' for values of several types in straight-line code, each assigned before it is read; each type has its own variable here (${[...names.values()].join(", ")}).`,
      declaration.span,
    );
  }
  if (replacements.size === 0) return body;
  const rewritten = substituteNodes(body, replacements);
  return { ...rewritten, statements: [...added, ...nodeArray(rewritten.statements)] };
}

/** Whether `node` lies inside the closure `closure`. */
function closureContains(closure: AstNode, node: AstNode): boolean {
  let found = false;
  walkAst(closure, (inner) => {
    if (inner === node) found = true;
  });
  return found;
}

/** Positions of list writes that count up with the writes (markSequentialWrites), as the `list[i]` target nodes. */
const sequentialWrites = new WeakSet<AstNode>();
/** Writes at a literal position that a straight-line block shows to be the list's length, or inside it. */
const literalAppends = new WeakSet<AstNode>();
const literalSets = new WeakSet<AstNode>();

/**
 * Marks the list writes whose position grows by one with each write, so a list that starts empty grows by appending:
 * a counter that starts at 0, only ever counts up by one, and counts up in the block of the write (`list[n] = x`
 * beside `n++`), or is the counter of the C-style loop whose body writes at it directly, without a `continue`.
 */
function markSequentialWrites(body: AstNode, context: LowerContext): void {
  const keys = context.bindings;
  const decremented = new Set<string>();
  walkAst(body, (node) => {
    if ((node.kind === "postfix" || node.kind === "prefix") && text(node.operator) === "--") {
      const key = bindingKey(node.value, keys);
      if (key !== null) decremented.add(key);
    }
  });
  const isConstant = (node: AstNode | undefined, value: number): boolean =>
    constantValue(node) === value;
  const counts = (key: string): boolean =>
    !decremented.has(key) &&
    (context.assignedValues.get(key) ?? []).every(
      (value) => isConstant(value, 0) || isNullConstant(value) || isEmptyGroovyExpression(value),
    ) &&
    (context.compoundValues.get(key) ?? []).every(
      (value) => text(value.operator) === "+" && isConstant(asNode(value.right) ?? undefined, 1),
    );
  // The binding an expression counts up by one: `n++`, `++n`, `n += 1`, `n = n + 1`.
  const countsUp = (expression: AstNode | null): string | null => {
    if (expression === null) return null;
    if (
      (expression.kind === "postfix" || expression.kind === "prefix") &&
      text(expression.operator) === "++"
    )
      return bindingKey(expression.value, keys);
    if (expression.kind !== "binary") return null;
    const operator = text(expression.operator);
    const right = asNode(expression.right);
    if (operator === "+=" && isConstant(right ?? undefined, 1))
      return bindingKey(expression.left, keys);
    const key = operator === "=" ? bindingKey(expression.left, keys) : null;
    return key !== null &&
      right?.kind === "binary" &&
      text(right.operator) === "+" &&
      bindingKey(right.left, keys) === key &&
      isConstant(asNode(right.right) ?? undefined, 1)
      ? key
      : null;
  };
  const expressionOf = (statement: AstNode): AstNode | null =>
    statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  const mark = (statements: readonly AstNode[], counters: Set<string>): void => {
    for (const statement of statements) {
      const key = countsUp(expressionOf(statement));
      if (key !== null) counters.add(key);
    }
    // The known lengths of lists in this straight-line block, for writes at literal positions: `a = []`, `a[0] = x`,
    // `a[1] = y`.
    const lengths = new Map<string, number>();
    for (const statement of statements) {
      const expression = expressionOf(statement);
      const operator = expression?.kind === "binary" ? text(expression.operator) : null;
      const assigned =
        expression?.kind === "declaration" || operator === "=" ? asNode(expression!.right) : null;
      const target =
        expression?.kind === "declaration" || operator === "=" ? asNode(expression!.left) : null;
      const left = target?.kind === "binary" && text(target.operator) === "[" ? target : null;
      const listKey = left === null ? null : bindingKey(asNode(left.left), keys);
      const position = left === null ? undefined : constantValue(asNode(left.right) ?? undefined);
      if (left !== null) {
        const key = bindingKey(asNode(left.right), keys);
        if (key !== null && counters.has(key) && counts(key)) sequentialWrites.add(left);
      }
      if (listKey !== null && typeof position === "number" && lengths.has(listKey)) {
        const length = lengths.get(listKey)!;
        if (position <= length) {
          (position === length ? literalAppends : literalSets).add(left!);
          lengths.set(listKey, Math.max(length, position + 1));
          continue;
        }
      }
      // A list set to a literal has its length; any other statement that may change a list forgets it.
      const variable = target === null || left !== null ? null : bindingKey(target, keys);
      if (variable !== null && assigned?.kind === "list") {
        lengths.set(variable, nodeArray(assigned.items).length);
        continue;
      }
      let calls = false;
      walkAst(statement, (child) => {
        if (child.kind === "variable") {
          const key = bindingKey(child, keys);
          if (key !== null) lengths.delete(key);
        } else if (child.kind === "methodCall" && callParts(child)?.inherited === true)
          calls ||= legacyApiCall(child, context) === null;
      });
      if (calls) lengths.clear();
    }
  };
  walkAst(body, (node) => {
    if (node.kind === "block") mark(nodeArray(node.statements), new Set());
    if (node.kind !== "for") return;
    const parts = nodeArray(asNode(node.collection)?.items);
    const loopBody = asNode(node.body);
    const counter = parts.length === 3 ? countsUp(parts[2]!) : null;
    if (counter === null || loopBody === null) return;
    let skips = false;
    walkAst(loopBody, (child) => {
      if (child.kind === "continue") skips = true;
    });
    if (!skips)
      mark(
        loopBody.kind === "block" ? nodeArray(loopBody.statements) : [loopBody],
        new Set([counter]),
      );
  });
}

/** Lists whose elements the code compares with null: `list[i] == null`, `list.contains(null)`, `any { e -> e == null }`. */
function nullElementLists(body: AstNode, keys: BindingKeys): Set<string> {
  const lists = new Set<string>();
  const testsNull = (node: AstNode | null): boolean => {
    let found = false;
    walkAst(node, (child) => {
      if (child.kind === "binary" && ["==", "!="].includes(text(child.operator) ?? "")) {
        if (
          isNullConstant(asNode(child.left) ?? undefined) ||
          isNullConstant(asNode(child.right) ?? undefined)
        )
          found = true;
      }
    });
    return found;
  };
  walkAst(body, (node) => {
    if (node.kind === "binary" && ["==", "!="].includes(text(node.operator) ?? "")) {
      for (const [side, other] of [
        [asNode(node.left), asNode(node.right)],
        [asNode(node.right), asNode(node.left)],
      ] as const) {
        if (
          side?.kind === "binary" &&
          text(side.operator) === "[" &&
          isNullConstant(other ?? undefined)
        ) {
          const key = bindingKey(asNode(side.left), keys);
          if (key !== null) lists.add(key);
        }
      }
    }
    if (node.kind !== "methodCall") return;
    const call = callParts(node);
    const key = bindingKey(asNode(node.object), keys);
    if (call === null || key === null) return;
    if (call.name === "contains" && call.arguments.some((argument) => isNullConstant(argument)))
      lists.add(key);
    if (
      ["any", "every", "find", "findAll", "count"].includes(call.name) &&
      call.arguments.some(testsNull)
    )
      lists.add(key);
  });
  return lists;
}

/**
 * The padding value of a list whose elements have one plain type (0, "", or false), from its elements or else from the
 * value written; null for any other list.
 */
function listPadding(
  name: string,
  valueNode: AstNode,
  context: LowerContext,
): number | string | boolean | null {
  // A null among the elements, which nothing compares with null (nullElementLists), leaves the type's empty value.
  const known = (context.types.listElements?.get(name) ?? UNKNOWN) & ~NULL;
  const elements =
    known === (UNKNOWN & ~NULL) ? inferType(valueNode, context.types) & ~NULL : known;
  if (onlyOf(elements, NUMBER)) return 0;
  if (onlyOf(elements, STRING)) return "";
  if (onlyOf(elements, BOOLEAN)) return false;
  return null;
}

/**
 * Whether a list write's position is a number: proven so, or arithmetic whose operands are numbers or of unknown type,
 * `join[i + offset]`, since Groovy failed on a list position of another type.
 */
function listGrowthIndex(indexNode: AstNode, context: LowerContext): boolean {
  if (onlyOf(inferType(indexNode, context.types), NUMBER)) return true;
  if (isRepeatableExpression(indexNode)) return false;
  let numeric = true;
  walkAst(indexNode, (node) => {
    if (node.kind !== "variable" && node.kind !== "constant") return;
    const type = inferType(node, context.types);
    if (!onlyOf(type, NUMBER) && type !== UNKNOWN) numeric = false;
  });
  return numeric;
}

/**
 * A write at a position of a list that starts empty and is filled by position: Groovy grew the list, padding with
 * null up to the position, where a TeaseScript list index must exist. The write appends at the end instead, which is
 * Groovy's result whenever the position is the length; a note says so.
 */
function growingListWrite(
  targetNode: AstNode,
  valueNode: AstNode,
  target: IrExpression,
  value: IrExpression,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | null {
  const listNode =
    targetNode.kind === "binary" && targetNode.operator === "[" ? asNode(targetNode.left) : null;
  const indexNode = asNode(targetNode.right);
  const name = variableName(listNode);
  const initializer = name === null ? undefined : context.constantInitializers.get(name);
  // A list that only ever starts empty, also where the script empties it again, `cards = []`.
  const key = listNode === null ? null : bindingKey(listNode, context.bindings);
  const assigned = key === null ? [] : (context.assignedValues.get(key) ?? []);
  const isEmptyList = (node: AstNode | undefined): boolean =>
    node?.kind === "list" && nodeArray(node.items).length === 0;
  const startsEmpty =
    isEmptyList(initializer) || (assigned.length > 0 && assigned.every(isEmptyList));
  // A literal position at or past the end of the literal list the variable starts as, `label = ["<", ">"]` then
  // `label[2] = exit`, grows it too.
  const position = indexNode === null ? undefined : constantValue(indexNode);
  const literalLists = [initializer, ...assigned].filter((node) => node !== undefined);
  const pastLiteral =
    typeof position === "number" &&
    literalLists.length > 0 &&
    literalLists.every((node) => node.kind === "list" && position >= nodeArray(node.items).length);
  if (
    target.kind !== "index" ||
    target.dict === true ||
    indexNode === null ||
    !(isRepeatableExpression(indexNode) || isPlainArithmetic(indexNode)) ||
    !(startsEmpty || pastLiteral) ||
    // A write that reads the same position first, `map[i] = map[i] % 1000`, needs the position to exist already.
    (listNode !== null && readsPosition(valueNode, listNode, indexNode)) ||
    !listGrowthIndex(indexNode, context)
  )
    return null;
  const list = target.target;
  // A literal position known to be inside the list is a plain write; one known to be its length appends.
  if (literalSets.has(targetNode)) return null;
  if (literalAppends.has(targetNode))
    return [
      {
        kind: "expression",
        expression: { kind: "methodCall", target: list, name: "add", arguments: [value] },
        span,
      },
    ];
  // A position that may lie beyond the end, which Groovy padded up to: the list gets padding values first.
  // A write at the end grows the list by appending where the position counts up with the writes, or is the length of
  // the literal list the variable starts as.
  const literalLengths = new Set(
    literalLists.map((node) => (node.kind === "list" ? nodeArray(node.items).length : -1)),
  );
  const literalLength = literalLengths.size === 1 ? [...literalLengths][0]! : null;
  const appends = sequentialWrites.has(targetNode) || (pastLiteral && position === literalLength);
  // Padding is null where the code compares the list's elements with null, else the empty value of the elements'
  // type; a list of elements of unknown type keeps growing by appending.
  const nullPadding = name !== null && context.nullElementLists.has(key ?? name);
  const neutral = nullPadding || name === null ? null : listPadding(name, valueNode, context);
  if (!appends && (nullPadding || neutral !== null)) {
    const padding: IrExpression = { kind: "literal", value: nullPadding ? null : neutral };
    addDiagnostic(
      context,
      "SX_LIST_PADDING",
      "warning",
      nullPadding
        ? "Groovy grew this list when writing past its end, padding it with null up to the position; the conversion pads it the same way."
        : `Groovy grew this list when writing past its end, padding it with null up to the position; the conversion pads it with ${JSON.stringify(padding.value)}, which Groovy truth treats like null, since nothing compares its elements with null.`,
      span,
    );
    return [
      {
        kind: "while",
        condition: {
          kind: "binary",
          operator: "<=",
          left: { kind: "property", target: list, name: "length" },
          right: target.index,
        },
        body: [
          {
            kind: "expression",
            expression: { kind: "methodCall", target: list, name: "add", arguments: [padding] },
            span,
          },
        ],
        span,
      },
      { kind: "assign", target, operator: "=", value, span },
    ];
  }
  addDiagnostic(
    context,
    "SX_LIST_GROWTH",
    "warning",
    "Groovy grew this list when writing at or past its end, padding with null; a TeaseScript position must exist, so a write at the end appends, which differs only for a position beyond the end.",
    span,
  );
  return [
    {
      kind: "if",
      condition: {
        kind: "binary",
        operator: "<",
        left: target.index,
        right: { kind: "property", target: list, name: "length" },
      },
      then: [{ kind: "assign", target, operator: "=", value, span }],
      else: [
        {
          kind: "expression",
          expression: { kind: "methodCall", target: list, name: "add", arguments: [value] },
          span,
        },
      ],
      span,
    },
  ];
}

/**
 * The regular expressions of the corpus that a text loop stands in for, until TeaseScript has regular expressions (a
 * future `.ts` text library): `split(/\s+/)`, which splits at runs of whitespace, and `replaceAll(/<[^>]*>/, "")`,
 * which removes markup tags. Null for any other call.
 */
function regexWorkaround(node: AstNode): "words" | "tags" | null {
  const call = node.kind === "methodCall" ? callParts(node) : null;
  if (call === null || call.inherited || asNode(node.object) === null) return null;
  const text = (argument: AstNode | undefined): string | undefined => {
    const value = argument === undefined ? undefined : constantValue(argument);
    return typeof value === "string" ? value : undefined;
  };
  if (call.name === "split" && call.arguments.length === 1 && text(call.arguments[0]) === "\\s+")
    return "words";
  if (
    call.name === "replaceAll" &&
    call.arguments.length === 2 &&
    text(call.arguments[0]) === "<[^>]*>" &&
    text(call.arguments[1]) === ""
  )
    return "tags";
  return null;
}

/**
 * A workaround for a regular expression (regexWorkaround) as a loop that computes `target`, with a note naming it as
 * a workaround: the words of a text, split at spaces, tabs, and line breaks with empty parts left out, or a text
 * without the parts from each `<` to the next `>`.
 */
function lowerRegexWorkaround(
  declaration: boolean,
  target: string,
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
  destination: AstNode = syntheticVariable(target, span),
): IrStatement[] | null {
  const kind = regexWorkaround(node);
  const sourceNode = asNode(node.object)!;
  // A source that may read the destination is read while a temporary collects the result.
  if (kind !== null && !declaration && mayReadDestination(sourceNode, destination, context)) {
    const temporary = freshName(kind === "words" ? "words" : "withoutTags", context);
    const built = lowerRegexWorkaround(true, temporary, node, span, context);
    return built === null
      ? null
      : [
          ...built,
          {
            kind: "assign",
            target: { kind: "variable", name: target },
            operator: "=",
            value: { kind: "variable", name: temporary },
            span,
          },
        ];
  }
  const source = lowerExpression(sourceNode, context);
  if (kind === null || source === null) return null;
  const text = (operation: string, args: IrExpression[], value: IrExpression): IrExpression => ({
    kind: "methodCall",
    target: value,
    name: operation,
    arguments: args,
  });
  const literal = (value: string | number): IrExpression => ({ kind: "literal", value });
  const variable = (name: string): IrExpression => ({ kind: "variable", name });
  const result = variable(target);
  const set = (value: IrExpression): IrStatement =>
    declaration
      ? { kind: "let", name: target, value, span }
      : { kind: "assign", target: result, operator: "=", value, span };
  addDiagnostic(
    context,
    "SX_REGEX_WORKAROUND",
    "warning",
    kind === "words"
      ? "Workaround: TeaseScript has no regular expressions yet (a future .ts text library), so a loop over the parts between spaces stands in for split(/\\s+/), with tabs and line breaks read as spaces; unlike Java, a leading space gives no empty first part."
      : 'Workaround: TeaseScript has no regular expressions yet (a future .ts text library), so a loop that removes each part from a < to the next > stands in for replaceAll(/<[^>]*>/, "").',
    span,
  );
  if (kind === "words") {
    const part = freshName("part", context);
    const spaced = [literal("\t"), literal("\n"), literal("\r")].reduce(
      (value, whitespace) => text("replace", [whitespace, literal(" ")], value),
      source,
    );
    return [
      set({ kind: "list", items: [] }),
      {
        kind: "for",
        variable: part,
        collection: text("split", [literal(" ")], spaced),
        body: [
          {
            kind: "if",
            condition: { kind: "binary", operator: "!=", left: variable(part), right: literal("") },
            then: [
              {
                kind: "expression",
                expression: {
                  kind: "methodCall",
                  target: result,
                  name: "add",
                  arguments: [variable(part)],
                },
                span,
              },
            ],
            else: [],
            span,
          },
        ],
        span,
      },
    ];
  }
  const rest = freshName("rest", context);
  const open = freshName("open", context);
  const close = freshName("close", context);
  const plus = (left: IrExpression, right: IrExpression): IrExpression => ({
    kind: "binary",
    operator: "+",
    left,
    right,
  });
  const join = (left: IrExpression, right: IrExpression): IrExpression => ({
    kind: "template",
    parts: [{ value: left }, { value: right }],
  });
  return [
    set(literal("")),
    { kind: "let", name: rest, value: source, span },
    {
      kind: "while",
      condition: text("contains", [literal("<")], variable(rest)),
      body: [
        { kind: "let", name: open, value: text("indexOf", [literal("<")], variable(rest)), span },
        {
          kind: "let",
          name: close,
          value: text(
            "indexOf",
            [literal(">")],
            text("substring", [variable(open)], variable(rest)),
          ),
          span,
        },
        {
          kind: "if",
          condition: { kind: "binary", operator: "<", left: variable(close), right: literal(0) },
          then: [{ kind: "break", span }],
          else: [],
          span,
        },
        {
          kind: "assign",
          target: result,
          operator: "=",
          value: join(result, text("substring", [literal(0), variable(open)], variable(rest))),
          span,
        },
        {
          kind: "assign",
          target: variable(rest),
          operator: "=",
          value: text(
            "substring",
            [plus(plus(variable(open), variable(close)), literal(1))],
            variable(rest),
          ),
          span,
        },
      ],
      span,
    },
    { kind: "assign", target: result, operator: "=", value: join(result, variable(rest)), span },
  ];
}

/**
 * Groovy never ran a function that nothing references: no call, action ID, or use as a value in the generated program
 * (after module loaders, setups, and the action dispatcher are composed), and no reference in the legacy code either,
 * which also counts statements the conversion could not convert (legacyUnreferencedFunctions). What such a function
 * cannot convert becomes a note, so it does not block the script.
 */
export function uncalledDiagnostics(
  program: MigrationProgram,
  legacyUnreferenced: ReadonlySet<string>,
): MigrationDiagnostic[] {
  const functions = program.statements.filter(
    (statement): statement is Extract<IrStatement, { kind: "function" }> =>
      statement.kind === "function",
  );
  if (!functions.some((statement) => statement.ownDiagnostics !== undefined)) return [];
  const references = (value: unknown, names: Map<string, number>): void => {
    if (Array.isArray(value)) {
      for (const item of value) references(item, names);
      return;
    }
    if (!isRecord(value)) return;
    const name =
      value.kind === "call" || value.kind === "variable"
        ? value.name
        : value.kind === "literal" && value.action === true
          ? value.value
          : null;
    if (typeof name === "string") names.set(name, (names.get(name) ?? 0) + 1);
    for (const [key, child] of Object.entries(value))
      if (key !== "ownDiagnostics") references(child, names);
  };
  const all = new Map<string, number>();
  references(program.statements, all);
  const uncalled = new Set<MigrationDiagnostic>();
  for (const statement of functions) {
    if (statement.ownDiagnostics === undefined || !legacyUnreferenced.has(statement.name)) continue;
    const own = new Map<string, number>();
    references(statement.body, own);
    // References inside the function itself do not call it.
    if ((all.get(statement.name) ?? 0) > (own.get(statement.name) ?? 0)) continue;
    for (const diagnostic of statement.ownDiagnostics) uncalled.add(diagnostic);
  }
  // Each names the file it belongs to, so a module's diagnostic never matches another file's.
  return [...uncalled]
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => ({
      ...diagnostic,
      sourceName: diagnostic.sourceName ?? program.sourceName,
    }));
}

/** A program whose `uncalled` diagnostics (uncalledDiagnostics) are notes, also in its rendered comments. */
export function withUncalledNotes(
  program: MigrationProgram,
  uncalled: readonly MigrationDiagnostic[],
): MigrationProgram {
  if (uncalled.length === 0) return program;
  const suffix = " Nothing in the program references this function, so Groovy never ran this code.";
  // A diagnostic without a file is the program's own.
  const key = (diagnostic: MigrationDiagnostic): string =>
    `${diagnostic.sourceName ?? program.sourceName}|${diagnostic.code}|${diagnostic.message}|${JSON.stringify(diagnostic.span)}`;
  const keys = new Set(uncalled.map(key));
  const todoText = (item: MigrationDiagnostic, label: string, message: string): string =>
    `// ${label} ${item.code}${item.span === null ? "" : ` line ${item.span.line}`}: ${singleLine(message)}`;
  const rewrite = (statements: IrStatement[], todo: ReadonlyMap<string, string>): IrStatement[] =>
    statements.map((statement): IrStatement => {
      switch (statement.kind) {
        case "comment":
          return { ...statement, text: todo.get(statement.text) ?? statement.text };
        case "function":
          return { ...statement, body: rewrite(statement.body, todo) };
        case "if":
          return {
            ...statement,
            then: rewrite(statement.then, todo),
            else: rewrite(statement.else, todo),
          };
        case "while":
        case "repeat":
        case "for":
          return { ...statement, body: rewrite(statement.body, todo) };
        case "switch":
          return {
            ...statement,
            cases: statement.cases.map((item) => ({ ...item, body: rewrite(item.body, todo) })),
            default: rewrite(statement.default, todo),
          };
        default:
          return statement;
      }
    });
  // Comments change only inside the function whose diagnostics became notes.
  const statements = program.statements.map((statement): IrStatement => {
    if (statement.kind !== "function" || statement.ownDiagnostics === undefined) return statement;
    const own = statement.ownDiagnostics.filter((diagnostic) => keys.has(key(diagnostic)));
    if (own.length === 0) return statement;
    const todo = new Map(
      own.map((item) => [
        todoText(item, "TODO", item.message),
        todoText(item, "NOTE", item.message + suffix),
      ]),
    );
    return { ...statement, body: rewrite(statement.body, todo) };
  });
  return {
    ...program,
    statements,
    diagnostics: program.diagnostics.map((diagnostic) =>
      keys.has(key(diagnostic))
        ? { ...diagnostic, severity: "warning", message: diagnostic.message + suffix }
        : diagnostic,
    ),
  };
}

/** Bindings declared with the Groovy type String. */
function textVariables(body: AstNode, keys: BindingKeys): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const left = node.kind === "declaration" ? asNode(node.left) : null;
    const key = bindingKey(left, keys);
    if (key !== null && TEXT_TYPES.has(text(left?.originType) ?? "")) names.add(key);
  });
  return names;
}

const TEXT_TYPES = new Set(["String", "java.lang.String"]);

/**
 * A value stored in a Groovy String variable, which Groovy converted to its text: interpolated, and through a helper
 * that keeps null where the value may be null. Text, and a value of unknown type, stay as they are.
 */
function asStoredText(value: IrExpression, node: AstNode, context: LowerContext): IrExpression {
  if (value.kind === "literal")
    return typeof value.value === "number" || typeof value.value === "boolean"
      ? { kind: "literal", value: String(value.value) }
      : value;
  // A value of unknown type, such as a call's result, is taken to be the text that the declaration names.
  const type = inferType(node, context.types);
  if (type === UNKNOWN || onlyOf(type, STRING | NULL)) return value;
  return (type & NULL) === 0 ? templateOrLiteral([{ value }]) : useHelper(context, "text", [value]);
}

/** Bindings declared with a Groovy integer type. */
function integerVariables(body: AstNode, keys: BindingKeys): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const left = node.kind === "declaration" ? asNode(node.left) : null;
    const key = bindingKey(left, keys);
    if (key !== null && INTEGER_TYPES.has(text(left?.originType) ?? "")) names.add(key);
  });
  return names;
}

/** Variables assigned a Java array of whole numbers, `new Integer[n]` or `new int[n]`. */
function integerArrays(body: AstNode, keys: BindingKeys): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    const value = assigns ? asNode(node.right) : null;
    const key = assigns ? bindingKey(asNode(node.left), keys) : null;
    const element = (text(value?.elementType) ?? "").replace(/^java\.lang\./u, "");
    if (key !== null && value?.kind === "array" && INTEGER_TYPES.has(element)) names.add(key);
  });
  return names;
}

/** The initializer of each variable assigned once, by its declaration. */
function declarationInitializers(body: AstNode, types: TypeEnvironment): Map<string, AstNode> {
  const initializers = new Map<string, AstNode>();
  walkAst(body, (node) => {
    const name = node.kind === "declaration" ? variableName(node.left) : null;
    const value = asNode(node.right);
    if (name !== null && value !== null && types.singleAssignment?.has(name) === true)
      initializers.set(name, value);
  });
  return initializers;
}

function currentDateVariables(body: AstNode, types: TypeEnvironment): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const name = node.kind === "declaration" ? variableName(node.left) : null;
    const value = asNode(node.right);
    if (
      name !== null &&
      value !== null &&
      isCurrentDate(value) &&
      types.singleAssignment?.has(name)
    ) {
      names.add(name);
    }
  });
  return names;
}

function isCurrentDateConstructor(node: AstNode): boolean {
  const args = asNode(node.arguments);
  return (
    node.kind === "constructorCall" &&
    (node.type === "java.util.Date" || node.type === "Date") &&
    (args === null || nodeArray(args.items).length === 0)
  );
}

/**
 * Java date pattern formatting of the current moment (#532): the fixed machine format `yyyy-MM-dd` is a date's
 * `toISO()`; a display pattern of a whole date, time, or both becomes `formatDate()`, `formatTime()`, or
 * `formatDateTime()`, which show the player's local form instead of the legacy pattern, with a note; a pattern of number
 * fields that is no whole date or time is written from the fields (datePatternFields). Other patterns (weekday and
 * month names, time zones) and dates built from Unix time are reported.
 */
function dateFormat(
  node: AstNode,
  targetNode: AstNode,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null {
  // Java `new SimpleDateFormat(pattern).format(new Date())` formats the current moment like Groovy's
  // `new Date().format(pattern)`.
  const javaFormat =
    targetNode.kind === "constructorCall" &&
    /(?:^|\.)SimpleDateFormat$/u.test(text(targetNode.type) ?? "") &&
    argumentsNodes.length === 1 &&
    isCurrentDateConstructor(argumentsNodes[0]!)
      ? nodeArray(asNode(targetNode.arguments)?.items)
      : null;
  if (javaFormat !== null && javaFormat.length === 1)
    return dateFormat(node, argumentsNodes[0]!, javaFormat, context);
  const pattern = argumentsNodes.length === 1 ? constantString(argumentsNodes[0]) : null;
  const fromNumber = unixDate(targetNode, context);
  if (fromNumber !== null && pattern !== null) {
    const kind = datePatternKind(pattern);
    if (fromNumber !== undefined && kind !== null && kind !== "isoDate") {
      addDiagnostic(
        context,
        "SX_DATE_FROM_SECONDS",
        "warning",
        `Workaround: TeaseScript builds no absoluteDateTime from a Unix number (#532), so the moment is the current absoluteDateTime minus the seconds since then; Java's pattern ${JSON.stringify(pattern)} becomes the player's local ${kind === "dateTime" ? "date and time" : kind} form.`,
        node.span,
      );
      return {
        kind: "methodCall",
        target: fromNumber,
        name: `format${kind === "date" ? "Date" : kind === "time" ? "Time" : "DateTime"}`,
        arguments: [],
      };
    }
  }
  if (!isCurrentDateConstructor(targetNode)) {
    return unsupportedExpression(
      context,
      node,
      "SX_DATE_FORMAT",
      `This Java date is built from its arguments, such as a Unix time in milliseconds; TeaseScript builds no absoluteDateTime or date from a number (#532). Store and load the absoluteDateTime or datetime itself, then format it.`,
    );
  }
  const kind = pattern === null ? null : datePatternKind(pattern);
  const fields = pattern === null || kind !== null ? null : datePatternFields(pattern);
  if (fields !== null) return fields;
  if (kind === null) {
    return unsupportedExpression(
      context,
      node,
      "SX_DATE_FORMAT",
      "This Java date pattern is neither the ISO date yyyy-MM-dd (toISO()) nor a whole date or time that formatDate(), formatTime(), or formatDateTime() can show (#532); build the text from the date fields.",
    );
  }
  const getter =
    kind === "isoDate" || kind === "date" ? "getDate" : kind === "time" ? "getTime" : "getDateTime";
  const method =
    kind === "isoDate"
      ? "toISO"
      : `format${kind === "date" ? "Date" : kind === "time" ? "Time" : "DateTime"}`;
  if (kind !== "isoDate") {
    addDiagnostic(
      context,
      "SX_DATE_FORMAT",
      "warning",
      `Java formatted the current ${kind === "dateTime" ? "date and time" : kind} with the pattern ${JSON.stringify(pattern)}; ${method}() shows the player's local form instead (#532).`,
      node.span,
    );
  }
  return {
    kind: "methodCall",
    target: { kind: "call", name: getter, positional: [], named: {} },
    name: method,
    arguments: [],
  };
}

/**
 * `new Date(milliseconds)` as an absoluteDateTime: the current one minus the exact seconds since that moment, since
 * TeaseScript builds no absoluteDateTime from a number (#532). Null for another receiver, undefined after a diagnostic.
 */
function unixDate(node: AstNode, context: LowerContext): IrExpression | null | undefined {
  const args = nodeArray(asNode(node.arguments)?.items);
  if (
    node.kind !== "constructorCall" ||
    !/(?:^|\.)Date$/u.test(text(node.type) ?? "") ||
    args.length !== 1
  )
    return null;
  // `(long) seconds * 1000`, the usual form, gives the seconds themselves.
  let millis = args[0]!;
  while (millis.kind === "cast" && asNode(millis.expression) !== null)
    millis = asNode(millis.expression)!;
  const right = asNode(millis.right);
  let secondsNode: AstNode | null = null;
  if (
    millis.kind === "binary" &&
    millis.operator === "*" &&
    constantValue(right ?? undefined) === 1000
  ) {
    secondsNode = asNode(millis.left);
    while (secondsNode?.kind === "cast" && asNode(secondsNode.expression) !== null)
      secondsNode = asNode(secondsNode.expression);
  }
  const value = lowerExpression(secondsNode ?? millis, context);
  if (value === null) return undefined;
  const seconds: IrExpression =
    secondsNode !== null
      ? value
      : { kind: "binary", operator: "/", left: value, right: { kind: "literal", value: 1000 } };
  const now: IrExpression = {
    kind: "call",
    name: "getAbsoluteDateTime",
    positional: [],
    named: {},
  };
  return {
    kind: "binary",
    operator: "-",
    left: now,
    right: {
      kind: "binary",
      operator: "*",
      left: {
        kind: "binary",
        operator: "-",
        left: { kind: "methodCall", target: now, name: "toSeconds", arguments: [] },
        right: seconds,
      },
      right: { kind: "duration", value: 1, unit: "s" },
    },
  };
}

/** What a Java SimpleDateFormat pattern shows: the ISO date, a whole date, a time, both, or null for anything else. */
function datePatternKind(pattern: string): "isoDate" | "date" | "time" | "dateTime" | null {
  if (pattern === "yyyy-MM-dd") return "isoDate";
  // Quoted text is literal; every other letter is a pattern field.
  const fields = pattern.replace(/'[^']*'/gu, "").replace(/[^A-Za-z]/gu, "");
  if (/[^yMdHhkKmsSa]/u.test(fields)) return null;
  const date = /y/u.test(fields) && /M/u.test(fields) && /d/u.test(fields);
  const time = /[HhkK]/u.test(fields) && /m/u.test(fields);
  if (date && time) return "dateTime";
  if (date && !/[HhkKmsSa]/u.test(fields)) return "date";
  if (time && !/[yMd]/u.test(fields)) return "time";
  return null;
}

/** The current date and time's fields that Java's pattern letters write as numbers. */
const NUMBER_PATTERN_FIELDS = new Map([
  ["y", "year"],
  ["M", "month"],
  ["d", "day"],
  ["H", "hour"],
  ["m", "minute"],
  ["s", "second"],
]);

/**
 * A Java pattern of number fields that is no whole date or time, such as jewell's `dd/MM` or `HH`, as the current
 * date and time's fields written the same way, padded to the letters' count: exact, since Java writes numbers the
 * same in every locale. Null for a pattern with another letter, such as a month or weekday name.
 */
function datePatternFields(pattern: string): IrExpression | null {
  const now: IrExpression = { kind: "call", name: "getDateTime", positional: [], named: {} };
  const parts: Array<{ text: string } | { value: IrExpression }> = [];
  for (const [token, letter] of pattern.matchAll(/'(?:[^']|'')*'|([A-Za-z])\1*|[^A-Za-z']+/gu)) {
    if (letter === undefined) {
      parts.push({
        text: token.startsWith("'") ? token.slice(1, -1).replaceAll("''", "'") || "'" : token,
      });
      continue;
    }
    const field = NUMBER_PATTERN_FIELDS.get(letter);
    if (field === undefined || (letter === "M" && token.length > 2)) return null;
    const value: IrExpression = { kind: "property", target: now, name: field };
    // `yy` writes the year's last two digits.
    const shown: IrExpression =
      letter === "y" && token.length === 2
        ? { kind: "binary", operator: "%", left: value, right: { kind: "literal", value: 100 } }
        : value;
    parts.push({
      value:
        token.length === 1
          ? shown
          : {
              kind: "methodCall",
              target: { kind: "call", name: "toString", positional: [shown], named: {} },
              name: "padStart",
              arguments: [
                { kind: "literal", value: token.length },
                { kind: "literal", value: "0" },
              ],
            },
    });
  }
  return { kind: "template", parts };
}

/** `Calendar.getInstance().get(Calendar.FIELD)` reads one field of the current local date and time. */
function calendarGetField(target: AstNode | null, args: AstNode[]): string | null {
  const instance = target === null ? null : callParts(target);
  // Only the default instance: an explicit time zone or locale has no datetime-property equivalent.
  if (
    instance === null ||
    instance.name !== "getInstance" ||
    instance.arguments.length !== 0 ||
    variableName(target?.object) !== "Calendar"
  ) {
    return null;
  }
  return args.length === 1 ? calendarConstant(args[0]!) : null;
}

function calendarConstant(node: AstNode): string | null {
  if (node.kind !== "property" || variableName(node.object) !== "Calendar") return null;
  return constantString(node.property);
}

/**
 * Maps a java.util.Calendar field to the accepted TeaseScript datetime properties. Java months count from 0 and
 * Java weekdays run Sunday=1..Saturday=7, while TeaseScript uses months 1..12 and ISO Monday=1..Sunday=7.
 */
function dateTimeField(
  field: string,
  dateTime: IrExpression,
  node: AstNode,
  context: LowerContext,
): IrExpression | null {
  const property = (name: string): IrExpression => ({ kind: "property", target: dateTime, name });
  const literal = (value: number): IrExpression => ({ kind: "literal", value });
  switch (field) {
    case "YEAR":
      return property("year");
    case "MONTH":
      return { kind: "binary", operator: "-", left: property("month"), right: literal(1) };
    case "DATE":
    case "DAY_OF_MONTH":
      return property("day");
    case "HOUR_OF_DAY":
      return property("hour");
    case "MINUTE":
      return property("minute");
    case "DAY_OF_WEEK":
      return {
        kind: "binary",
        operator: "+",
        left: { kind: "binary", operator: "%", left: property("weekdayNumber"), right: literal(7) },
        right: literal(1),
      };
    case "DAY_OF_YEAR": {
      // Whole calendar days since January 1st, counted from one (#532: `date - date` and `.days`).
      const date: IrExpression =
        dateTime.kind === "call"
          ? { kind: "call", name: "getDate", positional: [], named: {} }
          : { kind: "call", name: "toDate", positional: [dateTime], named: {} };
      const newYear: IrExpression = {
        kind: "call",
        name: "toDate",
        positional: [
          {
            kind: "template",
            parts: [
              { value: { kind: "property", target: date, name: "year" } },
              { text: "-01-01" },
            ],
          },
        ],
        named: {},
      };
      return {
        kind: "binary",
        operator: "+",
        left: {
          kind: "property",
          target: { kind: "binary", operator: "-", left: date, right: newYear },
          name: "days",
        },
        right: literal(1),
      };
    }
    default:
      return unsupportedExpression(
        context,
        node,
        "SX_CALENDAR_FIELD",
        `java.util.Calendar field ${field} has no direct TeaseScript datetime property.`,
      );
  }
}

/** A name Groovy read through a SexScript getter of the script object, such as `dataFolder` for getDataFolder(). */
function isLegacyGetterProperty(name: string): boolean {
  const property = capitalized(name);
  return SEXSCRIPT_API_METHODS.has(`get${property}`) || SEXSCRIPT_API_METHODS.has(`is${property}`);
}

/** A reference to a closure function without calling it (and not to a same-named local variable). */
function isUncalledClosure(node: AstNode, context: LowerContext): boolean {
  const name = variableName(node);
  return name !== null && context.functions.has(name) && !context.shadowingReferences.has(node);
}

/**
 * Finds variable references that resolve to a block-local `def` variable sharing its name with a closure function,
 * following Groovy's lexical block and closure scopes.
 */
function collectShadowingReferences(
  body: AstNode,
  functions: ReadonlyMap<string, unknown>,
): Set<AstNode> {
  const references = new Set<AstNode>();
  const visit = (value: unknown, scopes: Set<string>[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, scopes);
      return;
    }
    if (!isAstNode(value)) return;
    const node = value;
    if (node.kind === "block" || node.kind === "closure" || node.kind === "for") {
      const scope = new Set<string>();
      if (node.kind === "closure") {
        for (const parameter of groovyParameters(node.parameters) ?? []) scope.add(parameter.name);
      }
      if (node.kind === "for" && typeof node.variable === "string") scope.add(node.variable);
      const inner = [...scopes, scope];
      const children = node.kind === "block" ? nodeArray(node.statements) : nodeChildren(node);
      for (const child of children) visit(child, inner);
      return;
    }
    if (node.kind === "declaration") {
      const name = variableName(node.left);
      const right = asNode(node.right);
      if (right !== null) visit(right, scopes);
      if (name !== null && functions.has(name) && right?.kind !== "closure")
        scopes.at(-1)?.add(name);
      return;
    }
    if (node.kind === "variable") {
      const name = variableName(node);
      if (name !== null && functions.has(name) && scopes.some((scope) => scope.has(name))) {
        references.add(node);
      }
      return;
    }
    for (const child of nodeChildren(node)) visit(child, scopes);
  };
  visit(body, []);
  return references;
}

function isKnownListExpression(node: AstNode, context: LowerContext): boolean {
  const type = inferType(node, context.types);
  return onlyOf(type, LIST | NULL) && (type & LIST) !== 0;
}

function isKnownMapExpression(node: AstNode, context: LowerContext): boolean {
  const type = inferType(node, context.types);
  return onlyOf(type, OBJECT | NULL) && (type & OBJECT) !== 0;
}

/**
 * The paths of the `new File(path)` values a listing receiver stands for: the constructor itself, or the values of a
 * variable that only holds such files (fileTests); null when every path is not inside the package's images folder.
 */
function imageFolderPaths(receiver: AstNode, context: LowerContext): AstNode[] | null {
  const variable = variableName(receiver);
  const constructors = isFileConstructor(receiver)
    ? [receiver]
    : variable !== null && context.fileVariables.has(variable)
      ? [...context.filePathOwners].flatMap(([value, owner]) => (owner === variable ? [value] : []))
      : [];
  const paths = constructors.flatMap((value) =>
    nodeArray(asNode(value.arguments)?.items).slice(0, 1),
  );
  return paths.length > 0 &&
    paths.length === constructors.length &&
    paths.every((path) =>
      /^\/?images\//iu.test(resolvedPath(path, context) ?? staticPath(path).text),
    )
    ? paths
    : null;
}

/** Whether a value is an images folder listing (imageFolderListing), or a variable that only holds one. */
function holdsImageListing(node: AstNode, context: LowerContext): boolean {
  const isListing = (value: AstNode): boolean => {
    const receiver = asNode(value.object);
    return (
      value.kind === "methodCall" &&
      constantString(value.method) === "listFiles" &&
      nodeArray(asNode(value.arguments)?.items).length === 0 &&
      receiver !== null &&
      imageFolderPaths(receiver, context) !== null
    );
  };
  if (context.media === null) return false;
  if (isListing(node)) return true;
  const key = node.kind === "variable" ? bindingKey(node, context.bindings) : null;
  const values = key === null ? undefined : context.assignedValues.get(key);
  return values !== undefined && values.length > 0 && values.every(isListing);
}

/**
 * A legacy listing of an images folder, `new File(folder).listFiles()` or the listing of a variable that only holds
 * such a file, as the package paths of the folder's images (#572): each package image carries a generated tag for its
 * full legacy folder path (image-tags.ts), so the images with the folder's tag are exactly its images; a computed
 * folder gets its tag from the pathTag helper at runtime. The legacy listing also held subfolders and other files, and
 * was null for a missing folder; the images are an empty list then. Undefined for a folder outside `images/`.
 */
function imageFolderListing(
  receiver: AstNode,
  node: AstNode,
  context: LowerContext,
): IrExpression | null | undefined {
  const paths = imageFolderPaths(receiver, context);
  if (paths === null) return undefined;
  const fixed = isFileConstructor(receiver) ? resolvedPath(paths[0]!, context) : null;
  let tag: IrExpression;
  if (fixed !== null) tag = { kind: "literal", value: pathTag(fixed) };
  else {
    // A variable holds the path itself (fileTests).
    const path = lowerExpression(isFileConstructor(receiver) ? paths[0]! : receiver, context);
    if (path === null) return null;
    tag =
      path.kind === "literal" && typeof path.value === "string"
        ? { kind: "literal", value: pathTag(path.value) }
        : useHelper(context, "pathTag", [path]);
  }
  addDiagnostic(
    context,
    "SX_IMAGE_TAGS",
    "warning",
    "The legacy script listed the files of an images folder; each package image carries a generated tag for its folder, so this lists the package paths of the folder's images by that tag, without subfolders and other files, and an empty list for a missing folder.",
    node.span,
  );
  return {
    kind: "call",
    name: "findImages",
    positional: [],
    named: { all: { kind: "list", items: [tag] } },
  };
}

/**
 * A legacy count of the images in a package folder, `new File("images/...").listFiles()` with an optional
 * `.findAll { it.name ==~ /pattern/ }` before `.size()`: the folders below `images/` as lowered text and value parts,
 * and the name filter. Returns null when a part cannot be lowered and undefined for other shapes.
 */
function imageListing(
  node: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
):
  | {
      segments: Array<Array<{ text: string } | { value: IrExpression }>>;
      nameFilter: AstNode | null;
    }
  | null
  | undefined {
  if (name !== "size" || argumentsNodes.length !== 0) return undefined;
  let receiver = asNode(node.object);
  const filter = receiver === null ? null : callParts(receiver);
  let nameFilter: AstNode | null = null;
  if (receiver !== null && filter?.name === "findAll" && !filter.inherited) {
    const closure = filter.arguments.length === 1 ? closureExpression(filter.arguments[0]!) : null;
    const test = closure === null ? null : closure.expression;
    const tested = test === null ? null : asNode(test.left);
    if (
      test === null ||
      test.kind !== "binary" ||
      (test.operator !== "==~" && test.operator !== "=~") ||
      tested?.kind !== "property" ||
      constantString(tested.property) !== "name" ||
      variableName(tested.object) !== closure!.parameter ||
      !isPure(test, context)
    ) {
      return undefined;
    }
    nameFilter = test;
    receiver = asNode(receiver.object);
  }
  const listing = receiver === null ? null : callParts(receiver);
  if (receiver === null || listing?.name !== "listFiles" || listing.inherited) return undefined;
  if (listing.arguments.length !== 0) return undefined;
  const file = asNode(receiver.object);
  if (file?.kind !== "constructorCall" || (file.type !== "File" && file.type !== "java.io.File")) {
    return undefined;
  }
  const pathArguments = nodeArray(asNode(file.arguments)?.items);
  if (pathArguments.length !== 1) return undefined;
  const pathSegments = imagePathSegments(pathArguments[0]!);
  if (pathSegments === null || pathSegments.length === 0) return undefined;
  const segments: Array<Array<{ text: string } | { value: IrExpression }>> = [];
  for (const segment of pathSegments) {
    const parts: Array<{ text: string } | { value: IrExpression }> = [];
    for (const part of segment) {
      if ("text" in part) {
        parts.push(part);
        continue;
      }
      const value = lowerExpression(part.node, context);
      if (value === null) return null;
      parts.push({ value });
    }
    segments.push(parts);
  }
  return { segments, nameFilter };
}

/**
 * A legacy image count (imageListing) as a tag query (#572): the converted package gives each image one tag for its
 * full legacy folder path in a generated sidecar (image-tags.ts), so the images tagged with the listed folder's tag are
 * exactly its images. A computed folder gets its tag from the pathTag helper at runtime. The legacy listing also counted
 * subfolders and other files; the query counts images only. A name filter keeps the conversion-time count.
 */
function imageCount(
  node: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
  media: readonly MediaFile[],
): IrExpression | null | undefined {
  const listing = imageListing(node, name, argumentsNodes, context);
  if (listing === null || listing === undefined) return listing;
  if (listing.nameFilter !== null) return conversionTimeImageCount(listing, node, context, media);
  const folder = templateOrLiteral(
    [[{ text: "images" }], ...listing.segments].flatMap((parts, index) =>
      index === 0 ? parts : [{ text: "/" }, ...parts],
    ),
  );
  const tag =
    folder.kind === "literal" && typeof folder.value === "string"
      ? { kind: "literal" as const, value: pathTag(folder.value) }
      : useHelper(context, "pathTag", [folder]);
  addDiagnostic(
    context,
    "SX_IMAGE_TAGS",
    "warning",
    "The legacy script counted the files of an images folder; each package image carries a generated tag for its folder, so this counts the folder's images by that tag, without subfolders and other files.",
    node.span,
  );
  return {
    kind: "property",
    target: {
      kind: "call",
      name: "findImages",
      positional: [],
      named: { all: { kind: "list", items: [tag] } },
    },
    name: "length",
  };
}

/**
 * A legacy image count (imageListing) with a name filter as the number of the package's images whose names match,
 * counted when it is converted, since tags do not filter by file name: a number for a fixed folder, and for a folder
 * that depends on values, a dict of the matching folders' counts read with the folder's lower-case path. The pattern
 * is literal text, or interpolates variables of the folder's path (folderNamePattern).
 */
function conversionTimeImageCount(
  listing: NonNullable<ReturnType<typeof imageListing>>,
  node: AstNode,
  context: LowerContext,
  media: readonly MediaFile[],
): IrExpression | undefined {
  const filter = listing.nameFilter === null ? null : asNode(listing.nameFilter.right);
  const fixedPattern = namePattern(filter);
  const folderValues = listing.segments.flatMap((parts) =>
    parts.flatMap((part) => ("value" in part ? [part.value] : [])),
  );
  const patternOf =
    fixedPattern !== null ? () => fixedPattern : folderNamePattern(filter, folderValues);
  if (listing.nameFilter !== null && patternOf === null) return undefined;
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const folderPattern = new RegExp(
    `^${listing.segments
      .map((parts) =>
        parts.map((part) => ("text" in part ? escape(part.text) : "([^/]*)")).join(""),
      )
      .join("/")}$`,
    "iu",
  );
  const counts = new Map<string, number>();
  for (const file of media) {
    const slash = file.path.replaceAll("\\", "/").lastIndexOf("/");
    const folder = slash < 0 ? "" : file.path.replaceAll("\\", "/").slice(0, slash);
    const fileName = file.path.replaceAll("\\", "/").slice(slash + 1);
    const match = folderPattern.exec(folder);
    if (match === null) continue;
    const pattern = patternOf === null ? null : patternOf(match.slice(1));
    const key = folder.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + (pattern === null || pattern.test(fileName) ? 1 : 0));
  }
  addDiagnostic(
    context,
    "SX_IMAGE_COUNT_WORKAROUND",
    "warning",
    "Workaround for counting the package images whose names match a pattern, which tags cannot express: the matching images of each folder were counted at conversion time, so images added to the package later are not counted, and only image files count.",
    node.span,
  );
  const fixed = listing.segments.every((parts) => parts.every((part) => "text" in part));
  if (fixed) {
    const folder = listing.segments
      .map((parts) => parts.map((part) => ("text" in part ? part.text : "")).join(""))
      .join("/")
      .toLowerCase();
    return { kind: "literal", value: counts.get(folder) ?? 0 };
  }
  const path = templateOrLiteral(
    listing.segments.flatMap((parts, index) => (index === 0 ? parts : [{ text: "/" }, ...parts])),
  );
  return {
    kind: "methodCall",
    target: {
      kind: "object",
      dict: true,
      properties: [...counts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([folder, count]) => ({
          name: folder,
          key: { kind: "literal", value: folder },
          value: { kind: "literal", value: count },
        })),
    },
    name: "get",
    arguments: [
      { kind: "methodCall", target: path, name: "lowercase", arguments: [] },
      { kind: "literal", value: 0 },
    ],
    dict: true,
  };
}

/** A Groovy name pattern whose regular expression is literal text, as a whole-name JavaScript pattern. */
function namePattern(node: AstNode | null): RegExp | null {
  const source = node === null ? null : constantString(node);
  if (source === null) return null;
  const insensitive = source.startsWith("(?i)");
  try {
    return new RegExp(`^(?:${insensitive ? source.slice(4) : source})$`, insensitive ? "iu" : "u");
  } catch {
    return null;
  }
}

/**
 * A Groovy name pattern that interpolates variables of the counted folder's path, as fapioh's `/$cardDeck-(\d+).jpg/`
 * for `sprintf("images/fapioh/cards/%s/", [cardDeck])`: given the text each value of the path has in one folder, the
 * pattern with that text in place of the variable, which Groovy inserted into the expression as it was. Null for
 * other patterns.
 */
function folderNamePattern(
  node: AstNode | null,
  folderValues: readonly IrExpression[],
): ((folderTexts: readonly string[]) => RegExp | null) | null {
  if (node?.kind !== "gstring") return null;
  const parts: unknown[] = Array.isArray(node.strings) ? node.strings : [];
  const strings = parts.filter((part): part is string => typeof part === "string");
  const positions = nodeArray(node.values).map((value) => {
    const name = variableName(value);
    return folderValues.findIndex((part) => part.kind === "variable" && part.name === name);
  });
  if (positions.length === 0 || positions.includes(-1) || strings.length !== parts.length)
    return null;
  return (folderTexts) => {
    const source = strings
      .map((part, index) =>
        index < positions.length ? `${part}${folderTexts[positions[index]!] ?? ""}` : part,
      )
      .join("");
    const insensitive = source.startsWith("(?i)");
    try {
      return new RegExp(
        `^(?:${insensitive ? source.slice(4) : source})$`,
        insensitive ? "iu" : "u",
      );
    } catch {
      // Groovy failed on a pattern that is no regular expression; no name matches it here.
      return /(?!)/u;
    }
  };
}

/**
 * The folders below `images/` in a literal, interpolated, or `sprintf("...%s...", [values])` path, each as text and
 * value parts; null when the path is not inside the package's images folder or has another shape.
 */
function imagePathSegments(
  node: AstNode,
): Array<Array<{ text: string } | { node: AstNode }>> | null {
  const parts: Array<{ text: string } | { node: AstNode }> = [];
  if (node.kind === "constant" && typeof node.value === "string") {
    parts.push({ text: node.value });
  } else if (node.kind === "gstring") {
    const strings = Array.isArray(node.strings) ? node.strings : [];
    const values = nodeArray(node.values);
    for (let index = 0; index < Math.max(strings.length, values.length); index += 1) {
      const text: unknown = strings[index];
      if (typeof text === "string" && text !== "") parts.push({ text });
      if (values[index] !== undefined) parts.push({ node: values[index]! });
    }
  } else {
    const call = callParts(node);
    const format = call?.arguments[0];
    const values = call?.arguments[1];
    if (
      call?.name !== "sprintf" ||
      !call.inherited ||
      call.arguments.length !== 2 ||
      format?.kind !== "constant" ||
      typeof format.value !== "string" ||
      values?.kind !== "list"
    ) {
      return null;
    }
    const items = nodeArray(values.items);
    const pieces = format.value.split(/%[sd]/u);
    if (
      pieces.length !== items.length + 1 ||
      format.value.replaceAll(/%[sd]/gu, "").includes("%")
    ) {
      return null;
    }
    pieces.forEach((piece, index) => {
      if (piece !== "") parts.push({ text: piece });
      if (index < items.length) parts.push({ node: items[index]! });
    });
  }
  const segments: Array<Array<{ text: string } | { node: AstNode }>> = [[]];
  for (const part of parts) {
    if (!("text" in part)) {
      segments.at(-1)!.push(part);
      continue;
    }
    const pieces = part.text.split("/");
    pieces.forEach((piece, index) => {
      if (index > 0) segments.push([]);
      if (piece !== "") segments.at(-1)!.push({ text: piece });
    });
  }
  const folders = segments.filter((segment) => segment.length > 0);
  const first = folders[0];
  if (first?.length !== 1 || !("text" in first[0]!) || first[0].text !== "images") return null;
  return folders.slice(1);
}

function noteSharedMapWrite(span: SourceSpan | null, context: LowerContext): void {
  addDiagnostic(
    context,
    "SX_SHARED_MAP_WRITE",
    "warning",
    "Groovy maps are shared by reference; if this map came from a list, a parameter, or another variable, the TeaseScript write changes only this copy (ADR 0014).",
    span,
  );
}

/**
 * Groovy map methods on a dict (#536) used as values: `contains(key)`, `keys`, `values`, `length`, and `[key]` for
 * `get`. Statements that change the dict (`put`, `remove`, `clear`, `each`) are lowered by dictStatement. Returns
 * undefined for other methods.
 */
function dictOperation(
  node: AstNode,
  targetNode: AstNode,
  name: string,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null | undefined {
  const target = (): IrExpression | null => lowerExpression(targetNode, context);
  const property = (member: string): IrExpression | null => {
    const lowered = target();
    return lowered === null
      ? null
      : { kind: "property", target: lowered, name: member, dict: true };
  };
  switch (name) {
    case "containsKey": {
      if (argumentsNodes.length !== 1) return undefined;
      const lowered = target();
      const key = dictKey(argumentsNodes[0]!, node, context, dictKeyTypes(targetNode, context));
      return lowered === null || key === null
        ? null
        : { kind: "methodCall", target: lowered, name: "contains", arguments: [key], dict: true };
    }
    case "keySet":
      return argumentsNodes.length === 0 ? property("keys") : undefined;
    case "values":
      return argumentsNodes.length === 0 ? property("values") : undefined;
    case "size":
      return argumentsNodes.length === 0 ? property("length") : undefined;
    case "isEmpty": {
      if (argumentsNodes.length !== 0) return undefined;
      const length = property("length");
      return length === null
        ? null
        : { kind: "binary", operator: "==", left: length, right: { kind: "literal", value: 0 } };
    }
    case "get": {
      if (argumentsNodes.length !== 1) return undefined;
      const lowered = target();
      const key = dictKey(argumentsNodes[0]!, node, context, dictKeyTypes(targetNode, context));
      if (lowered === null || key === null) return null;
      noteMissingKey(node, { receiver: targetNode, key: argumentsNodes[0]!, name: null }, context);
      return { kind: "index", target: lowered, index: key, dict: true };
    }
    default:
      return undefined;
  }
}

/**
 * Groovy map statements on a dict (#536): `put` writes `map[key]`, `remove` of a key that may be missing is guarded
 * (Groovy ignored a missing key, a dict reports it), `clear()` empties it, and `each { key, value -> }` loops over the
 * keys as they were when the loop started. Returns null for other statements.
 */
function dictStatement(
  receiver: AstNode,
  call: { name: string; arguments: AstNode[] },
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | null {
  const dict = lowerExpression(receiver, context);
  if (dict === null) return null;
  const node = context.statementRoot ?? receiver;
  switch (call.name) {
    case "put": {
      if (call.arguments.length !== 2) return null;
      const key = dictKey(call.arguments[0]!, node, context, dictKeyTypes(receiver, context));
      const value = lowerExpression(call.arguments[1]!, context);
      if (key === null || value === null) return null;
      noteSharedMapWrite(span, context);
      return [
        {
          kind: "assign",
          target: { kind: "index", target: dict, index: key, dict: true },
          operator: "=",
          value,
          span,
        },
      ];
    }
    case "remove": {
      if (call.arguments.length !== 1 || !isRepeatableExpression(call.arguments[0]!)) return null;
      const key = dictKey(call.arguments[0]!, node, context, dictKeyTypes(receiver, context));
      if (key === null) return null;
      noteSharedMapWrite(span, context);
      const remove: IrStatement = {
        kind: "expression",
        expression: {
          kind: "methodCall",
          target: dict,
          name: "remove",
          arguments: [key],
          dict: true,
        },
        span,
      };
      return [
        {
          kind: "if",
          condition: {
            kind: "methodCall",
            target: dict,
            name: "contains",
            arguments: [key],
            dict: true,
          },
          then: [remove],
          else: [],
          span,
        },
      ];
    }
    case "clear":
      if (call.arguments.length !== 0) return null;
      noteSharedMapWrite(span, context);
      return [
        {
          kind: "expression",
          expression: {
            kind: "methodCall",
            target: dict,
            name: "clear",
            arguments: [],
            dict: true,
          },
          span,
        },
      ];
    case "each": {
      const argument = closureArgument(call.arguments);
      const [key, value] = argument?.parameters ?? [];
      // `map.each { entry -> entry.key, entry.value }` reads each entry as its key and value.
      const entryBody = argument === null ? null : asNode(argument.closure.body);
      const entry = argument?.parameters.length === 1 ? argument.parameters[0]! : null;
      const receiverName = variableName(receiver);
      if (entry !== null && entryBody !== null && receiverName !== null) {
        if (containsReturnForCurrentClosure(entryBody)) return null;
        const valueName = changesMap(entryBody, receiverName)
          ? null
          : entryValueName(entryBody, entry);
        const rewritten = withEntryReads(entryBody, entry, receiver, valueName);
        if (rewritten === null) return null;
        const readsValue =
          valueName !== null && JSON.stringify(rewritten).includes(`"name":"${valueName}"`);
        if (readsValue) context.generatedNames.add(valueName);
        return [
          {
            kind: "for",
            variable: entry,
            ...(readsValue ? { valueVariable: valueName } : {}),
            collection: dict,
            dict: true,
            body: lowerBlock(rewritten, context),
            span,
          },
        ];
      }
      if (
        argument === null ||
        key === undefined ||
        value === undefined ||
        argument.parameters.length !== 2
      )
        return null;
      const closureBody = asNode(argument.closure.body);
      if (closureBody === null || containsReturnForCurrentClosure(closureBody)) return null;
      // Each entry's key and value (#639), taken as each iteration starts, as Groovy passed them to the closure.
      return [
        {
          kind: "for",
          variable: key,
          valueVariable: value,
          collection: dict,
          dict: true,
          body: lowerBlock(closureBody, context),
          span,
        },
      ];
    }
    default:
      return null;
  }
}

/** Whether an expression is a variable that holds a map used as a lookup table (#536). */
function isDictionary(node: AstNode, context: LowerContext): boolean {
  const key = bindingKey(node, context.bindings);
  return (
    key !== null && context.mapUses.dictionaries.has(key) && !context.shadowingReferences.has(node)
  );
}

function lowerMethodCallExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const call = callParts(node);
  if (call === null) {
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_OR_OBJECT_CALL",
      "Dynamic Groovy method names are not lowered by the first slice.",
    );
  }
  if (!call.inherited)
    return lowerObjectMethodCallExpression(node, call.name, call.arguments, context);
  // A parameter or local of the current function shadows a function of the same name; calling it calls the
  // closure value it holds.
  if (context.helperMainParameter === null && isVisibleLocal(call.name, node, context)) {
    const args = lowerArguments(call.arguments, context);
    return args === null ? null : actionCall({ kind: "variable", name: call.name }, args, context);
  }
  const helperInfo = context.helperFunctions.get(call.name);
  if (helperInfo !== undefined) {
    let argumentNodes = call.arguments;
    if (helperInfo.stripsMain) {
      if (
        context.helperMainParameter === null ||
        variableName(argumentNodes[0]) !== context.helperMainParameter
      ) {
        return unsupportedExpression(
          context,
          node,
          "SX_HELPER_MAIN_ARGUMENT",
          `Helper call ${call.name}() does not pass the expected legacy main object.`,
        );
      }
      argumentNodes = argumentNodes.slice(1);
    }
    if (
      argumentNodes.length >= helperInfo.requiredArgs &&
      argumentNodes.length < helperInfo.minArgs
    )
      return defaultOrderCall(context, node);
    if (argumentNodes.length < helperInfo.minArgs || argumentNodes.length > helperInfo.maxArgs) {
      return unsupportedExpression(
        context,
        node,
        "SX_FUNCTION_ARITY",
        `Call to ${call.name} has ${argumentNodes.length} authored arguments; expected ${helperInfo.minArgs}..${helperInfo.maxArgs}.`,
      );
    }
    const args = lowerArguments(argumentNodes, context);
    return args === null
      ? null
      : { kind: "call", name: call.name, positional: args, named: {}, local: true };
  }
  if (
    context.packageFunctions.has(call.name) &&
    !context.functions.has(call.name) &&
    context.helperMainParameter === null
  ) {
    // Defined elsewhere in the package (for example an injected mixin method); arity is checked by the compiler.
    const args = lowerArguments(call.arguments, context);
    return args === null
      ? null
      : { kind: "call", name: call.name, positional: args, named: {}, local: true };
  }
  if (
    !context.functions.has(call.name) &&
    !context.packageFunctions.has(call.name) &&
    context.types.variables.has(call.name) &&
    context.helperMainParameter === null
  ) {
    // Groovy `name(...)` on a variable calls the closure it holds; closure values are action IDs here.
    const args = lowerArguments(call.arguments, context);
    return args === null ? null : actionCall({ kind: "variable", name: call.name }, args, context);
  }
  const functionInfo = callsHostOfOwnName(call.name, call.arguments.length, context)
    ? undefined
    : context.functions.get(call.name);
  // Groovy called a closure of one parameter without an argument with null.
  if (functionInfo !== undefined && call.arguments.length === 0 && functionInfo.minArgs === 1) {
    addDiagnostic(
      context,
      "SX_NULL_ARGUMENT",
      "info",
      `Groovy called ${call.name} without an argument, which gave its one parameter null; the call passes null.`,
      node.span,
    );
    return {
      kind: "call",
      name: call.name,
      positional: [{ kind: "literal", value: null }],
      named: {},
      local: true,
    };
  }
  if (functionInfo !== undefined) {
    if (
      call.arguments.length < functionInfo.minArgs ||
      call.arguments.length > functionInfo.maxArgs
    ) {
      return unsupportedExpression(
        context,
        node,
        "SX_FUNCTION_ARITY",
        `Call to ${call.name} has ${call.arguments.length} arguments; expected ${functionInfo.minArgs}..${functionInfo.maxArgs}.`,
      );
    }
    const args = lowerArguments(call.arguments, context);
    return args === null
      ? null
      : { kind: "call", name: call.name, positional: args, named: {}, local: true };
  }
  if (
    context.helperMainParameter !== null &&
    variableName(node.object) !== context.helperMainParameter
  ) {
    return unsupportedExpression(
      context,
      node,
      "SX_HELPER_UNQUALIFIED_CALL",
      `Unqualified Groovy helper call ${call.name}() is not assumed to be a SexScript host API.`,
    );
  }
  if (DIRECT_STORAGE_LOADS.has(call.name) || ONLINE_LOADS.has(call.name)) {
    if (ONLINE_LOADS.has(call.name))
      addDiagnostic(context, "SX_ONLINE_STORAGE", "warning", ONLINE_STORAGE_NOTE, node.span);
    if (call.arguments.length !== 1) {
      return unsupportedExpression(
        context,
        node,
        "SX_STORAGE_LOAD_ARITY",
        `${call.name}() must have exactly one key argument.`,
      );
    }
    const key = lowerExpression(call.arguments[0]!, context);
    if (key === null) return null;
    if (call.name === "loadInteger" || call.name === "receiveInteger")
      return { kind: "load", key, integer: true };
    if (call.name === "loadFloat") return { kind: "load", key, number: true };
    const shape = storageKeyShape(call.arguments[0]!);
    if (call.name === "loadString" && shape !== null && context.nonTextKeys.has(shape)) {
      addDiagnostic(
        context,
        "SX_LOAD_STRING_TEXT",
        "warning",
        "loadString() read the stored value as text, and the package saves a number or a boolean under this key, so the value is turned into text.",
        node.span,
      );
      return useHelper(context, "text", [{ kind: "load", key }]);
    }
    if (call.name === "loadBoolean" && shape !== null && context.nonBooleanKeys.has(shape)) {
      addDiagnostic(
        context,
        "SX_LOAD_BOOLEAN_TEXT",
        "warning",
        'loadBoolean() read the stored value as text, true only for "true", and the package saves a number or a text under this key, so the value is read the same way; a missing value, null in Groovy, reads as false.',
        node.span,
      );
      return useHelper(context, "booleanText", [{ kind: "load", key }]);
    }
    if (call.name === "loadString" || call.name === "receiveString")
      return { kind: "load", key, read: "string" };
    if (call.name === "loadBoolean" || call.name === "receiveBoolean")
      return { kind: "load", key, read: "boolean" };
    return { kind: "load", key };
  }
  if (call.name === "loadMap") {
    return unsupportedExpression(
      context,
      node,
      "SX_STORAGE_MAP_SEMANTICS",
      "Legacy loadMap() filters the loaded value to Map-or-null; automatic object/map migration is not proven safe yet.",
    );
  }
  if (call.name === "loadFirstTrue") {
    const keys = lowerArguments(call.arguments, context);
    if (keys === null) return null;
    // One list or array argument, `loadFirstTrue(keys.toArray(new String[0]))`, is the list of keys itself.
    const only = call.arguments.length === 1 ? call.arguments[0]! : null;
    const listed =
      only !== null &&
      (constantString(only.method) === "toArray" ||
        (onlyOf(inferType(only, context.types), LIST | NULL) &&
          (inferType(only, context.types) & LIST) !== 0));
    return useHelper(context, "loadFirstTrue", [listed ? keys[0]! : { kind: "list", items: keys }]);
  }

  // getSelectedValue lowers its own arguments: its option list must stay a literal list.
  if (call.name === "getSelectedValue") return lowerSelectedValue(node, call.arguments, context);
  const args = lowerArguments(call.arguments, context);
  if (args === null) return null;

  switch (call.name) {
    case "getRandom":
      if (args.length !== 1)
        return unsupportedExpression(
          context,
          node,
          "SX_RANDOM_ARITY",
          "getRandom() must have one argument.",
        );
      // Only a positive integer bound is certain to give randomInteger() a non-empty range (positiveWholeBound), without
      // a division's fraction.
      if (
        positiveWholeBound(asNode(call.arguments[0]), context) &&
        !JSON.stringify(args[0]).includes('"operator":"/"')
      ) {
        return {
          kind: "call",
          name: "randomInteger",
          positional: [
            { kind: "range", from: { kind: "literal", value: 0 }, to: args[0]!, inclusive: false },
          ],
          named: {},
        };
      }
      return useHelper(context, "random", args);
    case "showPopup": {
      // TeaseScript popups return nothing; the legacy result was the seconds until the player closed it.
      const root = context.statementRoot;
      if (args.length !== 1 || root === null || !isHoistable(root, node, context)) {
        return unsupportedExpression(
          context,
          node,
          "SX_POPUP_POSITION",
          "The popup's waiting time is used inside a larger expression that cannot run around the popup; assign showPopup() to a variable first.",
        );
      }
      context.popupTimers += 1;
      const start = context.popupTimers === 1 ? "popupStart" : `popupStart${context.popupTimers}`;
      const seconds = currentSeconds();
      addDiagnostic(
        context,
        "SX_POPUP_ELAPSED",
        "warning",
        `showPopup() returned the seconds until the player closed the popup; TeaseScript popups return nothing, so the time is measured with getAbsoluteDateTime().toSeconds(), in whole seconds.`,
        node.span,
      );
      // Legacy timing started once the message was computed.
      let message = args[0]!;
      if (!isPure(call.arguments[0]!, context)) {
        const name = start.replace("popupStart", "popupMessage");
        context.prelude.push({ kind: "let", name, value: message, span: node.span });
        message = { kind: "variable", name };
      }
      context.prelude.push(
        { kind: "let", name: start, value: seconds, span: node.span },
        ...popupStatements(message, node.span, context),
      );
      return {
        kind: "binary",
        operator: "-",
        left: seconds,
        right: { kind: "variable", name: start },
      };
    }
    case "getTime":
      // Legacy getTime() returned Unix seconds; TeaseScript getTime() is the local time of day (#532).
      return args.length === 0
        ? currentSeconds()
        : unsupportedExpression(
            context,
            node,
            "SX_TIME_ARITY",
            "getTime() must have no arguments.",
          );
    case "getBoolean": {
      if (args.length !== 1 && args.length !== 3) {
        return unsupportedExpression(
          context,
          node,
          "SX_BOOLEAN_ARITY",
          "getBoolean() must have one or three arguments.",
        );
      }
      // Legacy getBoolean shows its text like show() and then two buttons, the first meaning true, as askBoolean does
      // (#712); its text becomes the ask's question (withAskQuestions), and the button texts are written where they
      // are not askBoolean's own "Yes" and "No".
      const labels = args.slice(1);
      const computed = { nodes: call.arguments.slice(1), values: labels };
      if (!pushPrompt(context, node, call.arguments[0]!, args[0]!, null, computed)) return null;
      const own = (label: IrExpression | undefined, text: string): boolean =>
        label === undefined || (label.kind === "literal" && label.value === text);
      return {
        kind: "input",
        input: "askBoolean",
        ...(own(labels[0], "Yes") ? {} : { yesText: labels[0]! }),
        ...(own(labels[1], "No") ? {} : { noText: labels[1]! }),
      };
    }
    case "getBooleans":
      if (args.length !== 3)
        return unsupportedExpression(
          context,
          node,
          "SX_BOOLEANS_ARITY",
          "getBooleans() must have exactly three arguments.",
        );
      // The legacy dialog's Cancel gave null; the form offers it where the script tests the answers for null.
      return {
        kind: "call",
        name: "askBooleans",
        positional: [],
        named: {
          message: args[0]!,
          texts: args[1]!,
          prefill: args[2]!,
          ...(context.cancelBooleans === true
            ? { cancel: { kind: "literal", value: "Cancel" } }
            : {}),
        },
      };
    case "showButton": {
      // Legacy returned the seconds until the click; TeaseScript returns the elapsed duration (V30 §21, #531).
      const legacyTimeout =
        args.length === 2 ? buttonTimeout(call.arguments[1], node, context) : undefined;
      if (legacyTimeout === null)
        return unsupportedExpression(context, node, "SX_BUTTON_TIMEOUT", NEGATIVE_TIMEOUT);
      if (legacyTimeout === "computed") return helperCall("button", [args[0]!, args[1]!]);
      if (legacyTimeout !== undefined) {
        // A zero timeout always returned 0 seconds, after the button's 10 ms.
        const root = context.statementRoot;
        if (root === null || !isHoistable(root, node, context)) {
          return unsupportedExpression(
            context,
            node,
            "SX_BUTTON_TIMEOUT",
            "This button with a zero timeout is used inside a larger expression that cannot run around it; assign showButton() to a variable first.",
          );
        }
        context.prelude.push({
          kind: "showButton",
          label: args[0]!,
          timeout: legacyTimeout,
          span: node.span,
        });
        return { kind: "literal", value: 0 };
      }
      return args.length === 1 || args.length === 2
        ? {
            kind: "binary",
            operator: "/",
            left: { kind: "button", label: args[0]!, timeout: args[1] ?? null },
            right: { kind: "duration", value: 1, unit: "s" },
          }
        : unsupportedExpression(
            context,
            node,
            "SX_BUTTON_ARITY",
            "showButton() must have one or two arguments.",
          );
    }
    case "useUrl": {
      if (args.length !== 1)
        return unsupportedExpression(
          context,
          node,
          "SX_URL_ARITY",
          "useUrl() must have one argument.",
        );
      if (context.accepted.has("openUrl"))
        return { kind: "call", name: "openUrl", positional: args, named: {} };
      // Legacy useUrl returned nothing; the link and its button run before the statement.
      context.prelude.push(...urlStatements(args[0]!, node.span, context));
      return { kind: "literal", value: null };
    }
    case "getFile": {
      // Without a title, Groovy passed null, and the chooser had no title.
      if (args.length > 1)
        return unsupportedExpression(
          context,
          node,
          "SX_CALL_ARITY",
          "getFile() must have one argument.",
        );
      if (context.accepted.has("chooseFile")) {
        addDiagnostic(
          context,
          "SX_FILE_TITLE",
          "warning",
          "getFile() titled its file chooser with this message; chooseFile() has no title.",
          node.span,
        );
        return { kind: "call", name: "chooseFile", positional: [], named: {} };
      }
      // The corpus asks for files to get a photo of the player (owner decision 2026-10-05): askImage() asks for an
      // image with the same message, which the player answers with a file or the camera (#608).
      addDiagnostic(
        context,
        "SX_FILE_PHOTO",
        "warning",
        "getFile() let the player pick any file with this title; scripts use it for a photo of the player, so askImage() asks for an image with this message, which the player answers with an image file or the camera; a chooser the player cancelled gave null, which askImage() does not.",
        node.span,
      );
      return { kind: "call", name: "askImage", positional: args, named: {} };
    }
    case "getDataFolder":
      if (args.length !== 0)
        return unsupportedExpression(
          context,
          node,
          "SX_CALL_ARITY",
          "getDataFolder() takes no arguments.",
        );
      addDiagnostic(
        context,
        "SX_DATA_FOLDER",
        "warning",
        "getDataFolder() was the legacy player's data folder on the player's computer; package paths start at the package root, so it is empty text here.",
        node.span,
      );
      return { kind: "literal", value: "" };
    case "isConnected":
      if (args.length !== 0)
        return unsupportedExpression(
          context,
          node,
          "SX_CALL_ARITY",
          "isConnected() takes no arguments.",
        );
      addDiagnostic(context, "SX_ONLINE_STORAGE", "warning", ONLINE_STORAGE_NOTE, node.span);
      return { kind: "literal", value: true };
    case "sendImage":
      if (args.length !== 1)
        return unsupportedExpression(
          context,
          node,
          "SX_CALL_ARITY",
          "sendImage() must have one argument.",
        );
      addDiagnostic(context, "SX_ONLINE_STORAGE", "warning", ONLINE_STORAGE_NOTE, node.span);
      return useHelper(context, "sendImage", args);
    case "receiveImage":
      if (args.length !== 1)
        return unsupportedExpression(
          context,
          node,
          "SX_CALL_ARITY",
          "receiveImage() must have one argument.",
        );
      addDiagnostic(context, "SX_ONLINE_STORAGE", "warning", ONLINE_STORAGE_NOTE, node.span);
      return {
        kind: "load",
        key: { kind: "template", parts: [{ text: SENT_IMAGE_PREFIX }, { value: args[0]! }] },
      };
    case "getString":
    case "getInteger":
    case "getFloat":
      return lowerSingleInput(node, call.name, call.arguments, args, context);
    case "getImage":
      // Legacy took a webcam picture without asking and returned its path, or null when it failed; without a webcam
      // it opened a file chooser titled with the message. takePhoto() returns a photo reference or null (V30 §33).
      // Without a message, Groovy passed null: the webcam picture without a chooser title.
      if (args.length > 1) {
        return unsupportedExpression(
          context,
          node,
          "SX_CALL_ARITY",
          "getImage() must have at most one argument.",
        );
      }
      if (args.length === 0) return { kind: "call", name: "takePhoto", positional: [], named: {} };
      if (!isPure(call.arguments[0]!, context)) {
        return unsupportedExpression(
          context,
          node,
          "SX_UNSUPPORTED_ARGUMENT",
          "getImage() computes its file-chooser title with side effects; takePhoto() has no title, so compute it explicitly first.",
        );
      }
      addDiagnostic(
        context,
        "SX_CAMERA_FALLBACK",
        "warning",
        "getImage() fell back to a file chooser titled with its message when no webcam worked; takePhoto() only uses the camera and returns null instead, and the Player decides how the photo is taken.",
        node.span,
      );
      return { kind: "call", name: "takePhoto", positional: [], named: {} };
    default:
      if (!SEXSCRIPT_API_METHODS.has(call.name)) {
        return unsupportedExpression(
          context,
          node,
          "SX_UNDEFINED_FUNCTION",
          `${call.name}() is not defined in this script, its package helpers, or the SexScript API; SexScript failed here at runtime.`,
        );
      }
      return unsupportedExpression(
        context,
        node,
        "SX_UNSUPPORTED_SEXSCRIPT_EXPRESSION",
        `Unsupported SexScript expression call: ${call.name}`,
      );
  }
}

const NEGATIVE_TIMEOUT =
  "A negative showButton() timeout made the legacy button wait fail; TeaseScript rejects it too (#531). Use a positive timeout.";

/**
 * A literal zero timeout showed the legacy button only for its 10 ms safety margin, and the result was 0; #531 rejects a
 * zero timeout, so the conversion keeps the 10 ms (with a note). Returns that timeout, null for a negative literal,
 * and undefined for any other timeout.
 */
function buttonTimeout(
  timeoutNode: AstNode | undefined,
  node: AstNode,
  context: LowerContext,
): IrExpression | null | undefined | "computed" {
  if (timeoutNode === undefined) return undefined;
  const value = staticNumber(timeoutNode, context);
  if (value !== undefined && value < 0) return null;
  if (value === undefined) {
    // A timeout known only at runtime may be zero, which TeaseScript rejects (#531): a helper keeps the legacy button.
    context.syntheticHelpers.add("button");
    addDiagnostic(
      context,
      "SX_BUTTON_COMPUTED_TIMEOUT",
      "info",
      "The legacy button with a timeout known only at runtime goes through a helper that keeps a zero timeout's 10 ms button and result of 0 seconds; a negative timeout stops the script, as it did in legacy.",
      node.span,
    );
    return "computed";
  }
  if (value !== 0) return undefined;
  addDiagnostic(
    context,
    "SX_BUTTON_TIMEOUT",
    "warning",
    "With a zero timeout the legacy button stayed visible only for its 10 ms safety margin, and the result was 0; TeaseScript rejects a zero timeout (#531), so the button keeps the 10 ms.",
    node.span,
  );
  return { kind: "duration", value: 10, unit: "ms" };
}

/**
 * Legacy single-field input shows `message` in its dialog and pre-fills `defaultValue`. TeaseScript shows the
 * question with `say` and then asks with a compact input whose `default:` prefills the field (V30 §20), also for
 * integer input (`askInteger`, #548).
 */
function lowerSingleInput(
  node: AstNode,
  name: string,
  argumentNodes: AstNode[],
  args: IrExpression[],
  context: LowerContext,
): IrExpression | null {
  if (args.length < 1 || args.length > 2) {
    return unsupportedExpression(
      context,
      node,
      "SX_INPUT_ARITY",
      `${name}() must have a message and an optional default value.`,
    );
  }
  const defaultNode = argumentNodes[1];
  const prefill = defaultNode === undefined || isEmptyDefault(defaultNode) ? null : args[1]!;
  if (prefill !== null && !isPure(defaultNode!, context)) {
    return unsupportedExpression(
      context,
      node,
      "SX_INPUT_PREFILL_EFFECT",
      `${name}() computes its pre-filled value with side effects, which legacy ran before showing the question; the question becomes a say before the input, so compute the value explicitly before the question.`,
    );
  }
  // Legacy text input showed `String.valueOf(default)`; a text default is text in TeaseScript too (null shows "null"),
  // and a list shows as Groovy printed it, `[a, b]`.
  const defaultType = defaultNode === undefined ? UNKNOWN : inferType(defaultNode, context.types);
  let textPrefill = prefill;
  if (
    prefill !== null &&
    name === "getString" &&
    defaultType !== UNKNOWN &&
    (defaultType & (LIST | OBJECT)) !== 0
  ) {
    const parts = onlyOf(defaultType, LIST | NULL) ? listText(defaultNode!, context) : undefined;
    if (parts === null) return null;
    if (parts === undefined) {
      return unsupportedExpression(
        context,
        node,
        "SX_INPUT_PREFILL_VALUE",
        `${name}() prefilled its field with this map or list as Groovy printed it; ` +
          "a TeaseScript text default has no such form, so build the default text explicitly.",
      );
    }
    textPrefill = templateOrLiteral(parts);
  } else {
    // A null or blank default opens the input without a prefill at runtime (#618), as the legacy empty field did. A
    // number input's prefill that may be no number, or a fraction where it needs a whole number, goes through a helper.
    if (
      prefill !== null &&
      name !== "getString" &&
      !notePrefill(name, defaultNode!, node, context)
    ) {
      if (!pushPrompt(context, node, argumentNodes[0]!, args[0]!)) return null;
      return useHelper(context, name === "getInteger" ? "askInteger" : "askNumber", [prefill]);
    }
    // A text input's prefill that may be no text is shown as text, and null stays null.
    if (prefill !== null && name === "getString" && !onlyOf(defaultType, STRING | NULL)) {
      textPrefill =
        prefill.kind === "literal"
          ? { kind: "literal" as const, value: String(prefill.value) }
          : (defaultType & NULL) === 0
            ? templateOrLiteral([{ value: prefill }])
            : useHelper(context, "text", [prefill]);
    }
  }
  if (!pushPrompt(context, node, argumentNodes[0]!, args[0]!)) return null;
  const input =
    name === "getString" ? "askText" : name === "getInteger" ? "askInteger" : "askNumber";
  return textPrefill === null
    ? { kind: "input", input }
    : { kind: "input", input, defaultValue: textPrefill };
}

/**
 * A number input's default that TeaseScript rejects when the input opens: a value that is no number, or a fraction for
 * a whole-number input (V30 §20; a null default opens it without a prefill, #618). Legacy showed the value in the field
 * instead, so such a default goes through a helper that asks without it then, with a note; false for such a default.
 */
function notePrefill(
  name: string,
  defaultNode: AstNode,
  node: AstNode,
  context: LowerContext,
): boolean {
  const type = inferType(defaultNode, context.types);
  const valid =
    onlyOf(type, NUMBER | NULL) &&
    (name !== "getInteger" || !mayBeFractional(defaultNode, context));
  if (valid) return true;
  addDiagnostic(
    context,
    "SX_INPUT_PREFILL",
    "warning",
    `${name}() pre-filled its field with this value; a TeaseScript default must be ${name === "getInteger" ? "a whole number" : "a number"}, so a helper asks without the default when it is not.`,
    node.span,
  );
  return false;
}

/** A written null or blank default, which TeaseScript rejects as written (TSV039): the input has no prefill. */
function isEmptyDefault(node: AstNode): boolean {
  return (
    node.kind === "constant" &&
    (node.value === null || (typeof node.value === "string" && node.value.trim() === ""))
  );
}

/**
 * Legacy input text replaces the shown text like show(); `null` keeps the current text. The prompt becomes a
 * `say` before the statement, which is only equivalent when the input could be evaluated first; otherwise this
 * reports the input and returns false.
 */
function pushPrompt(
  context: LowerContext,
  inputNode: AstNode,
  messageNode: AstNode,
  message: IrExpression,
  /** An argument whose statements already run before the prompt, such as the loop that builds a menu's options. */
  evaluated: AstNode | null = null,
  /**
   * The lowered button texts or options and their nodes: one with effects, such as `"Yes, ${dommeTitle()}"`, is
   * computed into a temporary before the question, in order after the question's own text, as Groovy evaluated every
   * argument before showing it; `values` then holds the temporary.
   */
  computed: { nodes: readonly AstNode[]; values: IrExpression[] } | null = null,
): boolean {
  if (isNullConstant(messageNode)) return true;
  const root = context.statementRoot;
  const effects = computed?.nodes.filter((node) => !isPure(node, context)) ?? [];
  // Groovy evaluates all arguments before showing the message, so other arguments must not have effects.
  const otherArguments = (callParts(inputNode)?.arguments ?? []).filter(
    (argument) =>
      argument !== messageNode &&
      argument !== evaluated &&
      !effects.includes(argument) &&
      !(
        argument.kind === "list" &&
        nodeArray(argument.items).every((item) => isPure(item, context) || effects.includes(item))
      ),
  );
  const ordered =
    root !== null &&
    isHoistable(root, inputNode, context, messageNode) &&
    otherArguments.every((argument) => isPure(argument, context));
  if (ordered && effects.length > 0 && computed !== null) {
    const temporary = (value: IrExpression, base: string): IrExpression => {
      const name = freshName(base, context);
      context.prelude.push({ kind: "let", name, value, span: inputNode.span });
      return { kind: "variable", name };
    };
    if (!isPure(messageNode, context)) message = temporary(message, "question");
    computed.nodes.forEach((node, index) => {
      if (effects.includes(node))
        computed.values[index] = temporary(computed.values[index]!, "option");
    });
  }
  if (!ordered) {
    addDiagnostic(
      context,
      "SX_PROMPT_POSITION",
      "error",
      "This input's question cannot be shown at the right moment: the input is guarded by && / || / ?:, follows side effects in the same statement, or has arguments with side effects. Split the statement so the input comes first.",
      inputNode.span,
    );
    return false;
  }
  const say: IrStatement = { kind: "say", value: message, span: inputNode.span };
  if (onlyOf(inferType(messageNode, context.types), STRING)) {
    context.prelude.push(say);
  } else if (isRepeatableExpression(messageNode)) {
    // A null legacy message kept the current text instead of showing "null".
    context.prelude.push({
      kind: "if",
      condition: {
        kind: "binary",
        operator: "!=",
        left: message,
        right: { kind: "literal", value: null },
      },
      then: [say],
      else: [],
      span: inputNode.span,
      guard: "prompt",
    });
  } else {
    addDiagnostic(
      context,
      "SX_PROMPT_NULLABLE",
      "warning",
      "This input message may be null at runtime; legacy then kept the current text, while say would show null.",
      inputNode.span,
    );
    context.prelude.push(say);
  }
  return true;
}

/** Legacy getSelectedValue() returns the zero-based index, which numeric `choose` labels reproduce. */
function lowerSelectedValue(
  node: AstNode,
  args: AstNode[],
  context: LowerContext,
): IrExpression | null {
  if (args.length !== 2) {
    return unsupportedExpression(
      context,
      node,
      "SX_CHOICE_ARITY",
      "getSelectedValue() must have exactly two arguments.",
    );
  }
  const message = lowerExpression(args[0]!, context);
  if (message === null) return null;
  const optionsNode = args[1]!;
  if (optionsNode.kind !== "list") {
    const listChoice = runtimeListSelectedValue(node, args[0]!, message, optionsNode, context);
    if (listChoice !== undefined) return listChoice;
    return unsupportedExpression(
      context,
      node,
      "SX_DYNAMIC_CHOICE_OPTIONS",
      "getSelectedValue() options come from a runtime list in a shape the importer does not convert: choose can take written options followed by one list, but this list is built inside a larger expression or is not proven to be a list. Build the option list in its own statement.",
    );
  }
  const options: IrExpression[] = [];
  for (const item of nodeArray(optionsNode.items)) {
    const option = lowerExpression(item, context);
    if (option === null) return null;
    options.push(option);
  }
  if (options.length === 0) {
    return unsupportedExpression(
      context,
      node,
      "SX_EMPTY_CHOICE",
      "getSelectedValue() has no choices.",
    );
  }
  const computed = { nodes: nodeArray(optionsNode.items), values: options };
  if (!pushPrompt(context, node, args[0]!, message, null, computed)) return null;
  return { kind: "choice", options };
}

/**
 * getSelectedValue() over a runtime list as a `choose` with a list option (V30 §19, PR #515): written options before
 * one runtime list keep their zero-based index as numeric value and the list's elements become choice objects with
 * the following ones, so the result stays the legacy index. A `collect` that builds the list becomes a loop before
 * the statement. Returns undefined when the options do not have that shape.
 */
function runtimeListSelectedValue(
  node: AstNode,
  messageNode: AstNode,
  message: IrExpression,
  optionsNode: AstNode,
  context: LowerContext,
): IrExpression | null | undefined {
  const allPieces = listPlusOperands(optionsNode);
  // Written options after the runtime list, `list + ["Back"]`, join it at runtime (#609), so their positions follow.
  let end = allPieces.length;
  while (end > 1 && allPieces[end - 1]!.kind === "list") end -= 1;
  const trailing = allPieces.slice(end);
  const pieces = allPieces.slice(0, end);
  const listNode = pieces.at(-1)!;
  const written = pieces.slice(0, -1);
  if (listNode.kind === "list" || written.some((piece) => piece.kind !== "list")) return undefined;
  const trailingItems = trailing.flatMap((piece) => nodeArray(piece.items));
  const writtenItems = written.flatMap((piece) => nodeArray(piece.items));
  let loop: IrStatement[] = [];
  let list: IrExpression;
  if (callParts(listNode)?.name === "collect") {
    // The loop runs before the statement, so written options before it must not have effects.
    const root = context.statementRoot;
    if (root === null || !isHoistable(root, node, context, listNode)) return undefined;
    if (!writtenItems.every((item) => isPure(item, context))) return undefined;
    const name = freshName("menuTexts", context);
    const lowered = lowerCollectionAssignment(true, name, listNode, node.span, context);
    if (lowered === null) return undefined;
    loop = lowered;
    list = { kind: "variable", name };
  } else {
    // Groovy needed a list here too, so a value that may be one is used as the list.
    if ((inferType(listNode, context.types) & LIST) === 0) return undefined;
    if (!isKnownListExpression(listNode, context))
      addDiagnostic(
        context,
        "SX_CHOICE_LIST",
        "info",
        "These options are not proven to be a list; Groovy needed a list here too, so the value is offered as one.",
        node.span,
      );
    const lowered = lowerExpression(listNode, context);
    if (lowered === null) return null;
    list = lowered;
  }
  if (trailingItems.length > 0) {
    const after = lowerArguments(trailingItems, context);
    if (after === null) return null;
    list = { kind: "binary", operator: "+", left: list, right: { kind: "list", items: after } };
  }
  const options: IrListChoiceOption[] = [];
  for (const [index, item] of writtenItems.entries()) {
    const text = lowerExpression(item, context);
    if (text === null) return null;
    options.push({ kind: "option", value: index, text });
  }
  context.prelude.push(...loop);
  if (!pushPrompt(context, node, messageNode, message, loop.length > 0 ? optionsNode : null))
    return null;
  const first: IrExpression = { kind: "literal", value: writtenItems.length };
  options.push({
    kind: "list",
    list: useHelper(context, "menuOptions", [list, first]),
    records: true,
  });
  return { kind: "listChoice", options };
}

/** The operands of a Groovy `a + b + c` chain, or the node itself. */
function listPlusOperands(node: AstNode): AstNode[] {
  const left = asNode(node.left);
  const right = asNode(node.right);
  if (node.kind === "binary" && node.operator === "+" && left !== null && right !== null) {
    return [...listPlusOperands(left), right];
  }
  return [node];
}

function lowerArguments(args: AstNode[], context: LowerContext): IrExpression[] | null {
  const result: IrExpression[] = [];
  for (const arg of args) {
    const lowered = lowerExpression(arg, context);
    if (lowered === null) return null;
    result.push(lowered);
  }
  return result;
}

function oneArgumentStatement(
  args: AstNode[],
  context: LowerContext,
  node: AstNode,
  build: (value: IrExpression) => IrStatement | IrStatement[],
): IrStatement[] {
  if (args.length !== 1)
    return [unsupportedStatement(context, node, "SX_CALL_ARITY", "Expected one argument.")];
  const value = lowerExpression(args[0]!, context);
  return value === null
    ? [
        unsupportedStatement(
          context,
          node,
          "SX_UNSUPPORTED_ARGUMENT",
          "Argument could not be migrated.",
        ),
      ]
    : [build(value)].flat();
}

/**
 * `say` text is message markup. Legacy emphasis such as `*grin*` reasonably becomes formatting, but block
 * markers at a line start and backslash escapes were plain text in SexScript and likely change the message.
 */
function noteUnintendedMarkup(node: AstNode | undefined, context: LowerContext): void {
  if (node === undefined) return;
  const texts: string[] = [];
  walkAst(node, (child) => {
    if (child.kind === "constant" && typeof child.value === "string") texts.push(child.value);
    if (child.kind === "gstring" && Array.isArray(child.strings)) {
      for (const part of child.strings) if (typeof part === "string") texts.push(part);
    }
  });
  const risky = texts.some(
    (text) =>
      /(^|\n)(#{1,3} |> |- |[1-9][0-9]*\. )/u.test(text) || /\\[\\*~`[\]()#>\-.:]/u.test(text),
  );
  if (risky) {
    addDiagnostic(
      context,
      "SX_SAY_MARKUP",
      "warning",
      "This legacy plain text contains a line-start list/heading/quote marker or a backslash escape that TeaseScript say renders as message markup; use escapeMarkup() if it must stay literal.",
      node.span,
    );
  }
}

/** The last argument of a slice helper for a range that leaves out its `to` end, `..<`: none for `..`. */
function exclusive(range: Extract<IrExpression, { kind: "range" }>): IrExpression[] {
  return range.inclusive ? [] : [{ kind: "literal", value: true }];
}

/** The legacy names of the setInfos() arguments, in order. */
const METADATA_FIELDS = [
  "version",
  "title",
  "summary",
  "author",
  "status",
  "color",
  "language",
  "tags",
] as const;

/**
 * Legacy setInfos(version, title, summary, author, status, color, language, tags) metadata, which becomes the file
 * header (V30 §41). A value known before the script runs, also text joined with `+`, is kept; a computed one has no
 * header form and stays a comment with its legacy source.
 */
function extractMetadata(args: AstNode[], context: LowerContext, span: SourceSpan | null): void {
  if (args.length !== 8) {
    addDiagnostic(
      context,
      "SX_METADATA_DYNAMIC",
      "warning",
      "setInfos() did not have its eight arguments, so its metadata is dropped.",
      span,
    );
    return;
  }
  const values = args.map((arg) => staticMetadataValue(arg, context));
  const tagsNode = args[7];
  const tagNames =
    tagsNode?.kind === "list"
      ? nodeArray(tagsNode.items).map((tag) => staticMetadataValue(tag, context))
      : [];
  const tagsKnown = tagsNode?.kind === "list" && tagNames.every((tag) => typeof tag === "string");
  const computed = METADATA_FIELDS.flatMap((field, index) =>
    (index === 7 ? tagsKnown : values[index] !== undefined)
      ? []
      : [{ field, source: sourceTextOf(args[index]!, context) }],
  );
  if (computed.length > 0) {
    addDiagnostic(
      context,
      "SX_METADATA_DYNAMIC",
      "warning",
      `setInfos() computed its ${computed.map(({ field }) => field).join(", ")} when the script ran; a file header holds only written values, so ${computed.length === 1 ? "it stays" : "they stay"} a comment after the header.`,
      span,
    );
  }
  context.metadata = {
    apiVersion: numberOrNull(values[0]),
    title: stringOrNull(values[1]),
    summary: stringOrNull(values[2]),
    author: stringOrNull(values[3]),
    status: stringOrNull(values[4]),
    color: numberOrNull(values[5]),
    language: stringOrNull(values[6]),
    tags: tagsKnown ? tagNames.filter((tag): tag is string => typeof tag === "string") : null,
    ...(computed.length === 0 ? {} : { computed }),
  };
}

/**
 * A metadata value known before the script runs: a literal, text joined from such values with `+`, or a variable that
 * the script assigns one such text once, as `titleline = "Escape Room"` before `setInfos(9, titleline, ...)`.
 */
function staticMetadataValue(
  node: AstNode | undefined,
  context: LowerContext,
  seen = new Set<string>(),
): string | number | boolean | null | undefined {
  if (node === undefined) return undefined;
  const literal = constantValue(node);
  if (literal !== undefined) return literal;
  if (node.kind === "binary" && node.operator === "+") {
    const left = staticMetadataValue(asNode(node.left) ?? undefined, context, seen);
    const right = staticMetadataValue(asNode(node.right) ?? undefined, context, seen);
    if (typeof left === "string" || typeof right === "string")
      return left === undefined || right === undefined ? undefined : `${left}${right}`;
    return undefined;
  }
  const name = variableName(node);
  if (name === null || seen.has(name) || context.types.singleAssignment?.has(name) !== true)
    return undefined;
  const initializer = context.constantInitializers.get(name);
  // Only text: a number may change by the variable's declared type, as `int size = 1.9` holds 1.
  const value =
    initializer === undefined
      ? undefined
      : staticMetadataValue(initializer, context, new Set([...seen, name]));
  return typeof value === "string" ? value : undefined;
}

/** The legacy source of an expression, on one line. */
function sourceTextOf(node: AstNode, context: LowerContext): string {
  const span = node.span;
  if (span === null) return "?";
  const lines = context.sourceLines.slice(span.line - 1, span.endLine);
  if (lines.length === 0) return "?";
  // Columns are one-based; the end column points past the expression.
  lines[lines.length - 1] = lines.at(-1)!.slice(0, span.endColumn - 1);
  lines[0] = lines[0]!.slice(span.column - 1);
  return singleLine(lines.map((line) => line.trim()).join(" "));
}

function callParts(
  node: AstNode,
): { name: string; inherited: boolean; arguments: AstNode[] } | null {
  if (node.kind !== "methodCall") return null;
  const name = constantString(node.method);
  if (name === null) return null;
  const objectName = variableName(node.object);
  const inherited = node.implicitThis === true || objectName === "main";
  const argsNode = asNode(node.arguments);
  return { name, inherited, arguments: argsNode === null ? [] : nodeArray(argsNode.items) };
}

interface LegacyHelperBindings {
  classLoaders: Set<string>;
  helperClasses: Map<string, string>;
}

function collectLegacyHelperBindings(body: AstNode): LegacyHelperBindings {
  const classLoaders = new Set<string>();
  walkAst(body, (node) => {
    if (node.kind !== "declaration") return;
    const name = variableName(node.left);
    const value = asNode(node.right);
    if (name !== null && value !== null && isGroovyClassLoaderConstructor(value))
      classLoaders.add(name);
  });

  const helperClasses = new Map<string, string>();
  walkAst(body, (node) => {
    if (node.kind !== "declaration") return;
    const name = variableName(node.left);
    const value = asNode(node.right);
    if (name === null || value === null || !isLegacyLoadClassCall(value, classLoaders)) return;
    const argsNode = asNode(value.arguments);
    const className = argsNode === null ? null : constantString(nodeArray(argsNode.items)[0]);
    if (className !== null) helperClasses.set(name, className);
  });
  return { classLoaders, helperClasses };
}

function isGroovyClassLoaderConstructor(node: AstNode): boolean {
  return node.kind === "constructorCall" && node.type === "groovy.lang.GroovyClassLoader";
}

function isLegacyLoadClassCall(node: AstNode, classLoaders: Set<string>): boolean {
  if (node.kind !== "methodCall" || constantString(node.method) !== "loadClass") return false;
  const receiver = variableName(node.object);
  return receiver !== null && classLoaders.has(receiver);
}

interface MixinShape {
  parameter: string;
  methods: Array<{ name: string; closure: AstNode }>;
  loadStatements: AstNode[];
  setup: AstNode | null;
}

/**
 * A runtime-loaded mixin module is a file whose only statement is a one-parameter closure, evaluated by the
 * package's loader with the script object as argument. `object.metaClass.name = { ... }` (or the call form
 * `object.metaClass.name { ... }`) injects a method; other statements run at load time; a returned closure is
 * a setup callback that the loader runs later.
 */
function mixinShape(body: AstNode): MixinShape | null {
  const statements = nodeArray(body.statements).filter((statement) => statement.kind !== "empty");
  const only = statements.length === 1 ? statements[0] : undefined;
  const closure = only?.kind === "expressionStatement" ? asNode(only.expression) : null;
  if (closure?.kind !== "closure" || closure.parameterSpecified !== true) return null;
  const parameters = groovyParameters(closure.parameters);
  const closureBody = asNode(closure.body);
  if (parameters?.length !== 1 || closureBody?.kind !== "block") return null;
  const parameter = parameters[0]!.name;
  const shape: MixinShape = { parameter, methods: [], loadStatements: [], setup: null };
  const inner = nodeArray(closureBody.statements);
  // An earlier return makes the result depend on control flow; only a module that always returns nothing has a
  // fixed result then.
  const earlyReturns = inner.slice(0, -1).flatMap((statement) => closureReturns(statement));
  const final = inner.at(-1);
  const finalValue = asNode(final?.kind === "return" ? final.value : null);
  const returnsNothing = (value: AstNode | null): boolean =>
    value === null || isNullConstant(value);
  if (
    earlyReturns.length > 0 &&
    (earlyReturns.some(({ value }) => !returnsNothing(value)) ||
      final?.kind !== "return" ||
      !returnsNothing(finalValue))
  ) {
    return null;
  }
  const lastMethod = inner.length === 0 ? null : injectedMethod(inner.at(-1)!, parameter);
  inner.forEach((statement, index) => {
    const method = injectedMethod(statement, parameter);
    if (method !== null) {
      shape.methods.push(method);
      return;
    }
    const value = asNode(statement.kind === "return" ? statement.value : statement.expression);
    if (index === inner.length - 1 && (statement.kind === "return" || value?.kind === "closure")) {
      if (value?.kind === "closure") shape.setup = value;
      else if (value !== null && !isNullConstant(value)) shape.loadStatements.push(statement);
      return;
    }
    shape.loadStatements.push(statement);
  });
  // A final `object.metaClass.name = { }` returns the assigned closure, which the loader runs as setup.
  const last = inner.at(-1);
  const assignsLast =
    last?.kind === "expressionStatement" && asNode(last.expression)?.kind === "binary";
  if (lastMethod !== null && assignsLast) {
    shape.setup = {
      kind: "closure",
      span: last.span,
      parameters: [],
      parameterSpecified: true,
      body: {
        kind: "block",
        span: last.span,
        statements: [callStatement(lastMethod.name, last.span)],
      },
    };
  }
  return shape;
}

function injectedMethod(
  statement: AstNode,
  parameter: string,
): { name: string; closure: AstNode } | null {
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  if (expression === null) return null;
  const isMetaClass = (node: unknown): boolean =>
    isAstNode(node) &&
    node.kind === "property" &&
    variableName(node.object) === parameter &&
    constantString(node.property) === "metaClass";
  if (expression.kind === "methodCall" && isMetaClass(expression.object)) {
    const name = constantString(expression.method);
    const args = nodeArray(asNode(expression.arguments)?.items);
    return name !== null && args.length === 1 && args[0]!.kind === "closure"
      ? { name, closure: args[0]! }
      : null;
  }
  const left = asNode(expression.left);
  const right = asNode(expression.right);
  if (expression.kind === "binary" && expression.operator === "=" && left?.kind === "property") {
    const name = constantString(left.property);
    return name !== null && isMetaClass(left.object) && right?.kind === "closure"
      ? { name, closure: right }
      : null;
  }
  return null;
}

/**
 * A module's loader lists `scripts/<directory>` and keeps names ending in `.groovy` (case-sensitive); files elsewhere
 * get no directory, so no loader selects them.
 */
function moduleNames(sourceName: string): { directory: string; name: string } {
  const parts = sourceName.split(/[\\/]/u);
  const file = parts.at(-1) ?? sourceName;
  const name = file.replace(/\.groovy$/u, "");
  const loadable = file.endsWith(".groovy") && parts.at(-3) === "scripts";
  return { directory: loadable ? (parts.at(-2) ?? "") : "", name };
}

function capitalized(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * Functions every package file may call: methods injected by mixin modules and the members of an anonymous-object
 * script, which mixin code reaches through the object receiver.
 */
export function packageFunctionNames(files: readonly ParsedGroovyFile[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const name of describeMixinModule(file)?.functions ?? []) names.add(name);
    if (file.root?.kind !== "scriptBody") continue;
    for (const objectClass of nodeArray(file.root.classes)) {
      for (const field of nodeArray(objectClass.fields)) {
        if (asNode(field.initialExpression)?.kind === "closure" && typeof field.name === "string") {
          names.add(field.name);
        }
      }
      for (const method of nodeArray(objectClass.methods)) {
        if (typeof method.name === "string") names.add(method.name);
      }
    }
  }
  return names;
}

/** Adds package-global types for names the file does not assign itself; shared names take the union. */
function withGlobalTypes(
  environment: TypeEnvironment,
  globals: ReadonlyMap<string, number> | undefined,
): TypeEnvironment {
  if (globals === undefined || globals.size === 0) return environment;
  const variables = new Map(environment.variables);
  for (const [name, type] of globals) variables.set(name, (variables.get(name) ?? 0) | type);
  return { ...environment, variables };
}

/** Value types of anonymous-object fields, which mixin modules reach through the object receiver. */
export function packageGlobalTypes(files: readonly ParsedGroovyFile[]): Map<string, number> {
  const types = new Map<string, number>();
  for (const file of files) {
    if (file.root?.kind !== "scriptBody") continue;
    for (const objectClass of nodeArray(file.root.classes)) {
      const statements = nodeArray(objectClass.fields).map((field) => ({
        kind: "expressionStatement",
        span: field.span,
        expression: {
          kind: "declaration",
          span: field.span,
          left: syntheticVariable(String(field.name), field.span),
          right: asNode(field.initialExpression) ?? { kind: "constant", span: null, value: null },
        },
      }));
      const methods = nodeArray(objectClass.methods)
        .map((method) => asNode(method.body))
        .filter((body) => body !== null);
      const environment = inferVariableTypes({
        kind: "block",
        span: null,
        statements: [...statements, ...methods],
      });
      for (const field of nodeArray(objectClass.fields)) {
        const name = String(field.name);
        const type = environment.variables.get(name);
        if (type !== undefined && asNode(field.initialExpression)?.kind !== "closure")
          types.set(name, type);
      }
    }
  }
  return types;
}

/**
 * Names assigned exactly once across all package files (declarations and object fields included), such as
 * constants shared by mixin modules.
 */
export function packageStableNames(files: readonly ParsedGroovyFile[]): Set<string> {
  const counts = new Map<string, number>();
  const count = (name: string | null): void => {
    if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const file of files) {
    walkAst(file.root, (node) => {
      const operator = typeof node.operator === "string" ? node.operator : "";
      const assigns = operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(operator);
      if (node.kind === "declaration" || (node.kind === "binary" && assigns))
        count(variableName(node.left));
      if (node.kind === "postfix" || node.kind === "prefix") count(variableName(node.value));
      if (node.kind === "field") count(typeof node.name === "string" ? node.name : null);
    });
  }
  return new Set([...counts].filter(([, total]) => total === 1).map(([name]) => name));
}

/** Describes a runtime-loaded mixin module without lowering it; null for ordinary scripts. */
export function describeMixinModule(file: ParsedGroovyFile): MixinModuleInfo | null {
  const body = file.root?.kind === "scriptBody" ? asNode(file.root.body) : null;
  const shape = body === null ? null : mixinShape(body);
  if (shape === null) return null;
  const { directory, name } = moduleNames(file.sourceName);
  const loadFunction = `load${capitalized(name)}Module`;
  const setupFunction = shape.setup === null ? null : `setup${capitalized(name)}Module`;
  const hoisted = shape.loadStatements.flatMap((statement) => {
    const declaration =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const declared = declaration?.kind === "declaration" ? variableName(declaration.left) : null;
    return declared !== null && asNode(declaration?.right)?.kind === "closure" ? [declared] : [];
  });
  return {
    sourceName: file.sourceName,
    directory,
    name,
    loadFunction,
    setupFunction,
    injected: shape.methods.map((method) => method.name),
    functions: [
      ...shape.methods.map((method) => method.name),
      ...hoisted,
      loadFunction,
      ...(setupFunction === null ? [] : [setupFunction]),
    ],
  };
}

/**
 * Flattens a mixin module into an ordinary script body of declarations: injected methods and module-level
 * closures become functions, module-level variables (which injected methods capture) become globals that the
 * load function assigns, and the object receiver is removed (`object.x(...)` becomes `x(...)`).
 */
function desugarMixinModule(
  body: AstNode,
  sourceName: string,
): { body: AstNode; info: MixinModuleInfo; receiverMembers: Set<string> } | null {
  const shape = mixinShape(body);
  const info =
    shape === null
      ? null
      : describeMixinModule({
          formatVersion: 1,
          sourceName,
          groovyVersion: "",
          mode: "script-body",
          root: { kind: "scriptBody", span: null, body },
          diagnostics: [],
        });
  if (shape === null || info === null) return null;
  // A module variable that shares its name with an object member reached as `object.name` keeps its own name
  // apart, since removing the receiver would otherwise make both the same variable.
  const moduleVariables = new Set(
    shape.loadStatements.flatMap((statement) => {
      const expression =
        statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
      const name = expression?.kind === "declaration" ? variableName(expression.left) : null;
      return name === null ? [] : [name];
    }),
  );
  const receiverMembers = new Set<string>();
  walkAst(body, (node) => {
    const name = node.kind === "property" ? constantString(node.property) : null;
    if (name !== null && variableName(node.object) === shape.parameter) receiverMembers.add(name);
  });
  const renamed = new Map(
    [...moduleVariables]
      .filter((name) => receiverMembers.has(name))
      .map((name) => [name, `${name}In${capitalized(info.name)}`]),
  );
  const strip = (node: AstNode): AstNode =>
    stripReceiver(renamed.size === 0 ? node : renameVariables(node, renamed), shape.parameter);
  const declaration = (name: string, right: AstNode, span: SourceSpan | null): AstNode => ({
    kind: "expressionStatement",
    span,
    expression: { kind: "declaration", span, left: syntheticVariable(name, span), right },
  });
  const functionClosure = (statements: AstNode[], span: SourceSpan | null): AstNode => ({
    kind: "closure",
    span,
    parameters: [],
    parameterSpecified: true,
    body: { kind: "block", span, statements },
  });

  const globals: AstNode[] = [];
  const loadBody: AstNode[] = [];
  // Injected methods become functions that exist from the start; Groovy installed them in order.
  const installedAt = new Map(
    shape.methods.map((method) => [method.name, method.closure.span?.line ?? 0]),
  );
  for (const original of shape.loadStatements) {
    const early = new Set<string>();
    walkAst(original, (node) => {
      const call = node.kind === "methodCall" ? callParts(node) : null;
      const line = call === null ? undefined : installedAt.get(call.name);
      if (call !== null && line !== undefined && (original.span?.line ?? 0) < line)
        early.add(call.name);
    });
    if (early.size > 0) {
      loadBody.push({
        kind: "importerNote",
        span: original.span,
        code: "SX_MODULE_EARLY_CALL",
        message: `This load-time code calls ${[...early].join(", ")} before the module installed ${early.size === 1 ? "it" : "them"}, which failed in Groovy; the converted function exists from the start.`,
      });
    }
  }
  for (const statement of shape.loadStatements.map(strip)) {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const name = expression?.kind === "declaration" ? variableName(expression.left) : null;
    const right = asNode(expression?.right);
    if (name !== null && right?.kind === "closure") {
      globals.push(statement);
    } else if (name !== null && right !== null && isLiteralData(right)) {
      // A module constant of literal data, such as `final LUNCH = "lunch"`, starts with its value.
      globals.push(statement);
    } else if (name !== null && right !== null) {
      globals.push(
        declaration(
          name,
          emptyValueLike(right) ?? {
            kind: "unsupportedExpression",
            span: null,
            groovyType: "org.codehaus.groovy.ast.expr.EmptyExpression",
          },
          statement.span,
        ),
      );
      if (!isEmptyGroovyExpression(right)) {
        loadBody.push({
          kind: "expressionStatement",
          span: statement.span,
          expression: {
            kind: "binary",
            span: statement.span,
            operator: "=",
            left: syntheticVariable(name, statement.span),
            right,
          },
        });
      }
    } else {
      loadBody.push(statement);
    }
  }
  const members = shape.methods.map((method) =>
    declaration(method.name, strip(method.closure), method.closure.span),
  );
  members.push(declaration(info.loadFunction, functionClosure(loadBody, body.span), body.span));
  if (shape.setup !== null && info.setupFunction !== null) {
    // The setup closure keeps its parameters; the loader calls it without arguments.
    members.push(declaration(info.setupFunction, strip(shape.setup), shape.setup.span));
  }
  const statements = [...globals, ...members].sort(
    (left, right) => (left.span?.line ?? 0) - (right.span?.line ?? 0),
  );
  return { body: { ...body, statements }, info, receiverMembers };
}

/** Renames plain variable references; member accesses such as `object.name` keep their property names. */
function renameVariables(node: AstNode, names: ReadonlyMap<string, string>): AstNode {
  const name = variableName(node);
  if (name !== null) return names.has(name) ? { ...node, name: names.get(name)! } : node;
  const result: AstNode = { ...node };
  for (const [key, child] of Object.entries(node)) {
    if (key === "span") continue;
    if (isAstNode(child)) result[key] = renameVariables(child, names);
    else if (Array.isArray(child)) {
      result[key] = child.map((item) => {
        if (isAstNode(item)) return renameVariables(item, names);
        // Closure parameters are plain records with a name.
        if (key === "parameters" && isRecord(item) && typeof item.name === "string") {
          const renamedParameter = names.get(item.name);
          if (renamedParameter !== undefined) return { ...item, name: renamedParameter };
        }
        return item;
      });
    }
  }
  return result;
}

function syntheticVariable(name: string, span: SourceSpan | null): AstNode {
  return { kind: "variable", span, name, type: "java.lang.Object" };
}

/** Replaces `object.x(...)` with `x(...)` and `object.x` with `x`; a bare `object` becomes `this`. */
function stripReceiver(node: AstNode, parameter: string): AstNode {
  if (node.kind === "variable" && variableName(node) === parameter)
    return { ...node, name: "this" };
  const propertyName = node.kind === "property" ? constantString(node.property) : null;
  if (propertyName !== null && variableName(node.object) === parameter) {
    return syntheticVariable(propertyName, node.span);
  }
  const result: AstNode = { ...node };
  if (node.kind === "methodCall" && variableName(node.object) === parameter) {
    result.object = syntheticVariable("this", node.span);
    result.implicitThis = true;
  }
  for (const [key, child] of Object.entries(result)) {
    if (key === "span" || key === "object") continue;
    if (isAstNode(child)) result[key] = stripReceiver(child, parameter);
    else if (Array.isArray(child)) {
      result[key] = child.map((item) => (isAstNode(item) ? stripReceiver(item, parameter) : item));
    }
  }
  const object = asNode(result.object);
  if (object !== null && result.implicitThis !== true)
    result.object = stripReceiver(object, parameter);
  return result;
}

/**
 * Some packages wrap the whole script in an anonymous object: `return new Object() { fields; methods }.main()`.
 * Construction runs the field initializers in order and then the entry method, so the importer flattens it into
 * an ordinary script body: fields become declarations, methods become closure declarations (lowered to
 * functions like other closures), and the entry method's statements run last.
 */
function desugarObjectScript(
  body: AstNode | null,
  classes: AstNode[],
  context: LowerContext,
): AstNode | null {
  const parts = body === null ? null : objectScriptParts(body, classes);
  if (body === null || parts === null) return body;
  const { statements, members, objectClass } = parts;
  const entryStatements = replaceModuleLoader(members, parts.entryStatements, context);
  for (const nested of classes) {
    if (nested !== objectClass && nested.outerClass === objectClass.name) {
      addDiagnostic(
        context,
        "SX_NESTED_CLASS",
        "warning",
        `Nested class ${String(nested.name).split("$").at(-1)} has no TeaseScript equivalent; its constructor calls are reported where they occur.`,
        nested.span,
      );
    }
  }
  return { ...body, statements: [...statements, ...members, ...entryStatements] };
}

/**
 * Methods without the overloads that only cast their parameters for another method of the same name and arity, such
 * as `void adjust(double p) { adjust((int) p) }` beside `void adjust(int p) { ... }`: TeaseScript has one function per
 * name, so the method they called starts by casting those parameters itself, as the dropped overload did.
 */
function withoutCastOverloads(methods: AstNode[]): AstNode[] {
  const targets = new Map<AstNode, { target: AstNode; casts: Array<string | null> }>();
  for (const method of methods) {
    const statements = nodeArray(asNode(method.body)?.statements);
    const only = statements.length === 1 ? statements[0]! : null;
    const call = asNode(only?.kind === "return" ? only.value : only?.expression);
    const parameters = parameterRecords(method).map((parameter) => text(parameter.name));
    if (call?.kind !== "methodCall" || call.implicitThis !== true) continue;
    if (constantString(call.method) !== method.name) continue;
    const items = nodeArray(asNode(call.arguments)?.items);
    if (items.length !== parameters.length) continue;
    const casts = items.map((item, index) =>
      item.kind === "cast" && variableName(asNode(item.value)) === parameters[index]
        ? text(item.type)
        : variableName(item) === parameters[index]
          ? null
          : undefined,
    );
    if (casts.includes(undefined) || casts.every((cast) => cast === null)) continue;
    // The called overload takes the cast types where the call casts.
    const target = methods.filter(
      (other) =>
        other !== method &&
        other.name === method.name &&
        parameterRecords(other).length === parameters.length &&
        casts.every(
          (cast, index) => cast === null || text(parameterRecords(other)[index]?.type) === cast,
        ),
    );
    if (target.length === 1)
      targets.set(method, { target: target[0]!, casts: casts.map((cast) => cast ?? null) });
  }
  if (targets.size === 0) return methods;
  return methods.flatMap((method) => {
    if (targets.has(method) && !targets.has(targets.get(method)!.target)) return [];
    const casts = [...targets.values()].filter(({ target }) => target === method);
    if (casts.length === 0) return [method];
    const span = method.span ?? null;
    const names = parameterRecords(method).map((parameter) => text(parameter.name));
    const types = names.map(
      (_, index) => casts.find((cast) => cast.casts[index] !== null)?.casts[index] ?? null,
    );
    const conversions = names.flatMap((name, index): AstNode[] => {
      const type = types[index];
      if (name === null || type === null || type === undefined) return [];
      const variable = (): AstNode => ({ kind: "variable", span, name, type: "java.lang.Object" });
      return [
        {
          kind: "expressionStatement",
          span,
          expression: {
            kind: "binary",
            span,
            operator: "=",
            left: variable(),
            right: { kind: "cast", span, type, value: variable() },
          },
        },
      ];
    });
    const body = asNode(method.body);
    return [
      {
        ...method,
        body: { ...body, statements: [...conversions, ...nodeArray(body?.statements)] },
      },
    ];
  });
}

/** A method's or closure's parameters, plain records with a name and a type. */
function parameterRecords(node: AstNode): Array<Record<string, unknown>> {
  return Array.isArray(node.parameters) ? node.parameters.filter(isRecord) : [];
}

/**
 * An object script's statements before the construction, its fields and other methods as declarations, and the entry
 * method's statements; null when the body does not end by constructing one of its classes and calling a method
 * without arguments.
 */
function objectScriptParts(
  body: AstNode,
  classes: AstNode[],
): {
  statements: AstNode[];
  members: AstNode[];
  entryStatements: AstNode[];
  objectClass: AstNode;
} | null {
  const statements = body.kind === "block" ? nodeArray(body.statements) : [];
  const last = statements.at(-1);
  const call = last?.kind === "return" ? asNode(last.value) : null;
  const constructor = call?.kind === "methodCall" ? asNode(call.object) : null;
  const entryName = call === null ? null : constantString(call.method);
  const objectClass = classes.find((item) => item.name === constructor?.type);
  const callArguments = call === null ? [] : nodeArray(asNode(call.arguments)?.items);
  if (constructor?.kind !== "constructorCall" || objectClass === undefined) return null;
  const methods = withoutCastOverloads(nodeArray(objectClass.methods));
  const entry = methods.find((method) => method.name === entryName);
  const entryBody = asNode(entry?.body);
  if (entry === undefined || entryBody?.kind !== "block" || callArguments.length > 0) return null;

  const members: AstNode[] = [];
  for (const field of nodeArray(objectClass.fields)) {
    const left: AstNode = {
      kind: "variable",
      span: field.span,
      name: field.name,
      type: "java.lang.Object",
    };
    const right = asNode(field.initialExpression) ?? {
      kind: "constant",
      span: field.span,
      value: null,
    };
    const declaration = { kind: "declaration", span: field.span, left, right };
    members.push({ kind: "expressionStatement", span: field.span, expression: declaration });
  }
  for (const method of methods) {
    if (method === entry) continue;
    const left: AstNode = {
      kind: "variable",
      span: method.span,
      name: method.name,
      type: "java.lang.Object",
    };
    const closure: AstNode = {
      kind: "closure",
      span: method.span,
      parameters: method.parameters,
      parameterSpecified: true,
      body: method.body,
      implicitReturn: method.returnType !== "void",
    };
    const declaration = { kind: "declaration", span: method.span, left, right: closure };
    members.push({ kind: "expressionStatement", span: method.span, expression: declaration });
  }
  members.sort((left, right) => (left.span?.line ?? 0) - (right.span?.line ?? 0));
  return {
    statements: statements.slice(0, -1),
    members,
    entryStatements: nodeArray(entryBody.statements),
    objectClass,
  };
}

/**
 * Replaces a runtime module loader (directory listing plus Groovy evaluation of each file) by direct calls to the
 * package's mixin modules in file-name order, and the later `setups.each { it() }` by calls to their setup
 * functions. Mutates the loader member in place and returns the rewritten entry statements.
 */
function replaceModuleLoader(
  members: AstNode[],
  entryStatements: AstNode[],
  context: LowerContext,
): AstNode[] {
  let loaderName: string | null = null;
  let modules: MixinModuleInfo[] = [];
  for (const member of members) {
    const declaration = asNode(member.expression);
    const closure = asNode(declaration?.right);
    const name = variableName(declaration?.left);
    const directory = closure?.kind === "closure" ? moduleLoaderDirectory(closure) : null;
    if (declaration === null || closure === null || name === null || directory === null) continue;
    modules = context.mixinModules
      .filter((module) => module.directory === directory)
      .toSorted((left, right) => left.name.localeCompare(right.name));
    if (modules.length === 0) continue;
    // Replacing the loader would silently skip a file of that directory that is not a recognized module.
    const recognized = new Set(modules.map((module) => module.sourceName));
    const others = (context.directoryFiles.get(directory) ?? []).filter(
      (name) => !recognized.has(name),
    );
    if (others.length > 0) {
      addDiagnostic(
        context,
        "SX_MODULE_UNRECOGNIZED",
        "error",
        `The loader evaluates every file in scripts/${directory}, but ${others.map((name) => name.split(/[\\/]/u).at(-1)).join(", ")} ${others.length === 1 ? "is" : "are"} not a mixin module the importer can convert (for example a module whose result depends on its control flow); the loader is kept as written.`,
        closure.span,
      );
      modules = [];
      continue;
    }
    loaderName = name;
    context.loadsModuleDirectories.add(directory);
    const span = closure.span;
    const note: AstNode = {
      kind: "importerNote",
      span,
      code: "SX_MODULE_LOADER",
      message: `Replaced runtime loading of scripts/${directory}/*.groovy (directory listing and Groovy evaluation) with direct calls to its ${modules.length} modules in file-name order, the order Windows lists them.`,
    };
    declaration.right = {
      ...closure,
      parameters: [],
      parameterSpecified: true,
      body: {
        kind: "block",
        span,
        statements: [note, ...modules.map((module) => callStatement(module.loadFunction, span))],
      },
    };
  }
  if (loaderName === null) return entryStatements;

  const setupVariables = new Set<string>();
  return entryStatements.flatMap((statement): AstNode[] => {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const value = asNode(expression?.right);
    if (
      expression?.kind === "declaration" &&
      value !== null &&
      callParts(value)?.name === loaderName
    ) {
      const variable = variableName(expression.left);
      if (variable !== null) setupVariables.add(variable);
      return [callStatement(loaderName, statement.span)];
    }
    const call = expression === null ? null : callParts(expression);
    if (call?.name === loaderName) return [callStatement(loaderName, statement.span)];
    if (
      call?.name === "each" &&
      setupVariables.has(variableName(expression?.object) ?? "") &&
      call.arguments.length === 1 &&
      callsOwnParameter(call.arguments[0]!)
    ) {
      return modules.flatMap((module) =>
        module.setupFunction === null ? [] : [callStatement(module.setupFunction, statement.span)],
      );
    }
    return [statement];
  });
}

function callStatement(name: string, span: SourceSpan | null): AstNode {
  return {
    kind: "expressionStatement",
    span,
    expression: {
      kind: "methodCall",
      span,
      object: syntheticVariable("this", span),
      method: { kind: "constant", span, value: name },
      arguments: { kind: "arguments", span, items: [] },
      implicitThis: true,
      safe: false,
      spreadSafe: false,
    },
  };
}

/** The body of a one-parameter closure as its parameter name and single expression. */
function closureExpression(closure: AstNode): { parameter: string; expression: AstNode } | null {
  if (closure.kind !== "closure") return null;
  const parameters = groovyParameters(closure.parameters) ?? [];
  const parameter = closure.parameterSpecified === true ? parameters[0]?.name : "it";
  const statements = nodeArray(asNode(closure.body)?.statements);
  const only = statements.length === 1 ? statements[0] : undefined;
  const expression = asNode(only?.kind === "return" ? only.value : only?.expression);
  return parameter === undefined || parameters.length > 1 || expression === null
    ? null
    : { parameter, expression };
}

/** `{ p -> p() }`: runs each setup callback without arguments. */
function callsOwnParameter(closure: AstNode): boolean {
  const body = closureExpression(closure);
  const call = body === null ? null : callParts(body.expression);
  return (
    call !== null && call.inherited && call.name === body?.parameter && call.arguments.length === 0
  );
}

/**
 * The loader's file selection and result filter, exactly: `findAll { f -> f.name.endsWith(".groovy") }` and
 * `findAll { p -> p }`. Any other selection would load a different set of modules.
 */
function isModuleLoaderFilter(closure: AstNode): boolean {
  const body = closureExpression(closure);
  if (body === null) return false;
  if (variableName(body.expression) === body.parameter) return true;
  const call = callParts(body.expression);
  const receiver = asNode(body.expression.object);
  const argument = call?.arguments[0];
  return (
    call?.name === "endsWith" &&
    receiver?.kind === "property" &&
    constantString(receiver.property) === "name" &&
    variableName(receiver.object) === body.parameter &&
    argument?.kind === "constant" &&
    argument.value === ".groovy"
  );
}

/** Directories whose mixin modules a script loads at runtime. */
export function loadedModuleDirectories(file: ParsedGroovyFile): string[] {
  const directories = new Set<string>();
  walkAst(file.root, (node) => {
    const directory = node.kind === "closure" ? moduleLoaderDirectory(node) : null;
    if (directory !== null) directories.add(directory);
  });
  return [...directories];
}

/** Calls of a recognized loader: listing, the two filters, evaluation of each file, and calling its result. */
const LOADER_CALLS = new Set(["listFiles", "findAll", "collect", "me", "call", "endsWith"]);

/** `new File(".../scripts/<dir>").listFiles()` combined with `Eval.me(...)` marks a module loader closure. */
function moduleLoaderDirectory(closure: AstNode): string | null {
  let evaluates = false;
  let lists = false;
  let exact = true;
  let directory: string | null = null;
  walkAst(closure.body, (node) => {
    if (node.kind === "methodCall") {
      const name = constantString(node.method);
      // The loader evaluates each listed file's own text and nothing else happens to the list.
      if (name === null || !LOADER_CALLS.has(name)) exact = false;
      if (name === "me" && variableName(node.object) === "Eval") {
        evaluates = true;
        const source = nodeArray(asNode(node.arguments)?.items)[0];
        if (source?.kind !== "property" || constantString(source.property) !== "text")
          exact = false;
      }
      if (name === "listFiles") lists = true;
      if (name === "findAll") {
        const filter = nodeArray(asNode(node.arguments)?.items)[0];
        if (filter === undefined || !isModuleLoaderFilter(filter)) exact = false;
      }
    }
    if (node.kind === "constructorCall" && (node.type === "File" || node.type === "java.io.File")) {
      walkAst(node.arguments, (argument) => {
        const texts =
          argument.kind === "constant" && typeof argument.value === "string"
            ? [argument.value]
            : argument.kind === "gstring" && Array.isArray(argument.strings)
              ? argument.strings.filter((part): part is string => typeof part === "string")
              : [];
        for (const text of texts) {
          const match = /scripts\/([^/]+)\/?$/u.exec(text);
          if (match !== null) directory = match[1]!;
        }
      });
    }
  });
  return evaluates && lists && exact ? directory : null;
}

function collectClosureInfo(body: AstNode): Map<string, ClosureInfo> {
  const result = new Map<string, ClosureInfo>();
  const add = (name: string, closure: AstNode, nested: boolean): void => {
    const implicitParameter = closure.parameterSpecified !== true;
    const parameters = groovyParameters(closure.parameters) ?? [];
    const minArgs = implicitParameter
      ? 0
      : parameters.filter((parameter) => parameter.defaultValue === null).length;
    result.set(name, {
      implicitParameter,
      minArgs,
      maxArgs: implicitParameter ? 0 : parameters.length,
      ...(nested ? { nested } : {}),
    });
  };
  for (const statement of nodeArray(body.statements)) {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    if (expression?.kind !== "declaration") continue;
    const name = variableName(expression.left);
    const closure = asNode(expression.right);
    if (name === null || closure?.kind !== "closure") continue;
    add(name, closure, false);
  }
  // A closure declared in a block of the script, such as an `if` body, becomes a script function at the top too, where
  // TeaseScript declares functions, when that keeps what each name refers to: nothing else declares or binds its name,
  // every use of the name follows the declaration in its block, and the closure reads no variable that a block or loop
  // around it declares, apart from other closures lifted so.
  const declarations = new Map<string, number>();
  const bound = new Set<string>();
  walkAst(body, (node) => {
    const name = node.kind === "declaration" ? variableName(node.left) : null;
    if (name !== null) declarations.set(name, (declarations.get(name) ?? 0) + 1);
    if (node.kind === "for" && typeof node.variable === "string") bound.add(node.variable);
    if (node.kind === "closure") {
      for (const parameter of groovyParameters(node.parameters) ?? []) bound.add(parameter.name);
      if (node.parameterSpecified !== true) bound.add("it");
    }
  });
  type Placed = { node: AstNode; blocks: readonly AstNode[] };
  const uses = new Map<string, Placed[]>();
  // The scopes, blocks and loops, that declare each variable of a block of the script.
  const blockLocals = new Map<string, AstNode[]>();
  const local = (name: string, scope: AstNode): void => {
    blockLocals.set(name, [...(blockLocals.get(name) ?? []), scope]);
  };
  const nested: Array<{ name: string; closure: AstNode; at: Placed }> = [];
  const place = (node: AstNode, blocks: readonly AstNode[], script: boolean): void => {
    const inner = node.kind === "block" || node.kind === "for" ? [...blocks, node] : blocks;
    const name =
      node.kind === "variable"
        ? variableName(node)
        : node.kind === "methodCall" && node.implicitThis === true
          ? constantString(node.method)
          : null;
    if (name !== null) uses.set(name, [...(uses.get(name) ?? []), { node, blocks: inner }]);
    // The script's own blocks, outside closures and apart from its top level; a loop's variable belongs to its loop.
    const nestedHere = script && blocks.length > 1;
    if (script && node.kind === "for" && typeof node.variable === "string")
      local(node.variable, node);
    if (nestedHere && node.kind === "declaration") {
      const declared = variableName(node.left);
      const closure = asNode(node.right);
      if (declared !== null) local(declared, blocks.at(-1)!);
      if (declared !== null && closure?.kind === "closure")
        nested.push({ name: declared, closure, at: { node, blocks: inner } });
    }
    for (const child of nodeChildren(node)) place(child, inner, script && node.kind !== "closure");
  };
  place(body, [], true);
  const after = (node: AstNode, start: AstNode): boolean => {
    const a = node.span;
    const b = start.span;
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return a.line > b.line || (a.line === b.line && a.column >= b.column);
  };
  let lifted = nested.filter(({ name, at }) => {
    const block = at.blocks.at(-1);
    return (
      declarations.get(name) === 1 &&
      !bound.has(name) &&
      !result.has(name) &&
      block !== undefined &&
      (uses.get(name) ?? []).every((use) => use.blocks.includes(block) && after(use.node, at.node))
    );
  });
  for (let changed = true; changed;) {
    const names = new Set(lifted.map(({ name }) => name));
    const kept = lifted.filter(({ closure, at }) => {
      let reads = false;
      walkAst(closure, (node) => {
        // Calling a closure of such a block reads it too.
        const read =
          node.kind === "variable"
            ? variableName(node)
            : node.kind === "methodCall" && node.implicitThis === true
              ? constantString(node.method)
              : null;
        const scopes = read === null || names.has(read) ? [] : (blockLocals.get(read) ?? []);
        if (scopes.some((scope) => at.blocks.includes(scope))) reads = true;
      });
      return !reads;
    });
    changed = kept.length !== lifted.length;
    lifted = kept;
  }
  for (const { name, closure } of lifted) add(name, closure, true);

  walkAst(body, (node) => {
    if (node.kind !== "methodCall" || node.implicitThis !== true) return;
    const name = constantString(node.method);
    if (name === null) return;
    const info = result.get(name);
    if (info === undefined || !info.implicitParameter) return;
    const argumentsNode = asNode(node.arguments);
    const argumentCount = argumentsNode === null ? 0 : nodeArray(argumentsNode.items).length;
    if (argumentCount === 1) info.maxArgs = 1;
  });
  return result;
}

/** Calls the action a closure value stands for through the generated package dispatcher. */
function actionCall(
  action: IrExpression,
  args: IrExpression[],
  context: LowerContext,
): IrExpression {
  context.actions.add(ACTION_DISPATCHER_MARKER);
  return {
    kind: "call",
    name: ACTION_DISPATCHER,
    positional: [action, { kind: "list", items: args }],
    named: {},
  };
}

/**
 * A path of the package's legacy data folder as file tests compare it: forward slashes, without a leading `./`, `/`,
 * or `scripts/` (the folder of the scripts, which the package root holds), in lower case, as the legacy player's file
 * systems ignored case.
 */
export function packageFilePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^(?:\.?\/)+/u, "")
    .replace(/^scripts\//iu, "")
    .toLowerCase();
}

/**
 * `new File("images/x.jpg") << new File(photo).getBytes()` (or `photo.getBytes()`): the target's path below `images/`
 * and the photo; null for another statement.
 */
export function photoCopy(node: AstNode): { path: string; source: AstNode } | null {
  if (node.kind !== "binary" || node.operator !== "<<") return null;
  const target = asNode(node.left);
  const bytes = asNode(node.right);
  const path =
    target !== null && isFileConstructor(target)
      ? constantString(nodeArray(asNode(target.arguments)?.items)[0])
      : null;
  if (path === null || !/^images\//iu.test(path)) return null;
  if (
    bytes?.kind !== "methodCall" ||
    !["getBytes", "bytes"].includes(constantString(bytes.method) ?? "")
  )
    return null;
  const file = asNode(bytes.object);
  const source =
    file !== null && isFileConstructor(file)
      ? (nodeArray(asNode(file.arguments)?.items)[0] ?? null)
      : file;
  return source === null ? null : { path: path.slice("images/".length), source };
}

function isFileConstructor(node: AstNode): boolean {
  return (
    node.kind === "constructorCall" &&
    (node.type === "File" || node.type === "java.io.File") &&
    nodeArray(asNode(node.arguments)?.items).length === 1
  );
}

/** Members that go through the files of a folder with a closure. */
const FOLDER_WALKS = new Set(["eachFile", "eachFileRecurse", "eachDir", "eachFileMatch"]);

/** Groovy's `FileType.FILES`, also written `groovy.io.FileType.FILES`, which walks only through files. */
function isFilesOnly(node: AstNode, context: LowerContext): boolean {
  const name = (value: AstNode | null): string | null => {
    if (value?.kind === "variable") return variableName(value);
    if (value?.kind === "classExpression") return text(value.type) ?? null;
    if (value?.kind !== "property") return null;
    const owner = name(asNode(value.object));
    const property = constantString(value.property);
    return owner === null || property === null ? null : `${owner}.${property}`;
  };
  const written = name(node);
  // Groovy resolves the qualified name to the enum, also where a variable is named `groovy`.
  if (written === "groovy.io.FileType.FILES") return true;
  if (written !== "FileType.FILES") return false;
  // A variable or parameter named FileType, `def FileType = [FILES: null]`, is no enum.
  const owner = asNode(node.object);
  if (owner?.kind !== "variable") return true;
  const key = bindingKey(owner, context.pathBindings?.keys ?? context.bindings) ?? "FileType";
  return !(
    key !== "FileType" ||
    context.assignedValues.has("FileType") ||
    context.pathBindings?.values.has("FileType") === true ||
    context.constantInitializers.has("FileType") ||
    context.changingPaths.has("FileType")
  );
}

/**
 * Bindings whose value a path cannot be read from at conversion time, by binding key: those a compound assignment or
 * `++` changes in place, and parameters and loop variables, which get values from outside.
 */
function changingVariables(body: AstNode, keys: BindingKeys): Set<string> {
  const changing = new Set<string>();
  // The keys of the reads of a parameter or loop variable in its own body, apart from a nested closure's own.
  const bound = (scope: AstNode, name: string): void => {
    const visit = (node: AstNode): void => {
      if (node !== scope && node.kind === "closure") {
        const own = (groovyParameters(node.parameters) ?? []).map((parameter) => parameter.name);
        if (own.includes(name) || (name === "it" && node.parameterSpecified !== true)) return;
      }
      if (node.kind === "variable" && variableName(node) === name) {
        const key = bindingKey(node, keys);
        if (key !== null) changing.add(key);
      }
      for (const child of nodeChildren(node)) visit(child);
    };
    visit(scope);
  };
  walkAst(body, (node) => {
    const operator = node.kind === "binary" ? text(node.operator) : null;
    const updated =
      (operator !== null &&
        operator.endsWith("=") &&
        !["=", "==", "!=", "<=", ">=", "==="].includes(operator)) ||
      node.kind === "postfix" ||
      node.kind === "prefix"
        ? (bindingKey(asNode(node.kind === "binary" ? node.left : node.value), keys) ?? null)
        : null;
    if (updated !== null) changing.add(updated);
    if (node.kind === "closure") {
      for (const parameter of groovyParameters(node.parameters) ?? []) bound(node, parameter.name);
      if (node.parameterSpecified !== true) bound(node, "it");
    }
    if (node.kind === "for" && typeof node.variable === "string") bound(node, node.variable);
  });
  return changing;
}

/**
 * The `new File(path)` values whose only use is `.exists()`, `.listFiles()`, or a walk through the folder's files
 * (FOLDER_WALKS): directly as its receiver, or kept in a variable that nothing reads otherwise
 * (LowerContext.fileValues, fileVariables).
 */
function fileTests(body: AstNode): {
  fileValues: Set<AstNode>;
  fileVariables: Set<string>;
  filePathOwners: Map<AstNode, string>;
} {
  const assigned = new Map<string, AstNode[]>();
  const otherUses = new Set<string>();
  const existsReceivers = new Set<AstNode>();
  const targets = new Set<AstNode>();
  walkAst(body, (node) => {
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    const name = assigns ? variableName(node.left) : null;
    const value = assigns ? asNode(node.right) : null;
    if (assigns && asNode(node.left) !== null) targets.add(asNode(node.left)!);
    if (name !== null && value !== null) {
      if (isFileConstructor(value)) assigned.set(name, [...(assigned.get(name) ?? []), value]);
      else if (!isEmptyGroovyExpression(value) && !isNullConstant(value)) otherUses.add(name);
    }
    const method = node.kind === "methodCall" ? constantString(node.method) : null;
    if (
      method === "exists" ||
      (method === "listFiles" && nodeArray(asNode(node.arguments)?.items).length === 0) ||
      (method !== null && FOLDER_WALKS.has(method))
    ) {
      const receiver = asNode(node.object);
      if (receiver !== null) existsReceivers.add(receiver);
    }
  });
  walkAst(body, (node) => {
    const name = node.kind === "variable" ? variableName(node) : null;
    if (name === null || !assigned.has(name) || existsReceivers.has(node) || targets.has(node))
      return;
    otherUses.add(name);
  });
  for (const name of otherUses) assigned.delete(name);
  return {
    fileValues: new Set([...assigned.values()].flat()),
    fileVariables: new Set(assigned.keys()),
    filePathOwners: new Map(
      [...assigned].flatMap(([name, values]) =>
        values.map((value): [AstNode, string] => [value, name]),
      ),
    ),
  };
}

/** Whether every read of `name` in the current function is a file size read, `name.getBytes().size()` or `.length()`. */
function onlySizeReads(name: string, context: LowerContext): boolean {
  const body = context.currentFunction?.body;
  if (body === undefined) return false;
  const sizeReceivers = new Set<AstNode>();
  const targets = new Set<AstNode>();
  walkAst(body, (node) => {
    if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) {
      const left = asNode(node.left);
      if (left !== null) targets.add(left);
    }
    if (node.kind !== "methodCall") return;
    const method = constantString(node.method);
    const receiver = asNode(node.object);
    if (method === "length" && receiver !== null) sizeReceivers.add(receiver);
    if (
      method === "size" &&
      receiver?.kind === "methodCall" &&
      constantString(receiver.method) === "getBytes"
    ) {
      const file = asNode(receiver.object);
      if (file !== null) sizeReceivers.add(file);
    }
  });
  let reads = 0;
  let others = false;
  walkAst(body, (node) => {
    if (node.kind !== "variable" || variableName(node) !== name || targets.has(node)) return;
    reads += 1;
    if (!sizeReceivers.has(node)) others = true;
  });
  return reads > 0 && !others;
}

/** A `new File(path)`, or a variable that only ever holds one. */
function isFileValue(node: AstNode | null, context: LowerContext): boolean {
  if (node === null) return false;
  if (isFileConstructor(node)) return true;
  const key = node.kind === "variable" ? bindingKey(node, context.bindings) : null;
  const values = key === null ? undefined : context.assignedValues.get(key);
  return values !== undefined && values.length > 0 && values.every(isFileConstructor);
}

/**
 * `new File(path).exists()` checked against the package's files when it is converted: a literal path is `true` or
 * `false`, and a computed path is looked up in the package files below the path's fixed beginning. A program
 * (`.exe`) never exists, since a package cannot start one.
 */
function fileExists(
  pathNode: AstNode,
  node: AstNode,
  context: LowerContext,
  files: ReadonlySet<string>,
): IrExpression | null {
  const present = [...files].filter((file) => !file.endsWith(".exe"));
  addDiagnostic(
    context,
    "SX_FILE_EXISTS",
    "warning",
    "The legacy script tested whether a file exists on the player's computer; the test reads the package's files as they were converted, and a program (.exe) never exists.",
    node.span,
  );
  // A path of text and getDataFolder(), or a variable that only ever holds such paths, is known now.
  const variable = variableName(pathNode);
  // A folder of the player's home existed on the computer (SX_HOME_FOLDER).
  const sources = context.fileVariables.has(variable ?? "")
    ? [...context.filePathOwners]
        .filter(([, owner]) => owner === variable)
        .map(([value]) => nodeArray(asNode(value.arguments)?.items)[0] ?? value)
    : [pathNode];
  if (sources.some(isHomePath)) {
    if (sources.every(isHomePath)) return { kind: "literal", value: true };
    const path = lowerExpression(pathNode, context);
    const others = fileExists(
      pathNode,
      node,
      { ...context, fileVariables: new Set(), filePathOwners: new Map() },
      files,
    );
    if (path === null || others === null) return null;
    return {
      kind: "binary",
      operator: "or",
      left: {
        kind: "methodCall",
        target: path,
        name: "startsWith",
        arguments: [{ kind: "literal", value: "~" }],
      },
      right: others,
    };
  }
  const paths = context.fileVariables.has(variable ?? "")
    ? [...context.filePathOwners]
        .filter(([, owner]) => owner === variable)
        .map(([value]) => staticPath(nodeArray(asNode(value.arguments)?.items)[0] ?? value))
    : [staticPath(pathNode)];
  const results = paths.every((path) => path.complete)
    ? paths.map((path) => present.includes(packageFilePath(path.text)))
    : [];
  if (results.length > 0 && results.every((result) => result === results[0]))
    return { kind: "literal", value: results[0]! };
  const path = lowerExpression(pathNode, context);
  if (path === null) return null;
  const prefix = packageFilePath(staticPath(pathNode).text);
  const candidates = present.filter((file) => file.startsWith(prefix)).sort();
  if (candidates.length === 0) return { kind: "literal", value: false };
  return {
    kind: "methodCall",
    target: {
      kind: "list",
      items: candidates.map((file) => ({ kind: "literal" as const, value: file })),
    },
    name: "contains",
    arguments: [useHelper(context, "packagePath", [path])],
  };
}

/**
 * The full path of the legacy player's folder, `new File(".").absolutePath`, which the computer provided: asked once as
 * the system speaker (owner decision). Undefined for another receiver or property.
 */
function playerFolder(
  receiver: AstNode,
  property: string,
  node: AstNode,
  context: LowerContext,
): IrExpression | undefined {
  if (
    !isFileConstructor(receiver) ||
    constantString(nodeArray(asNode(receiver.arguments)?.items)[0]) !== "." ||
    !["absolutePath", "canonicalPath", "getAbsolutePath", "getCanonicalPath"].includes(property)
  )
    return undefined;
  addDiagnostic(
    context,
    "SX_OS_INFO",
    "warning",
    'The legacy script read the full path of the player\'s folder on the computer, which a browser does not provide; the player is asked once, as the system speaker, and the answer is saved as "system.playerFolder".',
    node.span,
  );
  return useHelper(context, "askOnce", [
    { kind: "literal", value: "system.playerFolder" },
    { kind: "literal", value: "Which folder holds your SexScripts player?" },
  ]);
}

/**
 * A read of a web address, `address.toURL().text` or `new URL(address).text`, which an online service answered: a
 * package has no such service (owner decision), so a system notice before the statement shows the request the
 * original made, with secret query values hidden, and the read is empty, as when the service answered nothing, so code
 * that goes on with the answer still runs. Undefined for any
 * other receiver.
 */
function onlineRequest(
  receiver: AstNode,
  node: AstNode,
  context: LowerContext,
): IrExpression | null | undefined {
  const address =
    receiver.kind === "methodCall" &&
    constantString(receiver.method) === "toURL" &&
    nodeArray(asNode(receiver.arguments)?.items).length === 0
      ? asNode(receiver.object)
      : receiver.kind === "constructorCall" &&
          (receiver.type === "URL" || receiver.type === "java.net.URL") &&
          nodeArray(asNode(receiver.arguments)?.items).length === 1
        ? nodeArray(asNode(receiver.arguments)?.items)[0]!
        : null;
  if (address === null) return undefined;
  const url = lowerExpression(address, context);
  if (url === null) return null;
  addDiagnostic(
    context,
    "SX_ONLINE_REQUEST",
    "warning",
    "The legacy script read this web address from an online service, which a package cannot reach; a system notice shows the request, with secret values hidden, and the read is empty, as when the service answered nothing.",
    node.span,
  );
  const shown =
    url.kind === "literal" && typeof url.value === "string"
      ? { text: maskedUrl(url.value) }
      : { value: useHelper(context, "maskUrl", [url]) };
  context.prelude.push(
    systemSay(
      templateOrLiteral([
        { text: "Online feature not available here. The original would have requested: GET " },
        shown,
      ]),
      node.span,
      context,
    ),
  );
  return node.kind === "methodCall" && constantString(node.method) === "readLines"
    ? { kind: "list", items: [] }
    : { kind: "literal", value: "" };
}

/** A URL with the values of query parameters named like a key, token, or password hidden (helper `maskUrl`). */
export function maskedUrl(url: string): string {
  const [base, query] = url.split("?");
  if (query === undefined) return url;
  const pairs = query.split("&").map((pair) => {
    const field = pair.split("=")[0]!;
    return SECRET_PARAMETER_PARTS.some((part) => field.toLowerCase().includes(part))
      ? `${field}=…`
      : pair;
  });
  return `${base}?${pairs.join("&")}`;
}

/**
 * `text ==~ /.*\d+\.jpg/`, Groovy's whole match of a pattern that a text matches by its end (parseTailPattern), as
 * text operations; undefined for another pattern.
 */
function tailMatch(node: AstNode, context: LowerContext): IrExpression | null | undefined {
  const leftNode = asNode(node.left);
  const pattern = constantString(node.right);
  const tail = pattern === null ? null : parseTailPattern(pattern);
  // Groovy matched the text of the value; a proven number or list stays manual.
  const type = leftNode === null ? 0 : inferType(leftNode, context.types);
  if (leftNode === null || tail === null || (type & STRING) === 0) return undefined;
  const value = lowerExpression(leftNode, context);
  if (value === null) return null;
  const text: IrExpression = tail.insensitive
    ? {
        kind: "methodCall",
        target: templateOrLiteral([{ value }]),
        name: "lowercase",
        arguments: [],
      }
    : templateOrLiteral([{ value }]);
  const ending: IrExpression = {
    kind: "literal",
    value: tail.insensitive ? tail.tail.toLowerCase() : tail.tail,
  };
  return tail.digits
    ? useHelper(context, "endsWithDigits", [text, ending])
    : { kind: "methodCall", target: text, name: "endsWith", arguments: [ending] };
}

/**
 * `new File(imagesFolder).eachFile { file -> ... }`: a loop over the package paths of the folder's images, found by the
 * tag of the folder's path (imageFolderListing); the loop variable answers what the closure asked of each File
 * (listedImageMember). The legacy walk also visited subfolders and other files. Undefined for another receiver.
 */
function imageFolderWalk(
  node: AstNode,
  receiver: AstNode,
  closure: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | undefined {
  const body = asNode(closure.body);
  const parameters = groovyParameters(closure.parameters);
  if (body?.kind !== "block" || parameters === null || parameters.length > 1) return undefined;
  if (imageFolderPaths(receiver, context) === null) return undefined;
  const returns = closureReturns(body);
  if (returns.some(({ insideLoop, value }) => insideLoop || value !== null)) return undefined;
  const images = imageFolderListing(receiver, node, context);
  if (images === undefined || images === null) return images === null ? [] : undefined;
  const variable = closure.parameterSpecified === true ? parameters[0]!.name : "it";
  const forget = walkVariable(body, variable, "file", context);
  try {
    if (returns.length > 0) noteReturnAsContinue(returns[0]!.node, context);
    const loopBody = lowerBlock(body, context);
    return [
      {
        kind: "for",
        variable,
        collection: images,
        body: returns.length > 0 ? withoutFinalContinue(returnsAsContinue(loopBody)) : loopBody,
        span,
      },
    ];
  } finally {
    forget();
  }
}

/**
 * Marks the reads of a walk's loop variable in its closure, apart from those of a nested closure that names a parameter
 * the same, such as an inner `.each { it }`, as the package path of a file or a subfolder; returns the undoing.
 */
function walkVariable(
  body: AstNode,
  variable: string,
  kind: "file" | "folder",
  context: LowerContext,
): () => void {
  const marked: Array<AstNode | string> = [];
  const visit = (node: AstNode): void => {
    if (node.kind === "closure") {
      const own = (groovyParameters(node.parameters) ?? []).map((parameter) => parameter.name);
      if (own.includes(variable) || (variable === "it" && node.parameterSpecified !== true)) return;
    }
    if (node.kind === "variable" && variableName(node) === variable) {
      marked.push(node);
      const id = bindingSpanId(node);
      if (id !== null) marked.push(id);
    }
    for (const child of nodeChildren(node)) visit(child);
  };
  visit(body);
  const earlier = marked.map((item) => [item, context.walkedEntries.get(item)] as const);
  for (const item of marked) context.walkedEntries.set(item, kind);
  return () => {
    for (const [item, kindBefore] of earlier) {
      if (kindBefore === undefined) context.walkedEntries.delete(item);
      else context.walkedEntries.set(item, kindBefore);
    }
  };
}

/**
 * The text of a path that a script fixes before it runs, with `getDataFolder()` as the package root and a variable
 * that only ever holds one such path read as that path; null for a computed path.
 */
function resolvedPath(
  node: AstNode,
  context: LowerContext,
  seen = new Set<string>(),
): string | null {
  const literal = constantString(node);
  if (literal !== null) return literal;
  if (isDataFolder(node)) return "";
  const variable = variableName(node);
  if (node.kind === "variable" && variable !== null) {
    const keys = context.pathBindings?.keys ?? context.bindings;
    const key = bindingKey(node, keys) ?? variable;
    if (seen.has(key) || context.changingPaths.has(key)) return null;
    const assigned = (context.pathBindings?.values ?? context.assignedValues).get(key) ?? [];
    const initializer = context.constantInitializers.get(variable);
    const values = assigned.length > 0 ? assigned : initializer === undefined ? [] : [initializer];
    const texts = values.map((value) => resolvedPath(value, context, new Set([...seen, key])));
    return texts.length > 0 && texts.every((text) => text !== null && text === texts[0])
      ? texts[0]!
      : null;
  }
  if (node.kind === "gstring") {
    const strings = Array.isArray(node.strings) ? node.strings : [];
    const values = nodeArray(node.values);
    let text = "";
    for (let index = 0; index < strings.length; index += 1) {
      const piece: unknown = strings[index];
      if (typeof piece === "string") text += piece;
      const value = values[index];
      if (value === undefined) continue;
      const part = resolvedPath(value, context, seen);
      if (part === null) return null;
      text += part;
    }
    return text;
  }
  if (node.kind === "binary" && node.operator === "+") {
    const left = asNode(node.left);
    const right = asNode(node.right);
    const start = left === null ? null : resolvedPath(left, context, seen);
    const rest = right === null ? null : resolvedPath(right, context, seen);
    return start === null || rest === null ? null : start + rest;
  }
  return null;
}

/** The package folder a walk goes through, `sounds/Deck/`, from the path its File names; null for a computed one. */
function walkedFolder(receiver: AstNode, context: LowerContext): string | null {
  const variable = variableName(receiver);
  const constructors = isFileConstructor(receiver)
    ? [receiver]
    : variable !== null && context.fileVariables.has(variable)
      ? [...context.filePathOwners].flatMap(([value, owner]) => (owner === variable ? [value] : []))
      : [];
  const texts = constructors.map((value) => {
    const path = nodeArray(asNode(value.arguments)?.items)[0];
    return path === undefined ? null : resolvedPath(path, context);
  });
  if (texts.length === 0 || texts.some((text) => text === null || text !== texts[0])) return null;
  // The folder's path parts, without `.`, empty parts, and a `..` with the part before it.
  const parts: string[] = [];
  for (const part of texts[0]!.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return null;
    } else parts.push(part);
  }
  return parts.length === 0 ? null : `${parts.join("/")}/`;
}

/** The members of a File that a closure asks of its parameter. */
function askedMembers(body: AstNode, variable: string): Set<string> {
  const members = new Set<string>();
  walkAst(body, (node) => {
    const member =
      node.kind === "property"
        ? constantString(node.property)
        : node.kind === "methodCall"
          ? constantString(node.method)
          : null;
    if (member !== null && variableName(node.object) === variable) members.add(member);
  });
  return members;
}

const LISTED_MEDIA_FOLDERS = new Set(["images", "sounds", "videos"]);

/**
 * The kind of entry a walk's closure acts on when its body is one `if` without `else` on the entry's kind:
 * `if (file.isDirectory()) {...}` or `if (file.isFile()) {...}`; null for any other body.
 */
function guardedKind(body: AstNode, variable: string): "folder" | "file" | null {
  const statements = nodeArray(body.statements);
  const only = statements.length === 1 ? statements[0]! : null;
  if (only?.kind !== "if" || branchStatements(only.else).length > 0) return null;
  const condition = asNode(only.condition);
  const member =
    condition?.kind === "methodCall" && nodeArray(asNode(condition.arguments)?.items).length === 0
      ? constantString(condition.method)
      : condition?.kind === "property"
        ? constantString(condition.property)
        : null;
  if (condition === null || variableName(asNode(condition.object)) !== variable) return null;
  if (member === "isDirectory" || member === "directory") return "folder";
  if (member === "isFile" || member === "file") return "file";
  return null;
}

/**
 * A walk through a package folder of images, sounds, or videos whose path the script fixes, as a loop over the
 * package's files or subfolders there, listed at conversion time: `eachFile`, which also visited subfolders, and
 * `eachFileRecurse`, also only through files (`FileType.FILES`). A walk through the images of one folder stays with
 * the folder's tag (imageFolderWalk); the list serves sounds and videos, subfolders, a walk through every level, and a
 * folder the package does not hold, which a note names. Undefined for a computed folder, another folder, or a closure
 * that tells files from subfolders where the folder holds both.
 */
function listedFolderWalk(
  node: AstNode,
  receiver: AstNode,
  closure: AstNode,
  recursive: "all" | "files" | null,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] | undefined {
  const body = asNode(closure.body);
  const parameters = groovyParameters(closure.parameters);
  if (body?.kind !== "block" || parameters === null || parameters.length > 1) return undefined;
  const folder = walkedFolder(receiver, context);
  const root = folder?.split("/")[0]?.toLowerCase();
  if (folder === null || root === undefined || !LISTED_MEDIA_FOLDERS.has(root)) return undefined;
  const variable = closure.parameterSpecified === true ? parameters[0]!.name : "it";
  const asked = askedMembers(body, variable);
  const tellsKinds = ["isFile", "file", "isDirectory", "directory"].some((member) =>
    asked.has(member),
  );
  const returns = closureReturns(body);
  if (returns.some(({ insideLoop, value }) => insideLoop || value !== null)) return undefined;
  // The package's files below the folder, written as the script writes it, or else in another letter case, as the
  // legacy player's file systems ignored case.
  const exact = context.actualFiles.filter((file) => file.startsWith(folder));
  const below =
    exact.length > 0
      ? exact
      : context.actualFiles.filter((file) => file.toLowerCase().startsWith(folder.toLowerCase()));
  const actualFolder = below[0]?.slice(0, folder.length) ?? folder;
  if (below.some((file) => !file.startsWith(actualFolder))) return undefined;
  // The walk's entries with a folder before what it holds, as Groovy visited them, and by name within a folder, where
  // Groovy followed the file system's order.
  const walked: Array<{ path: string; folder: boolean }> = [];
  const visit = (prefix: string): void => {
    const children = new Map<string, boolean>();
    for (const file of below) {
      const rest = file.slice(actualFolder.length);
      if (!rest.startsWith(prefix)) continue;
      const tail = rest.slice(prefix.length);
      const name = tail.split("/")[0]!;
      children.set(name, (children.get(name) ?? false) || tail.includes("/"));
    }
    for (const name of [...children.keys()].sort()) {
      const path = `${prefix}${name}`;
      if (!children.get(name)) walked.push({ path, folder: false });
      else {
        if (recursive !== "files") walked.push({ path, folder: true });
        if (recursive !== null) visit(`${path}/`);
      }
    }
  };
  visit("");
  const files = walked.filter((entry) => !entry.folder);
  const folders = walked.filter((entry) => entry.folder);
  // A closure that only acts on one kind, as Baccarat's `if (file.isDirectory()) names << file.getName()`, goes
  // through that kind: the entries of the other one did nothing.
  const guarded = guardedKind(body, variable);
  if (tellsKinds && guarded === null && files.length > 0 && folders.length > 0) return undefined;
  // A walk that tells files from subfolders goes through the kind the folder holds.
  const listsFolders = tellsKinds && (guarded === null ? folders.length > 0 : guarded === "folder");
  // A walk through the images the package holds in one folder finds them by the folder's tag (imageFolderWalk).
  if (root === "images" && recursive === null && !listsFolders && files.length > 0)
    return undefined;
  const entries = (tellsKinds ? (listsFolders ? folders : files) : walked).map(
    (entry) => entry.path,
  );
  // The package holds the images and sounds folders' files at its root; other folders keep their names.
  const packagePath = (rest: string): string =>
    root === "videos" ? `${actualFolder}${rest}` : `${actualFolder.slice(root.length + 1)}${rest}`;
  const listed = folder.replace(/\/$/u, "");
  addDiagnostic(
    context,
    "SX_FOLDER_FILES",
    "warning",
    entries.length === 0
      ? `The legacy script went through the ${listsFolders ? "subfolders" : "files"} of ${listed}, which the package does not hold, so this goes through none.`
      : `The legacy script went through the ${listsFolders ? "subfolders" : "files"} of ${listed}; this goes through the package's ${listsFolders ? "subfolders" : "files"} there, as listed at conversion time.`,
    node.span,
  );
  const forget = walkVariable(body, variable, listsFolders ? "folder" : "file", context);
  try {
    if (returns.length > 0) noteReturnAsContinue(returns[0]!.node, context);
    const loopBody = lowerBlock(body, context);
    return [
      {
        kind: "for",
        variable,
        collection: {
          kind: "list",
          items: entries.map((entry): IrExpression => ({
            kind: "literal",
            value: packagePath(entry),
          })),
          lines: true,
        },
        body: returns.length > 0 ? withoutFinalContinue(returnsAsContinue(loopBody)) : loopBody,
        span,
      },
    ];
  } finally {
    forget();
  }
}

/**
 * What a folder walk asked of a File that is an image of the folder (imageFolderWalk): its name, its path, and whether
 * it is a file. Undefined for another receiver or member.
 */
function listedImageMember(
  receiver: AstNode,
  member: string,
  context: LowerContext,
): IrExpression | undefined {
  const variable = variableName(receiver);
  const id = bindingSpanId(receiver);
  const kind =
    context.walkedEntries.get(receiver) ??
    (id === null ? undefined : context.walkedEntries.get(id));
  if (variable === null || kind === undefined) return undefined;
  const folder = kind === "folder";
  const path: IrExpression = { kind: "variable", name: variable };
  if (member === "name" || member === "getName") return useHelper(context, "fileName", [path]);
  if (["path", "getPath", "absolutePath", "getAbsolutePath", "toString"].includes(member))
    return path;
  if (member === "isFile" || member === "file") return { kind: "literal", value: !folder };
  if (member === "isDirectory" || member === "directory") return { kind: "literal", value: folder };
  return undefined;
}

/** Whether a path names a folder of the player's home, `System.getProperty("user.home") + "/Downloads"`. */
function isHomePath(node: AstNode): boolean {
  let home = false;
  walkAst(node, (child) => {
    home ||=
      child.kind === "methodCall" &&
      constantString(child.method) === "getProperty" &&
      variableName(child.object) === "System" &&
      constantString(nodeArray(asNode(child.arguments)?.items)[0]) === "user.home";
  });
  return home;
}

/** The fixed text after the home in a home path, `/Downloads`; empty for a computed rest. */
function homeSuffix(node: AstNode): string {
  if (node.kind === "binary" && node.operator === "+") {
    const left = asNode(node.left);
    const right = asNode(node.right);
    if (left !== null && isHomePath(left) && right !== null) {
      const rest = staticPath(right);
      return left.kind === "methodCall" ? rest.text : `${homeSuffix(left)}${rest.text}`;
    }
  }
  return "";
}

/** Whether a folder walk's receiver may be a folder of the player's home: a home File, or a variable holding one. */
function walksHome(receiver: AstNode, context: LowerContext): boolean {
  if (isFileConstructor(receiver))
    return isHomePath(nodeArray(asNode(receiver.arguments)?.items)[0] ?? receiver);
  const variable = variableName(receiver);
  return (
    variable !== null &&
    context.fileVariables.has(variable) &&
    [...context.filePathOwners].some(
      ([value, owner]) =>
        owner === variable && isHomePath(nodeArray(asNode(value.arguments)?.items)[0] ?? value),
    )
  );
}

/**
 * Whether a value is the legacy player's folder of installed scripts, `new File(getDataFolder() + "scripts/")`, also
 * through variables that only ever hold it or its path.
 */
function isInstalledScriptsFolder(
  node: AstNode,
  context: LowerContext,
  seen = new Set<string>(),
): boolean {
  const resolve = (value: AstNode): AstNode => {
    const name = variableName(value);
    const key = name === null ? null : bindingKey(value, context.bindings);
    const values = key === null ? undefined : context.assignedValues.get(key);
    if (name === null || key === null || seen.has(key) || values?.length !== 1) return value;
    seen.add(key);
    return resolve(values[0]!);
  };
  let value = resolve(node);
  if (isFileConstructor(value)) value = resolve(nodeArray(asNode(value.arguments)?.items)[0]!);
  if (
    value.kind === "methodCall" &&
    constantString(value.method) === "toString" &&
    asNode(value.object) !== null
  )
    value = asNode(value.object)!;
  const path = staticPath(value);
  return path.complete && /^(?:\.?\/)*scripts\/?$/iu.test(path.text.replaceAll("\\", "/"));
}

/** `NetworkInterface.networkInterfaces` or `NetworkInterface.getNetworkInterfaces()`. */
function isNetworkInterfaces(node: AstNode): boolean {
  const owner = asNode(node.object);
  const ownerName = variableName(owner) ?? (owner?.kind === "class" ? text(owner.type) : null);
  const named = (name: string | null): boolean =>
    name === "NetworkInterface" || name === "java.net.NetworkInterface";
  return (
    (node.kind === "property" &&
      constantString(node.property) === "networkInterfaces" &&
      named(ownerName)) ||
    (node.kind === "methodCall" &&
      constantString(node.method) === "getNetworkInterfaces" &&
      named(ownerName))
  );
}

/**
 * The legacy data folder, the package root: `getDataFolder()`, also with its separators replaced, or the player's
 * working directory, `System.getProperty("user.dir")`.
 */
function isDataFolder(node: AstNode): boolean {
  if (node.kind !== "methodCall") return false;
  const method = constantString(node.method);
  const receiver = asNode(node.object);
  if (method === "getDataFolder") return nodeArray(asNode(node.arguments)?.items).length === 0;
  if (method === "replaceAll" || method === "replace")
    return receiver !== null && isDataFolder(receiver);
  return (
    method === "getProperty" &&
    variableName(receiver) === "System" &&
    constantString(nodeArray(asNode(node.arguments)?.items)[0]) === "user.dir"
  );
}

/**
 * The fixed beginning of a path, its text up to the first computed part, with `getDataFolder()` as the package root;
 * `complete` when nothing in it is computed.
 */
function staticPath(node: AstNode): { text: string; complete: boolean } {
  const literal = constantString(node);
  if (literal !== null) return { text: literal, complete: true };
  if (isDataFolder(node)) return { text: "", complete: true };
  if (node.kind === "gstring") {
    const strings = Array.isArray(node.strings) ? node.strings : [];
    const values = nodeArray(node.values);
    let text = "";
    for (let index = 0; index < strings.length; index += 1) {
      const piece: unknown = strings[index];
      if (typeof piece === "string") text += piece;
      const value = values[index];
      if (value !== undefined && !isDataFolder(value)) return { text, complete: false };
    }
    return { text, complete: true };
  }
  if (node.kind === "binary" && node.operator === "+") {
    const left = asNode(node.left);
    const right = asNode(node.right);
    if (left === null || right === null) return { text: "", complete: false };
    const start = staticPath(left);
    if (!start.complete) return start;
    const rest = staticPath(right);
    return { text: start.text + rest.text, complete: rest.complete };
  }
  return { text: "", complete: false };
}

/**
 * `String.format(pattern, values...)` with a literal pattern of `%s`, `%d`, `%f` conversions, an optional `0` flag, a
 * width, and a precision for `%f`: interpolation, `padStart` for a width, and a fixed number of decimals through a
 * helper. Returns undefined for other patterns.
 */
function formatText(
  argumentsNodes: AstNode[],
  node: AstNode,
  context: LowerContext,
): IrExpression | null | undefined {
  const pattern = constantString(argumentsNodes[0]);
  if (pattern === null) return undefined;
  const specifiers = [...pattern.matchAll(/%(0?)(\d*)(?:\.(\d+))?([sdf%])|%/gu)];
  if (specifiers.some((match) => match[4] === undefined)) return undefined;
  const values = argumentsNodes.slice(1);
  if (specifiers.filter((match) => match[4] !== "%").length !== values.length) return undefined;
  const parts: Array<{ text: string } | { value: IrExpression }> = [];
  let position = 0;
  let next = 0;
  for (const match of specifiers) {
    if (match.index > position) parts.push({ text: pattern.slice(position, match.index) });
    position = match.index + match[0].length;
    const [, zero, width, precision, conversion] = match;
    if (conversion === "%") {
      parts.push({ text: "%" });
      continue;
    }
    const lowered = lowerExpression(values[next++]!, context);
    if (lowered === null) return null;
    if (
      lowered.kind === "literal" &&
      ((conversion === "s" && typeof lowered.value === "string") ||
        (conversion === "d" && Number.isInteger(lowered.value) && Number(lowered.value) >= 0))
    ) {
      parts.push({
        text: String(lowered.value).padStart(Number(width || "0"), zero === "0" ? "0" : " "),
      });
      continue;
    }
    let value: IrExpression =
      conversion === "f"
        ? useHelper(context, "fixed", [
            lowered,
            { kind: "literal", value: Number(precision ?? "6") },
            { kind: "literal", value: 10 ** Number(precision ?? "6") },
          ])
        : conversion === "d"
          ? { kind: "call", name: "toInteger", positional: [lowered], named: {} }
          : lowered;
    if (width !== undefined && width !== "") {
      const text: IrExpression =
        conversion === "f"
          ? value
          : { kind: "call", name: "toString", positional: [value], named: {} };
      value = {
        kind: "methodCall",
        target: text,
        name: "padStart",
        arguments: [
          { kind: "literal", value: Number(width) },
          { kind: "literal", value: zero === "0" ? "0" : " " },
        ],
      };
    }
    parts.push({ value });
  }
  if (position < pattern.length) parts.push({ text: pattern.slice(position) });
  addDiagnostic(
    context,
    "SX_FORMAT",
    "warning",
    "Java String.format() wrote these values; the conversion pads and rounds them the same way for this pattern, but a negative number padded with zeros puts the zeros before the minus sign.",
    node.span,
  );
  return templateOrLiteral(parts);
}

/** The empty value of a type, the start of a variable whose own initializer could not convert; null otherwise. */
/**
 * Variables a closure assigns that nothing declares: Groovy kept them in the script's binding, shared by every
 * closure, so they are declared in the script, starting with their type's empty value (withPlacedBindings places them).
 */
function bindingDeclarations(
  body: AstNode | null,
  context: LowerContext,
  members: ReadonlySet<string> = new Set(),
): IrStatement[] {
  if (body === null || context.functionDepth > 0) return [];
  // The names each closure declares itself (its parameters, also the implicit `it`, its locals, and loop variables),
  // and the names the script body declares or assigns outside closures.
  const declared = new Set<string>();
  const scopes = new Map<AstNode, Set<string>>();
  const collect = (node: AstNode, scope: Set<string>, insideClosure: boolean): void => {
    if (node.kind === "closure") {
      const own = new Set<string>();
      for (const parameter of Array.isArray(node.parameters) ? node.parameters : [])
        if (isRecord(parameter) && typeof parameter.name === "string") own.add(parameter.name);
      if (node.parameterSpecified !== true) own.add("it");
      scopes.set(node, own);
      for (const child of nodeChildren(node)) collect(child, own, true);
      return;
    }
    const name =
      node.kind === "declaration"
        ? variableName(node.left)
        : node.kind === "for"
          ? text(node.variable)
          : // A top-level assignment declares the variable there.
            !insideClosure && node.kind === "binary" && node.operator === "="
            ? variableName(node.left)
            : null;
    if (name !== null) scope.add(name);
    for (const child of nodeChildren(node)) collect(child, scope, insideClosure);
  };
  collect(body, declared, false);
  // A closure's assignment to a name that neither it nor a closure around it declares writes the binding.
  const assigned = new Map<string, AstNode>();
  const visit = (node: AstNode, enclosing: ReadonlyArray<Set<string>>): void => {
    const inner =
      node.kind === "closure" ? [...enclosing, scopes.get(node) ?? new Set<string>()] : enclosing;
    if (inner.length > 0 && node.kind === "binary" && node.operator === "=") {
      const name = variableName(node.left);
      if (name !== null && !assigned.has(name) && !inner.some((scope) => scope.has(name)))
        assigned.set(name, node);
    }
    for (const child of nodeChildren(node)) visit(child, inner);
  };
  visit(body, []);
  const names = [...assigned.keys()].filter(
    (name) =>
      !declared.has(name) &&
      !members.has(name) &&
      !context.functions.has(name) &&
      !context.packageFunctions.has(name) &&
      !isLegacyGetterProperty(name),
  );
  return names.map((name): IrStatement => ({
    kind: "let",
    name,
    value: neutralValue(context.types.variables.get(name) ?? UNKNOWN),
    span: null,
  }));
}

/**
 * The script's statements with each binding declaration (bindingDeclarations) just before the first statement that
 * may use the variable: one that names it or calls a function that reaches it, also through the dispatcher when an
 * action reaches it. A variable that only functions nothing calls use is declared first.
 */
function withPlacedBindings(
  declarations: IrStatement[],
  statements: IrStatement[],
  context: LowerContext,
): IrStatement[] {
  if (declarations.length === 0) return statements;
  type Found = { variables: Set<string>; calls: Set<string> };
  const names = (
    value: unknown,
    found: Found = { variables: new Set(), calls: new Set() },
  ): Found => {
    if (Array.isArray(value)) {
      for (const item of value) names(item, found);
      return found;
    }
    if (!isRecord(value)) return found;
    if (value.kind === "variable" && typeof value.name === "string")
      found.variables.add(value.name);
    if (value.kind === "call" && typeof value.name === "string") found.calls.add(value.name);
    if (value.kind === "literal" && value.action === true && typeof value.value === "string")
      found.calls.add(value.value);
    for (const child of Object.values(value)) names(child, found);
    return found;
  };
  const functions = new Map(
    statements.flatMap((statement): Array<[string, Found]> =>
      statement.kind === "function" ? [[statement.name, names(statement.body)]] : [],
    ),
  );
  const firstUse = (name: string): number => {
    // The functions that reach the variable, directly or through another one.
    const reaching = new Set(
      [...functions].flatMap(([fn, found]) => (found.variables.has(name) ? [fn] : [])),
    );
    for (let grown = true; grown;) {
      grown = false;
      const dispatched = [...reaching].some((fn) => context.actions.has(fn));
      for (const [fn, found] of functions) {
        if (reaching.has(fn)) continue;
        if (
          [...found.calls].some((call) => reaching.has(call)) ||
          (dispatched && found.calls.has(ACTION_DISPATCHER))
        ) {
          reaching.add(fn);
          grown = true;
        }
      }
    }
    const dispatched = [...reaching].some((fn) => context.actions.has(fn));
    return statements.findIndex((statement) => {
      if (statement.kind === "function") return false;
      const found = names(statement);
      return (
        found.variables.has(name) ||
        [...found.calls].some((call) => reaching.has(call)) ||
        (dispatched && found.calls.has(ACTION_DISPATCHER))
      );
    });
  };
  const before = new Map<number, IrStatement[]>();
  for (const declaration of declarations) {
    if (declaration.kind !== "let") continue;
    let index = firstUse(declaration.name);
    if (index < 0) index = 0;
    // The comments right before a statement stay with it.
    while (index > 0) {
      const previous = statements[index - 1]!;
      if (previous.kind !== "blank" && !(previous.kind === "comment" && !previous.trailing)) break;
      index -= 1;
    }
    before.set(index, [...(before.get(index) ?? []), declaration]);
  }
  const result: IrStatement[] = [];
  statements.forEach((statement, index) => {
    result.push(...bindingNote(before.get(index) ?? [], context), statement);
  });
  return result;
}

function bindingNote(declarations: IrStatement[], context: LowerContext): IrStatement[] {
  const names = declarations.flatMap((declaration) =>
    declaration.kind === "let" ? [declaration.name] : [],
  );
  if (names.length === 0) return [];
  const message = `Groovy kept ${names.join(", ")}, which functions assign without a declaration, in the script's binding that every function shares; ${names.length === 1 ? "it is" : "they are"} declared here, before the script first uses ${names.length === 1 ? "it" : "them"}, with an empty value.`;
  context.diagnostics.push({
    code: "SX_BINDING_VARIABLE",
    severity: "warning",
    message,
    span: null,
  });
  return [
    {
      kind: "comment",
      text: `// NOTE SX_BINDING_VARIABLE: ${message}`,
      trailing: false,
      span: null,
    },
    ...declarations,
  ];
}

/**
 * Declares the variables the script body assigns outside closures without declaring them: Groovy kept them in the
 * script's binding. The first of the script's statements that uses one declares it when it assigns it; otherwise a
 * declaration with its type's empty value comes just before that statement. Functions do not count as uses, since
 * they read the variable only when called.
 */
function withScriptBindings(
  statements: IrStatement[],
  body: AstNode | null,
  context: LowerContext,
  members: ReadonlySet<string> = new Set(),
): IrStatement[] {
  if (body === null || context.functionDepth > 0) return statements;
  // A `def` is local to its block, so an assignment where no enclosing block has declared the name writes the binding,
  // also when a sibling block declares a local of that name (SecretSexScript's `Slot1`).
  const assigned = new Set<string>();
  const collect = (node: AstNode, scopes: ReadonlyArray<Set<string>>): void => {
    if (node.kind === "closure") return;
    if (node.kind === "block" || node.kind === "for") {
      const scope = new Set<string>();
      const loopVariable = node.kind === "for" ? text(node.variable) : null;
      if (loopVariable !== null) scope.add(loopVariable);
      for (const child of nodeChildren(node)) collect(child, [...scopes, scope]);
      return;
    }
    if (node.kind === "declaration") {
      const right = asNode(node.right);
      if (right !== null) collect(right, scopes);
      const left = asNode(node.left);
      for (const target of left?.kind === "arguments" ? nodeArray(left.items) : [left]) {
        const name = variableName(target);
        if (name !== null) scopes.at(-1)!.add(name);
      }
      return;
    }
    if (node.kind === "binary" && node.operator === "=") {
      const name = variableName(node.left);
      if (name !== null && !scopes.some((scope) => scope.has(name))) assigned.add(name);
    }
    for (const child of nodeChildren(node)) collect(child, scopes);
  };
  collect(body, [new Set()]);
  const names = [...assigned].filter(
    (name) =>
      !members.has(name) &&
      !context.functions.has(name) &&
      !context.packageFunctions.has(name) &&
      !isLegacyGetterProperty(name),
  );
  if (names.length === 0) return statements;
  const mentions = (value: unknown, name: string): boolean => {
    if (Array.isArray(value)) return value.some((item) => mentions(item, name));
    if (!isRecord(value)) return false;
    if (value.kind === "variable" && value.name === name) return true;
    return Object.values(value).some((child) => mentions(child, name));
  };
  // A name the conversion already declares at the top, such as a destructured variable, keeps its declaration; a
  // declaration inside a block is a local of that block, which the binding's declaration renames.
  const lets = new Set(
    statements.flatMap((statement) => (statement.kind === "let" ? [statement.name] : [])),
  );
  const before = new Map<number, string[]>();
  const replaced = new Map<number, IrStatement>();
  for (const name of names) {
    if (lets.has(name)) continue;
    const index = statements.findIndex(
      (statement) => statement.kind !== "function" && mentions(statement, name),
    );
    if (index < 0) continue;
    const first = replaced.get(index) ?? statements[index]!;
    if (
      first.kind === "assign" &&
      first.operator === "=" &&
      first.target.kind === "variable" &&
      first.target.name === name &&
      !mentions(first.value, name)
    ) {
      replaced.set(index, { kind: "let", name, value: first.value, span: first.span });
      continue;
    }
    before.set(index, [...(before.get(index) ?? []), name]);
  }
  return statements.flatMap((statement, index) => {
    const empty = before.get(index) ?? [];
    if (empty.length === 0) return [replaced.get(index) ?? statement];
    const message = `Groovy kept ${empty.join(", ")}, which the script assigns without a declaration, in the script's binding; ${empty.length === 1 ? "it is" : "they are"} declared here with an empty value.`;
    context.diagnostics.push({
      code: "SX_BINDING_VARIABLE",
      severity: "warning",
      message,
      span: null,
    });
    return [
      {
        kind: "comment",
        text: `// NOTE SX_BINDING_VARIABLE: ${message}`,
        trailing: false,
        span: null,
      },
      ...empty.map((name): IrStatement => ({
        kind: "let",
        name,
        value: neutralValue(context.types.variables.get(name) ?? UNKNOWN),
        span: null,
      })),
      replaced.get(index) ?? statement,
    ];
  });
}

function neutralValue(type: number): IrExpression {
  if (onlyOf(type, NUMBER | NULL) && (type & NUMBER) !== 0) return { kind: "literal", value: 0 };
  if (onlyOf(type, STRING | NULL) && (type & STRING) !== 0) return { kind: "literal", value: "" };
  if (onlyOf(type, BOOLEAN | NULL) && (type & BOOLEAN) !== 0)
    return { kind: "literal", value: false };
  if (onlyOf(type, LIST | NULL) && (type & LIST) !== 0) return { kind: "list", items: [] };
  return { kind: "literal", value: null };
}

/**
 * A literal media path as the package names the file: the legacy player found `images/` and `sounds/` files ignoring
 * letter case, around spaces, and below a repeated folder name, and a MIDI file is converted to MP3 with the package.
 * Other paths stay as they are; a path that several files match apart from case gets a note.
 */
function mediaFile(
  file: IrExpression,
  folder: "images" | "sounds",
  node: AstNode,
  context: LowerContext,
): IrExpression {
  if (file.kind !== "literal" || typeof file.value !== "string" || context.files === null)
    return file;
  const prefix = `${folder}/`;
  const available = context.actualFiles
    .filter((actual) => actual.toLowerCase().startsWith(prefix))
    .map((actual) => actual.slice(prefix.length));
  const written = file.value;
  const candidates = [
    written,
    written.trim(),
    written.replace(new RegExp(`^${folder}/`, "iu"), ""),
    written.replace(/^([^/]+)\/\1\//u, "$1/"),
  ];
  const midi = (path: string): string => path.replace(/\.midi?$/iu, ".mp3");
  for (const candidate of candidates) {
    if (available.includes(candidate)) {
      if (candidate !== written)
        addDiagnostic(
          context,
          "SX_MEDIA_PATH",
          "warning",
          `The legacy player found "${written}" as the file "${candidate}"; the path names that file.`,
          node.span,
        );
      return { kind: "literal", value: midi(candidate) };
    }
  }
  for (const candidate of candidates) {
    const matches = available.filter((actual) => actual.toLowerCase() === candidate.toLowerCase());
    if (matches.length === 1) {
      addDiagnostic(
        context,
        "SX_MEDIA_PATH",
        "warning",
        `The legacy player found "${written}" as the file "${matches[0]}" regardless of letter case; the path names that file.`,
        node.span,
      );
      return { kind: "literal", value: midi(matches[0]!) };
    }
    if (matches.length > 1) {
      addDiagnostic(
        context,
        "SX_MEDIA_PATH_CASE",
        "warning",
        `Several files match "${written}" apart from letter case (${matches.join(", ")}); the legacy player's file system held only one of them, so check which one this is.`,
        node.span,
      );
      return file;
    }
  }
  // An empty path clears the image, a URL is no package file, and a photo the package copies there exists once copied.
  if (
    written.trim() !== "" &&
    !/^[a-z]+:\/\//iu.test(written) &&
    !(folder === "images" && context.copiedImages.has(written))
  )
    addDiagnostic(
      context,
      "SX_MEDIA_MISSING",
      "warning",
      `No file in the package matches "${written}"; unless the script creates it while running, the legacy player showed nothing here either.`,
      node.span,
    );
  return { kind: "literal", value: midi(written) };
}

/**
 * The values a switched value can hold when they are all known: a storage read, or a variable assigned only from
 * one, of a key the package only ever stores literals under. Null otherwise.
 */
function storedValues(node: AstNode, context: LowerContext): ReadonlySet<string> | null {
  const read = (value: AstNode | null): ReadonlySet<string> | null => {
    const call = value === null ? null : legacyApiCall(value, context);
    if (call === null || !DIRECT_STORAGE_LOADS.has(call.name) || call.arguments.length !== 1)
      return null;
    const key = constantString(call.arguments[0]);
    return key === null ? null : (context.storageLiterals.get(key) ?? null);
  };
  const direct = read(node);
  if (direct !== null) return direct;
  const name = variableName(node);
  if (name === null || context.types.singleAssignment?.has(name) !== true) return null;
  const initializer = context.constantInitializers.get(name) ?? null;
  return read(initializer);
}

/** The variables a script assigns a photo it took: getImage(), getFile(), or receiveImage(). */
function photoVariables(body: AstNode): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const assigns =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=");
    const value = assigns ? asNode(node.right) : null;
    const name = assigns ? variableName(node.left) : null;
    if (
      name !== null &&
      value?.kind === "methodCall" &&
      value.implicitThis === true &&
      ["getImage", "getFile", "receiveImage"].includes(constantString(value.method) ?? "")
    )
      names.add(name);
  });
  return names;
}

/**
 * A function that only composes an image in memory and shows it with `setImage(bytes, n)`: TeaseScript has no image
 * composition yet (the accepted layered scene is not implemented), so the function shows the base image it read, the
 * first one, with a note. Null for any other function, also one that shows text, waits, saves, or changes a
 * variable it does not declare.
 */
function composedImage(body: AstNode, context: LowerContext): IrStatement[] | null {
  let showsBytes = false;
  let other = false;
  const reads: AstNode[] = [];
  const locals = new Set<string>();
  walkAst(body, (node) => {
    if (node.kind === "declaration") {
      const name = variableName(node.left);
      if (name !== null) locals.add(name);
    }
  });
  walkAst(body, (node) => {
    if (node.kind === "binary" && node.operator === "=") {
      const target = variableName(node.left);
      if (target === null || !locals.has(target)) other = true;
    }
    if (node.kind !== "methodCall") return;
    const method = constantString(node.method) ?? "";
    const args = nodeArray(asNode(node.arguments)?.items);
    if (node.implicitThis === true) {
      if (method === "setImage" && args.length === 2) showsBytes = true;
      else if (!context.functions.has(method)) other = true;
      return;
    }
    // A change of a list or map the function does not declare would be lost.
    const receiver = variableName(node.object);
    if (
      receiver !== null &&
      !locals.has(receiver) &&
      [
        "add",
        "addAll",
        "clear",
        "push",
        "put",
        "putAt",
        "remove",
        "removeAll",
        "leftShift",
      ].includes(method)
    )
      other = true;
    if ((method === "getImage" || method === "read") && args.length === 1) {
      const argument = args[0]!;
      const path = isFileConstructor(argument)
        ? (nodeArray(asNode(argument.arguments)?.items)[0] ?? null)
        : argument;
      if (path !== null) reads.push(path);
    }
  });
  // The base is the image the function was given, as a parameter, or else the first it read: a frame or background
  // read first stays in the composition only.
  const parameters = new Set(context.currentFunction?.parameters ?? []);
  const given = reads.find((read) => {
    let names = false;
    walkAst(read, (node) => (names ||= parameters.has(variableName(node) ?? "")));
    return names;
  });
  const base = given ?? reads[0] ?? null;
  if (!showsBytes || other || base === null) return null;
  const image = imagePathBelowImages(base, context);
  if (image === null) return null;
  if (context.accepted.has("layeredScene")) {
    const scene = layeredScene(body, image, context);
    if (scene !== null) return scene;
  }
  addDiagnostic(
    context,
    "SX_IMAGE_COMPOSITION",
    "warning",
    "The legacy function composed an image in memory from parts of other images and showed it; TeaseScript cannot compose images yet (the accepted layered scene with showOverlayImage is not implemented), so the function shows the image it was given, or else the first image it read.",
    body.span,
  );
  return [{ kind: "showImage", file: mediaFile(image, "images", body, context), span: body.span }];
}

/** Java drawing calls that the layered scene does not cover: text, shapes, pixel edits, and transformations. */
const UNCOVERED_DRAWING = new Set([
  "drawString",
  "fillRect",
  "clearRect",
  "setRGB",
  "rotate",
  "scale",
  "translate",
  "drawLine",
  "drawRect",
  "fillOval",
  "drawOval",
]);

/**
 * The accepted layered scene (V30 "Future layered scene") for a straight-line image composition: the base image as
 * the background, and each drawn image as an overlay at the percentages of the canvas its pixels gave, the canvas
 * size known from literal numbers or from the base image's size at conversion time. Null when a drawing runs in a
 * loop or the canvas size is unknown, where the base image stays.
 */
function layeredScene(
  body: AstNode,
  base: IrExpression,
  context: LowerContext,
): IrStatement[] | null {
  const images = new Map<string, AstNode>();
  const draws: AstNode[] = [];
  let canvas: AstNode[] | null = null;
  let loops = false;
  let uncovered = false;
  const visit = (node: AstNode, inLoop: boolean): void => {
    const loop = inLoop || node.kind === "for" || node.kind === "while";
    if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) {
      const name = variableName(node.left);
      const value = asNode(node.right);
      const call = value?.kind === "methodCall" ? value : null;
      const method = call === null ? "" : (constantString(call.method) ?? "");
      if (name !== null && call !== null && (method === "getImage" || method === "read")) {
        const argument = nodeArray(asNode(call.arguments)?.items)[0];
        const path =
          argument !== undefined && isFileConstructor(argument)
            ? nodeArray(asNode(argument.arguments)?.items)[0]
            : argument;
        if (path !== undefined) images.set(name, path);
      }
      if (value?.kind === "constructorCall" && String(value.type).endsWith("BufferedImage"))
        canvas = nodeArray(asNode(value.arguments)?.items).slice(0, 2);
    }
    if (node.kind === "methodCall") {
      const method = constantString(node.method) ?? "";
      if (method === "drawImage") {
        draws.push(node);
        if (loop) loops = true;
      }
      if (UNCOVERED_DRAWING.has(method)) uncovered = true;
    }
    for (const child of Object.values(node))
      for (const item of Array.isArray(child) ? child : [child])
        if (isAstNode(item) && item.kind !== "closure") visit(item, loop);
  };
  visit(body, false);
  const sizeOf = (path: AstNode | undefined): { width: number; height: number } | null => {
    const literal = path === undefined ? null : constantString(path);
    if (literal === null || context.media === null) return null;
    const relative = literal.replace(/^images\//iu, "").toLowerCase();
    const file = context.media.find(
      (item) => item.path.replaceAll("\\", "/").toLowerCase() === relative,
    );
    return file?.width !== undefined && file.height !== undefined
      ? { width: file.width, height: file.height }
      : null;
  };
  // A number of the composition: a literal, arithmetic, or an image's getWidth()/getHeight().
  const number = (node: AstNode | undefined): number | null => {
    if (node === undefined) return null;
    if (node.kind === "constant" && typeof node.value === "number") return node.value;
    if (node.kind === "cast") return number(asNode(node.expression) ?? undefined);
    if (node.kind === "binary" && ["+", "-", "*", "/"].includes(String(node.operator))) {
      const left = number(asNode(node.left) ?? undefined);
      const right = number(asNode(node.right) ?? undefined);
      if (left === null || right === null) return null;
      return node.operator === "+"
        ? left + right
        : node.operator === "-"
          ? left - right
          : node.operator === "*"
            ? left * right
            : left / right;
    }
    if (node.kind === "methodCall") {
      const method = constantString(node.method);
      const size = sizeOf(images.get(variableName(node.object) ?? ""));
      if (method === "getWidth" && size !== null) return size.width;
      if (method === "getHeight" && size !== null) return size.height;
    }
    return null;
  };
  const [canvasWidth, canvasHeight] = (canvas ?? []).map((side) => number(side));
  if (loops || draws.length === 0 || canvasWidth == null || canvasHeight == null) return null;
  const percent = (node: AstNode | undefined, side: number): IrExpression | null => {
    const value = number(node);
    return value === null
      ? null
      : { kind: "literal", value: Math.round((value / side) * 10000) / 100 };
  };
  const overlays: IrStatement[] = [];
  for (const draw of draws) {
    const args = nodeArray(asNode(draw.arguments)?.items);
    const imagePath = images.get(variableName(args[0]) ?? "");
    const file = imagePath === undefined ? null : imagePathBelowImages(imagePath, context);
    if (file === null) return null;
    // drawImage(image, x, y, observer), (image, x, y, width, height, observer), or a source rectangle.
    const [x, y] = [percent(args[1], canvasWidth), percent(args[2], canvasHeight)];
    const sized = args.length >= 6 && args.length < 10;
    const cropped = args.length >= 10;
    if (cropped) uncovered = true;
    const width = cropped
      ? percent(
          { kind: "binary", span: null, operator: "-", left: args[3]!, right: args[1]! },
          canvasWidth,
        )
      : sized
        ? percent(args[3], canvasWidth)
        : (() => {
            const size = sizeOf(imagePath);
            return size === null
              ? null
              : percent({ kind: "constant", span: null, value: size.width }, canvasWidth);
          })();
    const height = cropped
      ? percent(
          { kind: "binary", span: null, operator: "-", left: args[4]!, right: args[2]! },
          canvasHeight,
        )
      : sized
        ? percent(args[4], canvasHeight)
        : (() => {
            const size = sizeOf(imagePath);
            return size === null
              ? null
              : percent({ kind: "constant", span: null, value: size.height }, canvasHeight);
          })();
    if (x === null || y === null) return null;
    overlays.push({
      kind: "expression",
      expression: {
        kind: "call",
        name: "showOverlayImage",
        positional: [],
        named: {
          image: mediaFile(file, "images", draw, context),
          x,
          y,
          ...(width === null ? {} : { width }),
          ...(height === null ? {} : { height }),
          anchor: { kind: "literal", value: "topLeft" },
          relativeTo: { kind: "literal", value: "background" },
        },
      },
      span: draw.span,
    });
  }
  addDiagnostic(
    context,
    uncovered ? "SX_LAYERED_SCENE_PARTIAL" : "SX_LAYERED_SCENE",
    "warning",
    uncovered
      ? "The legacy function composed an image in memory; the layered scene places the base image and the drawn images, but not what it does not cover here: a part of an image (a source rectangle), text, shapes, pixel edits, or transformations."
      : "The legacy function composed an image in memory from other images; the layered scene places them, with pixel positions as percentages of the canvas.",
    body.span,
  );
  return [
    {
      kind: "expression",
      expression: {
        kind: "call",
        name: "showBackgroundImage",
        positional: [],
        named: { image: mediaFile(base, "images", body, context) },
      },
      span: body.span,
    },
    ...overlays,
  ];
}

/** A path the legacy script read below `images/`, as a path of the package's images; null for another path. */
/**
 * The image the current function was given: the path below `images/` of an image it reads (`getImage`,
 * `ImageIO.read`) that names one of its parameters; null outside a function or without such a read.
 */
function givenImage(context: LowerContext): IrExpression | null {
  const current = context.currentFunction;
  const parameters = new Set(current?.parameters ?? []);
  if (current === undefined || current === null || parameters.size === 0) return null;
  let found: AstNode | null = null;
  walkAst(current.body, (node) => {
    if (found !== null || node.kind !== "methodCall") return;
    const method = constantString(node.method) ?? "";
    const args = nodeArray(asNode(node.arguments)?.items);
    if ((method !== "getImage" && method !== "read") || args.length !== 1) return;
    const path = isFileConstructor(args[0]!)
      ? (nodeArray(asNode(args[0]!.arguments)?.items)[0] ?? null)
      : args[0]!;
    let names = false;
    if (path !== null)
      walkAst(path, (child) => (names ||= parameters.has(variableName(child) ?? "")));
    if (names) found = path;
  });
  return found === null ? null : imagePathBelowImages(found, context);
}

function imagePathBelowImages(node: AstNode, context: LowerContext): IrExpression | null {
  const literal = constantString(node);
  if (literal !== null)
    return /^images\//iu.test(literal)
      ? { kind: "literal", value: literal.slice("images/".length) }
      : null;
  if (node.kind === "binary" && node.operator === "+") {
    const prefix = constantString(node.left);
    const rest = asNode(node.right);
    if (prefix?.toLowerCase() === "images/" && rest !== null) return lowerExpression(rest, context);
  }
  return null;
}

/**
 * A device command that useFile() ran, named by the variable that holds it, such as `estim_start` or `lock_finish`:
 * the device's label and the state the command left it in (owner decision: an estim unit runs or stops, and a lock
 * or a guillotine's arm locks or unlocks). Null for any other path.
 */
function deviceCommand(node: AstNode): { name: string; label: string; state: string } | null {
  let found: { name: string; label: string; state: string } | null = null;
  walkAst(node, (child) => {
    const name = variableName(child);
    const match =
      name === null ? null : /^(estim|lock|arm)_?(start|on|finish|stop|off|end)$/iu.exec(name);
    if (found !== null || match === null) return;
    const estim = match[1]!.toLowerCase() === "estim";
    const starts = ["start", "on"].includes(match[2]!.toLowerCase());
    found = {
      name: name!,
      label: estim ? "Estim" : "Lock",
      state: estim ? (starts ? "RUNNING" : "STOPPED") : starts ? "LOCKED" : "UNLOCKED",
    };
  });
  return found;
}

/** Text files that useFile() opened in an editor or viewer of the player's computer. */
const TEXT_FILE_EXTENSIONS = new Set([".txt", ".log", ".csv", ".ini"]);

/** The fixed text at the end of a path, `".txt"` of `"log_" + code + ".txt"`; null when the end is computed. */
function pathSuffix(node: AstNode): string | null {
  const literal = constantString(node);
  if (literal !== null) return literal;
  if (node.kind === "binary" && node.operator === "+") {
    const right = asNode(node.right);
    return right === null ? null : pathSuffix(right);
  }
  if (node.kind === "gstring") {
    const strings = Array.isArray(node.strings) ? node.strings : [];
    const last: unknown = strings.at(-1);
    return typeof last === "string" && last !== "" ? last : null;
  }
  return null;
}

/** Programs a package may hold, which useFile() started on the player's computer. */
const PROGRAM_EXTENSIONS = new Set([".exe", ".bat", ".cmd", ".com", ".jar", ".msi"]);

/** Audio files the legacy useFile() opened in the system's player. */
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".mid", ".midi"]);
/** Video files a browser plays, and the formats the corpus driver converts to MP4 (H.264) at conversion time. */
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".ogv"]);
export const CONVERTED_VIDEO_EXTENSIONS = new Set([
  ".wmv",
  ".avi",
  ".mpg",
  ".mpeg",
  ".flv",
  ".mov",
]);

/**
 * `useFile(path)` opened a file with a program of the player's computer: an audio or video file plays in the session,
 * and anything else, such as a device control program or an executable, cannot start from a package.
 */
function useFileStatements(
  args: AstNode[],
  node: AstNode,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  const device = args.length === 1 ? deviceCommand(args[0]!) : null;
  if (device !== null) {
    addDiagnostic(
      context,
      "SX_DEVICE_STATE",
      "warning",
      `useFile() ran the device command in ${device.name} on the player's computer, which a package cannot start; a permanent button shows the device's state instead, "${device.label}: ${device.state}".`,
      node.span,
    );
    return [
      {
        kind: "expression",
        expression: useHelper(context, "showDevice", [
          { kind: "literal", value: device.label },
          { kind: "literal", value: device.state },
        ]),
        span,
      },
    ];
  }
  const path = args.length === 1 ? constantString(args[0]) : null;
  const extension = path === null ? "" : path.slice(path.lastIndexOf(".")).toLowerCase();
  if (
    path !== null &&
    (VIDEO_EXTENSIONS.has(extension) || CONVERTED_VIDEO_EXTENSIONS.has(extension))
  ) {
    const converted = CONVERTED_VIDEO_EXTENSIONS.has(extension);
    addDiagnostic(
      context,
      "SX_USE_FILE_VIDEO",
      "warning",
      `useFile() opened this video in the system's player; it plays in the session here, without waiting.${converted ? " The package holds it as an MP4 converted at import, since browsers do not play this format." : ""}`,
      node.span,
    );
    // The package root holds the images folder's files; other data folders keep their names.
    const file = path.replaceAll("\\", "/").replace(/^images\//iu, "");
    return [
      {
        kind: "playAudio",
        video: true,
        file: {
          kind: "literal",
          value: converted ? `${file.slice(0, file.lastIndexOf("."))}.mp4` : file,
        },
        async: true,
        repeatCount: null,
        span,
      },
    ];
  }
  // A text file opened in the computer's editor or viewer, such as a log: its text shows in the chat as prose from the
  // system speaker, since the player only reads it (owner decision).
  const suffix = args.length === 1 ? pathSuffix(args[0]!) : null;
  if (
    suffix !== null &&
    TEXT_FILE_EXTENSIONS.has(suffix.slice(suffix.lastIndexOf(".")).toLowerCase())
  ) {
    const viewed = viewedText(args[0]!, javaHost(context));
    if (viewed === null) return [];
    if (viewed !== undefined) {
      addDiagnostic(
        context,
        "SX_FILE_VIEW",
        "warning",
        "useFile() opened this text file in a program of the player's computer; its text shows in the chat as prose from the system speaker.",
        node.span,
      );
      return [systemSay(viewed.read, span, context, true)];
    }
  }
  // A program the package holds, such as a puzzle, cannot start: a system notice says so (owner decision), and for a
  // puzzle the player says whether it was solved, so the story continues.
  if (path !== null && PROGRAM_EXTENSIONS.has(extension)) {
    const name = path.replaceAll("\\", "/").split("/").at(-1)!;
    const puzzle = /puzzle/iu.test(path);
    addDiagnostic(
      context,
      "SX_EXTERNAL_PROGRAM_NOTICE",
      "warning",
      `useFile() started the program ${path} on the player's computer, which a package cannot do; a system notice says so${puzzle ? ", and the player says whether the puzzle was solved" : ""}.`,
      node.span,
    );
    return [
      systemSay(
        {
          kind: "literal",
          value: puzzle
            ? `The puzzle (${name}) is not available here. Solve it in your mind, or skip it.`
            : `The program ${name} that the original started is not available here.`,
        },
        span,
        context,
      ),
      ...(puzzle
        ? [
            {
              kind: "let" as const,
              name: freshName("puzzleSolved", context),
              value: {
                kind: "choice" as const,
                options: [
                  { kind: "literal" as const, value: "Puzzle solved" },
                  { kind: "literal" as const, value: "Not solved" },
                ],
                labels: ["solved", "unsolved"],
              },
              span,
            },
          ]
        : []),
    ];
  }
  if (path === null || !AUDIO_EXTENSIONS.has(extension))
    return [
      unsupportedStatement(
        context,
        node,
        "SX_EXTERNAL_PROGRAM",
        "useFile() opened this file with a program of the player's computer, such as a device control program or an executable; a TeaseScript package cannot start programs.",
      ),
    ];
  addDiagnostic(
    context,
    "SX_USE_FILE_AUDIO",
    "warning",
    "useFile() opened this audio file in the system's player; it plays in the session here, without waiting.",
    node.span,
  );
  return [
    {
      kind: "playAudio",
      file: mediaFile(
        { kind: "literal", value: path.replace(/^sounds\//iu, "") },
        "sounds",
        node,
        context,
      ),
      async: true,
      repeatCount: null,
      span,
    },
  ];
}

/**
 * `command.execute()` started a program of the player's computer. A device switch program, whose command ends with
 * on or off (also `ein`, `an`, `aus`), shows the switch state as a persistent permanent button (V30 §28), since the
 * device state spans scripts; the state is read at runtime for a computed command.
 */
function switchCommand(
  targetNode: AstNode,
  node: AstNode,
  context: LowerContext,
): IrExpression | null | undefined {
  // `command.toString().execute()` runs the command's text.
  const commandNode =
    targetNode.kind === "methodCall" &&
    constantString(targetNode.method) === "toString" &&
    nodeArray(asNode(targetNode.arguments)?.items).length === 0 &&
    asNode(targetNode.object) !== null
      ? asNode(targetNode.object)!
      : targetNode;
  const commandType = inferType(commandNode, context.types);
  const literal = constantString(commandNode);
  // A variable named for the switch state it sets, `switchbox_on`, holds that state's command.
  const named = /switch\w*?_(on|off)$/iu.exec(variableName(commandNode) ?? "")?.[1]?.toLowerCase();
  if (named !== undefined) {
    addDiagnostic(
      context,
      "SX_SWITCH_BUTTON",
      "warning",
      "The legacy script ran a device switch program, which a package cannot start; a persistent permanent button shows the switch state instead and is replaced when the state changes.",
      node.span,
    );
    return useHelper(context, "switchButton", [{ kind: "literal", value: `switch ${named}` }]);
  }
  if (literal !== null && switchState(literal) === null) return undefined;
  if (literal === null && commandNode.kind !== "gstring" && !onlyOf(commandType, STRING | NULL))
    return undefined;
  const command = lowerExpression(commandNode, context);
  if (command === null) return null;
  addDiagnostic(
    context,
    "SX_SWITCH_BUTTON",
    "warning",
    "The legacy script ran a device switch program, which a package cannot start; a persistent permanent button shows the switch state instead and is replaced when the state changes.",
    node.span,
  );
  return useHelper(context, "switchButton", [command]);
}

/** ON or OFF for a device switch command by its last word, or null for another command. */
function switchState(command: string): "ON" | "OFF" | null {
  const last = command.trim().split(/\s+/u).at(-1)?.toLowerCase() ?? "";
  if (["on", "ein", "an"].includes(last)) return "ON";
  if (["off", "aus"].includes(last)) return "OFF";
  return null;
}

/** A popup, or its workaround while main does not implement showPopup: the message and an OK button. */
function popupStatements(
  message: IrExpression,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (context.accepted.has("showPopup")) return [{ kind: "showPopup", message, span }];
  addDiagnostic(
    context,
    "SX_POPUP_WORKAROUND",
    "warning",
    "Workaround for showPopup, which main does not implement yet: the message in the chat and an OK button. Switch back to showPopup when it is implemented.",
    span,
  );
  return [
    { kind: "say", value: message, span },
    { kind: "showButton", label: { kind: "literal", value: "OK" }, timeout: null, span },
  ];
}

/** openUrl(), or its workaround while main does not implement it: the link in the chat and a button to continue. */
function urlStatements(
  url: IrExpression,
  span: SourceSpan | null,
  context: LowerContext,
): IrStatement[] {
  if (context.accepted.has("openUrl"))
    return [
      {
        kind: "expression",
        expression: { kind: "call", name: "openUrl", positional: [url], named: {} },
        span,
      },
    ];
  addDiagnostic(
    context,
    "SX_OPEN_URL_WORKAROUND",
    "warning",
    "Workaround for openUrl(), which main does not implement yet: the link in the chat, which the player can open, and a button to continue. Switch back to openUrl() when it is implemented.",
    span,
  );
  return [
    systemSay(
      url.kind === "literal" && typeof url.value === "string"
        ? { kind: "literal", value: `Open this link: ${url.value}` }
        : { kind: "template", parts: [{ text: "Open this link: " }, { value: url }] },
      span,
      context,
    ),
    { kind: "showButton", label: { kind: "literal", value: "Continue" }, timeout: null, span },
  ];
}

/** The lowering as the Java and data API rules see it (java-data.ts). */
function javaHost(context: LowerContext): JavaRuleHost {
  return {
    lower: (node) => lowerExpression(node, context),
    diagnostic: (code, severity, message, span) =>
      addDiagnostic(context, code, severity, message, span),
    helper: (name, args) => useHelper(context, name, args),
    calendarField: (field, value, node) => dateTimeField(field, value, node, context),
    valueType: (node) => inferType(node, context.types),
    isVariable: (name) => context.types.variables.has(name),
    listWrite: (receiver, node) => {
      const parameterWrite = parameterListWrite(receiver, node, context);
      if (parameterWrite !== null) {
        addDiagnostic(context, "SX_PARAMETER_LIST_WRITE", "error", parameterWrite, node.span);
        return false;
      }
      noteSharedListWrite(receiver, node, context);
      return true;
    },
    actionCall: (action, args) => actionCall(action, args, context),
    isPhoto: (node) => context.photoVariables.has(variableName(node) ?? ""),
    state: context.java,
  };
}

/**
 * Text the importer adds, which the legacy author never wrote, said as the system speaker (owner decision); `prose`
 * shows text the player only reads, such as a file's content, as prose.
 */
function systemSay(
  value: IrExpression,
  span: SourceSpan | null,
  context: LowerContext,
  prose = false,
): IrStatement {
  context.syntheticHelpers.add("systemSpeaker");
  // `prose (…)` would read as prose options (V30 §17), so other values are written as text.
  const shown =
    prose && value.kind !== "literal" && value.kind !== "template"
      ? { kind: "template" as const, parts: [{ value }] }
      : value;
  return {
    kind: "say",
    value: shown,
    speaker: SYSTEM_SPEAKER,
    ...(prose ? { prose: true } : {}),
    span,
  };
}

function useHelper(context: LowerContext, name: HelperName, args: IrExpression[]): IrExpression {
  context.syntheticHelpers.add(name);
  return helperCall(name, args);
}

function unsupportedExpression(
  context: LowerContext,
  node: AstNode,
  code: string,
  message: string,
): null {
  addDiagnostic(context, code, "error", message, node.span);
  return null;
}

function unsupportedStatement(
  context: LowerContext,
  node: AstNode,
  code: string,
  message: string,
): IrStatement {
  addDiagnostic(context, code, "error", message, node.span);
  const legacySource = node.span === null ? [] : legacySourceLines(context, node.span);
  return { kind: "unsupported", legacySource, span: node.span };
}

/**
 * Renders the not-yet-rendered root causes added while lowering one statement as inline notes, so the
 * generated file explains what needs manual work at the place where it is needed.
 */
function diagnosticNotes(context: LowerContext, firstDiagnostic: number): IrStatement[] {
  const fresh = context.diagnostics
    .slice(firstDiagnostic)
    .filter(
      (diagnostic) =>
        diagnostic.severity !== "info" && !context.renderedDiagnostics.has(diagnostic),
    );
  for (const diagnostic of fresh) context.renderedDiagnostics.add(diagnostic);
  return rootDiagnostics(fresh).map((diagnostic) => {
    const label = diagnostic.severity === "error" ? "TODO" : "NOTE";
    const location = diagnostic.span === null ? "" : ` line ${diagnostic.span.line}`;
    return {
      kind: "comment",
      text: `// ${label} ${diagnostic.code}${location}: ${singleLine(diagnostic.message)}`,
      trailing: false,
      span: diagnostic.span,
    };
  });
}

/** Generated comment text must not contain line terminators, or the rest would become code. */
function singleLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/gu, " ");
}

function legacySourceLines(context: LowerContext, span: SourceSpan): string[] {
  const lines = context.sourceLines.slice(span.line - 1, span.endLine);
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => singleLine(line.slice(indent)).trimEnd());
}

function addDiagnostic(
  context: LowerContext,
  code: string,
  severity: "info" | "warning" | "error",
  message: string,
  span: SourceSpan | null,
): void {
  context.diagnostics.push({ code, severity, message, span });
}

function asNode(value: unknown): AstNode | null {
  return isAstNode(value) ? value : null;
}

function nodeArray(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isAstNode) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isLiteral(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function constantValue(node: AstNode | undefined): string | number | boolean | null | undefined {
  return node?.kind === "constant" && isLiteral(node.value) ? node.value : undefined;
}

/**
 * A number known before the script runs: a number literal, arithmetic on such numbers, or a variable assigned one
 * such number once; undefined otherwise.
 */
function staticNumber(
  node: AstNode | null,
  context: LowerContext,
  seen = new Set<string>(),
): number | undefined {
  if (node === null) return undefined;
  const literal = constantValue(node);
  if (typeof literal === "number") return literal;
  if (node.kind === "unaryMinus") {
    const value = staticNumber(asNode(node.value), context, seen);
    return value === undefined ? undefined : -value;
  }
  if (node.kind === "binary" && typeof node.operator === "string") {
    const left = staticNumber(asNode(node.left), context, seen);
    const right = staticNumber(asNode(node.right), context, seen);
    if (left === undefined || right === undefined) return undefined;
    switch (node.operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return right === 0 ? undefined : left / right;
      default:
        return undefined;
    }
  }
  const name = variableName(node);
  if (name === null || seen.has(name) || context.types.singleAssignment?.has(name) !== true)
    return undefined;
  const initializer = context.constantInitializers.get(name);
  return initializer === undefined
    ? undefined
    : staticNumber(initializer, context, new Set([...seen, name]));
}

/**
 * Whether a value is a positive whole number wherever it is read: one known before the script runs, or a variable that
 * a declaration gives such a value and that every assignment sets to one, which nothing else changes, as a parameter, a
 * loop, `++` or `--`, or a compound assignment would.
 */
function positiveWholeBound(
  node: AstNode | null,
  context: LowerContext,
  seen = new Set<string>(),
): boolean {
  if (node === null) return false;
  const value = staticNumber(node, context);
  if (value !== undefined) return Number.isInteger(value) && value > 0;
  if (node.kind !== "variable") return false;
  const key = bindingKey(node, context.bindings);
  if (
    key === null ||
    seen.has(key) ||
    !context.declaredWrites.initialized.has(key) ||
    context.declaredWrites.other.has(key) ||
    context.parameterBindings.has(key) ||
    (context.compoundValues.get(key)?.length ?? 0) > 0
  )
    return false;
  const values = context.assignedValues.get(key) ?? [];
  return (
    values.length > 0 &&
    values.every((written) => positiveWholeBound(written, context, new Set([...seen, key])))
  );
}

function isTrueConstant(node: AstNode | null): boolean {
  return node?.kind === "constant" && node.value === true;
}

function isNullConstant(node: AstNode | undefined): boolean {
  return node?.kind === "constant" && node.value === null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function migrateScriptPath(value: string): string {
  return value.toLowerCase().endsWith(".groovy") ? `${value.slice(0, -7)}.tease` : `${value}.tease`;
}

/** Whether any call in the values names the function. */
export function callsFunction(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some((item) => callsFunction(item, name));
  if (!isRecord(value)) return false;
  if (value.kind === "call" && value.name === name) return true;
  return Object.values(value).some((child) => callsFunction(child, name));
}
