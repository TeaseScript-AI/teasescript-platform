// Whether a committed change is a pure move: every line it adds or removes is one Git marks as moved, or one of a closed
// list of admitted forms, or a line the change declares with its reason.
//
//   node tools/pure-move-check.mjs BASE [--declare FILE] [--renames FILE] [PATH…]
//
// The change is the one from `git merge-base BASE HEAD` to `HEAD`, both Git's committed trees (commit first); PATHs
// limit it. Git's moved-line detection is read once over the whole change (`moved-lines.mjs`), so a block moved from
// one file into another counts as moved.
//
// An added or removed line Git does not mark as moved is admitted only as one of these forms, nothing else; each form
// holds the whole line, by that side's blob parsed as TypeScript (TypeScript and JavaScript files; comments are the
// parser's, so a string's or a template's text is never one):
//   1. a line of an import or re-export statement (an import declaration, or an export declaration with a module
//      specifier), with nothing else on it but whitespace and comments;
//   2. a bare `export` keyword added to a moved declaration: an added line where a top-level declaration starts with
//      its `export` modifier, paired with a removed line where the same declaration starts without one, the rest of
//      the two lines equal, indentation aside, each removed line paired once;
//   3. a line of whitespace alone;
//   4. a line of comments and whitespace alone, in a file the change adds, above its first import or export statement
//      (a comment elsewhere is a declared line or a failure);
// or as a declared line: an entry of the `--declare` file, a JSON array of `{ "file", "side": "added" | "removed",
// "line", "reason" }` (the reason one clause; the file named as it is on that side), for a path-keyed entry (a test
// table's key, an allowance, a comment citing a moved file's path) or a line no form admits (a signature the formatter
// rewrapped after `export` was added). A declared line must be in the change and not marked moved, and every
// declaration must match one; each is printed with its reason. Declarations come from that file alone, and no flag
// admits a line class.
//
// And a pure move keeps every import's binding: over the change's files, the set of bindings before equals the set
// after, a binding being one imported or re-exported name with its target, its local or exported name and whether it is
// type-only (a default import's name `default`, a namespace's `*`). A relative specifier's target is the file it resolves
// to on that side; a target the move relocated is keyed by its family, from `--renames FILE`, the move sweep's map
// (`{ "renames": { "old": "new" | ["new", …] } }`, old and new paths joined where they share one), and the bindings
// within one family (a split's files importing each other) are left out. A binding on one side only fails, with its file,
// line and specifier; form 1 admits an import line's presence, this rule its content. A target the move relocates or
// adds without a family in `--renames` fails, and the report names the flag.
//
// The report always ends with the change's shape: the moved lines, the admitted lines by form, the declared lines and
// the bindings differing.
//
// The residual is Git's: its move detection is heuristic, and a moved block below its size threshold (20 alphanumeric
// characters) reads as added and removed. A failure on such a block is read by a person, not overridden.
//
// Exit status: 0 when every line is moved, admitted or declared and no binding differs; 1 otherwise (each printed with
// its file and line); 2 when Git's output or the declarations cannot be read, a file name Git quotes, or a binary change, whose
// content the check cannot inspect.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { movedLinesOf, MovedLinesUnreadable } from "./moved-lines.mjs";

const PARSED = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/u;
export const RESIDUAL =
  "Git's move detection is heuristic: a moved block below its size threshold (20 alphanumeric characters) reads as added and removed. Read such a failure; it is not overridden.";
const FORMS = ["import", "export", "whitespace", "header comment"];

/** Why the check cannot be trusted: exit 2. */
class CannotRun extends Error {}

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
  let first = null;
  for (const statement of source.statements) {
    const start = statement.getStart(source);
    const isImport =
      ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined);
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
      Number.isInteger(entry.line) &&
      entry.line > 0 &&
      typeof entry.reason === "string" &&
      entry.reason.trim() !== "" &&
      !entry.reason.includes("\n") &&
      Object.keys(entry).every((key) => ["file", "side", "line", "reason"].includes(key));
    if (!ok)
      throw new CannotRun(
        `pure-move-check: a declaration is not { file, side: "added" | "removed", line, reason }: ${JSON.stringify(entry)}`,
      );
  }
  return entries;
}

