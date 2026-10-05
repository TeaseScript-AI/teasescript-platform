/**
 * Conversion rules for legacy Java and data APIs that TeaseScript expresses with values, loops, and small generated
 * functions (the category-a rules of corpus inventory step 4/A). The lowering in lower.ts calls the hooks below through
 * `JavaRuleHost`; a hook returns undefined for anything it does not recognize, so the lowering's own handling and
 * diagnostics stay in place.
 *
 * Package text resources: legacy scripts read text files of their own package, such as quiz questions, Properties
 * strings, or INI settings. When no script of the package writes such a file, its text belongs to the package as
 * converted: a `File` (or a stream or reader over one) becomes the path text that names it, and reading it calls a
 * generated function that holds the file's lines, Properties entries, or INI values as they were at conversion time.
 */
import {
  constantString,
  isAstNode,
  variableName,
  type AstNode,
  type ParsedGroovyFile,
  type SourceSpan,
} from "./ast.ts";
import {
  argumentOf,
  argumentsOf,
  asNode,
  buildTree,
  dottedName,
  isAssigned,
  isNullConstant,
  isWholeStatement,
  memberOf,
  type Tree,
} from "./java-ast.ts";
import type { HelperName } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import {
  analyzeTemporal,
  temporalBinary,
  temporalCall,
  temporalConstructor,
  temporalProperty,
  temporalStatement,
  type TemporalAnalysis,
} from "./java-time.ts";
import {
  analyzeText,
  textAssignment,
  textCall,
  textConstructor,
  textDeclaration,
  textMatch,
  textProperty,
  textStatement,
  type TextAnalysis,
} from "./java-text.ts";
import { packageFilePath } from "./lower.ts";

/** What the rules need from the lowering of the current file. */
export interface JavaRuleHost {
  lower(node: AstNode): IrExpression | null;
  /** Adds a diagnostic: a warning becomes an inline NOTE, an error an inline TODO. */
  diagnostic(
    code: string,
    severity: "info" | "warning" | "error",
    message: string,
    span: SourceSpan | null,
  ): void;
  helper(name: HelperName, args: IrExpression[]): IrExpression;
  /** A java.util.Calendar field (`MONTH`, `DAY_OF_WEEK`, ...) of a date and time, or null after a diagnostic. */
  calendarField(field: string, value: IrExpression, node: AstNode): IrExpression | null;
  /** The legacy value types a node may have (types.ts). */
  valueType(node: AstNode): number;
  /** Whether a name is a variable of the script rather than a Java class. */
  isVariable(name: string): boolean;
  /**
   * Checks a write to a list: false after a diagnostic when Groovy changed a list that a caller or loop shares, true
   * otherwise, with a note when another variable shared it.
   */
  listWrite(receiver: AstNode, node: AstNode): boolean;
  /** A call of the function an action ID (a converted closure value) names. */
  actionCall(action: IrExpression, args: IrExpression[]): IrExpression;
  /** Whether a node names a photo the script took, whose reference is no package path. */
  isPhoto(node: AstNode): boolean;
  readonly state: JavaFileState;
}

/** A note that a line gives once, however many of its operations differ the same way. */
export function noteOnce(
  host: JavaRuleHost,
  code: string,
  message: string,
  span: SourceSpan | null,
): void {
  const key = `${code}:${span?.line ?? ""}`;
  if (span !== null && host.state.data.noted.has(key)) return;
  host.state.data.noted.add(key);
  host.diagnostic(code, "warning", message, span);
}

/** Reads a file of the legacy data folder by its name in `PackageOptions.files`; null when it cannot be read. */
export type PackageFileReader = (name: string) => Uint8Array | null;

/** The package's files that package text reads can snapshot, and the paths some package script writes. */
export interface PackageResources {
  /** Each file by its normalized path (`packageFilePath`), for paths that only one file has. */
  readonly files: ReadonlyMap<string, string>;
  /** Normalized paths that several files share apart from letter case. */
  readonly ambiguous: ReadonlySet<string>;
  /** Paths that some script of the package may write, delete, or hand to code the importer cannot follow. */
  readonly writes: readonly PathPattern[];
  readonly read: PackageFileReader | null;
  readonly contents: Map<string, Uint8Array | null>;
}

/** The resource analysis of one file, and the package data its conversion uses. */
export interface JavaFileState {
  readonly resources: PackageResources | null;
  readonly analysis: ResourceAnalysis;
  /** The Calendar and Date values of the body (java-time.ts). */
  readonly temporal: TemporalAnalysis;
  /** The Random objects, character arrays, and HashSets of the body (java-text.ts). */
  readonly text: TextAnalysis;
  /** Generated data per kind, by normalized path, shared by every context lowering the file. */
  readonly data: {
    lines: Map<string, string[]>;
    properties: Map<string, Map<string, string>>;
    ini: Map<string, Map<string, string>>;
    /** Notes already given, by code and line, so that one line explains each difference once. */
    noted: Set<string>;
  };
}

/** A path as code computes it: its fixed beginning and its fixed end; `complete` when nothing in it is computed. */
interface PathPattern {
  prefix: string;
  suffix: string;
  complete: boolean;
  /** Where a write of the path happens, as `file:line`. */
  origin?: string;
  /**
   * For a write that the conversion keeps in storage (storedText): a whole-text write, an append, or a delete through a
   * `File` variable or a `File` of one path.
   */
  stored?: "write" | "append" | "delete";
}

type ResourceKind = "file" | "stream" | "ini";

/**
 * How a value reaches a reader: the bytes of a file, or characters in a charset: one the code names, Java's platform
 * default, or one the conversion does not decode.
 */
type Charset = "bytes" | "utf-8" | "iso-8859-1" | "platform" | "unknown";

interface ResourceAnalysis {
  /** Resource constructors that become the path text of their file. */
  readonly values: ReadonlySet<AstNode>;
  /** Variables that only ever hold resources, by kind. */
  readonly variables: ReadonlyMap<string, ResourceKind>;
  /** The constructors each resource variable is assigned, directly or through another resource variable. */
  readonly sources: ReadonlyMap<string, readonly AstNode[]>;
  /** `new Properties()` constructors kept in a Properties variable. */
  readonly propertiesValues: ReadonlySet<AstNode>;
  /** Properties variables: assigned one `new Properties()` and loaded once from a package resource. */
  readonly properties: ReadonlySet<string>;
  /**
   * Presence variables: assigned `File` values of fixed paths and true or false, and read only by `exists()` and as
   * conditions, so each `File` value may stand for whether its file is in the package.
   */
  readonly presence: ReadonlySet<string>;
  /** The `File` constructors that presence variables are assigned. */
  readonly presenceValues: ReadonlySet<AstNode>;
  /** Variables assigned once with a path text known whole (constantPaths). */
  readonly constants: ReadonlyMap<string, string>;
}

const FILE_TYPES = new Set(["File", "java.io.File"]);
/** Streams and readers over one file, with the charset they read characters in. */
const STREAM_TYPES = new Map<string, Charset | "reader" | "wrap">([
  ["FileInputStream", "bytes"],
  ["java.io.FileInputStream", "bytes"],
  ["FileReader", "platform"],
  ["java.io.FileReader", "platform"],
  ["InputStreamReader", "reader"],
  ["java.io.InputStreamReader", "reader"],
  ["BufferedReader", "wrap"],
  ["java.io.BufferedReader", "wrap"],
]);
const INI_TYPES = new Set(["Wini", "org.ini4j.Wini"]);
const PROPERTIES_TYPES = new Set(["Properties", "java.util.Properties"]);
/** Constructors that write the file their first argument names. */
const WRITER_TYPES = new Set([
  "FileWriter",
  "java.io.FileWriter",
  "FileOutputStream",
  "java.io.FileOutputStream",
  "PrintWriter",
  "java.io.PrintWriter",
  "PrintStream",
  "java.io.PrintStream",
  "RandomAccessFile",
  "java.io.RandomAccessFile",
]);
/** Members that write, delete, or rename the file (or the `Wini` or Properties table's file) they are called on. */
const WRITING_MEMBERS = new Set([
  "append",
  "createNewFile",
  "delete",
  "deleteDir",
  "deleteOnExit",
  "leftShift",
  "newDataOutputStream",
  "newObjectOutputStream",
  "newOutputStream",
  "newPrintWriter",
  "newWriter",
  "renameTo",
  "setBytes",
  "setText",
  "store",
  "withDataOutputStream",
  "withObjectOutputStream",
  "withOutputStream",
  "withPrintWriter",
  "withWriter",
  "withWriterAppend",
  "write",
]);
/** Folder members that hand out the folder's files, which code may then write. */
const LISTING_FILE_MEMBERS = new Set([
  "absoluteFile",
  "canonicalFile",
  "eachDir",
  "eachFile",
  "eachFileMatch",
  "eachFileRecurse",
  "getAbsoluteFile",
  "getCanonicalFile",
  "getParentFile",
  "listFiles",
  "parentFile",
  "traverse",
]);
/** Members that run a closure with the File as its delegate, whose unqualified calls act on the File. */
const DELEGATE_MEMBERS = new Set(["identity", "tap", "with"]);
/** Groovy assignment operators: `=` and the compound ones such as `+=` and `<<=`. */
const ASSIGNMENT_OPERATORS = /^(?:[-+*/%&|^]|<<|>>>?|\*\*)?=$/u;
/** Calls that return a `File` the package did not construct. */
const FILE_PRODUCING_CALLS = new Set([
  "createTempFile",
  "getSelectedFile",
  "getSelectedFiles",
  "toFile",
]);
/** Classes whose static methods may write the files or paths they receive. */
const WRITING_CLASSES = /(?:^|\.)(?:Files|FileUtils|ImageIO|IOUtils|Paths)$/u;
/** Calls that only read the files they receive. */
const READING_CALLS = new Set(["ImageIO.read", "javax.imageio.ImageIO.read"]);
/** Package text this rule snapshots at most, so a computed path does not pull in a whole folder of files. */
const MAX_CANDIDATES = 64;

