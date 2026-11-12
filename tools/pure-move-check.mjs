// Whether a committed change is a pure move: every line it adds or removes is one Git marks as moved, or one of a closed
// list of admitted forms, or a line the change declares with its reason.
//
//   node tools/pure-move-check.mjs BASE [--declare FILE] [--renames FILE] [PATH…]
//
// The change is the one from `git merge-base BASE HEAD` to `HEAD`, both Git's committed trees (commit first), renames
// included; PATHs limit it, as Git's literal pathspecs. A check that looked at nothing has not passed: a PATH that
// matches no file of the change, on either side, is refused (an unchanged file matches none), and so is an empty
// change, as is an argument that begins with `-` and is no option above. Git's moved-line detection is read once over
// the whole change (`moved-lines.mjs`), so a block moved from one file into another counts as moved.
//
// An added or removed line Git does not mark as moved is admitted only as one of these forms, nothing else; each form
// holds the whole line, by that side's blob parsed as TypeScript (TypeScript and JavaScript files; comments are the
// parser's, so a string's or a template's text is never one):
//   1. a line of an import or re-export statement (an import declaration, an export declaration with a module
//      specifier, or `import x = require()`), with nothing else on it but whitespace and comments;
//   2. a bare `export` keyword added to a moved declaration: an added line where a top-level declaration starts with
//      its `export` modifier, paired with a removed line where the same declaration starts without one, the rest of
//      the two lines equal, indentation aside, each removed line paired once;
//   3. a line of whitespace alone;
//   4. a line of comments and whitespace alone, in a file the change adds, above its first import or export statement
//      (a comment elsewhere is a declared line or a failure);
// or as a declared line: an entry of the `--declare` file, a JSON array of `{ "file", "side": "added" | "removed",
// "text", "reason" }` (the line's text exactly as in that side's blob, without its LF but keeping a CR before it, so
// that a rebase shifting the line leaves it declared; the reason one clause; the file named as it is on that side), for
// a path-keyed entry (a test table's key, an allowance, a comment citing a moved file's path) or a line no form admits
// (a signature the formatter rewrapped after `export` was added). A declared line must be in the change and not marked
// moved (a line of a side that is no regular file, below, counts as unmoved), and every declaration must match one;
// each is printed with its reason. A declaration is taken only by a line that needs one: the changed unmoved lines no
// form admits, in diff order, then the refused imports' lines (below); one covers one line, so two lines of one text
// need two, taken in the file's order. A blob a declaration names must be UTF-8, or the check cannot compare its text
// exactly and stops (exit 2): a file that is not can be moved, but not declared in. Declarations come from that file
// alone, and no flag admits a line class.
//
// And a pure move keeps every import's binding: over the change's files, the set of bindings before equals the set
// after, a binding being one imported or re-exported name with its target, its local or exported name and whether it is
// type-only (a default import's name `default`, a namespace's `*`). A bare specifier is its target as spelled: its
// package's maps and a config's `paths` aliases are not resolved. A relative specifier's target is the file TypeScript
// resolves it to on that side, from that side's committed tree alone: the configuration of the nearest committed
// `tsconfig.json` whose root files include the importer (none: NodeNext, as Node runs it, for a JavaScript file or a
// tree with no config), its module format (`package.json`'s `type`, its extension), the specifier's own `import` or
// `require` mode, and a folder's `package.json`; JavaScript and JSON targets resolve even where the config disables
// them. A target the move relocated is keyed by its family, from `--renames FILE`, the move sweep's map (`{ "renames":
// { "old": "new" | ["new", …] } }`, old and new paths joined where they share one), and the bindings within one family
// (a split's files importing each other) are left out. A binding on one side only fails, with its file, line and
// specifier; form 1 admits an import line's presence, this rule its content. A target the move relocates or adds
// without a family in `--renames` fails, and the report names the flag. So does a binding on one side only between two
// files the change edits, its target there on both sides, as when code moves out of a file that still calls it, and the
// report names the family that would join the two. A relative specifier either side cannot
// resolve, to no file or in a file whose configuration the tree does not establish (a config with an error, such as an
// `extends` the tree does not hold, or a TypeScript file no config includes or none is above), is refused by name:
// reported unless a declaration names its side and its line's text, never passed; the move's compiler run is the
// witness for what the check declines. A declared refusal, its line changed or not, is printed with the refusal reason it covers. One
// known class is a config that `extends` an uncommitted package, which only an install supplies:
// `player/vue/tsconfig.json` extends `@vue/tsconfig`, so every relative import in a file it owns is refused, and a move
// there declares those lines.
//
// The bindings compared are those of import, re-export and import-equals statements. Every other module reference in a
// changed file the check parses (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) is refused by name the
// same way, one per line: an `import` keyword outside those statements other than `import.meta` (a dynamic or type
// import), a `require` identifier outside them, a triple-slash reference directive, or a comment (JSDoc included)
// holding `import(` or `@import`. A changed file of any other type, `.vue` and `.html` among them, is outside the rule:
// the report lists it as `not compared (unparsed)`, and `vue-tsc` and the move's compiler run are its witness. A side
// that is no regular file (a gitlink, mode 160000, or a symbolic link, 120000), whose content is no file's text, is
// never parsed or resolved (a link's blob is read only to check a declaration of it is UTF-8): it gives no bindings,
// the resolver sees no such file (a linked `tsconfig.json` or `package.json` is none), each of its added or removed
// lines is unadmitted unless declared, whether Git marks it moved or it is whitespace (a submodule's new commit is no
// move), and the report lists it as `not compared (not a regular file)`.
//
// The report always ends with the change's shape: the moved lines, the admitted lines by form, the declared lines, the
// bindings differing and the refused specifiers.
//
// The residual is Git's: its move detection is heuristic, and a moved block below its size threshold (20 alphanumeric
// characters) reads as added and removed. A failure on such a block is read by a person, not overridden.
//
// Exit status: 0 when every line is moved, admitted or declared and no binding differs; 1 otherwise (each printed with
// its file and line); 2 when Git's output or the declarations cannot be read, a file name Git quotes, or a binary change, whose
// content the check cannot inspect, and for a refused argument or an empty change.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";
import { movedLinesOf, MovedLinesUnreadable } from "./moved-lines.mjs";

