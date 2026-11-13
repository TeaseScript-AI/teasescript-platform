// Whether a committed change is a pure move: every line it adds or removes is one Git marks as moved, or one of a closed
// list of admitted forms, or a line the change declares with its reason.
//
//   node tools/moves/pure-move-check.mjs BASE [--declare FILE] [--renames FILE] [PATH…]
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
//   3. a line of whitespace alone whose line break before it lies outside every token's text as TypeScript's parse of
//      that side's blob places the tokens, in a file the check parses without a syntax error (a template literal's or a
//      string's lines are its content; JSX text's lines after its first non-whitespace character are a token's too, so
//      refused, though JSX drops a whitespace line; a comment's are admitted); any other whitespace line is unadmitted
//      and declared as any line is (an empty line's entry has `"text": ""`). Node can place a token otherwise without a
//      parse error in two readings, the complete set review round 2 of #2621 bounded: `await` followed by `/` in a
//      `.mjs` or `.mts` file without an import or export (a script to this parse, a module to Node), and `<!--` in a
//      script (a comment to Node). A move of such a file declares its whitespace lines or reads its templates by hand;
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
// alone, and no flag admits a line class. To write one, run the check without `--declare`: it lists each line that
// needs one as `unadmitted: FILE:LINE (SIDE): TEXT`. Read each, and declare those you mean, each with the reason that
// line changed. A generated file the change rewrites in place is declared whole instead, `{ "file", "whole": true,
// "reason" }` (the reason naming the command that wrote it): its added and removed lines are not judged but listed, as
// `not judged (declared whole): FILE (+N -M): reason`, and counted in the shape line, and its import bindings are
// still compared. A whole entry for a file the change adds, deletes or renames, for a path of the `--renames` map, for
// none of the change's files, or a second one for a file, cannot run: moved code is never declared away.
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
// holding `import(` or `@import`. One exception: a line whose every reference is a dynamic `import(…)`, which the
// change leaves unchanged and which is refused on both sides of a file the change edits at one path and does not
// declare whole, is not refused and needs no declaration; it is printed once, by its line at HEAD, as `not judged:
// unchanged dynamic import, FILE:LINE`, and counted in the shape line: check where its path points after the move,
// since no move tool reads a path built at run time. A declaration that names such a line still covers it. A changed
// file of any other type, `.vue` and `.html` among them, is outside the rule: the report lists it as `not compared
// (unparsed)`, and `vue-tsc` and the move's compiler run are its witness. A side that is no regular file (a gitlink,
// mode 160000, or a symbolic link, 120000), whose content is no file's text, is never parsed or resolved (a link's blob
// is read only to check a declaration of it is UTF-8): it gives no bindings, the resolver sees no such file (a linked
// `tsconfig.json` or `package.json` is none), each of its added or removed lines is unadmitted unless declared, whether
// Git marks it moved or it is whitespace (a submodule's new commit is no move), and the report lists it as `not
// compared (not a regular file)`.
//
// The report always ends with the change's shape: the moved lines, the admitted lines by form, the declared lines, the
// bindings differing and the refused specifiers (and `; not judged N` after them when N lines are not judged).
//
// The residual is Git's: its move detection is heuristic, and a moved block below its size threshold (20 alphanumeric
// characters) reads as added and removed. A failure on such a block is read by a person, not overridden.
//
// Exit status: 0 when every line is moved, admitted or declared and no binding differs; 1 otherwise (each printed with
// its file and line); 2 when Git's output or the declarations cannot be read, a file name Git quotes, or a binary
// change, whose content the check cannot inspect, and for a refused argument or an empty change.

import { execFileSync, spawnSync } from "node:child_process";
import { movedLinesOf, MovedLinesUnreadable } from "./moved-lines.mjs";
import { FORMS, PARSED, regular, verdictsOf } from "./pure-move-forms.mjs";
import {
  boundDeclarations,
  CannotRun,
  declarationsOf,
  renamesOf,
  wholeFiles,
} from "./pure-move-declarations.mjs";
import { bindingDifferences } from "./pure-move-bindings.mjs";

export const RESIDUAL =
  "Git's move detection is heuristic: a moved block below its size threshold (20 alphanumeric characters) reads as added and removed. Read such a failure; it is not overridden.";