const SNAPSHOT_NOTE =
  "The legacy script read this package file when it ran; the conversion holds the file's text as it was converted (no script of the package writes it), so a later edit of the file does not apply.";

// ---------------------------------------------------------------------------------------------------------------
// Package analysis

/**
 * The package's files and the paths its scripts may write. Every package file named once apart from letter case can
 * be read; a path is written when a script writes, deletes, or passes a `File` for it to code the importer cannot
 * follow, so only text no script changes is snapshot.
 */
export function packageResources(
  files: readonly ParsedGroovyFile[],
  names: readonly string[],
  read: PackageFileReader | null,
): PackageResources {
  const byPath = new Map<string, string>();
  const ambiguous = new Set<string>();
  const contents = new Map<string, Uint8Array | null>();
  for (const name of names) {
    const path = packageFilePath(name);
    const first = byPath.get(path);
    if (first === undefined) {
      byPath.set(path, name);
      continue;
    }
    // Copies with the same bytes under folders that differ in letter case read the same on any file system.
    const left = read?.(first) ?? null;
    const right = read?.(name) ?? null;
    if (left === null || right === null || Buffer.compare(left, right) !== 0) ambiguous.add(path);
  }
  for (const path of ambiguous) byPath.delete(path);
  // A write to a value of unknown origin anywhere in the package may change any File that left the analysis.
  const parts = files.flatMap((file) =>
    file.root === null
      ? []
      : [{ name: file.sourceName.split(/[\\/]/u).pop()!, ...writtenPaths(buildTree(file.root)) }],
  );
  const unknownWrite = parts.some((part) => part.unknownWrite);
  const writes = parts.flatMap(({ name, direct, escaped }) =>
    [...direct, ...(unknownWrite ? escaped : [])].map((write) => ({
      ...write,
      origin: `${name}${write.origin ?? ""}`,
    })),
  );
  return { files: byPath, ambiguous, writes, read, contents };
}

/** The resource analysis of a file or function body, for the lowering of its code. */
export function javaFileState(
  body: AstNode | null,
  resources: PackageResources | null,
  shared?: JavaFileState,
): JavaFileState {
  return {
    resources: shared?.resources ?? resources,
    analysis: body === null ? emptyAnalysis() : analyzeResources(body),
    temporal:
      body === null
        ? { variables: new Map(), fields: new Map(), writable: new Set() }
        : analyzeTemporal(body),
    text:
      body === null
        ? {
            randoms: new Set(),
            charArrays: new Set(),
            orderedSets: new Set(),
            textBuffers: new Set(),
            bufferValues: new Set(),
            closureFields: new Set(),
          }
        : analyzeText(body),
    data: shared?.data ?? {
      lines: new Map(),
      properties: new Map(),
      ini: new Map(),
      noted: new Set(),
    },
  };
}

function emptyAnalysis(): ResourceAnalysis {
  return {
    values: new Set(),
    variables: new Map(),
    sources: new Map(),
    propertiesValues: new Set(),
    properties: new Set(),
    presence: new Set(),
    presenceValues: new Set(),
    constants: new Map(),
  };
}

/**
 * Finds the resources of a body: `File`, stream, reader, and `Wini` values over package files that the conversion
 * represents by their path text, the Properties tables loaded from them, and the paths the body may write.
 */
function analyzeResources(root: AstNode): ResourceAnalysis {
  const tree = buildTree(root);
  const isResourceConstructor = (node: AstNode, variables: ReadonlyMap<string, ResourceKind>) =>
    resourceConstructorKind(node, variables) !== null;

  // Resource variables: every assignment a resource (or nothing), every read a use the conversion supports.
  // Candidates by the type they construct; the loop below drops those whose values or uses do not fit.
  const variables = new Map<string, ResourceKind>();
  for (const [name, values] of tree.assignments) {
    if (tree.parameters.has(name)) continue;
    const kinds = values.flatMap((value) => {
      const kind = value === null ? null : constructedKind(value);
      return kind === null ? [] : [kind];
    });
    if (kinds.length > 0 && kinds.every((kind) => kind === kinds[0]))
      variables.set(name, kinds[0]!);
  }
  const properties = new Set<string>();
  for (const [name, values] of tree.assignments) {
    if (tree.parameters.has(name)) continue;
    if (
      values.length === 1 &&
      values[0]?.kind === "constructorCall" &&
      PROPERTIES_TYPES.has(String(values[0].type)) &&
      argumentsOf(values[0]).length === 0
    )
      properties.add(name);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, kind] of variables) {
      const values = tree.assignments.get(name) ?? [];
      const assignedOk = values.every(
        (value) =>
          value === null ||
          isNullConstant(value) ||
          (resourceConstructorKind(value, variables) === kind &&
            isResourceConstructor(value, variables)) ||
          variables.get(variableName(value) ?? "") === kind,
      );
      const readsOk = (tree.reads.get(name) ?? []).every((reference) =>
        supportedResourceUse(reference, kind, tree, variables, properties),
      );
      if (!assignedOk || !readsOk) {
        variables.delete(name);
        changed = true;
      }
    }
    for (const name of properties) {
      const reads = tree.reads.get(name) ?? [];
      const loads = reads.filter((reference) => memberOf(reference, tree)?.name === "load");
      const ok =
        loads.length === 1 && reads.every((reference) => propertiesUse(reference, tree, variables));
      if (!ok) {
        properties.delete(name);
        changed = true;
      }
    }
  }

  const values = new Set<AstNode>();
  for (const node of tree.constructors) {
    if (!isResourceConstructor(node, variables)) continue;
    if (
      supportedResourceUse(
        node,
        resourceConstructorKind(node, variables)!,
        tree,
        variables,
        properties,
      )
    )
      values.add(node);
  }
  // A constructor inside a resource value is a resource value too (`new InputStreamReader(new FileInputStream(f))`).
  for (const node of [...values]) {
    for (let inner = argumentsOf(node)[0]; inner?.kind === "constructorCall";) {
      values.add(inner);
      inner = argumentsOf(inner)[0];
    }
  }
  const sources = new Map<string, AstNode[]>();
  const sourcesOf = (name: string, seen: Set<string>): AstNode[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    return (tree.assignments.get(name) ?? []).flatMap((value) => {
      if (value === null || isNullConstant(value)) return [];
      const alias = variableName(value);
      return alias !== null ? sourcesOf(alias, seen) : [value];
    });
  };
  for (const name of variables.keys()) sources.set(name, sourcesOf(name, new Set()));
  const propertiesValues = new Set<AstNode>();
  for (const name of properties) {
    const value = tree.assignments.get(name)?.[0];
    if (value !== null && value !== undefined) propertiesValues.add(value);
  }
  const constants = constantPaths(tree);
  const { presence, presenceValues } = presenceVariables(tree, variables, constants);
  return {
    values,
    variables,
    sources,
    propertiesValues,
    properties,
    presence,
    presenceValues,
    constants,
  };
}

/**
 * Variables that hold a `File` of a fixed path until a test of its existence replaces it with true or false, as
 * add-on checks do: `def pack = new File("...")`, `if (pack.exists()) pack = true`.
 */