const PARSED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
// the resolver's root for a committed tree's paths
const ROOT = "/tree/";
export const RESIDUAL =
  "Git's move detection is heuristic: a moved block below its size threshold (20 alphanumeric characters) reads as added and removed. Read such a failure; it is not overridden.";
const FORMS = ["import", "export", "whitespace", "header comment"];

/** Whether a change's side is a regular file (mode 100644 or 100755), whose blob is a file's text. */
const regular = (file, mode) => file !== null && (mode === "100644" || mode === "100755");

/** Why the check cannot be trusted: exit 2. */
class CannotRun extends Error {}

/**
 * `text`'s line starts by Git's lines (an LF alone ends one; TypeScript also ends one at a CR or U+2028), and `lineOf`,
 * the line of an offset, found among them by binary search: made once per blob.
 */
function gitLines(text) {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  const lineOf = (offset) => {
    let [low, high] = [0, starts.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return { starts, lineOf };
}

/**
 * A blob's shape by Git's lines (a newline alone ends one), each line's whole content classified: its import and
 * re-export lines, holding nothing else but whitespace and comments; the lines of comments and whitespace alone above
 * its first import or export statement; and the lines where a top-level declaration starts, each with whether it
 * starts with its `export` modifier.
 */
function shapeOf(file, text) {
  const importLines = new Set();
  const headerComments = new Set();
  const declarationStarts = new Map();
  if (!PARSED.test(file)) return { importLines, headerComments, declarationStarts };
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // each character's kind: 0 code or a token's text (a string's, a template's, JSX text), 1 a comment, 2 an import or
  // re-export statement. A comment is one wholly inside a token's trivia, between the token's full start and its start:
  // every comment is some token's (the end of the file's included), and no token's own text is trivia. JSDoc nodes are
  // not descended: their text is the trivia of the token they precede.
  const kind = new Uint8Array(text.length);
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    // both scans at the token's full start: a comment before the next newline is a trailing one to the scanner
    const [from, to] = [node.getFullStart(), node.getStart(source)];
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, from) ?? []),
      ...(ts.getTrailingCommentRanges(text, from) ?? []),
    ])
      if (range.pos >= from && range.end <= to) kind.fill(1, range.pos, range.end);
  };
  visit(source);
  const { starts, lineOf } = gitLines(text);
  let first = null;
  for (const statement of source.statements) {
    const start = statement.getStart(source);
    const isImport =
      ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) ||
      (ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference));
    if (isImport) kind.fill(2, start, statement.getEnd());
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exportFirst =
      modifiers.length > 0 &&
      modifiers[0].kind === ts.SyntaxKind.ExportKeyword &&
      modifiers[0].getStart(source) === start;
    // a line's declaration start is the statement that starts the line (its first non-whitespace character), no later one
    const startsLine = text.slice(starts[lineOf(start) - 1], start).trim() === "";
    if (
      startsLine &&
      !declarationStarts.has(lineOf(start)) &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isVariableStatement(statement) ||
        ts.isModuleDeclaration(statement))
    )
      declarationStarts.set(lineOf(start), { exported: exportFirst });
    // the header's boundary: the first statement that imports or exports, a decorated export's decorators included
    const exported =
      isImport ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (first === null && exported) first = lineOf(start);
  }
  for (let line = 1; line <= starts.length; line += 1) {
    const [from, to] = [starts[line - 1], line < starts.length ? starts[line] - 1 : text.length];
    let [code, comment, statement] = [false, false, false];
    for (let at = from; at < to; at += 1) {
      if (kind[at] === 1) comment = true;
      else if (kind[at] === 2) statement = true;
      else if (!/\s/u.test(text[at])) code = true;
    }
    if (statement && !code) importLines.add(line);
    if (first !== null && line < first && comment && !code && !statement) headerComments.add(line);
  }
  return { importLines, headerComments, declarationStarts };
}

/** The declarations of `path`, checked. */
function declarationsOf(path) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CannotRun(
      `pure-move-check: the declarations ${path} cannot be read: ${error.message}`,
    );
  }
  if (!Array.isArray(entries)) throw new CannotRun(`pure-move-check: ${path} is not a JSON array`);
  for (const entry of entries) {
    const ok =
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.file === "string" &&
      (entry.side === "added" || entry.side === "removed") &&
      typeof entry.text === "string" &&
      !entry.text.includes("\n") &&
      typeof entry.reason === "string" &&
      entry.reason.trim() !== "" &&
      !entry.reason.includes("\n") &&
      Object.keys(entry).every((key) => ["file", "side", "text", "reason"].includes(key));
    if (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "line"))
      throw new CannotRun(
        `pure-move-check: a declaration names its line by "text" now, not "line": replace "line" with that line's exact text, LF-delimited, in that side's blob (removed: the merge base; added: HEAD), keeping any CR: ${JSON.stringify(entry)}`,
      );
    if (!ok)
      throw new CannotRun(
        `pure-move-check: a declaration is not { file, side: "added" | "removed", text, reason }: ${JSON.stringify(entry)}`,
      );
  }
  return entries;
}

