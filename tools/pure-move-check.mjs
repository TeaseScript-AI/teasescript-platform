// Whether a committed change is a pure move: every line it adds or removes is one Git marks as moved, or one of a closed
// list of admitted forms, or a line the change declares with its reason.
//
//   node tools/pure-move-check.mjs BASE [--declare FILE] [PATH…]
//
// The change is the one from `git merge-base BASE HEAD` to `HEAD`, both Git's committed trees (commit first); PATHs
// limit it. Git's moved-line detection is read once over the whole change (`moved-lines.mjs`), so a block moved from
// one file into another counts as moved.
//
// An added or removed line Git does not mark as moved is admitted only as one of these forms, nothing else:
//   1. a line of an import or re-export statement: an import declaration, or an export declaration with a module
//      specifier, in that side's blob (TypeScript and JavaScript files);
//   2. a bare `export` keyword added to a moved declaration: an added line that is `export ` and then the text of a
//      removed line Git does not mark as moved, indentation aside, each removed line paired once;
//   3. a line of whitespace alone;
//   4. a comment-only line in a file the change adds, above its first import or export statement (a comment elsewhere
//      is a declared line or a failure);
// or as a declared line: an entry of the `--declare` file, a JSON array of `{ "file", "side": "added" | "removed",
// "line", "reason" }` (the reason one clause; the file named as it is on that side), for a path-keyed entry (a test
// table's key, an allowance, a comment citing a moved file's path) or a line no form admits (a signature the formatter
// rewrapped after `export` was added). A declared line must be in the change and not marked moved, and every
// declaration must match one; each is printed with its reason. Declarations come from that file alone, and no flag
// admits a line class.
//
// The report always ends with the change's shape: the moved lines, the admitted lines by form and the declared lines.
//
// The residual is Git's: its move detection is heuristic, and a moved block below its size threshold (20 alphanumeric
// characters) reads as added and removed. A failure on such a block is read by a person, not overridden.
//
// Exit status: 0 when every line is moved, admitted or declared; 1 when one is not (each printed with its file and
// line); 2 when Git's output or the declarations cannot be read.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { movedLinesOf, MovedLinesUnreadable } from "./moved-lines.mjs";

const PARSED = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/u;
export const RESIDUAL =
  "Git's move detection is heuristic: a moved block below its size threshold (20 alphanumeric characters) reads as added and removed. Read such a failure; it is not overridden.";
const FORMS = ["import", "export", "whitespace", "header comment"];

/** Why the check cannot be trusted: exit 2. */
class CannotRun extends Error {}