function presenceVariables(
  tree: Tree,
  resources: ReadonlyMap<string, ResourceKind>,
  constants: ReadonlyMap<string, string>,
): { presence: Set<string>; presenceValues: Set<AstNode> } {
  const presence = new Set<string>();
  const presenceValues = new Set<AstNode>();
  for (const [name, values] of tree.assignments) {
    if (resources.has(name) || tree.parameters.has(name)) continue;
    const files = values.filter(
      (value): value is AstNode =>
        value !== null &&
        value.kind === "constructorCall" &&
        FILE_TYPES.has(String(value.type)) &&
        argumentsOf(value).length === 1 &&
        pathPattern(argumentsOf(value)[0]!, constants).complete,
    );
    const others = values.every(
      (value) =>
        value === null ||
        files.includes(value) ||
        (value.kind === "constant" && (typeof value.value === "boolean" || value.value === null)),
    );
    if (files.length === 0 || !others) continue;
    // Any other read could still see the File, which Groovy took as true where the flag may be false.
    const reads = (tree.reads.get(name) ?? []).every((read) => {
      const member = memberOf(read, tree);
      return (
        member !== null &&
        !member.property &&
        member.name === "exists" &&
        member.arguments.length === 0
      );
    });
    if (!reads) continue;
    presence.add(name);
    for (const value of files) presenceValues.add(value);
  }
  return { presence, presenceValues };
}

/** The kind of resource a constructor of a resource type makes, whatever its arguments. */
function constructedKind(node: AstNode): ResourceKind | null {
  if (node.kind !== "constructorCall") return null;
  const type = String(node.type);
  if (FILE_TYPES.has(type)) return "file";
  if (INI_TYPES.has(type)) return "ini";
  return STREAM_TYPES.has(type) ? "stream" : null;
}

/** The kind of resource a constructor makes, when its arguments name a package file the conversion can follow. */
function resourceConstructorKind(
  node: AstNode,
  variables: ReadonlyMap<string, ResourceKind>,
): ResourceKind | null {
  if (node.kind !== "constructorCall") return null;
  const type = String(node.type);
  const args = argumentsOf(node);
  const resource = (argument: AstNode | undefined, kinds: readonly ResourceKind[]): boolean => {
    if (argument === undefined) return false;
    const variable = variables.get(variableName(argument) ?? "");
    if (variable !== undefined) return kinds.includes(variable);
    const inner = resourceConstructorKind(argument, variables);
    return inner !== null && kinds.includes(inner);
  };
  const pathText = (argument: AstNode | undefined): boolean =>
    argument !== undefined &&
    argument.kind !== "constructorCall" &&
    !variables.has(variableName(argument) ?? "");
  if (FILE_TYPES.has(type)) return args.length === 1 && pathText(args[0]) ? "file" : null;
  if (INI_TYPES.has(type))
    return args.length === 1 && resource(args[0], ["file", "stream"]) ? "ini" : null;
  const stream = STREAM_TYPES.get(type);
  if (stream === undefined) return null;
  if (stream === "bytes" || stream === "platform")
    return args.length === 1 && (resource(args[0], ["file"]) || pathText(args[0]))
      ? "stream"
      : null;
  if (stream === "reader")
    return (args.length === 1 || (args.length === 2 && constantString(args[1]) !== null)) &&
      resource(args[0], ["stream"])
      ? "stream"
      : null;
  return args.length === 1 && resource(args[0], ["stream"]) ? "stream" : null;
}

/** A use of a resource value or variable that the conversion supports. */
function supportedResourceUse(
  node: AstNode,
  kind: ResourceKind,
  tree: Tree,
  variables: ReadonlyMap<string, ResourceKind>,
  properties: ReadonlySet<string>,
): boolean {
  const parent = tree.parents.get(node) ?? null;
  const member = memberOf(node, tree);
  if (member !== null) {
    // A text file the package writes keeps its text in storage (storedText): `file.text` reads it, and `file.text = x`
    // and `file.text += x` write it as statements.
    if (member.property) {
      if (kind !== "file" || member.name !== "text") return false;
      const assignment = tree.parents.get(member.call) ?? null;
      if (assignment?.kind !== "binary" || asNode(assignment.left) !== member.call) return true;
      return (
        ["=", "+="].includes(String(assignment.operator)) && isWholeStatement(assignment, tree)
      );
    }
    switch (member.name) {
      case "write":
      case "setText":
      case "append":
        return (
          kind === "file" && member.arguments.length === 1 && isWholeStatement(member.call, tree)
        );
      case "delete":
        return (
          kind === "file" && member.arguments.length === 0 && isWholeStatement(member.call, tree)
        );
      case "getText":
        return kind === "file" && member.arguments.length === 0;
      case "readLines":
        return member.arguments.length === 0 && kind !== "ini";
      case "exists":
        return member.arguments.length === 0 && kind === "file";
      case "close":
        return (
          member.arguments.length === 0 && kind === "stream" && isWholeStatement(member.call, tree)
        );
      case "get":
        return member.arguments.length === 2 && kind === "ini";
      default:
        return false;
    }
  }
  // `file << text` as a statement appends to a stored text file.
  if (
    kind === "file" &&
    parent?.kind === "binary" &&
    parent.operator === "<<" &&
    asNode(parent.left) === node &&
    isWholeStatement(parent, tree)
  )
    return true;
  const argument = argumentOf(node, tree);
  if (argument !== null) {
    if (argument.call.kind === "constructorCall" && argument.index === 0)
      return resourceConstructorKind(argument.call, variables) !== null;
    if (argument.call.kind === "methodCall" && constantString(argument.call.method) === "load")
      return properties.has(variableName(argument.call.object) ?? "");
    return false;
  }
  // The value of a resource variable's assignment.
  if (
    parent !== null &&
    (parent.kind === "declaration" || (parent.kind === "binary" && parent.operator === "=")) &&
    asNode(parent.right) === node
  ) {
    return variables.get(variableName(parent.left) ?? "") === kind;
  }
  return false;
}

/** A use of a Properties variable that the conversion supports. */
function propertiesUse(
  node: AstNode,
  tree: Tree,
  variables: ReadonlyMap<string, ResourceKind>,
): boolean {
  const member = memberOf(node, tree);
  if (member === null || member.property) return false;
  switch (member.name) {
    case "load": {
      const source = member.arguments[0];
      if (member.arguments.length !== 1 || source === undefined) return false;
      if (!isWholeStatement(member.call, tree)) return false;
      const kind =
        variables.get(variableName(source) ?? "") ?? resourceConstructorKind(source, variables);
      return kind === "stream";
    }
    case "get":
    case "containsKey":
      return member.arguments.length === 1;
    case "getProperty":
      return member.arguments.length === 1 || member.arguments.length === 2;
    default:
      return false;
  }
}

/** The writes of one file: paths it writes, and paths of `File` values it hands to code that may write them. */
interface FileWrites {
  /** Paths that a writer or a writing member of a known `File` changes. */
  direct: PathPattern[];
  /**
   * Paths of `File` values that leave the code the analysis follows (handed to a function, stored, returned, listed
   * from a folder, or kept in a variable of the script binding that other files share); any write to a value of unknown
   * origin may change them.
   */
  escaped: PathPattern[];
  /** Whether a writing member is called on a value that may be a `File` of unknown origin. */
  unknownWrite: boolean;
}

/**
 * The paths a body may write. A file changes only through a write: a writer constructor that opens a path or a `File`,
 * a writing member (`write`, `append`, `delete`, `renameTo`, `text =`, `text +=`, `<<`, `store`, ...) of a `File` or
 * `Wini` value, a `File` handed to a writing class such as `ImageIO`, or java.nio `Paths`/`Files`. A `File` comes from a
 * constructor or an `as File` cast, so a write to a value of unknown origin, such as a parameter or a call result, can
 * only change a `File` that left the code the analysis follows. A write of a folder covers the files below it.
 */