/**
 * The check of the change from the merge base of `base` and `HEAD`: `{ mergeBase, unadmitted, declared, stale, refused,
 * covered, wholes, unparsed, irregular, bindings, renames, counts }`.
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
  const entries = declare === null ? [] : declarationsOf(declare);
  const declarations = entries.filter((d) => d.whole !== true);
  const renameMap = renames === null ? null : renamesOf(renames);
  const wholes = wholeFiles(
    entries.filter((d) => d.whole === true),
    files,
    renameMap,
  );
  const lineDeclarations = boundDeclarations(declarations, mergeBase, cwd);
  const { verdicts, moved } = verdictsOf(
    mergeBase,
    "HEAD",
    files.filter((change) => !wholes.some((w) => w.file === change.file)),
    { cwd, declaredFor: lineDeclarations.declaredFor },
  );
  const counts = {
    movedAdded: moved.added,
    movedRemoved: moved.removed,
    declared: 0,
    unadmitted: 0,
    whole: wholes.length,
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
  const bindings = bindingDifferences(mergeBase, "HEAD", files, renameMap, git);
  // each refusal a declaration covers is printed with the refusal reason it covers
  const refused = [];
  const covered = [];
  for (const refusal of bindings.refusals) {
    const cover = lineDeclarations.cover(refusal);
    if (cover === null) refused.push(refusal);
    else {
      if (cover.taken) counts.declared += 1;
      covered.push({ ...refusal, declared: cover.reason });
    }
  }
  const [kept, notJudged] = unchangedDynamicImports(refused, files, wholes);
  counts.refused = kept.length;
  counts.notJudged = notJudged.length;
  const stale = lineDeclarations.stale();
  return {
    mergeBase,
    unadmitted,
    declared,
    stale,
    refused: kept,
    covered,
    notJudged,
    wholes,
    unparsed,
    irregular,
    bindings,
    renames: renames !== null,
    counts,
  };
}

/**
 * The undeclared `refused` (each `{ side, file, line, text, dynamic }`) kept, and those not judged: a line whose every
 * reference is a dynamic `import(…)`, neither added nor removed, refused on both sides of a file the change edits at one
 * path (`files`, the change's) and does not declare whole (`wholes`); one per such line, its line at HEAD.
 */
function unchangedDynamicImports(refused, files, wholes) {
  const changed = new Map();
  for (const change of files)
    if (
      change.old !== null &&
      change.old === change.file &&
      !wholes.some((w) => w.file === change.file)
    )
      changed.set(change.file, {
        removed: new Set(change.removedLines.map((row) => row.line)),
        added: new Set(change.addedLines.map((row) => row.line)),
      });
  const unchanged = (refusal) =>
    refusal.dynamic &&
    changed.has(refusal.file) &&
    !changed.get(refusal.file)[refusal.side].has(refusal.line);
  // (an added side's line pairs with a removed side's of its file and text, each once: a line the change left as it was,
  // and a dynamic import on both sides; an unpaired one stays refused, as one whose other side the change made no
  // reference, inside a template literal)
  const removed = refused.filter((refusal) => refusal.side === "removed" && unchanged(refusal));
  const paired = new Set();
  for (const refusal of refused) {
    if (refusal.side !== "added" || !unchanged(refusal)) continue;
    const other = removed.find(
      (one) => !paired.has(one) && one.file === refusal.file && one.text === refusal.text,
    );
    if (other === undefined) continue;
    paired.add(other);
    paired.add(refusal);
  }
  return [
    refused.filter((refusal) => !paired.has(refusal)),
    refused.filter((refusal) => paired.has(refusal) && refusal.side === "added"),
  ];
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
    notJudged,
    wholes,
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
  for (const n of notJudged)
    out.push(`  not judged: unchanged dynamic import, ${n.file}:${n.line}`);
  for (const w of wholes)
    out.push(`  not judged (declared whole): ${w.file} (+${w.added} -${w.removed}): ${w.reason}`);
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
    `shape: moved +${counts.movedAdded} -${counts.movedRemoved}; admitted ${FORMS.map((form) => `${form} ${counts[form]}`).join(", ")}; declared ${counts.declared}; unadmitted ${counts.unadmitted}; bindings differing ${bindings.differing.length}; refused ${counts.refused}; declared whole ${counts.whole}${counts.notJudged > 0 ? `; not judged ${counts.notJudged}` : ""}`,
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
      "usage: node tools/moves/pure-move-check.mjs BASE [--declare FILE] [--renames FILE] [PATH…]",
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