/**
 * Each added or removed line of `files` (the changes `movedLinesOf` reads for `mergeBase`..`head`) that Git does not
 * mark moved, with the form that admits it or `null`: `[entry, form, reason]`, `entry` `{ side, file, row, shape,
 * added }`. `declaredFor(entry)` gives a declared line's reason, which comes before the forms. Also the moved lines'
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
    const before = change.old === null ? null : shapeOf(change.old, blob(mergeBase, change.old));
    const after = change.file === null ? null : shapeOf(change.file, blob(head, change.file));
    for (const row of change.removedLines) {
      if (row.moved) moved.removed += 1;
      else {
        rows.push({ side: "removed", file: change.old, row, shape: before, added: false });
        if (before?.declarationStarts.get(row.line)?.exported === false) {
          const key = row.text.trimStart();
          unpairedRemoved.set(key, (unpairedRemoved.get(key) ?? 0) + 1);
        }
      }
    }
    for (const row of change.addedLines) {
      if (row.moved) moved.added += 1;
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
    const reason = declaredFor(entry);
    if (reason !== null) verdicts.push([entry, "declared", reason]);
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
 * A blob's bindings: `{ kind, target, name, as, typeOnly, line, specifier }`, one per imported or re-exported name (a
 * default import's name is `default`, a namespace's `*`, `import x = require()`'s `=`; a side-effect import's, and an
 * empty clause's (`import {} from`, `export {} from`), empty, its local name `{}` for the clause). Its target is
 * `{ type, path }`: `bare` with the specifier itself; `file`, a relative specifier resolved against `exists` as
 * TypeScript resolves it (`.js` to `.ts`, `.tsx` or `.d.ts`, `.mjs` to `.mts` or `.d.mts`, `.cjs` to `.cts` or `.d.cts`,
 * an extensionless one to its file or `/index`); or `missing`, a relative one that resolves to no file, its path.
 */
function bindingsOf(file, text, exists) {
  if (!PARSED.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const resolve = (specifier) => {
    if (!specifier.startsWith(".")) return { type: "bare", path: specifier };
    const at = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const tries = [at];
    for (const [js, own] of [
      [".js", [".ts", ".tsx", ".d.ts"]],
      [".mjs", [".mts", ".d.mts"]],
      [".cjs", [".cts", ".d.cts"]],
      [".jsx", [".tsx"]],
    ])
      if (at.endsWith(js)) for (const ext of own) tries.push(at.slice(0, -js.length) + ext);
    tries.push(
      `${at}.ts`,
      `${at}.tsx`,
      `${at}.d.ts`,
      `${at}/index.ts`,
      `${at}/index.d.ts`,
      `${at}/index.js`,
    );
    const found = tries.find(exists);
    return found === undefined ? { type: "missing", path: at } : { type: "file", path: found };
  };
  const out = [];
  for (const statement of source.statements) {
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const at = { kind: "import", target: resolve(specifier), line, specifier };
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
      const specifier = statement.moduleSpecifier.text;
      const at = { kind: "re-export", target: resolve(specifier), line, specifier };
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
      const specifier = statement.moduleReference.expression.text;
      out.push({
        kind: "import",
        target: resolve(specifier),
        line,
        specifier,
        name: "=",
        as: statement.name.text,
        typeOnly: statement.isTypeOnly,
      });
    }
  }
  return out;
}

/**
 * The bindings on one side only: over `files`, the set of `{ kind, target, name, as, typeOnly }` before and after. A
 * target is its type and path (`bare`, `file`, `missing` apart), a file the move relocated keyed by its family
 * (`renames`); bindings within one family are left out.
 */