function writtenPaths(tree: Tree): FileWrites {
  const writes: FileWrites = { direct: [], escaped: [], unknownWrite: false };
  const constants = constantPaths(tree);
  // Variables that hold a File: assigned one, or another such variable.
  const fileVariables = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, values] of tree.assignments) {
      if (fileVariables.has(name)) continue;
      const holdsFile = values.some(
        (value) =>
          value !== null && (fileValue(value) || fileVariables.has(variableName(value) ?? "")),
      );
      if (holdsFile) {
        fileVariables.add(name);
        changed = true;
      }
    }
  }
  /** The paths a path text or a `File` (or `Wini`) value names. */
  const pathsOf = (node: AstNode, seen: Set<string>): PathPattern[] => {
    const name = variableName(node);
    if (name !== null) {
      if (seen.has(name)) return [];
      seen.add(name);
      const values = tree.assignments.get(name) ?? [];
      if (tree.parameters.has(name) || tree.mutated.has(name) || values.length === 0)
        return [unknownPattern()];
      return values.flatMap((value) =>
        value === null || isNullConstant(value) ? [] : pathsOf(value, seen),
      );
    }
    if (node.kind === "cast") {
      const value = asNode(node.value);
      return value === null ? [unknownPattern()] : pathsOf(value, seen);
    }
    if (node.kind === "constructorCall") {
      const [first, second] = argumentsOf(node);
      if (!fileValue(node) || first === undefined) return [unknownPattern()];
      if (second === undefined || INI_TYPES.has(String(node.type))) return pathsOf(first, seen);
      // new File(parent, child) names the child below the parent.
      const child = pathPattern(second, constants);
      return pathsOf(first, seen).map((parent) => joinPatterns(parent, child));
    }
    if (node.kind === "methodCall" || node.kind === "property") {
      // A call result may be any path, unless it is a stream or writer, which names no file.
      const method = constantString(node.method) ?? constantString(node.property) ?? "";
      return /(?:Stream|Writer)$/u.test(method) ? [] : [unknownPattern()];
    }
    return [pathPattern(node, constants)];
  };
  const at = (list: PathPattern[], node: AstNode, paths: readonly PathPattern[]) => {
    const origin = node.span === null ? "" : `:${node.span.line}`;
    list.push(...paths.map((path) => ({ ...path, origin })));
  };
  const isFile = (node: AstNode): boolean =>
    fileValue(node) || fileVariables.has(variableName(node) ?? "");
  /** Whether a value is certainly not a `File`: text, numbers, collections, or another constructed type. */
  const notFile = (node: AstNode, seen: Set<string>): boolean => {
    if (node.kind === "constructorCall") return !fileValue(node);
    if (node.kind === "cast") return !fileValue(node);
    if (
      ["constant", "gstring", "list", "map", "range", "array", "closure", "not"].includes(node.kind)
    )
      return true;
    if (node.kind === "binary") return node.operator !== "[" && node.operator !== "=";
    const name = variableName(node);
    if (name === null || tree.parameters.has(name)) return false;
    if (seen.has(name)) return true;
    seen.add(name);
    const values = tree.assignments.get(name) ?? [];
    return (
      values.length > 0 &&
      values.every((value) => value === null || isNullConstant(value) || notFile(value, seen))
    );
  };
  // A write of a value: of its paths when it is a known File, of any escaped File when its origin is unknown.
  const write = (
    target: AstNode | null,
    operation: AstNode,
    stored?: "write" | "append" | "delete",
  ) => {
    if (target === null) return;
    const simple =
      stored !== undefined &&
      (variableName(target) !== null ||
        (target.kind === "constructorCall" &&
          FILE_TYPES.has(String(target.type)) &&
          argumentsOf(target).length === 1));
    if (isFile(target))
      at(
        writes.direct,
        operation,
        pathsOf(target, new Set()).map((path) => (simple ? { ...path, stored } : path)),
      );
    else if (!notFile(target, new Set())) writes.unknownWrite = true;
  };
  // Where each File value and each read of a File variable goes.
  const fileUses = [
    ...tree.constructors.filter(fileValue),
    ...[...tree.parents.keys()].filter((node) => node.kind === "cast" && fileValue(node)),
    ...[...fileVariables].flatMap((name) => tree.reads.get(name) ?? []),
  ];
  for (const node of fileUses) {
    const member = memberOf(node, tree);
    if (member !== null) {
      // Members that hand out the files of a folder or another File: any file below may be written through them.
      // The parent of a File holds its siblings too.
      if (LISTING_FILE_MEMBERS.has(member.name)) {
        const parent = member.name === "parentFile" || member.name === "getParentFile";
        at(
          writes.escaped,
          member.call,
          pathsOf(node, new Set()).map((path) => ({
            prefix: parent ? path.prefix.replace(/[^\\/]*$/u, "") : path.prefix,
            suffix: "",
            complete: false,
          })),
        );
      }
      // A closure that runs with the File as its delegate, as `file.with { write(text) }`, may write it.
      if (DELEGATE_MEMBERS.has(member.name))
        at(writes.direct, member.call, pathsOf(node, new Set()));
      continue;
    }
    const argument = argumentOf(node, tree);
    if (argument !== null) {
      const type = String(argument.call.type);
      const owner = dottedName(asNode(argument.call.object));
      const method = constantString(argument.call.method);
      if (
        argument.call.kind === "constructorCall" &&
        (STREAM_TYPES.has(type) || WRITER_TYPES.has(type))
      )
        continue;
      if (
        argument.call.kind === "constructorCall" &&
        INI_TYPES.has(type) &&
        isAssigned(argument.call, tree)
      )
        continue;
      if (owner !== null && method !== null && READING_CALLS.has(`${owner}.${method}`)) continue;
      if (method === "load") continue;
      at(writes.escaped, node, pathsOf(node, new Set()));
      continue;
    }
    if (isAssigned(node, tree)) continue;
    at(writes.escaped, node, pathsOf(node, new Set()));
  }
  // A File variable of the script binding, assigned without a declaration, is shared with the files the script loads.
  for (const name of fileVariables) {
    if (tree.declared.has(name)) continue;
    const reference = (tree.reads.get(name) ?? [])[0];
    const origin = reference ?? tree.assignments.get(name)?.find((value) => value !== null);
    if (origin !== undefined && origin !== null)
      at(writes.escaped, origin, pathsOf({ kind: "variable", span: null, name }, new Set()));
  }
  for (const node of tree.constructors) {
    if (!WRITER_TYPES.has(String(node.type))) continue;
    const first = argumentsOf(node)[0];
    // A writer over another stream or writer opens no file itself.
    if (first === undefined || (first.kind === "constructorCall" && !fileValue(first))) continue;
    at(writes.direct, node, pathsOf(first, new Set()));
  }
  for (const call of tree.calls) {
    const method = constantString(call.method);
    const receiver = asNode(call.object);
    const args = argumentsOf(call);
    if (method !== null && FILE_PRODUCING_CALLS.has(method))
      at(writes.escaped, call, [unknownPattern()]);
    const owner = dottedName(receiver);
    // A class name such as `javax.imageio.ImageIO` or `System.out` is no value the script assigned.
    const className =
      owner !== null &&
      /^[A-Z]/u.test(owner.split(".").at(-1) ?? "") &&
      !tree.assignments.has(owner.split(".")[0]!);
    if (
      method !== null &&
      WRITING_MEMBERS.has(method) &&
      call.implicitThis !== true &&
      !className
    ) {
      // StringBuilder.delete(start, end) is no file deletion; Wini.store(file) writes its argument; renameTo(target)
      // changes both files.
      const stored =
        (method === "write" || method === "setText") && args.length === 1
          ? "write"
          : method === "append" && args.length === 1
            ? "append"
            : method === "delete" && args.length === 0
              ? "delete"
              : undefined;
      if (method === "store" && args.length > 0) write(args[0]!, call);
      else if (method !== "delete" || args.length === 0) write(receiver, call, stored);
      // The target of renameTo() is a File or, through Groovy, a path text.
      const renamed = receiver !== null && (isFile(receiver) || !notFile(receiver, new Set()));
      if (method === "renameTo" && args[0] !== undefined && renamed)
        at(writes.direct, call, pathsOf(args[0], new Set()));
    }
    if (owner === null || !className || !WRITING_CLASSES.test(owner)) continue;
    if (READING_CALLS.has(`${owner}.${method}`)) continue;
    if (/(?:^|\.)(?:Paths|Files)$/u.test(owner)) {
      at(
        writes.direct,
        call,
        args.length === 0 ? [unknownPattern()] : args.flatMap((arg) => pathsOf(arg, new Set())),
      );
      continue;
    }
    // A File handed to a writing class; ImageIO.write(image, format, output) writes only its output.
    const outputs = /(?:^|\.)ImageIO$/u.test(owner) ? args.slice(2) : args;
    for (const output of outputs) write(output, call);
  }
  // `file.text = value`, `file.bytes += value`, and `file << value`.
  for (const [node, parent] of tree.parents) {
    if (node.kind === "binary" && node.operator === "<<") write(asNode(node.left), node, "append");
    if (
      node.kind === "property" &&
      ["text", "bytes"].includes(constantString(node.property) ?? "") &&
      parent?.kind === "binary" &&
      ASSIGNMENT_OPERATORS.test(String(parent.operator)) &&
      asNode(parent.left) === node
    )
      write(
        asNode(node.object),
        node,
        constantString(node.property) !== "text"
          ? undefined
          : parent.operator === "="
            ? "write"
            : parent.operator === "+="
              ? "append"
              : undefined,
      );
  }
  return writes;
}

/** Variables assigned once with a path text that is known whole, such as `def folder = getDataFolder()`. */
function constantPaths(tree: Tree): Map<string, string> {
  const constants = new Map<string, string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, values] of tree.assignments) {
      if (constants.has(name) || tree.parameters.has(name) || tree.mutated.has(name)) continue;
      if (values.length !== 1) continue;
      const value = values[0];
      if (value === null || value === undefined) continue;
      const pattern = pathPattern(value, constants);
      if (!pattern.complete) continue;
      constants.set(name, pattern.prefix);
      changed = true;
    }
  }
  return constants;
}

/** The path of a child below a parent folder, as `new File(parent, child)` joins them. */
function joinPatterns(parent: PathPattern, child: PathPattern): PathPattern {
  const separator = parent.prefix === "" || /[\\/]$/u.test(parent.prefix) ? "" : "/";
  if (parent.complete && child.complete) {
    const text = `${parent.prefix}${separator}${child.prefix}`;
    return { prefix: text, suffix: text, complete: true };
  }
  return {
    prefix: parent.complete ? `${parent.prefix}${separator}${child.prefix}` : parent.prefix,
    suffix: child.suffix,
    complete: false,
  };
}