/** The 1-based line of each offset of `text`, by Git's lines (a newline alone ends one). */
function lineIndex(text) {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return (offset) => {
    let [low, high] = [0, starts.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

/** A blob's import and re-export lines, and the comment-only lines above its first import or export statement. */
function shapeOf(file, text) {
  const importLines = new Set();
  const headerComments = new Set();
  if (!PARSED.test(file)) return { importLines, headerComments };
  const lineOf = lineIndex(text);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  let first = null;
  for (const statement of source.statements) {
    const isImport =
      ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined);
    if (isImport)
      for (
        let line = lineOf(statement.getStart(source));
        line <= lineOf(statement.getEnd() - 1);
        line += 1
      )
        importLines.add(line);
    const exported =
      isImport ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (ts.canHaveModifiers(statement) &&
        (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    if (first === null && exported) first = statement.getStart(source);
  }
  if (first !== null) {
    // lines before the first import or export that hold comments and whitespace alone
    const code = new Set();
    const comment = new Set();
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      text,
    );
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      const start = scanner.getTokenStart();
      if (start >= first) break;
      const [from, to] = [lineOf(start), lineOf(Math.max(start, scanner.getTokenEnd() - 1))];
      const target =
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
          ? comment
          : kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia
            ? null
            : code;
      if (target !== null) for (let line = from; line <= to; line += 1) target.add(line);
    }
    for (const line of comment) if (!code.has(line)) headerComments.add(line);
  }
  return { importLines, headerComments };
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

/** The check of the change from the merge base of `base` and `HEAD`: `{ unadmitted, declared, stale, counts }`. */
export function checkMove(base, { declare = null, paths = [], cwd = process.cwd() } = {}) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const files = movedLinesOf(mergeBase, "HEAD", paths, cwd);
  const declarations = declare === null ? [] : declarationsOf(declare);
  const used = new Set();
  const counts = { movedAdded: 0, movedRemoved: 0, declared: 0, unadmitted: 0 };
  for (const form of FORMS) counts[form] = 0;
  const unadmitted = [];
  const declared = [];
  const blob = (ref, file) => git("cat-file", "blob", `${ref}:${file}`);
  // removed lines Git does not mark moved, by their text without indentation, for form 2's pairing
  const unpairedRemoved = new Map();
  const rows = [];
  for (const change of files) {
    const before = change.old === null ? null : shapeOf(change.old, blob(mergeBase, change.old));
    const after = change.file === null ? null : shapeOf(change.file, blob("HEAD", change.file));
    for (const row of change.removedLines) {
      if (row.moved) counts.movedRemoved += 1;
      else {
        rows.push({ side: "removed", file: change.old, row, shape: before, added: false });
        const key = row.text.trimStart();
        unpairedRemoved.set(key, (unpairedRemoved.get(key) ?? 0) + 1);
      }
    }
    for (const row of change.addedLines) {
      if (row.moved) counts.movedAdded += 1;
      else rows.push({ side: "added", file: change.file, row, shape: after, added: change.added });
    }
  }
  // form 2 pairs each `export` line with one removed line; the paired removed lines are admitted with it
  const pairedRemoved = new Map();
  const exportOf = (row) => {
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
    const index = declarations.findIndex(
      (d, at) =>
        !used.has(at) &&
        d.file === entry.file &&
        d.side === entry.side &&
        d.line === entry.row.line,
    );
    if (index !== -1) {
      used.add(index);
      verdicts.push([entry, "declared", declarations[index].reason]);
      continue;
    }
    if (entry.shape?.importLines.has(entry.row.line)) verdicts.push([entry, "import"]);
    else if (entry.row.text.trim() === "") verdicts.push([entry, "whitespace"]);
    else if (
      entry.side === "added" &&
      entry.added &&
      entry.shape?.headerComments.has(entry.row.line)
    )
      verdicts.push([entry, "header comment"]);
    else if (entry.side === "added" && exportOf(entry.row)) verdicts.push([entry, "export"]);
    else verdicts.push([entry, null]);
  }
  for (const verdict of verdicts) {
    const [entry, form] = verdict;
    if (form !== null || entry.side !== "removed") continue;
    const key = entry.row.text.trimStart();
    const paired = pairedRemoved.get(key) ?? 0;
    if (paired > 0) {
      pairedRemoved.set(key, paired - 1);
      verdict[1] = "export";
    }
  }
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
  return { mergeBase, unadmitted, declared, stale, counts };
}

/** The report's lines and exit status for `result`. */
export function reportOf(base, result) {
  const { mergeBase, unadmitted, declared, stale, counts } = result;
  const out = [`pure-move check of ${base}..HEAD (merge base ${mergeBase.slice(0, 12)}):`];
  for (const u of unadmitted) out.push(`  unadmitted: ${u.file}:${u.line} (${u.side}): ${u.text}`);
  for (const s of stale)
    out.push(
      `  declaration matching no unmoved line: ${s.file}:${s.line} (${s.side}): ${s.reason}`,
    );
  for (const d of declared) out.push(`  declared: ${d.file}:${d.line} (${d.side}): ${d.reason}`);
  out.push(
    `shape: moved +${counts.movedAdded} -${counts.movedRemoved}; admitted ${FORMS.map((form) => `${form} ${counts[form]}`).join(", ")}; declared ${counts.declared}; unadmitted ${counts.unadmitted}`,
  );
  const failed = unadmitted.length > 0 || stale.length > 0;
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
  const [base, ...paths] = args;
  if (base === undefined || base.startsWith("--")) {
    console.error("usage: node tools/pure-move-check.mjs BASE [--declare FILE] [PATH…]");
    process.exit(2);
  }
  let result;
  try {
    result = checkMove(base, { declare, paths });
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
