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
  withActionDispatcher,
  type HelperName,
} from "./helpers.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
import { enforceVariableTypes, functionResultTypes, type TeaseType } from "./variable-types.ts";
import { pathTag } from "./image-tags.ts";
import type { AcceptedForm, MediaFile } from "./workarounds.ts";
import { SEXSCRIPT_API_METHODS } from "./sexscript-api.ts";
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
}

export interface HelperFunctionInfo {
  minArgs: number;
  maxArgs: number;
  stripsMain: boolean;
}

export type HelperRegistry = ReadonlyMap<string, ReadonlyMap<string, HelperFunctionInfo>>;

export interface LowerOptions {
  helperRegistry?: HelperRegistry;
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
  /** Value types of package globals defined in other files, such as anonymous-object fields. */
  globalTypes?: ReadonlyMap<string, number>;
  /**
   * Whether the package stops all background sounds somewhere, so background sounds keep their handles. Without
   * package context, the file itself decides.
   */
  stopsBackgroundSounds?: boolean;
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
  stopsBackgroundSounds: boolean;
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
  /** How the maps are used, by binding: dicts (#536), object fields, value and key types. */
  mapUses: MapUses;
  /** Binding keys of variables that closures declare (bindingKeys). */
  bindings: BindingKeys;
  /** Bindings declared with a Groovy integer type (`int`, `long`, ...), which store whole numbers. */
  integerVariables: ReadonlySet<string>;
  /** Initializers of variables assigned once, by their declaration (staticNumber). */
  constantInitializers: ReadonlyMap<string, AstNode>;
  /** Dict keys known present where the lowering is (presenceFact), from surrounding tests. */
  knownKeys: string[];
  /** Assignment targets being lowered, which are written rather than read. */
  writeTargets: Set<AstNode>;
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
  /** `new File(path)` values that only `.exists()` reads, which convert to their path (fileTests). */
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
      registry.set(className, collectHelperFunctionInfo(nodeArray(helperClass.methods)));
    }
  }
  return registry;
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
   * Variables the code tests for null itself: compared with `== null` or `!= null`, or read with `?.`, where null and
   * an empty list behave differently. Groovy truth treats them alike.
   */
  nullTested: Set<string>;
  /**
   * Variables a text can show before their first assignment: shown inside a function, which may run first, or at the
   * top level before the top level assigns them.
   */
  shownEarly: Set<string>;
  /** Numbers that start as null and that nothing tests for null, which start at 0 (owner decision 2026-10-05). */
  zeroStartNumbers: Set<string>;
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
      const types = withGlobalTypes(
        inferVariableTypes(body, [], functions, functionResults),
        globalTypes,
      );
      return [{ body, types, keys: bindingKeys(body, file.sourceName) }];
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
  };
  const removed = new Map<string, Set<string> | "all">();
  for (const body of bodies) collectMapUses(body, uses, removed);
  for (const body of bodies) collectEarlyDisplays(body, uses.shownEarly);
  for (const { body, types, keys } of bodies) {
    walkAst(body, (node) => {
      const right = node.kind === "declaration" ? asNode(node.right) : null;
      const key = right === null ? null : bindingKey(asNode(node.left), keys);
      const name = variableName(node.left);
      const type = name === null ? UNKNOWN : (types.variables.get(name) ?? UNKNOWN);
      if (
        key !== null &&
        (isEmptyGroovyExpression(right!) || isNullConstant(right!)) &&
        !PRIMITIVE_DEFAULTS.has(text(asNode(node.left)?.originType) ?? "") &&
        !uses.nullTested.has(key) &&
        onlyOf(type, NUMBER | NULL) &&
        (type & NUMBER) !== 0
      )
        uses.zeroStartNumbers.add(key);
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
    stopsBackgroundSounds: options.stopsBackgroundSounds ?? packageStopsBackgroundSounds([file]),
    resultUses: options.resultUses ?? packageResultUses([file]),
    directoryFiles: options.directoryFiles ?? new Map(),
    scriptPaths: options.scriptPaths ?? null,
    dateValues: new Set(),
    aliasedLists: new Set(),
    parameterBindings: new Set(),
    assignedValues: new Map(),
    mapUses: mapUsesOf([]),
    bindings: new Map(),
    integerVariables: new Set(),
    constantInitializers: new Map(),
    knownKeys: [],
    writeTargets: new Set(),
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

  if (file.root.kind === "compilationUnit") return lowerHelperCompilationUnit(file, context);
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
    context.constantInitializers = declarationInitializers(body, context.types);
    context.integerVariables = integerVariables(body, context.bindings);
    context.mapUses =
      options.mapUses ?? mapUsesOf([{ body, types: context.types, keys: context.bindings }]);
    context.elementRemovals = elementRemovals(body);
    Object.assign(context, fileTests(body));
    context.photoVariables = photoVariables(body);
    // A lookup reads the type of the dict's values, as an index reads a list's element type.
    const listElements = new Map(context.types.listElements ?? []);
    for (const [key, type] of context.mapUses.dictionaryValues) {
      const name = bindingName(key);
      if (type !== 0) listElements.set(name, (listElements.get(name) ?? 0) | type);
    }
    // A number that starts at 0 instead of null holds no null.
    const variables = new Map(context.types.variables);
    for (const key of context.mapUses.zeroStartNumbers) {
      const name = bindingName(key);
      const type = variables.get(name);
      if (type !== undefined) variables.set(name, type & ~NULL);
    }
    context.types = { ...context.types, variables, listElements };
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
  const typedStatements = withEnforcedTypes(
    [...context.closureFunctions, ...authoredStatements],
    context,
  );
  const statements = [...helperStatements(context.syntheticHelpers), ...typedStatements];
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
  return renameConflictingIdentifiers(withActionDispatcher(program));
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
  const helperClass = classes[0]!;
  const fields = nodeArray(helperClass.fields);
  if (fields.length > 0) {
    addDiagnostic(
      baseContext,
      "SX_HELPER_SHARED_STATE",
      "error",
      "Auxiliary Groovy helper classes with fields may carry shared or static state and require explicit migration.",
      helperClass.span,
    );
    return {
      sourceName: file.sourceName,
      metadata: null,
      statements: [],
      diagnostics: baseContext.diagnostics,
    };
  }
  const methods = nodeArray(helperClass.methods);
  const helperFunctions = collectHelperFunctionInfo(methods);
  const statements: IrStatement[] = [];
  for (const method of methods) {
    const leadingComments = takeCommentsBefore(baseContext, method.span).map(
      (comment) => comment.text,
    );
    const lowered = lowerHelperMethod(method, baseContext, helperFunctions);
    if (lowered === null) continue;
    if (lowered.kind === "function" && leadingComments.length > 0)
      lowered.leadingComments = leadingComments;
    statements.push(lowered);
  }
  const typedStatements = withEnforcedTypes(statements, baseContext);
  return {
    sourceName: file.sourceName,
    metadata: null,
    statements: [...helperStatements(baseContext.syntheticHelpers), ...typedStatements],
    diagnostics: baseContext.diagnostics,
  };
}

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
  for (const { statement, name, type, first } of result.placeholders) {
    const span = statement.span;
    const diagnostic: MigrationDiagnostic = {
      code: "SX_PLACEHOLDER_TYPE",
      severity: "warning",
      message:
        first === undefined
          ? `Groovy started '${name}' as empty text and later stored ${type}; TeaseScript variables keep one type, so it starts as the empty value of that type, which differs only where the empty text was read.`
          : `Groovy started '${name}' as empty text and later stored ${type}; the TeaseScript variable keeps these types in a union and starts as the empty value of the first, ${first}, which differs only where the empty text was read.`,
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
    const minArgs = authored.filter((parameter) => parameter.defaultValue === null).length;
    result.set(name, { minArgs, maxArgs: authored.length, stripsMain });
  }
  return result;
}

function lowerHelperMethod(
  method: AstNode,
  baseContext: LowerContext,
  helperFunctions: Map<string, HelperFunctionInfo>,
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
  const context: LowerContext = {
    diagnostics: baseContext.diagnostics,
    metadata: baseContext.metadata,
    functions: collectClosureInfo(body),
    types: inferVariableTypes(
      body,
      authoredRecords.map((parameter) => parameter.name),
      helperFunctions.keys(),
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
    unreachable: false,
    mixinModules: baseContext.mixinModules,
    loadsModuleDirectories: baseContext.loadsModuleDirectories,
    stopsBackgroundSounds: baseContext.stopsBackgroundSounds,
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
    mapUses: baseContext.mapUses,
    bindings: new Map(),
    integerVariables: new Set(),
    constantInitializers: new Map(),
    knownKeys: [],
    writeTargets: new Set(),
    accepted: baseContext.accepted,
    elementRemovals: elementRemovals(body),
    media: baseContext.media,
    files: baseContext.files,
    actualFiles: baseContext.actualFiles,
    ...fileTests(body),
    photoVariables: photoVariables(body),
    checksUndefinedVariables: baseContext.checksUndefinedVariables,
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
  for (const parameter of authoredRecords) {
    const parameterName = parameter.name;
    const initial = parameter.defaultValue;
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
  for (let index = 0; index < statements.length; index += 1) {
    // Read-then-default code becomes one read with a default; the `if` is consumed.
    const merged = readThenDefault(statements[index]!, statements[index + 1], context);
    const statement = merged ?? statements[index]!;
    if (merged !== null) index += 1;
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
  return withInstantShows(withVisibleCountdowns(withReusedLoopCounters(result), context));
}

/**
 * Legacy `show()` displayed its text at once, and the `wait()` right after it set the timing, so text shown directly
 * before a wait appears without reading time (converter owner decision 2026-10-05); counting loops keep their pace.
 */
function withInstantShows(statements: IrStatement[]): IrStatement[] {
  return statements.map((statement, index) => {
    if (statement.kind !== "say") return statement;
    const next = statements
      .slice(index + 1)
      .find((item) => item.kind !== "blank" && item.kind !== "comment");
    return next?.kind === "wait" && !next.visible ? { ...statement, instant: true } : statement;
  });
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
 * A loop that only redraws a countdown until `waited = getTimestamp().toSeconds() - start` reaches a limit kept the
 * legacy player busy for that time; TeaseScript runs it out of its instruction budget. Right after `waited` is computed, with a
 * body that only shows text and sets its own locals before recomputing `waited`, it becomes a visible timer over the
 * limit (`timer`, as for waitWithGauge), whose display replaces the redrawn text.
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
    return [
      ...diagnosticNotes(context, firstDiagnostic),
      { kind: "wait", duration: condition.right, visible: true, unit: "s", span: statement.span },
    ];
  });
}

/** The start variable of `waited = getTimestamp().toSeconds() - start` (declaration or assignment), or null. */
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
 * The current Unix time in seconds, which legacy code used for elapsed time and "how long ago": a `timestamp` is the
 * fixed moment for that, while local date and time values have no zone (#532).
 */
function currentSeconds(): IrExpression {
  return {
    kind: "methodCall",
    target: { kind: "call", name: "getTimestamp", positional: [], named: {} },
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
    value.target.name === "getTimestamp" &&
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
            `${node.kind} ${node.label} leaves an outer labelled loop; TeaseScript ${node.kind} affects only the innermost loop. Restructure the loops, for example with a flag.`,
          ),
        ];
      }
      return [{ kind: node.kind, span: node.span }];
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
  if (input && !inputOptions && isLoopMenu(node, context)) return node;
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
    const result =
      loop?.name === "collect" ? closureResult(closureArgument(loop.arguments)!.closure) : null;
    const elements =
      loop?.name === "findAll" && receiver !== null
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
  for (const item of [...declarations, substituteNodes(statement, replacements)]) {
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
    const first = lowerCondition(leftNode, context);
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
    if (first === null || then === null) {
      const legacySource = span === null ? [] : legacySourceLines(context, span);
      return [{ kind: "unsupported", legacySource, span }];
    }
    return [
      declaration
        ? { kind: "let", name, value: first, span }
        : { kind: "assign", target: variable, operator: "=", value: first, span },
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
  return [
    ...lowerStatement(assign(syntheticConstant(null, span)), context),
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
  const shadowed =
    context.functions.has(call.name) ||
    context.packageFunctions.has(call.name) ||
    context.helperFunctions.has(call.name) ||
    isVisibleLocal(call.name, node, context);
  return shadowed ? null : call;
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
    const pureCall = call.inherited
      ? DIRECT_STORAGE_LOADS.has(legacyApiCall(node, context)?.name ?? "")
      : mathCall
        ? PURE_MATH_METHODS.has(call.name)
        : PURE_OBJECT_METHODS.has(call.name);
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

function syntheticConstant(value: boolean | null, span: SourceSpan | null): AstNode {
  return { kind: "constant", span, value };
}

function lowerExpressionStatement(node: AstNode, context: LowerContext): IrStatement[] {
  const expression = asNode(node.expression);
  if (expression === null)
    return [unsupportedStatement(context, node, "SX_MISSING_EXPRESSION", "Missing expression.")];

  if (expression.kind === "declaration") return lowerDeclaration(expression, node.span, context);
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
  if (
    startsNull &&
    key !== null &&
    !context.mapUses.nullTested.has(key) &&
    isListType(context.types.variables.get(name) ?? UNKNOWN)
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
  return [
    {
      kind: "let",
      name,
      value,
      span,
      ...(optionalType === null ? {} : { type: `${optionalType}?` }),
      ...(INTEGER_TYPES.has(declaredType) ? { integer: true as const } : {}),
      ...(INTEGER_TYPES.has(declaredType) && mayBeText(right, context)
        ? { maybeText: true as const }
        : {}),
    },
  ];
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
    const value = lowerClosureValue(closure, context, name);
    return value === null
      ? [
          unsupportedStatement(
            context,
            closure,
            "SX_NESTED_CLOSURE",
            "Nested Groovy closures are not lowered automatically.",
          ),
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
        `Closure ${name} was not discovered during the prepass.`,
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
      parameters.push({ name: record.name, defaultValue });
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
    const composed = composedImage(body, context);
    const lowered =
      composed ??
      lowerBlock(
        closure.implicitReturn === false || !context.resultUses.has(name)
          ? body
          : withImplicitReturn(body, context),
        context,
      );
    const ownDiagnostics = context.diagnostics.slice(firstDiagnostic);
    return [
      {
        kind: "function",
        name,
        parameters,
        body: lowered,
        span,
        ...(ownDiagnostics.some((diagnostic) => diagnostic.severity === "error")
          ? { ownDiagnostics }
          : {}),
      },
    ];
  } finally {
    context.functionDepth -= 1;
    context.currentFunction = outerFunction;
    context.knownKeys.splice(0, context.knownKeys.length, ...outerKeys);
  }
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
  const operator = text(node.operator);
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
      context.writeTargets.add(targetNode);
      target = lowerExpression(targetNode, context);
      context.writeTargets.delete(targetNode);
    }
    if (target !== null) noteSharedListWrite(asNode(targetNode.left), node, context);
    if (target?.kind === "index" && target.dict === true) noteSharedMapWrite(node.span, context);
  } else if (operator === "=" && targetNode.kind === "property") {
    context.writeTargets.add(targetNode);
    target = lowerExpression(targetNode, context);
    context.writeTargets.delete(targetNode);
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
  if (
    operator === "-=" &&
    variableTarget !== null &&
    (removesElement || isListType(inferType(targetNode, context.types)))
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
  const grown =
    operator === "=" ? growingListWrite(targetNode, target, value, span, context) : null;
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
    // TeaseScript += only adds numbers; text and list appends become an ordinary assignment.
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
  return [
    { kind: "assign", target, operator, value, span, ...(textInteger ? { maybeText: true } : {}) },
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
  if (
    targetNode === null ||
    !isRepeatableIndex(targetNode) ||
    (index !== null && negativeConstantIndex(index) !== null)
  )
    return [unsupportedPostfix(node, context)];
  context.writeTargets.add(targetNode);
  const target = lowerExpression(targetNode, context);
  context.writeTargets.delete(targetNode);
  if (target === null) return [];
  if (targetNode.kind === "binary") noteSharedListWrite(asNode(targetNode.left), node, context);
  if (targetNode.kind === "property" || (target.kind === "index" && target.dict === true))
    noteSharedMapWrite(node.span, context);
  return [
    {
      kind: "assign",
      target,
      operator: operator === "++" ? "+=" : "-=",
      value: { kind: "literal", value: 1 },
      span,
    },
  ];
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
  if (call !== null && !call.inherited && receiver !== null && isDictionary(receiver, context)) {
    const dictionary = dictStatement(receiver, call, span, context);
    if (dictionary !== null) return dictionary;
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
  if (call.name === "sleep") {
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
    return [{ kind: "let", name: `ignoredAnswer${context.ignoredInputs}`, value: answer, span }];
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
      return oneArgumentStatement(args, context, node, (file) => ({
        kind: "showImage",
        file: mediaFile(file, "images", node, context),
        span,
      }));
    }
    case "playSound":
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
      return [
        { kind: "expression", expression: useHelper(context, "stopBackgroundSounds", []), span },
      ];
    case "save":
      return lowerSave(args, node, span, context);
    case "send":
      addDiagnostic(context, "SX_ONLINE_STORAGE", "warning", ONLINE_STORAGE_NOTE, node.span);
      return lowerSave(args, node, span, context);
    case "useFile":
      return useFileStatements(args, node, span, context);
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
  const argument =
    call.arguments.length === 0 && call.name === "sum" ? null : closureArgument(call.arguments);
  if (argument === null && !(call.name === "sum" && call.arguments.length === 0)) return null;
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

  // From here on the idiom is recognized; an inner failure keeps its own root diagnostic.
  const failed = (): IrStatement[] => [
    unsupportedStatement(
      context,
      right,
      "SX_UNSUPPORTED_DECLARATION_VALUE",
      `Cannot safely migrate the ${call.name}() loop for ${target}.`,
    ),
  ];
  const collection = lowerExpression(receiver, context);
  if (collection === null) return failed();
  // A loop body that reads the target sees its old value only through a separate result variable.
  // The loop reads the receiver and runs the closure after the result starts; when either may read the
  // destination, a separate variable collects the result, which the destination gets last.
  const readsTarget =
    mayReadDestination(receiver, destination, context) ||
    (argument !== null && mayReadDestination(argument.closure, destination, context));
  const accumulator = readsTarget ? freshName(`${call.name}Result`, context) : target;
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
  switch (call.name) {
    case "collect": {
      const value = lowerExpression(result!.value, context);
      if (value === null) return failed();
      initial = { kind: "list", items: [] };
      body = [...prefix, add(value)];
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
            then: [assign({ kind: "literal", value: null })],
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
  return [start, loop, ...empty, store];
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
            },
            body: loopBody,
            span,
          },
        ]
      : [{ kind: "repeat", count, body: loopBody, span }];
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

  const collection = lowerIterated(receiverNode, context);
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
  if (returns.length > 0) noteReturnAsContinue(returns[0]!.node, context);
  const loopBody = lowerBlock(body, context);
  return [
    {
      kind: "for",
      variable,
      collection,
      body: returns.length > 0 ? withoutFinalContinue(returnsAsContinue(loopBody)) : loopBody,
      span,
    },
  ];
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
function returnsAsContinue(statements: IrStatement[]): IrStatement[] {
  return statements.map((statement): IrStatement => {
    switch (statement.kind) {
      case "return":
      case "goto":
        return { kind: "continue", span: statement.span };
      case "exit":
        return statement.returned === true ? { kind: "continue", span: statement.span } : statement;
      case "if":
        return {
          ...statement,
          then: returnsAsContinue(statement.then),
          else: returnsAsContinue(statement.else),
        };
      case "switch":
        return {
          ...statement,
          cases: statement.cases.map((item) => ({ ...item, body: returnsAsContinue(item.body) })),
          default: returnsAsContinue(statement.default),
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
  if (args.length === 1 && isNullConstant(args[0])) {
    return [
      { kind: "expression", expression: useHelper(context, "stopBackgroundSounds", []), span },
    ];
  }
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
  if (context.stopsBackgroundSounds || !fixedPasses) {
    // Keep the handle so a later playBackgroundSound(null) can stop this sound; the helper also plays nothing for
    // fewer than one pass, which `repeat: n times` rejects.
    const passes = repeatCount ?? { kind: "literal", value: 1 };
    return [
      {
        kind: "expression",
        expression: useHelper(context, "playBackgroundSound", [file, passes]),
        span,
      },
    ];
  }
  return [{ kind: "playAudio", file, async: true, repeatCount, span }];
}

/** Whether any file stops all background sounds with playBackgroundSound(null) or stopSoundThreads(). */
export function packageStopsBackgroundSounds(files: readonly ParsedGroovyFile[]): boolean {
  let stops = false;
  for (const file of files) {
    walkAst(file.root, (node) => {
      const call = node.kind === "methodCall" ? callParts(node) : null;
      if (call === null || !call.inherited) return;
      if (call.name === "stopSoundThreads") stops = true;
      // A file that may be null at runtime stops all sounds as well.
      const file = call.arguments[0];
      if (
        call.name === "playBackgroundSound" &&
        !(file?.kind === "constant" && typeof file.value === "string")
      ) {
        stops = true;
      }
    });
  }
  return stops;
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
  const body =
    loopBody !== null && loopBody.kind !== "block" && loopBody.kind !== "empty"
      ? { kind: "block", span: loopBody.span, statements: [loopBody] }
      : loopBody;
  // A loop that removes its element from the collection proves it a list (elementRemovals).
  let removes = false;
  if (body !== null) walkAst(body, (child) => (removes ||= context.elementRemovals.has(child)));
  const collection =
    collectionNode === null ? null : lowerIterated(collectionNode, context, removes);
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
    collectionNode?.kind === "methodCall" &&
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
  return [{ kind: "for", variable, collection, body: loweredBody, span: node.span }];
}

/**
 * A collection a loop iterates. Groovy iterated a range up to the whole number at or below a fractional upper bound,
 * where TeaseScript stops, so a bound that may hold a fraction is floored.
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
    if (onlyOf(type, STRING | NULL))
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
      "Groovy iterated text by character and a list by element; this value is not proven to be one of them, so a helper splits text into its characters.",
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
    "Groovy iterated this range up to the whole number at or below its upper bound, which may hold a fraction; the bound is floored.",
    node.span,
  );
  return {
    ...collection,
    to: { kind: "call", name: "floor", positional: [collection.to], named: {} },
  };
}

/**
 * Whether a list position can be one past the end: a random position plus a positive number, `getRandom(n) + 1` for a
 * 1-based pick, a list's size, or a variable assigned one of these.
 */
function mayIndexPastEnd(node: AstNode, context: LowerContext, seen = new Set<string>()): boolean {
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
  if (node.kind === "variable") {
    const key = bindingKey(node, context.bindings);
    if (key === null || seen.has(key)) return false;
    seen.add(key);
    return (context.assignedValues.get(key) ?? []).some((value) =>
      mayIndexPastEnd(value, context, seen),
    );
  }
  return false;
}

/**
 * Whether a value may be a missing storage value, which Groovy read as null: a storage read, or a variable that starts
 * with one or with null.
 */
function mayReadNull(node: AstNode, context: LowerContext): boolean {
  if (node.kind === "methodCall")
    return DIRECT_STORAGE_LOADS.has(legacyApiCall(node, context)?.name ?? "");
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
      return values.some((value) => mayBeFractional(value, context, seen));
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
    const match = matchNode === null ? null : lowerExpression(matchNode, context);
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
  if (isAcceptedSwitch(valueCases)) {
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
  let chain: IrStatement[] = defaultStatements;
  for (let index = cases.length - 1; index >= 0; index -= 1) {
    const switchCase = cases[index]!;
    chain = [
      {
        kind: "if",
        condition: caseMatches(subject, switchCase.matches[0]!, listCases[index]!),
        then: switchCase.body,
        else: chain,
        span: switchCase.span,
      },
    ];
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
    if ((terminal !== undefined && isSwitchBreak(terminal)) || terminal?.kind === "return")
      return result;
  }
  result.push(...withoutTerminalBreak(defaultSource));
  return result;
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
    'Legacy chained to the script this value names, and ended the chain when the value was null or empty or named no file; its ".groovy" becomes ".tease" here, and script() fails at runtime for a name that is no file of the package.',
    node.span,
  );
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
      return { kind: "list", items };
    }
    case "map":
      return lowerMapExpression(node, context);
    case "gstring":
      return lowerGString(node, context);
    case "array":
      return lowerArrayExpression(node, context);
    case "constructorCall":
      if (isCurrentDateConstructor(node)) {
        return { kind: "call", name: "getDateTime", positional: [], named: {} };
      }
      if (context.fileValues.has(node)) {
        const pathNode = nodeArray(asNode(node.arguments)?.items)[0];
        return pathNode === undefined ? null : lowerExpression(pathNode, context);
      }
      return unsupportedExpression(
        context,
        node,
        "SX_JAVA_CONSTRUCTOR",
        `Java object construction (new ${text(node.type) ?? "?"}) has no TeaseScript equivalent.`,
      );
    case "closure":
      return lowerClosureValue(node, context);
    case "property":
      return lowerPropertyExpression(node, context);
    case "range": {
      const fromNode = asNode(node.from);
      const toNode = asNode(node.to);
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
 * variable, the value is the variable itself and the increment follows the statement.
 */
function lowerPostfixValue(node: AstNode, context: LowerContext): IrExpression | null {
  const name = variableName(asNode(node.value));
  const operator = node.operator === "++" ? "+=" : node.operator === "--" ? "-=" : null;
  const root = context.statementRoot;
  if (
    name === null ||
    operator === null ||
    root === null ||
    root !== context.postludeRoot ||
    root.kind !== "expressionStatement" ||
    !incrementsAfterStatement(root, node, name, context)
  ) {
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
  // The change may move before the statement when nothing else in it reads the variable or calls a local function.
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
    operator === null ||
    root === null ||
    uses !== 1 ||
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
 * kept 1 and "1" apart; on a dict with number keys, a key of unknown type becomes text too. A key that may be null is
 * reported.
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
  if ((keyType & NULL) !== 0 && keyType !== UNKNOWN) {
    return unsupportedExpression(
      context,
      node,
      "SX_DICT_KEY",
      "This map key may be null; dict keys are text (#536).",
    );
  }
  const key = lowerExpression(keyNode, context);
  if (key === null) return null;
  if (onlyOf(keyType, STRING) || (keyType === UNKNOWN && !numberKeys)) return key;
  noteDictKeyText(node, context);
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

function lowerBinaryExpression(node: AstNode, context: LowerContext): IrExpression | null {
  const operator = text(node.operator);
  if (operator === "[") {
    const targetNode = asNode(node.left);
    const indexNode = asNode(node.right);
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
    // Groovy read null past the end of a list, which code that picks `getRandom(size) + 1` relies on.
    if (!context.writeTargets.has(node) && mayIndexPastEnd(indexNode, context)) {
      addDiagnostic(
        context,
        "SX_INDEX_PAST_END",
        "warning",
        "This position can be one past the end of the list, where Groovy read null; a helper reads null there too.",
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
      "A side of this comparison may be a storage value that is missing; Groovy ordered null below every value, so a helper compares the sides as Groovy did.",
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
    const lookup = isNullConstant(other) ? dictLookup(lookupNode, context) : undefined;
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
    const read = (): IrExpression => ({ kind: "load", key });
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
 * evaluated twice; undefined for any other expression.
 */
function dictLookup(node: AstNode, context: LowerContext): IrExpression | null | undefined {
  const parts = dictLookupParts(node, context);
  if (parts === null || (parts.key !== null && !isRepeatableExpression(parts.key)))
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
      TYPED_STORAGE_LOADS.has(legacyApiCall(read, context)?.name ?? "")
    ) ||
    // A dict's default has its value type, as for `?:` (dictDefaultFits).
    (dictLookupParts(read, context) !== null &&
      !dictDefaultFits(dictLookupParts(read, context)!, fallback, context))
  )
    return null;
  const merged: AstNode = { kind: "readDefault", span: read.span, read, fallback };
  const span =
    statement.span === null || next.span === null
      ? statement.span
      : { ...statement.span, endLine: next.span.endLine, endColumn: next.span.endColumn };
  return { ...statement, span, expression: { ...expression!, right: merged } };
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
  if (onlyOf(type, BOOLEAN)) return value;
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
  if (isDictionary(node, context)) {
    // A dict is false when it is empty, as a Groovy map was.
    return {
      kind: "binary",
      operator: ">",
      left: { kind: "property", target: value, name: "length", dict: true },
      right: { kind: "literal", value: 0 },
    };
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
  addDiagnostic(
    context,
    "SX_CONDITION_TYPE",
    "warning",
    "Condition is not proven boolean; TeaseScript conditions must be boolean, unlike Groovy truthiness. Verify or compare explicitly.",
    node.span,
  );
  return value;
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
function isRepeatableExpression(node: AstNode): boolean {
  if (node.kind === "variable" || node.kind === "constant") return true;
  if (node.kind === "property") {
    const target = asNode(node.object);
    return target !== null && isRepeatableExpression(target);
  }
  return false;
}

/**
 * Groovy `+` concatenates when either operand is a string; TeaseScript `+` is numeric only, so string
 * concatenation becomes interpolation. Left-associative chains such as `1 + 2 + "x"` keep their numeric prefix.
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
      "Groovy + operands are not proven numeric; TeaseScript + only adds numbers. Use interpolation if this joins text.",
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
  if (!element && !removesList && !onlyOf(rightType, NUMBER | STRING | BOOLEAN | NULL)) {
    return unsupportedExpression(
      context,
      node,
      "SX_LIST_DIFFERENCE",
      "Groovy list - removed one value or every element of a list; the right side is not proven to be either. Use difference() with a list.",
    );
  }
  const left = lowerExpression(leftNode, context);
  const right = lowerExpression(rightNode, context);
  if (left === null || right === null) return null;
  addDiagnostic(
    context,
    "SX_LIST_DIFFERENCE",
    "warning",
    "Groovy list - kept repeated elements of the list; difference() keeps each remaining element once (V30 §16).",
    node.span,
  );
  return {
    kind: "methodCall",
    target: left,
    name: "difference",
    arguments: [removesList ? right : { kind: "list", items: [right] }],
  };
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
      // Groovy `list + element` appends one element; `list + otherList` appends all elements, so the right
      // side must be proven one or the other (a null right side is appended as an element).
      const rightType = inferType(rightNode, context.types);
      const rightIsList = onlyOf(rightType, LIST);
      const rightIsElement = (rightType & (LIST | NULL)) === 0 && rightType !== 0;
      if (!rightIsList && !rightIsElement) {
        unsupportedExpression(
          context,
          rightNode,
          "SX_LIST_CONCATENATION",
          "Groovy list + appends a list's elements or a single value; the type of this right side is not proven, so convert it manually.",
        );
        return null;
      }
      const left = listConcatenationOperands(leftNode, context);
      const right = lowerExpression(rightNode, context);
      if (left === null || right === null) return null;
      return [...left, rightIsList ? right : { kind: "list", items: [right] }];
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
    if (leftNode !== null && rightNode !== null && onlyOf(inferType(node, context.types), STRING)) {
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
  const rightType = inferType(right, context.types);
  return (
    onlyOf(inferType(left, context.types), BOOLEAN) &&
    (onlyOf(rightType, BOOLEAN | NULL) || rightType === UNKNOWN)
  );
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
    case "java.lang.String":
      return { kind: "call", name: "toString", positional: [value], named: {} };
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
      return args === null ? null : useHelper(context, helper.name, args);
    }
    if ((name === "ceil" || name === "floor") && argumentsNodes.length === 1) {
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
  if (name === "exists" && argumentsNodes.length === 0 && targetNode !== null) {
    const pathNode = isFileConstructor(targetNode)
      ? nodeArray(asNode(targetNode.arguments)?.items)[0]
      : context.fileVariables.has(variableName(targetNode) ?? "")
        ? targetNode
        : undefined;
    if (pathNode !== undefined && context.files !== null)
      return fileExists(pathNode, node, context, context.files);
  }
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
          ? "Groovy count() counted every occurrence of a text, overlapping ones too; it converts only for a literal text whose occurrences cannot overlap."
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
      // Java replaceAll() takes a regular expression and a replacement pattern; only plain text is covered.
      const pattern = literalText(argumentsNodes[0]);
      const replacement = literalText(argumentsNodes[1]);
      if (argumentsNodes.length !== 2 || pattern === null || replacement === null) return undefined;
      if (/[\\^$.|?*+()[\]{}]/u.test(pattern) || /[\\$]/u.test(replacement)) return undefined;
      operation = "replace";
      break;
    }
    case "split": {
      // Java split() takes a regular expression and drops trailing empty parts.
      const separator = literalText(argumentsNodes[0]);
      if (argumentsNodes.length !== 1 || separator === null || separator === "") return undefined;
      if (/[\\^$.|?*+()[\]{}]/u.test(separator)) return undefined;
      addDiagnostic(
        context,
        "SX_SPLIT_TRAILING_EMPTY",
        "warning",
        "Java split() drops trailing empty parts; TeaseScript split() keeps them.",
        node.span,
      );
      operation = "split";
      break;
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

/** Java Math helpers without an accepted TeaseScript built-in. */
const MATH_HELPERS = new Map<string, { name: HelperName; arity: number }>([
  ["abs", { name: "abs", arity: 1 }],
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

/**
 * A write at a position of a list that starts empty and is filled by position: Groovy grew the list, padding with
 * null up to the position, where a TeaseScript list index must exist. The write appends at the end instead, which is
 * Groovy's result whenever the position is the length; a note says so.
 */
function growingListWrite(
  targetNode: AstNode,
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
  if (
    target.kind !== "index" ||
    target.dict === true ||
    indexNode === null ||
    !isRepeatableExpression(indexNode) ||
    initializer?.kind !== "list" ||
    nodeArray(initializer.items).length !== 0 ||
    !onlyOf(inferType(indexNode, context.types), NUMBER)
  )
    return null;
  addDiagnostic(
    context,
    "SX_LIST_GROWTH",
    "warning",
    "Groovy grew this list when writing at or past its end, padding with null; a TeaseScript position must exist, so a write at the end appends, which differs only for a position beyond the end.",
    span,
  );
  const list = target.target;
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
 * `formatDateTime()`, which show the player's local form instead of the legacy pattern, with a note. Other patterns
 * (weekday names, partial fields, time zones) and dates built from Unix time are reported.
 */
function dateFormat(
  node: AstNode,
  targetNode: AstNode,
  argumentsNodes: AstNode[],
  context: LowerContext,
): IrExpression | null {
  const pattern = argumentsNodes.length === 1 ? constantString(argumentsNodes[0]) : null;
  if (!isCurrentDateConstructor(targetNode)) {
    return unsupportedExpression(
      context,
      node,
      "SX_DATE_FORMAT",
      "This Java date is built from its arguments, such as a Unix time in milliseconds; TeaseScript builds no timestamp or date from a number (#532). Store and load the timestamp or datetime itself, then format it.",
    );
  }
  const kind = pattern === null ? null : datePatternKind(pattern);
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
 * that depends on values, a dict of the matching folders' counts read with the folder's lower-case path. Only a
 * pattern of literal text applies.
 */
function conversionTimeImageCount(
  listing: NonNullable<ReturnType<typeof imageListing>>,
  node: AstNode,
  context: LowerContext,
  media: readonly MediaFile[],
): IrExpression | undefined {
  const pattern =
    listing.nameFilter === null ? null : namePattern(asNode(listing.nameFilter.right));
  if (listing.nameFilter !== null && pattern === null) return undefined;
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const folderPattern = new RegExp(
    `^${listing.segments
      .map((parts) => parts.map((part) => ("text" in part ? escape(part.text) : "[^/]*")).join(""))
      .join("/")}$`,
    "iu",
  );
  const counts = new Map<string, number>();
  for (const file of media) {
    const slash = file.path.replaceAll("\\", "/").lastIndexOf("/");
    const folder = slash < 0 ? "" : file.path.replaceAll("\\", "/").slice(0, slash);
    const fileName = file.path.replaceAll("\\", "/").slice(slash + 1);
    if (!folderPattern.test(folder)) continue;
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
      if (
        argument === null ||
        key === undefined ||
        value === undefined ||
        argument.parameters.length !== 2
      )
        return null;
      const closureBody = asNode(argument.closure.body);
      if (closureBody === null || containsReturnForCurrentClosure(closureBody)) return null;
      return [
        {
          kind: "for",
          variable: key,
          collection: dict,
          dict: true,
          body: [
            {
              kind: "let",
              name: value,
              value: {
                kind: "index",
                target: dict,
                index: { kind: "variable", name: key },
                dict: true,
              },
              span,
            },
            ...lowerBlock(closureBody, context),
          ],
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
  const functionInfo = context.functions.get(call.name);
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
    return call.name === "loadInteger" || call.name === "receiveInteger"
      ? { kind: "load", key, integer: true }
      : { kind: "load", key };
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
    return useHelper(context, "loadFirstTrue", [{ kind: "list", items: keys }]);
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
      // Only a positive integer bound is certain to give randomInteger() a non-empty range.
      if (
        args[0]!.kind === "literal" &&
        typeof args[0]!.value === "number" &&
        Number.isInteger(args[0]!.value) &&
        args[0]!.value > 0
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
        "showPopup() returned the seconds until the player closed the popup; TeaseScript popups return nothing, so the time is measured with getTimestamp().toSeconds(), in whole seconds.",
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
      // Legacy getBoolean shows its text like show() and then two buttons; the first button means true.
      if (!pushPrompt(context, node, call.arguments[0]!, args[0]!)) return null;
      const yes = args[1] ?? { kind: "literal", value: "Yes" };
      const no = args[2] ?? { kind: "literal", value: "No" };
      return {
        kind: "binary",
        operator: "==",
        left: { kind: "choice", options: [yes, no], labels: ["yes", "no"] },
        right: { kind: "literal", value: "yes" },
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
      if (context.accepted.has("askBooleans"))
        return {
          kind: "call",
          name: "askBooleans",
          positional: [],
          named: { message: args[0]!, texts: args[1]!, defaults: args[2]! },
        };
      addDiagnostic(
        context,
        "SX_ASK_BOOLEANS_WORKAROUND",
        "warning",
        "Workaround for askBooleans(), which main does not implement yet: one yes/no choice per item, the preset marked, and a confirmation that can start over. Switch back to askBooleans(message:, texts:, defaults:) when it is implemented.",
        node.span,
      );
      return useHelper(context, "askBooleans", args);
    case "showButton": {
      // Legacy returned the seconds until the click; TeaseScript returns the elapsed duration (V30 §21, #531).
      const legacyTimeout =
        args.length === 2 ? buttonTimeout(call.arguments[1], node, context) : undefined;
      if (legacyTimeout === null)
        return unsupportedExpression(context, node, "SX_BUTTON_TIMEOUT", NEGATIVE_TIMEOUT);
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
      if (args.length !== 1)
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
      // The corpus asks for files to get a photo of the player (owner decision 2026-10-05); chooseFile() is #604.
      addDiagnostic(
        context,
        "SX_FILE_PHOTO",
        "warning",
        "getFile() let the player pick any file with this title; scripts use it for a photo of the player, so the title is shown and takePhoto() takes the photo, or gives null as a cancelled chooser did.",
        node.span,
      );
      if (!pushPrompt(context, node, call.arguments[0]!, args[0]!)) return null;
      return { kind: "call", name: "takePhoto", positional: [], named: {} };
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
      if (args.length !== 1) {
        return unsupportedExpression(
          context,
          node,
          "SX_CALL_ARITY",
          "getImage() must have one argument.",
        );
      }
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
): IrExpression | null | undefined {
  if (timeoutNode === undefined) return undefined;
  const value = staticNumber(timeoutNode, context);
  if (value !== undefined && value < 0) return null;
  if (value === undefined) {
    addDiagnostic(
      context,
      "SX_BUTTON_TIMEOUT",
      "warning",
      "With a zero timeout the legacy button stayed visible for its 10 ms safety margin; TeaseScript rejects a timeout that is not positive (#531), so this button stops the script if its computed timeout is zero or negative.",
      node.span,
    );
    return undefined;
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
    // A prefill that may be blank or null opens the input without a default then, as the legacy empty field did.
    if (prefill !== null && !notePrefill(name, defaultNode!, node, context)) {
      if (!pushPrompt(context, node, argumentNodes[0]!, args[0]!)) return null;
      return useHelper(
        context,
        name === "getString" ? "askText" : name === "getInteger" ? "askInteger" : "askNumber",
        [prefill],
      );
    }
    if (prefill !== null && name === "getString" && !onlyOf(defaultType, STRING)) {
      textPrefill =
        prefill.kind === "literal"
          ? { kind: "literal" as const, value: String(prefill.value) }
          : templateOrLiteral([{ value: prefill }]);
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
 * A default TeaseScript rejects when the input opens: `null` for numbers, and blank text for text input (V30 §20).
 * Legacy showed "null" or an empty field instead, so a default that may be either goes through a helper that asks
 * without it then, with a note; false for such a default. A text default that is not text becomes text, which is
 * never blank.
 */
function notePrefill(
  name: string,
  defaultNode: AstNode,
  node: AstNode,
  context: LowerContext,
): boolean {
  const type = inferType(defaultNode, context.types);
  const text = constantValue(defaultNode);
  const valid =
    name === "getString"
      ? (typeof text === "string" && text.trim() !== "") ||
        (text !== undefined && typeof text !== "string") ||
        (defaultNode.kind === "gstring" && gstringHasText(defaultNode)) ||
        onlyOf(type, NUMBER | BOOLEAN | NULL)
      : onlyOf(type, NUMBER);
  if (valid) return true;
  addDiagnostic(
    context,
    "SX_INPUT_PREFILL",
    "warning",
    name === "getString"
      ? `${name}() pre-filled its field with this value, also when it was blank or null; a TeaseScript default must be non-blank text, so a helper asks without the default then.`
      : `${name}() pre-filled its field with this value, also when it was null; a TeaseScript default must be ${name === "getInteger" ? "a whole number" : "a number"}, so a helper asks without the default when it is not.`,
    node.span,
  );
  return false;
}

/** Whether a GString has literal text other than whitespace, so it is never blank. */
function gstringHasText(node: AstNode): boolean {
  const strings = Array.isArray(node.strings) ? node.strings : [];
  return strings.some((part) => typeof part === "string" && part.trim() !== "");
}

function isEmptyDefault(node: AstNode): boolean {
  return node.kind === "constant" && (node.value === null || node.value === "");
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
): boolean {
  if (isNullConstant(messageNode)) return true;
  const root = context.statementRoot;
  // Groovy evaluates all arguments before showing the message, so other arguments must not have effects.
  const otherArguments = (callParts(inputNode)?.arguments ?? []).filter(
    (argument) => argument !== messageNode,
  );
  const ordered =
    root !== null &&
    isHoistable(root, inputNode, context, messageNode) &&
    otherArguments.every((argument) => isPure(argument, context));
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
  if (!pushPrompt(context, node, args[0]!, message)) return null;
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
  const pieces = listPlusOperands(optionsNode);
  const listNode = pieces.at(-1)!;
  const written = pieces.slice(0, -1);
  if (listNode.kind === "list" || written.some((piece) => piece.kind !== "list")) return undefined;
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
    if (!isKnownListExpression(listNode, context)) return undefined;
    const lowered = lowerExpression(listNode, context);
    if (lowered === null) return null;
    list = lowered;
  }
  const options: IrListChoiceOption[] = [];
  for (const [index, item] of writtenItems.entries()) {
    const text = lowerExpression(item, context);
    if (text === null) return null;
    options.push({ kind: "option", value: index, text });
  }
  context.prelude.push(...loop);
  if (!pushPrompt(context, node, messageNode, message)) return null;
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
  const values = args.map(staticMetadataValue);
  const tagsNode = args[7];
  const tagNames =
    tagsNode?.kind === "list" ? nodeArray(tagsNode.items).map(staticMetadataValue) : [];
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

/** A metadata value known before the script runs: a literal, or text joined from literals with `+`. */
function staticMetadataValue(
  node: AstNode | undefined,
): string | number | boolean | null | undefined {
  if (node === undefined) return undefined;
  const literal = constantValue(node);
  if (literal !== undefined) return literal;
  if (node.kind === "binary" && node.operator === "+") {
    const left = staticMetadataValue(asNode(node.left) ?? undefined);
    const right = staticMetadataValue(asNode(node.right) ?? undefined);
    if (typeof left === "string" || typeof right === "string")
      return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  return undefined;
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
): { body: AstNode; info: MixinModuleInfo } | null {
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
    } else if (name !== null && right !== null) {
      globals.push(
        declaration(
          name,
          {
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
  return { body: { ...body, statements }, info };
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
  const methods = nodeArray(objectClass.methods);
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
  for (const statement of nodeArray(body.statements)) {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    if (expression?.kind !== "declaration") continue;
    const name = variableName(expression.left);
    const closure = asNode(expression.right);
    if (name === null || closure?.kind !== "closure") continue;
    const implicitParameter = closure.parameterSpecified !== true;
    const parameters = groovyParameters(closure.parameters) ?? [];
    const minArgs = implicitParameter
      ? 0
      : parameters.filter((parameter) => parameter.defaultValue === null).length;
    result.set(name, {
      implicitParameter,
      minArgs,
      maxArgs: implicitParameter ? 0 : parameters.length,
    });
  }

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

function isFileConstructor(node: AstNode): boolean {
  return (
    node.kind === "constructorCall" &&
    (node.type === "File" || node.type === "java.io.File") &&
    nodeArray(asNode(node.arguments)?.items).length === 1
  );
}

/**
 * The `new File(path)` values whose only use is `.exists()`: directly as its receiver, or kept in a variable that
 * nothing reads otherwise (LowerContext.fileValues, fileVariables).
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
    if (node.kind === "methodCall" && constantString(node.method) === "exists") {
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
 * The fixed beginning of a path, its text up to the first computed part, with `getDataFolder()` as the package root;
 * `complete` when nothing in it is computed.
 */
function staticPath(node: AstNode): { text: string; complete: boolean } {
  const literal = constantString(node);
  if (literal !== null) return { text: literal, complete: true };
  if (node.kind === "methodCall" && constantString(node.method) === "getDataFolder")
    return { text: "", complete: true };
  if (node.kind === "gstring") {
    const strings = Array.isArray(node.strings) ? node.strings : [];
    const first: unknown = strings[0];
    return {
      text: typeof first === "string" ? first : "",
      complete: nodeArray(node.values).length === 0,
    };
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
    {
      kind: "say",
      value:
        url.kind === "literal" && typeof url.value === "string"
          ? { kind: "literal", value: `Open this link: ${url.value}` }
          : { kind: "template", parts: [{ text: "Open this link: " }, { value: url }] },
      span,
    },
    { kind: "showButton", label: { kind: "literal", value: "Continue" }, timeout: null, span },
  ];
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