/**
 * Each added or removed line of `files` (the changes `movedLinesOf` reads for `mergeBase`..`head`) that Git does not
 * mark moved, and each line of a side that is no regular file whether Git marks it moved or not, with the form that
 * admits it or `null` (only a declaration admits the latter): `[entry, form, reason]`, `entry` `{ side, file, row,
 * shape, added, irregular }`. `declaredFor(entry)` gives a declared line's reason, asked only of a line no form admits, in
 * diff order. Also the moved lines'
 * counts. Shared with `structure-report.mjs --moved`, so the forms have one home.
 */
export function verdictsOf(
  mergeBase,
  head,
  files,
  { cwd = process.cwd(), declaredFor = () => null } = {},
) {
  const blob = (ref, file) =>
    execFileSync("git", ["cat-file", "blob", `${ref}:${file}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const moved = { added: 0, removed: 0 };
  // removed lines Git does not mark moved where a declaration starts without `export`, by their text without
  // indentation, for form 2's pairing
  const unpairedRemoved = new Map();
  const rows = [];
  for (const change of files) {
    if (change.binary) continue;
    const before = regular(change.old, change.oldMode)
      ? shapeOf(change.old, blob(mergeBase, change.old))
      : null;
    const after = regular(change.file, change.newMode)
      ? shapeOf(change.file, blob(head, change.file))
      : null;
    // a side that is no regular file: each of its lines is judged, moved or not, and only a declaration admits it
    const irregular = {
      removed: change.old !== null && !regular(change.old, change.oldMode),
      added: change.file !== null && !regular(change.file, change.newMode),
    };
    for (const row of change.removedLines) {
      if (irregular.removed)
        rows.push({ side: "removed", file: change.old, row, shape: null, irregular: true });
      else if (row.moved) moved.removed += 1;
      else {
        rows.push({ side: "removed", file: change.old, row, shape: before, added: false });
        if (before?.declarationStarts.get(row.line)?.exported === false) {
          const key = row.text.trimStart();
          unpairedRemoved.set(key, (unpairedRemoved.get(key) ?? 0) + 1);
        }
      }
    }
    for (const row of change.addedLines) {
      if (irregular.added)
        rows.push({ side: "added", file: change.file, row, shape: null, irregular: true });
      else if (row.moved) moved.added += 1;
      else rows.push({ side: "added", file: change.file, row, shape: after, added: change.added });
    }
  }
  // form 2 pairs each `export` line with one removed line; the paired removed lines are admitted with it
  const pairedRemoved = new Map();
  const exportOf = (entry) => {
    const { row } = entry;
    if (entry.shape?.declarationStarts.get(row.line)?.exported !== true) return false;
    const text = row.text.trimStart();
    if (!text.startsWith("export ")) return false;
    const rest = text.slice("export ".length);
    const left = unpairedRemoved.get(rest) ?? 0;
    if (left === 0) return false;
    unpairedRemoved.set(rest, left - 1);
    pairedRemoved.set(rest, (pairedRemoved.get(rest) ?? 0) + 1);
    return true;
  };
  const verdicts = [];
  for (const entry of rows) {
    if (entry.irregular) verdicts.push([entry, null]);
    else if (entry.shape?.importLines.has(entry.row.line)) verdicts.push([entry, "import"]);
    else if (entry.row.text.trim() === "") verdicts.push([entry, "whitespace"]);
    else if (
      entry.side === "added" &&
      entry.added &&
      entry.shape?.headerComments.has(entry.row.line)
    )
      verdicts.push([entry, "header comment"]);
    else if (entry.side === "added" && exportOf(entry)) verdicts.push([entry, "export"]);
    else verdicts.push([entry, null]);
  }
  for (const verdict of verdicts) {
    const [entry, form] = verdict;
    if (form !== null || entry.side !== "removed") continue;
    if (entry.shape?.declarationStarts.get(entry.row.line)?.exported !== false) continue;
    const key = entry.row.text.trimStart();
    const paired = pairedRemoved.get(key) ?? 0;
    if (paired > 0) {
      pairedRemoved.set(key, paired - 1);
      verdict[1] = "export";
    }
  }
  // a declaration is taken only by a line no form admits, in diff order
  for (const verdict of verdicts) {
    if (verdict[1] !== null) continue;
    const reason = declaredFor(verdict[0]);
    if (reason === null) continue;
    verdict[1] = "declared";
    verdict.push(reason);
  }
  return { verdicts, moved };
}

/** The renames of `path`, the move sweep's map: `{ "renames": { "old": "new" | ["new", …] } }`, checked. */
function renamesOf(path) {
  let map;
  try {
    map = JSON.parse(readFileSync(path, "utf8")).renames;
  } catch (error) {
    throw new CannotRun(`pure-move-check: the renames ${path} cannot be read: ${error.message}`);
  }
  const ok =
    map !== null &&
    typeof map === "object" &&
    !Array.isArray(map) &&
    Object.values(map).every(
      (to) =>
        typeof to === "string" ||
        (Array.isArray(to) && to.length > 0 && to.every((one) => typeof one === "string")),
    );
  if (!ok)
    throw new CannotRun(`pure-move-check: ${path} is not { "renames": { old: new | [new, …] } }`);
  return map;
}

/**
 * The families a move's renames make: each old path with its new paths, joined where they share one (a merge), each
 * path mapped to its family's name, its lexicographically smallest member (any one member would do: the comparison only
 * needs the same name on both sides).
 */
function familiesOf(renames) {
  const parent = new Map();
  const find = (path) => {
    while (parent.has(path) && parent.get(path) !== path) path = parent.get(path);
    return path;
  };
  const join = (a, b) => {
    for (const path of [a, b]) if (!parent.has(path)) parent.set(path, path);
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };
  for (const [old, to] of Object.entries(renames)) for (const path of [to].flat()) join(old, path);
  const family = new Map();
  for (const path of parent.keys()) family.set(path, find(path));
  return family;
}

/**
 * TypeScript's resolution over one side's committed tree (`ref`, its files `tree`, its folders `folders`): a host that
 * reads only that tree's blobs (cached); a file's configuration (`configOf`: `{ options }` or `{ refused: reason }`);
 * and its implied module format (`formatOf`: `package.json`'s `type` and the file's extension). A file's configuration
 * is that of the nearest committed `tsconfig.json` whose root files (its `files`, `include` and `exclude`, matched by
 * TypeScript's own `matchFiles` over the tree) include it; a config matching no file is passed over, and one with any
 * other error (an `extends` the tree does not hold) refuses the files below it by name. With none: a JavaScript file,
 * or any file of a tree with no `tsconfig.json`, resolves as Node runs it (NodeNext); a TypeScript file is refused.
 * JavaScript and JSON targets resolve even where a config disables them, as they load at runtime.
 */
function treeResolver(ref, tree, folders, git) {
  // a resolver path's tree path: the root as `/tree` or `/tree/`, a path below it, or `null` outside the tree
  const inTree = (name) =>
    name === ROOT.slice(0, -1)
      ? ""
      : name.startsWith(ROOT)
        ? name.slice(ROOT.length).replace(/\/$/u, "")
        : null;
  const blobs = new Map();
  const readFile = (name) => {
    const file = inTree(name);
    if (file === null || !tree.has(file)) return undefined;
    if (!blobs.has(file)) blobs.set(file, git("cat-file", "blob", `${ref}:${file}`));
    return blobs.get(file);
  };
  const host = {
    fileExists: (name) => {
      const file = inTree(name);
      return file !== null && tree.has(file);
    },
    directoryExists: (name) => {
      const folder = inTree(name);
      return folder !== null && folders.has(folder);
    },
    readFile,
    realpath: (name) => name,
    getCurrentDirectory: () => ROOT,
    useCaseSensitiveFileNames: true,
  };
  const configs = new Map();
  const entries = new Map();
  for (const file of tree) {
    const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    if (!entries.has(dir)) entries.set(dir, { files: [], directories: [] });
    entries.get(dir).files.push(path.posix.basename(file));
  }
  for (const folder of folders) {
    if (folder === "") continue;
    const parent = path.posix.dirname(folder) === "." ? "" : path.posix.dirname(folder);
    if (!entries.has(parent)) entries.set(parent, { files: [], directories: [] });
    entries.get(parent).directories.push(path.posix.basename(folder));
  }
  const readDirectory = (root, extensions, excludes, includes, depth) =>
    ts.matchFiles(
      root,
      extensions,
      excludes,
      includes,
      true,
      ROOT,
      depth,
      (dir) => {
        const at = inTree(dir);
        return (at === null ? undefined : entries.get(at)) ?? { files: [], directories: [] };
      },
      (name) => name,
    );
  const parse = (config) => {
    if (!configs.has(config)) {
      const read = ts.readConfigFile(ROOT + config, readFile);
      const parsed = ts.parseJsonConfigFileContent(
        read.config ?? {},
        { ...host, readDirectory },
        ROOT + path.posix.dirname(config),
        undefined,
        ROOT + config,
      );
      // a config that matches no file says so as an error (TS18003); that is no error of its settings
      const errors = [read.error, ...parsed.errors].filter(
        (error) => error && error.code !== 18003,
      );
      configs.set(config, {
        options: { ...parsed.options, allowJs: true, resolveJsonModule: true },
        files: new Set(parsed.fileNames),
        error:
          errors.length === 0 ? null : ts.flattenDiagnosticMessageText(errors[0].messageText, " "),
      });
    }
    return configs.get(config);
  };
  const anyConfig = [...tree].some((file) => path.posix.basename(file) === "tsconfig.json");
  const NODE = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    resolveJsonModule: true,
  };
  const configOf = (file) => {
    let dir = path.posix.dirname(file);
    let nearest = null;
    for (;;) {
      const config = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
      if (tree.has(config)) {
        nearest ??= config;
        const parsed = parse(config);
        if (parsed.error !== null) return { refused: `${config}: ${parsed.error}` };
        if (parsed.files.has(ROOT + file)) return { options: parsed.options };
      }
      if (dir === "." || dir === "") break;
      dir = path.posix.dirname(dir);
    }
    if (!anyConfig || /\.(js|mjs|cjs|jsx)$/u.test(file)) return { options: NODE };
    return {
      refused:
        nearest === null
          ? "no committed tsconfig.json is above it"
          : `no committed tsconfig.json includes it (the nearest, ${nearest}, leaves it out)`,
    };
  };
  const formatOf = (file, options) =>
    ts.getImpliedNodeFormatForFile(ROOT + file, undefined, host, options);
  return { host, configOf, formatOf, NODE };
}

/**
 * A blob's bindings: `{ kind, target, name, as, typeOnly, line, specifier }`, one per imported or re-exported name (a
 * default import's name is `default`, a namespace's `*`, `import x = require()`'s `=`; a side-effect import's, and an
 * empty clause's (`import {} from`, `export {} from`), empty, its local name `{}` for the clause). Its target is
 * `{ type, path }`: `bare` with the specifier itself, compared by its spelling; `file`, a relative specifier resolved by
 * TypeScript's resolver over that side's committed tree (`resolver`: the file's configuration, its implied module format
 * and the specifier's own usage mode, `import` or `require`); `missing`, a relative one that resolves to no file; or
 * `refused`, a relative one in a file whose configuration the tree does not establish (`reason`). Every other module
 * reference (outside the import, re-export and import-equals statements above) is a `reference` whose target is
 * `refused`, one per line.
 */
function bindingsOf(file, text, resolver) {
  if (!PARSED.test(file)) return [];
  const config = resolver.configOf(file);
  const options = config.options ?? resolver.NODE;
  const source = ts.createSourceFile(
    file,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      impliedNodeFormat: resolver.formatOf(file, options),
    },
    true,
  );
  const { lineOf } = gitLines(text);
  const resolve = (node) => {
    const specifier = node.text;
    if (!specifier.startsWith(".")) return { type: "bare", path: specifier };
    const at = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (config.refused) return { type: "refused", path: at, reason: config.refused };
    const mode = ts.getModeForUsageLocation(source, node, options);
    const found = ts.resolveModuleName(
      specifier,
      ROOT + file,
      options,
      resolver.host,
      undefined,
      undefined,
      mode,
    ).resolvedModule;
    if (found !== undefined && found.resolvedFileName.startsWith(ROOT))
      return { type: "file", path: found.resolvedFileName.slice(ROOT.length) };
    return {
      type: "missing",
      path: at,
      reason: "resolves to no file under the committed configuration",
    };
  };
  const out = [];
  const compared = new Set();
  for (const statement of source.statements) {
    const line = lineOf(statement.getStart(source));
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      compared.add(statement);
      const specifier = statement.moduleSpecifier.text;
      const at = { kind: "import", target: resolve(statement.moduleSpecifier), line, specifier };
      const clause = statement.importClause;
      if (clause === undefined) out.push({ ...at, name: "", as: "", typeOnly: false });
      else {
        if (clause.name)
          out.push({ ...at, name: "default", as: clause.name.text, typeOnly: clause.isTypeOnly });
        const bindings = clause.namedBindings;
        if (
          !clause.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length === 0
        )
          out.push({ ...at, name: "", as: "{}", typeOnly: clause.isTypeOnly });
        if (bindings && ts.isNamespaceImport(bindings))
          out.push({ ...at, name: "*", as: bindings.name.text, typeOnly: clause.isTypeOnly });
        else if (bindings)
          for (const element of bindings.elements)
            out.push({
              ...at,
              name: (element.propertyName ?? element.name).text,
              as: element.name.text,
              typeOnly: clause.isTypeOnly || element.isTypeOnly,
            });
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      compared.add(statement);
      const specifier = statement.moduleSpecifier.text;
      const at = { kind: "re-export", target: resolve(statement.moduleSpecifier), line, specifier };
      const clause = statement.exportClause;
      if (clause === undefined)
        out.push({ ...at, name: "*", as: "*", typeOnly: statement.isTypeOnly });
      else if (ts.isNamespaceExport(clause))
        out.push({ ...at, name: "*", as: clause.name.text, typeOnly: statement.isTypeOnly });
      else if (clause.elements.length === 0)
        out.push({ ...at, name: "", as: "{}", typeOnly: statement.isTypeOnly });
      else
        for (const element of clause.elements)
          out.push({
            ...at,
            name: (element.propertyName ?? element.name).text,
            as: element.name.text,
            typeOnly: statement.isTypeOnly || element.isTypeOnly,
          });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      compared.add(statement);
      const specifier = statement.moduleReference.expression.text;
      out.push({
        kind: "import",
        target: resolve(statement.moduleReference.expression),
        line,
        specifier,
        name: "=",
        as: statement.name.text,
        typeOnly: statement.isTypeOnly,
      });
    }
  }
  out.push(...otherReferencesOf(source, text, compared, lineOf));
  return out;
}

/**
 * Every other module reference of `source` (its `text`), refused by name, one per line, as a `reference` whose target
 * is `refused`: an `import` keyword (not `import.meta`) or a `require` identifier outside the `compared` statements, a
 * triple-slash reference directive, or a comment (JSDoc included) holding `import(` or `@import`.
 */
function otherReferencesOf(source, text, compared, lineOf) {
  const out = [];
  const lines = new Set();
  const refuse = (at, shown, what) => {
    const line = lineOf(at);
    if (lines.has(line)) return;
    lines.add(line);
    const specifier = shown.split("\n")[0].slice(0, 60);
    out.push({
      kind: "reference",
      target: {
        type: "refused",
        path: specifier,
        reason: `${what}, a module reference the binding rule does not compare`,
      },
      line,
      specifier,
      name: "",
      as: "",
      typeOnly: false,
    });
  };
  for (const [list, what] of [
    [source.referencedFiles, "a `/// <reference path>`"],
    [source.typeReferenceDirectives, "a `/// <reference types>`"],
    [source.libReferenceDirectives, "a `/// <reference lib>`"],
  ])
    for (const directive of list) refuse(directive.pos, directive.fileName, what);
  const comments = new Set();
  // a JSDoc comment is read twice: its parsed tokens as code's, below (never within a compared statement, whose binding
  // it is not), and its text as a comment's, from the token it precedes
  const visit = (node, inCompared, inDoc) => {
    const doc =
      inDoc ||
      (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode);
    const within = !doc && (inCompared || compared.has(node));
    // every child, a token's too (the end-of-file token holds the JSDoc after the last statement)
    for (const child of node.getChildren(source)) visit(child, within, doc);
    if (node.kind > ts.SyntaxKind.LastToken) return;
    for (const range of doc
      ? []
      : [
          ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
          ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
        ]) {
      if (comments.has(range.pos)) continue;
      comments.add(range.pos);
      const found = /import\(|@import/u.exec(text.slice(range.pos, range.end));
      if (found !== null)
        refuse(
          range.pos + found.index,
          text.slice(range.pos + found.index, range.end),
          `a comment's \`${found[0]}\``,
        );
    }
    if (within) return;
    const parent = node.parent ?? node;
    if (node.kind === ts.SyntaxKind.ImportKeyword && !ts.isMetaProperty(parent))
      refuse(node.getStart(source), parent.getText(source), "an `import`");
    else if (ts.isIdentifier(node) && node.text === "require")
      refuse(
        node.getStart(source),
        (ts.isCallExpression(parent) ? parent : node).getText(source),
        "a `require`",
      );
  };
  visit(source, false, false);
  return out;
}

/**
 * The bindings on one side only: over `files`, the set of `{ kind, target, name, as, typeOnly }` before and after. A
 * target is its type and path (`bare` and `file` apart), a file the move relocated keyed by its family (`renames`);
 * bindings within one family are left out. A relative specifier either side cannot resolve (`missing`, `refused`) is
 * no binding but a refusal, `{ side, file, line, specifier, reason }` (its side `removed` or `added`, as a
 * declaration names it), which the check reports unless it is declared.
 */
function bindingDifferences(mergeBase, head, files, renames, git) {
  const family = familiesOf(renames ?? {});
  const keyOf = (target) =>
    target.type === "file"
      ? `file:${family.get(target.path) ?? target.path}`
      : `${target.type}:${target.path}`;
  // a side's files: its tree's regular files, the only ones the resolver reads (a symbolic link's blob is a path, a
  // gitlink names a commit)
  const listed = (ref) =>
    new Set(
      git("ls-tree", "-r", "-z", "--full-tree", ref)
        .split("\0")
        .filter((entry) => regular(entry, entry.slice(0, entry.indexOf(" "))))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
    );
  const trees = { before: listed(mergeBase), after: listed(head) };
  // each side's folders, for the resolver's `directoryExists`
  const foldersOf = (paths) => {
    const out = new Set([""]);
    for (const one of paths)
      for (let at = one.lastIndexOf("/"); at > 0; at = one.lastIndexOf("/", at - 1))
        out.add(one.slice(0, at));
    return out;
  };
  const folders = { before: foldersOf(trees.before), after: foldersOf(trees.after) };
  const resolvers = {
    before: treeResolver(mergeBase, trees.before, folders.before, git),
    after: treeResolver(head, trees.after, folders.after, git),
  };
  const sides = { before: new Map(), after: new Map() };
  const relocated = new Set();
  // the files the change edits, on each side
  const changed = {
    before: new Set(files.map((change) => change.old)),
    after: new Set(files.map((change) => change.file)),
  };
  const refusals = new Map();
  for (const change of files) {
    if (change.binary) continue;
    for (const [side, ref, file, mode] of [
      ["before", mergeBase, change.old, change.oldMode],
      ["after", head, change.file, change.newMode],
    ]) {
      if (!regular(file, mode)) continue;
      const text = git("cat-file", "blob", `${ref}:${file}`);
      const lines = text.split("\n");
      for (const binding of bindingsOf(file, text, resolvers[side])) {
        if (binding.target.type === "missing" || binding.target.type === "refused") {
          const refusal = {
            side: side === "before" ? "removed" : "added",
            file,
            line: binding.line,
            text: lines[binding.line - 1],
            specifier: binding.specifier,
            reason: binding.target.reason,
          };
          refusals.set(JSON.stringify([side, file, binding.line, binding.specifier]), refusal);
          continue;
        }
        const target = keyOf(binding.target);
        if (family.has(file) && target === keyOf({ type: "file", path: file })) continue;
        // a resolved file that is there on one side only, with no family: a relocation the renames do not name
        const other = side === "before" ? trees.after : trees.before;
        const { type, path: at } = binding.target;
        if (type === "file" && !other.has(at) && !family.has(at)) relocated.add(at);
        // another file the change edits, there on both sides: one a family could join with the importer
        const sibling =
          type === "file" && at !== file && other.has(at) && changed[side].has(at) ? at : null;
        const key = JSON.stringify([
          binding.kind,
          target,
          binding.name,
          binding.as,
          binding.typeOnly,
        ]);
        if (!sides[side].has(key)) sides[side].set(key, { ...binding, file, target, sibling });
      }
    }
  }
  const only = (side, other) =>
    [...sides[side]]
      .filter(([key]) => !sides[other].has(key))
      .map(([, binding]) => ({ side, ...binding }));
  const differing = [...only("before", "after"), ...only("after", "before")];
  const joinable = new Map();
  for (const { file, sibling } of differing)
    if (sibling !== null) joinable.set(JSON.stringify([file, sibling]), [file, sibling]);
  return {
    differing,
    relocated: [...relocated],
    joinable: [...joinable.values()],
    refusals: [...refusals.values()],
  };
}

/**
 * The check of the change from the merge base of `base` and `HEAD`: `{ mergeBase, unadmitted, declared, stale, refused,
 * covered, unparsed, irregular, bindings, renames, counts }`.
 */
export function checkMove(
  base,
  { declare = null, renames = null, paths = [], cwd = process.cwd() } = {},
) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const mergeBase = git("merge-base", base, "HEAD").trim();
  // each PATH by Git's own pathspec matching, with `movedLinesOf`'s settings that decide which files a diff shows: the
  // change limited to it is empty or not (exit 0 or 1)
  const unmatched = paths.filter((file) => {
    const { status, stderr } = spawnSync(
      "git",
      [
        "diff",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        mergeBase,
        "HEAD",
        "--",
        `:(literal)${file}`,
      ],
      { cwd, encoding: "utf8" },
    );
    if (status !== 0 && status !== 1)
      throw new CannotRun(
        `pure-move-check: Git cannot limit the change to ${file}: ${stderr.trim()}`,
      );
    return status === 0;
  });
  if (unmatched.length > 0)
    throw new CannotRun(
      unmatched
        .map(
          (file) =>
            `pure-move-check: ${file} matches no file of the change ${mergeBase.slice(0, 12)}..HEAD`,
        )
        .join("\n"),
    );
  const files = movedLinesOf(mergeBase, "HEAD", paths, cwd);
  if (files.length === 0)
    throw new CannotRun(
      `pure-move-check: the change ${mergeBase.slice(0, 12)}..HEAD is empty: nothing to check (the check reads committed trees: commit first)`,
    );
  const binary = files.filter((change) => change.binary);
  if (binary.length > 0)
    throw new CannotRun(
      `pure-move-check: a binary change cannot be inspected: ${binary.map((change) => change.header).join("; ")}`,
    );
  const unparsed = files
    .filter((change) => !PARSED.test(change.file ?? change.old))
    .map((change) =>
      change.old !== null && change.file !== null && change.old !== change.file
        ? `${change.old} → ${change.file}`
        : (change.file ?? change.old),
    );
  // each side that is no regular file, never read
  const irregular = files.flatMap((change) =>
    [
      [change.old, change.oldMode],
      [change.file, change.newMode],
    ]
      .filter(([file, mode]) => file !== null && !regular(file, mode))
      .map(([file, mode]) => `${file} (${mode})`),
  );
  const declarations = declare === null ? [] : declarationsOf(declare);
  // a declaration's text is compared exactly, and Git's diff and blobs, read as UTF-8, turn bytes that are not into
  // U+FFFD, which a declaration could then match: each blob a declaration names must decode without loss
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const key of new Set(declarations.map((d) => JSON.stringify([d.file, d.side])))) {
    const [file, side] = JSON.parse(key);
    const read = spawnSync(
      "git",
      ["cat-file", "blob", `${side === "removed" ? mergeBase : "HEAD"}:${file}`],
      { cwd, maxBuffer: 256 * 1024 * 1024 },
    );
    // (a file not on that side has no blob and stays unmatched; a gitlink has none either, but Git's line for it,
    // `Subproject commit …`, can be declared)
    if (read.status !== 0) continue;
    try {
      decoder.decode(read.stdout);
    } catch {
      throw new CannotRun(
        `pure-move-check: ${file} (${side}) is not UTF-8, so a declaration's text cannot be compared with its lines exactly`,
      );
    }
  }
  // each declaration binds to the one line it first matches, by the line's number on its side
  const bound = new Map();
  const declaredFor = (entry) => {
    const index = declarations.findIndex(
      (d, at) =>
        !bound.has(at) &&
        d.file === entry.file &&
        d.side === entry.side &&
        d.text === entry.row.text,
    );
    if (index === -1) return null;
    bound.set(index, entry.row.line);
    return declarations[index].reason;
  };
  const { verdicts, moved } = verdictsOf(mergeBase, "HEAD", files, { cwd, declaredFor });
  const counts = {
    movedAdded: moved.added,
    movedRemoved: moved.removed,
    declared: 0,
    unadmitted: 0,
  };
  for (const form of FORMS) counts[form] = 0;
  const unadmitted = [];
  const declared = [];
  for (const [entry, form, reason] of verdicts) {
    const at = { file: entry.file, line: entry.row.line, side: entry.side, text: entry.row.text };
    if (form === "declared") {
      counts.declared += 1;
      declared.push({ ...at, reason });
    } else if (form === null) {
      counts.unadmitted += 1;
      unadmitted.push(at);
    } else counts[form] += 1;
  }
  const bindings = bindingDifferences(
    mergeBase,
    "HEAD",
    files,
    renames === null ? null : renamesOf(renames),
    git,
  );
  // a refusal is declared by the declaration bound to its line, a changed one or not, else by one of its side and its
  // line's text bound to none, which it binds; each is printed with the refusal reason it covers
  const refused = [];
  const covered = [];
  const ofSide = (d, refusal) => d.file === refusal.file && d.side === refusal.side;
  for (const refusal of bindings.refusals) {
    let index = declarations.findIndex(
      (d, at) => ofSide(d, refusal) && bound.get(at) === refusal.line,
    );
    if (index === -1) {
      index = declarations.findIndex(
        (d, at) => ofSide(d, refusal) && !bound.has(at) && d.text === refusal.text,
      );
      if (index !== -1) {
        bound.set(index, refusal.line);
        counts.declared += 1;
      }
    }
    if (index === -1) refused.push(refusal);
    else covered.push({ ...refusal, declared: declarations[index].reason });
  }
  counts.refused = refused.length;
  const stale = declarations.filter((_, at) => !bound.has(at));
  return {
    mergeBase,
    unadmitted,
    declared,
    stale,
    refused,
    covered,
    unparsed,
    irregular,
    bindings,
    renames: renames !== null,
    counts,
  };
}