function bindingDifferences(mergeBase, head, files, renames, git) {
  const family = familiesOf(renames ?? {});
  const keyOf = (target) =>
    target.type === "file"
      ? `file:${family.get(target.path) ?? target.path}`
      : `${target.type}:${target.path}`;
  const listed = (ref) =>
    new Set(git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean));
  const trees = { before: listed(mergeBase), after: listed(head) };
  const sides = { before: new Map(), after: new Map() };
  const relocated = new Set();
  for (const change of files) {
    if (change.binary) continue;
    for (const [side, ref, file] of [
      ["before", mergeBase, change.old],
      ["after", head, change.file],
    ]) {
      if (file === null) continue;
      const text = git("cat-file", "blob", `${ref}:${file}`);
      for (const binding of bindingsOf(file, text, (one) => trees[side].has(one))) {
        const target = keyOf(binding.target);
        if (family.has(file) && target === keyOf({ type: "file", path: file })) continue;
        // a resolved file that is there on one side only, with no family: a relocation the renames do not name
        const other = side === "before" ? trees.after : trees.before;
        const { type, path: at } = binding.target;
        if (type === "file" && !other.has(at) && !family.has(at)) relocated.add(at);
        const key = JSON.stringify([
          binding.kind,
          target,
          binding.name,
          binding.as,
          binding.typeOnly,
        ]);
        if (!sides[side].has(key)) sides[side].set(key, { ...binding, file, target });
      }
    }
  }
  const only = (side, other) =>
    [...sides[side]]
      .filter(([key]) => !sides[other].has(key))
      .map(([, binding]) => ({ side, ...binding }));
  return {
    differing: [...only("before", "after"), ...only("after", "before")],
    relocated: [...relocated],
  };
}

/** The check of the change from the merge base of `base` and `HEAD`: `{ unadmitted, declared, stale, bindings, counts }`. */
export function checkMove(
  base,
  { declare = null, renames = null, paths = [], cwd = process.cwd() } = {},
) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const files = movedLinesOf(mergeBase, "HEAD", paths, cwd);
  const binary = files.filter((change) => change.binary);
  if (binary.length > 0)
    throw new CannotRun(
      `pure-move-check: a binary change cannot be inspected: ${binary.map((change) => change.header).join("; ")}`,
    );
  const declarations = declare === null ? [] : declarationsOf(declare);
  const used = new Set();
  const declaredFor = (entry) => {
    const index = declarations.findIndex(
      (d, at) =>
        !used.has(at) &&
        d.file === entry.file &&
        d.side === entry.side &&
        d.line === entry.row.line,
    );
    if (index === -1) return null;
    used.add(index);
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
  const stale = declarations.filter((_, at) => !used.has(at));
  const bindings = bindingDifferences(
    mergeBase,
    "HEAD",
    files,
    renames === null ? null : renamesOf(renames),
    git,
  );
  return { mergeBase, unadmitted, declared, stale, bindings, renames: renames !== null, counts };
}

/** The report's lines and exit status for `result`. */
export function reportOf(base, result) {
  const { mergeBase, unadmitted, declared, stale, bindings, renames, counts } = result;
  const out = [`pure-move check of ${base}..HEAD (merge base ${mergeBase.slice(0, 12)}):`];
  for (const u of unadmitted) out.push(`  unadmitted: ${u.file}:${u.line} (${u.side}): ${u.text}`);
  for (const s of stale)
    out.push(
      `  declaration matching no unmoved line: ${s.file}:${s.line} (${s.side}): ${s.reason}`,
    );
  for (const d of declared) out.push(`  declared: ${d.file}:${d.line} (${d.side}): ${d.reason}`);
  for (const b of bindings.differing)
    out.push(
      `  binding only ${b.side}: ${b.file}:${b.line} ${b.kind} from "${b.specifier}": ${b.typeOnly ? "type " : ""}${b.name || "(side effect)"}${b.as !== b.name ? ` as ${b.as}` : ""}`,
    );
  if (bindings.differing.length > 0 && !renames && bindings.relocated.length > 0)
    out.push(
      `  the move relocates or adds ${bindings.relocated.join(", ")}: name its family with --renames FILE (the move sweep's map)`,
    );
  out.push(
    `shape: moved +${counts.movedAdded} -${counts.movedRemoved}; admitted ${FORMS.map((form) => `${form} ${counts[form]}`).join(", ")}; declared ${counts.declared}; unadmitted ${counts.unadmitted}; bindings differing ${bindings.differing.length}`,
  );
  const failed = unadmitted.length > 0 || stale.length > 0 || bindings.differing.length > 0;
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
  if (base === undefined || base.startsWith("--")) {
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
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