/** A `File` or `Wini` constructor, or an `as File` cast. */
function fileValue(node: AstNode): boolean {
  if (node.kind === "cast") return FILE_TYPES.has(String(node.type));
  return (
    node.kind === "constructorCall" &&
    (FILE_TYPES.has(String(node.type)) || INI_TYPES.has(String(node.type)))
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Lowering hooks

/** A resource constructor as the path text of its file, and `new Properties()` as an empty dict. */
export function javaConstructor(
  node: AstNode,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const analysis = host.state.analysis;
  if (analysis.values.has(node)) {
    const first = argumentsOf(node)[0];
    return first === undefined ? undefined : host.lower(first);
  }
  if (analysis.propertiesValues.has(node)) return { kind: "object", properties: [], dict: true };
  if (analysis.presenceValues.has(node)) return filePresence(node, host);
  return temporalConstructor(node, host) ?? textConstructor(node, host);
}

/** `Properties props = new Properties()`: a dict of text whose missing keys read as null, as Properties.get() does. */
export function javaDeclaration(
  name: string,
  value: AstNode,
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null {
  if (!host.state.analysis.propertiesValues.has(value))
    return textDeclaration(name, value, span, host);
  return [
    {
      kind: "let",
      name,
      value: { kind: "object", properties: [], dict: true },
      type: "string? dict",
      span,
    },
  ];
}

/** Reads of package resources and Properties tables. */
export function javaMethodCall(
  node: AstNode,
  name: string,
  args: readonly AstNode[],
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const receiver = asNode(node.object);
  if (receiver === null) return undefined;
  const { analysis } = host.state;
  // The variable already holds whether its file is in the package.
  if (name === "exists" && args.length === 0 && analysis.presence.has(variableName(receiver) ?? ""))
    return host.lower(receiver);
  const kind = resourceKindOf(receiver, analysis);
  if (kind !== null) {
    const stored = kind === "file" ? storedText(receiver, host) : undefined;
    if (stored !== undefined) {
      if (stored === null) return null;
      if (name === "readLines" && args.length === 0) return host.helper("textLines", [stored.read]);
      if (name === "getText" && args.length === 0) return stored.read;
      if (name === "exists" && args.length === 0)
        return stored.packaged
          ? { kind: "literal", value: true }
          : {
              kind: "binary",
              operator: "!=",
              left: { kind: "load", key: stored.key },
              right: { kind: "literal", value: null },
            };
      return undefined;
    }
    if (name === "readLines" && args.length === 0 && kind !== "ini")
      return packageTextRead(node, receiver, "lines", host);
    if (name === "exists" && args.length === 0 && kind === "file")
      return resourceExists(node, receiver, host);
    if (name === "get" && args.length === 2 && kind === "ini")
      return iniRead(node, receiver, args, host);
    return undefined;
  }
  const table = variableName(receiver);
  if (table === null || !analysis.properties.has(table))
    return temporalCall(node, name, args, host) ?? textCall(node, name, args, host);
  const target: IrExpression = { kind: "variable", name: table };
  if ((name === "get" || name === "getProperty") && args.length === 1) {
    const key = host.lower(args[0]!);
    if (key === null) return null;
    return {
      kind: "methodCall",
      target,
      name: "get",
      arguments: [key, { kind: "literal", value: null }],
      dict: true,
    };
  }
  if (name === "getProperty" && args.length === 2) {
    const key = host.lower(args[0]!);
    const fallback = host.lower(args[1]!);
    if (key === null || fallback === null) return null;
    return { kind: "methodCall", target, name: "get", arguments: [key, fallback], dict: true };
  }
  if (name === "containsKey" && args.length === 1) {
    const key = host.lower(args[0]!);
    return key === null ? null : { kind: "methodCall", target, name: "contains", arguments: [key] };
  }
  return undefined;
}

/** Java bean properties such as `calendar.time`. */
export function javaProperty(
  node: AstNode,
  name: string,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const receiver = asNode(node.object);
  if (
    name === "text" &&
    receiver !== null &&
    resourceKindOf(receiver, host.state.analysis) === "file"
  ) {
    const stored = storedText(receiver, host);
    if (stored !== undefined) return stored === null ? null : stored.read;
  }
  return temporalProperty(node, name, host) ?? textProperty(node, name);
}

/** Groovy operators on Java values, such as `date + days`. */
export function javaBinary(node: AstNode, host: JavaRuleHost): IrExpression | null | undefined {
  return temporalBinary(node, host) ?? textMatch(node, host);
}

/** Groovy assignments to parts of Java values, such as `buffer[1..2] = text`. */
export function javaAssignment(
  node: AstNode,
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null {
  const operator = String(node.operator);
  const left = asNode(node.left);
  const right = asNode(node.right);
  const file =
    operator === "<<"
      ? left
      : left?.kind === "property" &&
          constantString(left.property) === "text" &&
          (operator === "=" || operator === "+=")
        ? asNode(left.object)
        : null;
  if (file !== null && right !== null && resourceKindOf(file, host.state.analysis) === "file") {
    const written = storedWrite(file, operator === "=" ? "write" : "append", right, span, host);
    if (written !== undefined) return written;
  }
  return textAssignment(node, span, host);
}

/** `properties.load(reader)` and `reader.close()` on package resources as statements. */
export function javaCallStatement(
  node: AstNode,
  name: string,
  args: readonly AstNode[],
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null {
  const receiver = asNode(node.object);
  if (receiver === null) return null;
  const { analysis } = host.state;
  if (resourceKindOf(receiver, analysis) === "file") {
    const operation =
      (name === "write" || name === "setText") && args.length === 1
        ? "write"
        : name === "append" && args.length === 1
          ? "append"
          : name === "delete" && args.length === 0
            ? "delete"
            : null;
    if (operation !== null) {
      const written = storedWrite(receiver, operation, args[0] ?? null, span, host);
      if (written !== undefined) return written;
    }
  }
  if (name === "close" && args.length === 0 && resourceKindOf(receiver, analysis) === "stream") {
    host.diagnostic(
      "SX_PACKAGE_TEXT_CLOSE",
      "info",
      "Removed close() of a reader over a package file, whose text the conversion holds.",
      span,
    );
    return [];
  }
  const table = variableName(receiver);
  if (name !== "load" || args.length !== 1 || table === null || !analysis.properties.has(table))
    return (
      temporalStatement(node, name, args, span, host) ?? textStatement(node, name, args, span, host)
    );
  // After a diagnostic, the lowering keeps the statement as manual work.
  const value = packageTextRead(node, args[0]!, "properties", host);
  if (value === undefined || value === null) return null;
  return [
    { kind: "assign", target: { kind: "variable", name: table }, operator: "=", value, span },
  ];
}

/** The generated functions that hold the package text this file reads. */
export function javaDataStatements(state: JavaFileState): IrStatement[] {
  const { lines, properties, ini } = state.data;
  const statements: IrStatement[] = [];
  if (lines.size > 0)
    statements.push(
      dataFunction(TEXT_LINES, lines, (items) => ({
        kind: "list",
        items: items.map((item) => ({ kind: "literal", value: item })),
      })),
    );
  if (properties.size > 0) statements.push(dataFunction(PROPERTIES, properties, tableValue));
  // ini4j returns null for a missing option, which the lookup's default gives.
  if (ini.size > 0) statements.push(dataFunction(INI, ini, tableValue, "string? dict"));
  return statements;
}

const TEXT_LINES = "sexscriptLegacyTextLines";
const PROPERTIES = "sexscriptLegacyProperties";
const INI = "sexscriptLegacyIni";

/**
 * `function name(path)`: the value of the package file the path names. The dict of indexes stops the script for a file
 * the package does not hold, where Groovy failed to read it.
 */
function dataFunction<T>(
  name: string,
  files: ReadonlyMap<string, T>,
  value: (data: T) => IrExpression,
  type?: string,
): IrStatement {
  const paths = [...files.keys()].sort();
  const index: IrExpression = {
    kind: "index",
    dict: true,
    target: {
      kind: "object",
      dict: true,
      properties: paths.map((path, position) => ({
        name: path,
        key: { kind: "literal", value: path },
        value: { kind: "literal", value: position },
      })),
    },
    index: {
      kind: "call",
      name: "sexscriptLegacyPackagePath",
      positional: [{ kind: "variable", name: "path" }],
      named: {},
    },
  };
  const body: IrStatement[] = [
    {
      kind: "comment",
      text: "// A file the package does not hold stops the script here, where Groovy failed to read it.",
      trailing: false,
      span: null,
    },
    { kind: "let", name: "index", value: index, span: null },
  ];
  paths.forEach((path, position) => {
    const data = value(files.get(path)!);
    const result: IrStatement[] =
      type === undefined
        ? [{ kind: "return", value: data, span: null }]
        : [
            { kind: "let", name: "values", value: data, type, span: null },
            { kind: "return", value: { kind: "variable", name: "values" }, span: null },
          ];
    if (position === paths.length - 1) {
      body.push(...result);
      return;
    }
    body.push({
      kind: "if",
      condition: {
        kind: "binary",
        operator: "==",
        left: { kind: "variable", name: "index" },
        right: { kind: "literal", value: position },
      },
      then: result,
      else: [],
      span: null,
    });
  });
  return {
    kind: "function",
    name,
    parameters: [{ name: "path", defaultValue: null }],
    body,
    leadingComments: [
      "// The text of package files as the legacy script read it, at conversion time.",
    ],
    span: null,
  };
}

function tableValue(entries: ReadonlyMap<string, string>): IrExpression {
  return {
    kind: "object",
    dict: true,
    properties: [...entries].map(([key, text]) => ({
      name: key,
      key: { kind: "literal", value: key },
      value: { kind: "literal", value: text },
    })),
  };
}

function resourceKindOf(node: AstNode, analysis: ResourceAnalysis): ResourceKind | null {
  const name = variableName(node);
  if (name !== null) return analysis.variables.get(name) ?? null;
  return analysis.values.has(node) ? resourceConstructorKind(node, analysis.variables) : null;
}

/** The constructors a resource value or variable may hold, down to the `File` (or path text) at the bottom. */
function resourceSources(node: AstNode, analysis: ResourceAnalysis): AstNode[] {
  const name = variableName(node);
  return name !== null ? [...(analysis.sources.get(name) ?? [])] : [node];
}

/** The path patterns of a resource and the charset its reader decodes the file with. */
function resourcePaths(
  node: AstNode,
  analysis: ResourceAnalysis,
): Array<{ pattern: PathPattern; charset: Charset }> {
  return resourceSources(node, analysis).flatMap(
    (source): Array<{ pattern: PathPattern; charset: Charset }> => {
      const type = String(source.type);
      const first = argumentsOf(source)[0];
      if (first === undefined) return [];
      const inner =
        !FILE_TYPES.has(type) &&
        (analysis.variables.has(variableName(first) ?? "") || first.kind === "constructorCall")
          ? resourcePaths(first, analysis)
          : [{ pattern: pathPattern(first, analysis.constants), charset: "bytes" as const }];
      const stream = STREAM_TYPES.get(type);
      if (stream === "platform") return inner.map((path) => ({ ...path, charset: "platform" }));
      if (stream !== "reader") return inner;
      const name = constantString(argumentsOf(source)[1])?.toLowerCase().replace(/[_-]/gu, "");
      const charset: Charset =
        name === undefined
          ? "platform"
          : name === "utf8"
            ? "utf-8"
            : name === "iso88591" || name === "latin1"
              ? "iso-8859-1"
              : "unknown";
      return inner.map((path) => ({ ...path, charset }));
    },
  );
}

type ReadKind = "lines" | "properties" | "ini";

/**
 * The generated call that reads a package resource, after proving each file it may name: a package file no script
 * writes, which decodes as text. Returns undefined when the receiver is not a resource and null after a diagnostic.
 */
function packageTextRead(
  node: AstNode,
  resource: AstNode,
  kind: ReadKind,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  if (resourceKindOf(resource, host.state.analysis) === null) return undefined;
  const files = resolveFiles(node, resource, kind, host);
  if (files === null) return null;
  noteOnce(host, "SX_PACKAGE_TEXT_SNAPSHOT", SNAPSHOT_NOTE, node.span);
  return dataCall(resource, kind, files, host);
}

/**
 * A text file the package's scripts write, such as a log or a task list the legacy script kept for itself or for
 * another program, keeps its text in storage under `file:` and its package path (owner decision: such files become
 * `save`/`load`): `key` names it, and `read` is its stored text, or the package's own file as converted, or "" when
 * neither exists yet. Undefined for a file no script writes, which stays a package resource, and null after a
 * diagnostic.
 */
export function storedText(
  receiver: AstNode,
  host: JavaRuleHost,
): { key: IrExpression; read: IrExpression; packaged: boolean } | null | undefined {
  const paths = resourcePaths(receiver, host.state.analysis).map(({ pattern }) => pattern);
  return storedFile(paths, receiver, false, host);
}

/**
 * The text of a file that useFile() opened in the computer's editor or viewer, named by its path text: a stored text
 * file (storedText), or a package file no script writes, as converted. Undefined for another file, and null after a
 * diagnostic.
 */
export function viewedText(
  path: AstNode,
  host: JavaRuleHost,
): { key: IrExpression; read: IrExpression; packaged: boolean } | null | undefined {
  return storedFile([pathPattern(path, host.state.analysis.constants)], path, true, host);
}

/** storedText and viewedText: the file of `paths`, whose path text `node` lowers to. */
function storedFile(
  paths: readonly PathPattern[],
  node: AstNode,
  viewed: boolean,
  host: JavaRuleHost,
): { key: IrExpression; read: IrExpression; packaged: boolean } | null | undefined {
  const { resources } = host.state;
  if (resources === null || paths.length === 0) return undefined;
  const single =
    paths.length === 1 && paths[0]!.complete ? packageFilePath(paths[0]!.prefix) : null;
  // The package's own file is the text until a script writes it.
  const bytes = single === null ? null : fileBytes(resources, single);
  const decoded = bytes === null ? null : decodeText(bytes, "platform");
  // Every write of the file must be one that storage keeps; deleting a package file would bring its text back.
  const written = (pattern: PathPattern): boolean => {
    const writes = resources.writes.filter((write) =>
      pattern.complete
        ? writeMatches(write, packageFilePath(pattern.prefix))
        : packageFilePath(write.prefix) === packageFilePath(pattern.prefix) &&
          write.suffix.toLowerCase() === pattern.suffix.toLowerCase(),
    );
    return (
      writes.length > 0 &&
      writes.every(
        (write) =>
          write.stored !== undefined &&
          (write.complete || !pattern.complete) &&
          !(write.stored === "delete" && decoded !== null),
      )
    );
  };
  if (!paths.every(written) && !(viewed && decoded !== null)) return undefined;
  // A computed path that may name a file of the package would need that file's text as its start; it stays manual.
  if (
    single === null &&
    paths.some((pattern) => [...resources.files.keys()].some((file) => matches(pattern, file)))
  )
    return undefined;
  const path = host.lower(node);
  if (path === null) return null;
  const key: IrExpression =
    single !== null
      ? { kind: "literal", value: `file:${single}` }
      : {
          kind: "template",
          parts: [{ text: "file:" }, { value: host.helper("packagePath", [path]) }],
        };
  if (!viewed) noteOnce(host, "SX_STORED_FILE", STORED_FILE_NOTE, node.span);
  return {
    key,
    read: { kind: "load", key, defaultValue: { kind: "literal", value: decoded?.text ?? "" } },
    packaged: decoded !== null,
  };
}

const STORED_FILE_NOTE =
  "The legacy script wrote this text file on the player's computer, which a package cannot do; its text is kept in storage under file: and its path instead, starting from the package's own file where there is one.";

/** A write, append, or delete of a stored text file (storedText) as storage statements. */
function storedWrite(
  receiver: AstNode,
  operation: "write" | "append" | "delete",
  value: AstNode | null,
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null | undefined {
  const stored = storedText(receiver, host);
  if (stored === undefined || stored === null) return stored;
  if (operation === "delete") return [{ kind: "delete", key: stored.key, span }];
  const text = value === null ? null : host.lower(value);
  if (text === null) return null;
  // Groovy wrote the text of the value; literal text joins as it is.
  const part = (item: IrExpression): { text: string } | { value: IrExpression } =>
    item.kind === "literal" && typeof item.value === "string"
      ? { text: item.value }
      : { value: item };
  const parts = operation === "append" ? [part(stored.read), part(text)] : [part(text)];
  const literal = parts.every((item) => "text" in item);
  return [
    {
      kind: "save",
      key: stored.key,
      value: literal
        ? {
            kind: "literal",
            value: parts.map((item) => ("text" in item ? item.text : "")).join(""),
          }
        : { kind: "template", parts },
      span,
    },
  ];
}

/** The call of the generated data function of a kind, which then holds the given files. */
function dataCall(
  resource: AstNode,
  kind: ReadKind,
  files: ReadonlyMap<string, string[] | Map<string, string>>,
  host: JavaRuleHost,
): IrExpression | null {
  const path = host.lower(resource);
  if (path === null) return null;
  for (const [file, data] of files) {
    if (Array.isArray(data)) host.state.data.lines.set(file, data);
    else if (kind === "properties") host.state.data.properties.set(file, data);
    else host.state.data.ini.set(file, data);
  }
  // The data function names the file as file tests compare it.
  host.helper("packagePath", [path]);
  return {
    kind: "call",
    name: kind === "lines" ? TEXT_LINES : kind === "properties" ? PROPERTIES : INI,
    positional: [path],
    named: {},
    local: true,
  };
}

/** The decoded data of every package file a resource may name, or null after a diagnostic. */
function resolveFiles(
  node: AstNode,
  resource: AstNode,
  kind: ReadKind,
  host: JavaRuleHost,
): Map<string, string[] | Map<string, string>> | null {
  const { analysis, resources } = host.state;
  const unsupported = (code: string, message: string): null => {
    host.diagnostic(code, "error", message, node.span);
    return null;
  };
  if (resources === null)
    return unsupported(
      "SX_PACKAGE_TEXT_UNKNOWN",
      "The legacy script read a package file; without the package's files the conversion cannot hold its text.",
    );
  const paths = resourcePaths(resource, analysis);
  if (paths.length === 0)
    return unsupported("SX_PACKAGE_TEXT_UNKNOWN", "The file this reader reads is not known.");
  const result = new Map<string, string[] | Map<string, string>>();
  for (const { pattern, charset } of paths) {
    if (!pattern.complete && pattern.prefix === "" && pattern.suffix === "")
      return unsupported(
        "SX_PACKAGE_TEXT_UNKNOWN",
        "The legacy script read a file whose whole path is computed; the conversion cannot tell which package file it is.",
      );
    if (charset === "unknown")
      return unsupported(
        "SX_PACKAGE_TEXT_CHARSET",
        "The legacy reader decoded the file in a charset the conversion does not decode.",
      );
    const candidates = [...resources.files.keys()].filter((file) => matches(pattern, file));
    const ambiguous = [...resources.ambiguous].filter((file) => matches(pattern, file));
    if (ambiguous.length > 0)
      return unsupported(
        "SX_PACKAGE_TEXT_AMBIGUOUS",
        `Several package files are named ${ambiguous[0]} apart from letter case; the legacy player read whichever its file system found.`,
      );
    if (candidates.length > MAX_CANDIDATES)
      return unsupported(
        "SX_PACKAGE_TEXT_UNKNOWN",
        `The computed path of this file matches ${candidates.length} package files; the conversion holds the text of at most ${MAX_CANDIDATES}.`,
      );
    if (candidates.length === 0) {
      const path = packageFilePath(pattern.prefix);
      const written = pattern.complete
        ? resources.writes.find((write) => writeMatches(write, path))
        : undefined;
      return unsupported(
        written !== undefined ? "SX_PACKAGE_TEXT_WRITTEN" : "SX_PACKAGE_TEXT_MISSING",
        written !== undefined
          ? `The package holds no file ${path}, which its scripts may write (${written.origin ?? "a write the conversion cannot follow"}); keep it as stored data instead.`
          : pattern.complete
            ? `The package holds no file ${path}; Groovy could not read it either, unless the player added it.`
            : "No package file matches the computed path of this file.",
      );
    }
    for (const file of candidates) {
      const written = resources.writes.find((write) => writeMatches(write, file));
      if (written !== undefined)
        return unsupported(
          "SX_PACKAGE_TEXT_WRITTEN",
          `The package's scripts may write ${file} (${written.origin ?? "a write the conversion cannot follow"}), so its text is not fixed at conversion time; keep it as stored data instead.`,
        );
      const bytes = fileBytes(resources, file);
      if (bytes === null)
        return unsupported(
          "SX_PACKAGE_TEXT_UNKNOWN",
          `The package file ${file} could not be read.`,
        );
      // Properties.load(InputStream) reads ISO-8859-1, ini4j's Wini UTF-8 from a File or stream, and File.readLines()
      // the platform charset.
      const decoded = decodeText(
        bytes,
        charset !== "bytes"
          ? charset
          : kind === "properties"
            ? "iso-8859-1"
            : kind === "ini"
              ? "utf-8"
              : "platform",
      );
      if (decoded === null)
        return unsupported(
          "SX_PACKAGE_TEXT_BINARY",
          `The package file ${file} is not text in the charset the legacy reader used.`,
        );
      if (decoded.note !== null)
        host.diagnostic("SX_PACKAGE_TEXT_CHARSET", "warning", decoded.note, node.span);
      if (kind === "lines") result.set(file, textLines(decoded.text));
      else if (kind === "properties") {
        const table = parseProperties(decoded.text);
        if (table === null)
          return unsupported(
            "SX_PACKAGE_TEXT_FORMAT",
            `The Properties file ${file} has a malformed \\u escape, which made Java fail to load it.`,
          );
        result.set(file, table);
      } else {
        const table = parseIni(decoded.text);
        if (table === null)
          return unsupported(
            "SX_PACKAGE_TEXT_FORMAT",
            `The INI file ${file} uses escapes, repeated sections, options without a value, or lines outside a section, which the conversion does not read the way ini4j did.`,
          );
        result.set(file, table);
      }
    }
  }
  return result;
}

/** `new File(path).exists()` for a resource that the conversion represents by its path text. */
function resourceExists(
  node: AstNode,
  resource: AstNode,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const { analysis, resources } = host.state;
  if (resources === null) return undefined;
  host.diagnostic(
    "SX_FILE_EXISTS",
    "warning",
    "The legacy script tested whether a file exists on the player's computer; the test reads the package's files as they were converted, and a program (.exe) never exists.",
    node.span,
  );
  const present = [...resources.files.keys(), ...resources.ambiguous].filter(
    (file) => !file.endsWith(".exe"),
  );
  const patterns = resourcePaths(resource, analysis).map(({ pattern }) => pattern);
  const results = patterns.every((pattern) => pattern.complete)
    ? patterns.map((pattern) => present.includes(packageFilePath(pattern.prefix)))
    : [];
  if (results.length > 0 && results.every((result) => result === results[0]))
    return { kind: "literal", value: results[0]! };
  const path = host.lower(resource);
  if (path === null) return null;
  const candidates = present
    .filter((file) => patterns.some((pattern) => matches(pattern, file)))
    .sort();
  if (candidates.length === 0) return { kind: "literal", value: false };
  return {
    kind: "methodCall",
    target: {
      kind: "list",
      items: candidates.map((file) => ({ kind: "literal" as const, value: file })),
    },
    name: "contains",
    arguments: [host.helper("packagePath", [path])],
  };
}

/** A `File` of a fixed path as whether the package holds its file, unless a script of the package may change it. */
function filePresence(node: AstNode, host: JavaRuleHost): IrExpression | null | undefined {
  const { resources } = host.state;
  const path = argumentsOf(node)[0];
  if (resources === null || path === undefined) return undefined;
  const file = packageFilePath(pathPattern(path, host.state.analysis.constants).prefix);
  const written = resources.writes.find((write) => writeMatches(write, file));
  if (written !== undefined) {
    host.diagnostic(
      "SX_PACKAGE_TEXT_WRITTEN",
      "error",
      `The package's scripts may write or delete ${file} (${written.origin ?? "a write the conversion cannot follow"}), so whether it exists is not fixed at conversion time.`,
      node.span,
    );
    return null;
  }
  host.diagnostic(
    "SX_FILE_EXISTS",
    "warning",
    "The legacy script tested whether a file exists on the player's computer; the test reads the package's files as they were converted, and a program (.exe) never exists.",
    node.span,
  );
  const present =
    !file.endsWith(".exe") && (resources.files.has(file) || resources.ambiguous.has(file));
  return { kind: "literal", value: present };
}

/**
 * ini4j `get(section, option)`: the option's text, or null when the file lacks it. A literal section and option of a
 * single known file read the value at conversion time.
 */
function iniRead(
  node: AstNode,
  resource: AstNode,
  args: readonly AstNode[],
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const files = resolveFiles(node, resource, "ini", host);
  if (files === null) return null;
  const section = constantString(args[0]);
  const option = constantString(args[1]);
  const patterns = resourcePaths(resource, host.state.analysis).map(({ pattern }) => pattern);
  const single =
    patterns.length > 0 &&
    patterns.every((pattern) => pattern.complete && pattern.prefix === patterns[0]!.prefix);
  const only = single ? files.get(packageFilePath(patterns[0]!.prefix)) : undefined;
  noteOnce(host, "SX_PACKAGE_TEXT_SNAPSHOT", SNAPSHOT_NOTE, node.span);
  if (section !== null && option !== null && only instanceof Map) {
    return { kind: "literal", value: only.get(iniKey(section, option)) ?? null };
  }
  const table = dataCall(resource, "ini", files, host);
  if (table === null) return null;
  const sectionValue = host.lower(args[0]!);
  const optionValue = host.lower(args[1]!);
  if (sectionValue === null || optionValue === null) return null;
  return {
    kind: "methodCall",
    target: table,
    name: "get",
    arguments: [
      { kind: "template", parts: [textPart(sectionValue), { text: "\n" }, textPart(optionValue)] },
      { kind: "literal", value: null },
    ],
    dict: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// File contents

function fileBytes(resources: PackageResources, path: string): Uint8Array | null {
  if (resources.contents.has(path)) return resources.contents.get(path)!;
  const name = resources.files.get(path);
  const bytes = name === undefined || resources.read === null ? null : resources.read(name);
  resources.contents.set(path, bytes);
  return bytes;
}

/**
 * Decodes a file as the legacy reader did. ASCII text reads the same in every charset; other text in the platform
 * charset, which the conversion cannot know, reads as UTF-8 when it is valid UTF-8 and as windows-1252 otherwise, with
 * a note. Returns null for binary data or text that is invalid in an explicit charset.
 */
function decodeText(
  bytes: Uint8Array,
  charset: "utf-8" | "iso-8859-1" | "platform",
): { text: string; note: string | null } | null {
  if (bytes.includes(0)) return null;
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  // ISO-8859-1 maps each byte to the code point of its value (TextDecoder's "latin1" is windows-1252); ASCII text
  // reads the same in every charset.
  if (charset === "iso-8859-1" || bytes.every((byte) => byte < 0x80))
    return { text: Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""), note: null };
  const utf8 = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return null;
    }
  })();
  if (charset === "utf-8") {
    if (utf8 === null) return null;
    return bom
      ? {
          text: utf8.slice(1),
          note: "The file starts with a UTF-8 byte order mark, which Java read as the character U+FEFF at the start of its first line; the conversion drops it.",
        }
      : { text: utf8, note: null };
  }
  if (utf8 !== null)
    return {
      text: bom ? utf8.slice(1) : utf8,
      note: `Java read this file in the player's platform charset (on Windows usually windows-1252); its text is UTF-8, as which the conversion reads it${bom ? ", without the byte order mark at its start, which Java read as text" : ""}.`,
    };
  return {
    text: new TextDecoder("windows-1252").decode(bytes),
    note: "Java read this file in the player's platform charset; its text is not UTF-8, so the conversion reads it as windows-1252, the usual charset of Windows.",
  };
}

/** Lines as Groovy readLines() returns them: split at LF, CR, or CRLF, without an empty last line after a final break. */
function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * java.util.Properties.load(): logical lines continued by an odd number of trailing backslashes, `#` and `!`
 * comments, keys ended by an unescaped `=`, `:`, or whitespace, and the escapes `\t`, `\n`, `\r`, `\f`, and `\uXXXX`;
 * any other escaped character is itself. A later key replaces an earlier one. Null for a malformed `\u` escape, on
 * which Java fails.
 */
function parseProperties(text: string): Map<string, string> | null {
  const lines = text.split(/\r\n|\r|\n/u);
  const table = new Map<string, string>();
  const whitespace = (character: string | undefined) =>
    character === " " || character === "\t" || character === "\f";
  const skip = (line: string, from: number) => {
    let position = from;
    while (whitespace(line[position])) position += 1;
    return position;
  };
  const continues = (line: string) => {
    let slashes = 0;
    for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) slashes += 1;
    return slashes % 2 === 1;
  };
  for (let index = 0; index < lines.length;) {
    const natural = lines[index++]!;
    const start = skip(natural, 0);
    if (start === natural.length || natural[start] === "#" || natural[start] === "!") continue;
    let logical = natural.slice(start);
    while (continues(logical)) {
      logical = logical.slice(0, -1);
      if (index >= lines.length) break;
      const next = lines[index++]!;
      logical += next.slice(skip(next, 0));
    }
    let keyEnd = 0;
    let escaped = false;
    for (; keyEnd < logical.length; keyEnd += 1) {
      const character = logical[keyEnd]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") escaped = true;
      else if (character === "=" || character === ":" || whitespace(character)) break;
    }
    let valueStart = skip(logical, keyEnd);
    if (logical[valueStart] === "=" || logical[valueStart] === ":")
      valueStart = skip(logical, valueStart + 1);
    const key = unescapeProperties(logical.slice(0, keyEnd));
    const value = unescapeProperties(logical.slice(valueStart));
    if (key === null || value === null) return null;
    table.set(key, value);
  }
  return table;
}

function unescapeProperties(text: string): string | null {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const next = text[++index];
    if (next === undefined) break;
    if (next === "u") {
      const hex = text.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return null;
      result += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else {
      result +=
        next === "t"
          ? "\t"
          : next === "n"
            ? "\n"
            : next === "r"
              ? "\r"
              : next === "f"
                ? "\f"
                : next;
    }
  }
  return result;
}

/**
 * An INI file as ini4j's `Wini` (0.5.2, as the legacy player bundled it) reads its plain form: `[section]` headers,
 * `option = value` or `option: value` with trimmed names and values that keep quotes and later `;` or `#` as text, `;`
 * or `#` comment lines, and the last value of a repeated option. Null for what the conversion does not reproduce:
 * escapes, an option without a value or outside a section, and repeated sections.
 */
function parseIni(text: string): Map<string, string> | null {
  const table = new Map<string, string>();
  const sections = new Set<string>();
  let section: string | null = null;
  for (const line of text.split(/\r\n|\r|\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.includes("\\")) return null;
    if (trimmed.startsWith("[")) {
      if (!trimmed.endsWith("]")) return null;
      section = trimmed.slice(1, -1).trim();
      if (sections.has(section)) return null;
      sections.add(section);
      continue;
    }
    if (section === null) return null;
    const operator = trimmed.search(/[=:]/u);
    if (operator <= 0) return null;
    const option = trimmed.slice(0, operator).trim();
    const value = trimmed.slice(operator + 1).trim();
    if (option === "") return null;
    table.set(iniKey(section, option), value);
  }
  return table;
}

/** A template part: literal text as text, any other value interpolated. */
function textPart(value: IrExpression): { text: string } | { value: IrExpression } {
  return value.kind === "literal" && typeof value.value === "string"
    ? { text: value.value }
    : { value };
}

/** A section and an option as one dict key: no INI name holds a line break. */
function iniKey(section: string, option: string): string {
  return `${section}\n${option}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths and AST helpers

/**
 * The fixed beginning and end of a path expression, with `getDataFolder()` as the package root and the variables of
 * `constants` as their text.
 */
function pathPattern(
  node: AstNode,
  constants: ReadonlyMap<string, string> = new Map(),
): PathPattern {
  const whole = (text: string): PathPattern => ({ prefix: text, suffix: text, complete: true });
  const literal = constantString(node);
  if (literal !== null) return whole(literal);
  const name = variableName(node);
  if (name !== null) {
    const text = constants.get(name);
    return text === undefined ? unknownPattern() : whole(text);
  }
  if (node.kind === "methodCall" && constantString(node.method) === "getDataFolder")
    return whole("");
  if (node.kind === "gstring") {
    const strings = Array.isArray(node.strings) ? node.strings.map(String) : [];
    const values = Array.isArray(node.values) ? node.values : [];
    let pattern = whole(strings[0] ?? "");
    values.forEach((value, index) => {
      const part = isAstNode(value) ? pathPattern(value, constants) : unknownPattern();
      pattern = joinText(joinText(pattern, part), whole(strings[index + 1] ?? ""));
    });
    return pattern;
  }
  if (node.kind === "binary" && node.operator === "+") {
    const left = asNode(node.left);
    const right = asNode(node.right);
    if (left === null || right === null) return unknownPattern();
    return joinText(pathPattern(left, constants), pathPattern(right, constants));
  }
  return unknownPattern();
}

/** Two path parts one after the other. */
function joinText(start: PathPattern, end: PathPattern): PathPattern {
  if (start.complete && end.complete) {
    const text = start.prefix + end.prefix;
    return { prefix: text, suffix: text, complete: true };
  }
  return {
    prefix: start.complete ? start.prefix + end.prefix : start.prefix,
    suffix: end.complete ? start.suffix + end.suffix : end.suffix,
    complete: false,
  };
}

function unknownPattern(): PathPattern {
  return { prefix: "", suffix: "", complete: false };
}

/** Whether a write may change a normalized package path: the path itself, or a file below a written folder. */
function writeMatches(write: PathPattern, file: string): boolean {
  const prefix = packageFilePath(write.prefix);
  if (write.complete) return file === prefix || file.startsWith(`${prefix.replace(/\/$/u, "")}/`);
  const suffix = write.suffix.replaceAll("\\", "/").toLowerCase();
  return file.startsWith(prefix) && (file.endsWith(suffix) || file.includes(`${suffix}/`));
}

/** Whether a path pattern may name a normalized package path. */
function matches(pattern: PathPattern, file: string): boolean {
  const prefix = packageFilePath(pattern.prefix);
  if (pattern.complete) return file === prefix;
  const suffix = pattern.suffix.replaceAll("\\", "/").toLowerCase();
  return file.startsWith(prefix) && file.endsWith(suffix);
}