/** The report's lines and exit status for `result`. */
export function reportOf(base, result) {
  const {
    mergeBase,
    unadmitted,
    declared,
    stale,
    refused,
    covered,
    unparsed,
    irregular,
    bindings,
    renames,
    counts,
  } = result;
  const out = [`pure-move check of ${base}..HEAD (merge base ${mergeBase.slice(0, 12)}):`];
  for (const u of unadmitted) out.push(`  unadmitted: ${u.file}:${u.line} (${u.side}): ${u.text}`);
  for (const s of stale)
    out.push(
      `  declaration matching no line that needs one (a changed unmoved line no form admits, or a refused import's line): ${s.file} (${s.side}) ${JSON.stringify(s.text)}: ${s.reason}`,
    );
  for (const d of declared) out.push(`  declared: ${d.file}:${d.line} (${d.side}): ${d.reason}`);
  for (const c of covered)
    out.push(
      `  declared refusal: ${c.file}:${c.line} (${c.side}) "${c.specifier}": ${c.reason}; declared: ${c.declared}`,
    );
  for (const r of refused)
    out.push(
      `  refused: ${r.file}:${r.line} (${r.side}) "${r.specifier}": ${r.reason}; declare it, the move's compiler run its witness`,
    );
  for (const name of new Set(unparsed)) out.push(`  not compared (unparsed): ${name}`);
  for (const side of new Set(irregular)) out.push(`  not compared (not a regular file): ${side}`);
  for (const b of bindings.differing)
    out.push(
      `  binding only ${b.side}: ${b.file}:${b.line} ${b.kind} from "${b.specifier}": ${b.typeOnly ? "type " : ""}${b.name || "(side effect)"}${b.as !== b.name ? ` as ${b.as}` : ""}`,
    );
  if (bindings.differing.length > 0 && !renames && bindings.relocated.length > 0)
    out.push(
      `  the move relocates or adds ${bindings.relocated.join(", ")}: name its family with --renames FILE (the move sweep's map)`,
    );
  for (const [importer, sibling] of bindings.joinable)
    out.push(
      `  ${importer} and ${sibling} both change, and a binding between them is on one side only: if the move took code from one into the other, name them one family with --renames FILE, as {"renames":{${JSON.stringify(importer)}:[${JSON.stringify(importer)},${JSON.stringify(sibling)}]}}`,
    );
  out.push(
    `shape: moved +${counts.movedAdded} -${counts.movedRemoved}; admitted ${FORMS.map((form) => `${form} ${counts[form]}`).join(", ")}; declared ${counts.declared}; unadmitted ${counts.unadmitted}; bindings differing ${bindings.differing.length}; refused ${counts.refused}`,
  );
  const failed =
    unadmitted.length > 0 ||
    stale.length > 0 ||
    bindings.differing.length > 0 ||
    refused.length > 0;
  if (unadmitted.length > 0) out.push(RESIDUAL);
  return { lines: out, status: failed ? 1 : 0 };
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--declare");
  let declare = null;
  if (at !== -1) {
    declare = args[at + 1];
    if (declare === undefined) {
      console.error("pure-move-check: --declare needs a file");
      process.exit(2);
    }
    args.splice(at, 2);
  }
  const renamesAt = args.indexOf("--renames");
  let renames = null;
  if (renamesAt !== -1) {
    renames = args[renamesAt + 1];
    if (renames === undefined) {
      console.error("pure-move-check: --renames needs a file");
      process.exit(2);
    }
    args.splice(renamesAt, 2);
  }
  const [base, ...paths] = args;
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (base === undefined || unknown !== undefined) {
    if (unknown !== undefined) console.error(`pure-move-check: unknown option ${unknown}`);
    console.error(
      "usage: node tools/pure-move-check.mjs BASE [--declare FILE] [--renames FILE] [PATH…]",
    );
    process.exit(2);
  }
  let result;
  try {
    result = checkMove(base, { declare, renames, paths });
  } catch (error) {
    if (!(error instanceof CannotRun || error instanceof MovedLinesUnreadable)) throw error;
    console.error(error.message);
    process.exit(2);
  }
  const { lines, status } = reportOf(base, result);
  console.log(lines.join("\n"));
  process.exit(status);
}

// run as a command, not when a test imports it
if (import.meta.main) main();
