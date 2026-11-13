// Whether a committed tree still names a moved file by its old location: the lines of HEAD's tracked text files that
// name an old path of a rename map, in five string forms that a move's other proofs do not read (`git diff -M`,
// `pure-move-check.mjs`, tsc, `check:imports`, knip and equal test names see imports and moved lines, not a path that
// code composes or writes in another syntax). It is pure-move-check.mjs's complement: that one judges the lines a move
// writes, this one what the tree still says. The forms:
//   1. root path: the old repository path, with its `.js` and `dist/` forms, or without its extension;
//   2. bare quoted name: a moved file's name alone between quotes in code (`"x.ts"`); the name without its extension
//      (`"x"`), mostly a word that is no path, prints last, as 2b;
//   3. renamed name: the old name of a file whose name changes, anywhere, prose included;
//   4. name after a slash: in a string, URL or regex, plain or regex-escaped, when its last folder and name no longer
//      name a tracked file or folder;
//   5. regex alternation: a moved name inside a group after a slash, checked as in form 4.
// Forms 1, 4 and 5 are findings; 2 and 3 are candidates for a reader. Not stale: a reference naming a tracked file
// without its extension, or a tracked folder (the one a split's files went into), and an import or export specifier
// in forms 4 and 5, which the typecheck resolves. The residuals: a name built at runtime from parts names no moved file
// as text, so no form sees it; and the map is Git's, `git diff -M` at its default similarity of 50 %, so a moved file
// edited past that reads as a deletion and an addition and is missing from a derived map (pass it with --renames).
//
//   node tools/move-sweep.mjs [BASE] [--renames FILE] [--splits FILE] [--declare FILE] [--forms 1,2,3,4,5]
//
// The map: by default each rename of `git diff -z -M --name-status` from `git merge-base BASE HEAD` to `HEAD`, old path
// to new path. --splits FILE merges in a JSON `{"renames": {old: [new, …]}}` for a split, one old path into several,
// which Git does not report as a rename; --renames FILE replaces the whole map (and BASE is then not needed). A hit
// counts as rewritten when it names any of an old path's new paths: an old path that is also one of its own new paths
// (a split that keeps the original file) is not stale in form 1, forms 4 and 5 skip a name when every old path with it
// is kept so (those files still have it, whatever folder a string puts before it), and form 3 lists an old name only
// when none of its new files keeps that name.
//
// The tree is HEAD's committed tree (commit first): its tracked regular files with a text extension, outside
// `node_modules/` and `dist/`, read as UTF-8 with a byte-order mark kept as a character (a file that is not UTF-8 is
// not read, and is listed), each line ended by `\n`, `\r\n` or `\r`. The forms are those of the reference sweep this
// tool replaces (the notes' `shared/move-sweep/move-sweep.py`), which ran in Python, and its text semantics are written
// out so that the two agree by construction:
//   - a word character is a Unicode letter, digit or underscore, `[\p{L}\p{N}_]`: Python's `\w` for text, exactly, for
//     every character Unicode 15.1 assigns (Python 3.13's database; a character a later Unicode adds counts here too),
//     and each of its word boundaries is the same class's lookaround;
//   - whitespace is Python's (str.isspace, its `\s`): `\t` to `\r`, U+001C to U+0020, U+0085, U+00A0, U+1680, U+2000
//     to U+200A, U+2028, U+2029, U+202F, U+205F and U+3000, which neither JavaScript's `\s` nor `trim` is (they take
//     U+FEFF and leave U+001C to U+001F and U+0085); a hit's line is trimmed of it, as Python's `strip`;
//   - any character but `\n` matches where Python's `.` does (`[^\n]`, also U+2028 and U+2029).
// It differs from the Python sweep on purpose in five inputs, each tested:
//   - an empty map (no move): nothing is moved, so no form applies (the Python's forms 2, 4 and 5 then match an empty
//     name, `"/.ts"`);
//   - an old path whose list of new paths is empty, a split to nothing: a malformed map, refused (exit 2); the Python
//     kept such a path, with no new path, and swept it, which its loop did by accident rather than by rule;
//   - a file name Git quotes (one with a non-ASCII character, a tab, a quote or a backslash): read here as it is,
//     through NUL-separated names; the Python read `git ls-files`' quoted names, could not open such a file and
//     skipped it;
//   - a symbolic link: its committed blob is its target's path, so it is not read as a text file; the Python opened the
//     file it pointed to. A tracked target is read under its own path, so that changes no hit;
//   - a tracked link to an untracked target: the target is not read, where the Python read through the link and could
//     report a stale reference in it. A file outside the committed tree is outside what the sweep claims.
// Beside them it prints what the Python left silent: the tracked files neither reads because they are not UTF-8 (a
// binary or a fixture in another encoding), so that a sweep's "nothing found" says which files it read. That is an
// output difference, not a hit difference.
//
// --declare FILE: a JSON array of `{ "file", "text", "reason" }`, a hit of form 1, 4 or 5 the reader states is not
// stale (a test fixture's invented path), printed with its reason. `text` is the hit's whole line as `pure-move-check`
// reads it (without its LF, a CR before that kept), so a rebase that moves the line leaves it declared; one declaration
// covers one line, two lines of one text need two, taken in the file's order, and every declaration must match such a
// hit. An entry with `line` (the old form) or `side` (`pure-move-check`'s field) cannot run, and a line that a lone CR
// ends or follows cannot be declared (`pure-move-check` does not end a line there).
//
// Output: each form's section, `== <form>. <title>: <count>` and its hits, `<file>:<line>: <the line, trimmed, its
// first 150 characters>`, in the order 1, 2, 3, 4, 5, then 2b; then the declared hits; last, only when there is one,
// the files not read, `== not read, not UTF-8: <count> files` and their paths, which leave the exit status as it is.
//
// Exit status: 0 when forms 1, 4 and 5 find nothing undeclared (forms 2 and 3 are listed, never failing); 1 when one
// does; 2 when it cannot run: `--help`, an unknown or valueless option, or no BASE and no --renames (each with the
// usage), a map or declaration file that cannot be read, is not UTF-8 or has the wrong shape, a declaration that
// matches no hit, or a file name Git reports that is not UTF-8.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const USAGE =
  "usage: node tools/move-sweep.mjs [BASE] [--renames FILE] [--splits FILE] [--declare FILE] [--forms 1,2,3,4,5]";

/** A run that cannot go on: its message and exit status 2. */
export class SweepError extends Error {}
const refuse = (message) => {
  throw new SweepError(message);
};

const WORD = String.raw`\p{L}\p{N}_`;
// Python's whitespace (str.isspace, its `\s` for text), and its `strip`.
const SPACE = String.raw`[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;
const STRIP_SPACE = new RegExp(String.raw`^${SPACE}+|${SPACE}+$`, "gu");
const notWordBefore = String.raw`(?<![${WORD}])`;
const notWordAfter = String.raw`(?![${WORD}])`;
const TEXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|vue|json|ya?ml|html|md|css)$/u;
const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|vue|json)$/u;
const STRIP = /\.(ts|js|vue|mjs|mts|cjs)$/u;
const EXT = String.raw`(?:\\\.|\.)(?:ts|js|vue|mjs|mts|cjs)${notWordAfter}`;
const SEP = String.raw`(?:\\/|/)`;
// A quote, a backtick, or one of them or `$` where a string or regex ends right after a name.
const QUOTE = "[\"'`]";
const QUOTE_OR_END = "[\"'`$]";
const END = String.raw`(?:${EXT}|(?=${QUOTE_OR_END}))`;
const SPECIFIER = new RegExp(
  String.raw`^${SPACE}*(${notWordBefore}import${notWordAfter}|${notWordBefore}export${notWordAfter}[^\n]*${notWordBefore}from${notWordAfter}|\}${SPACE}*from${notWordAfter}|${notWordBefore}from${notWordAfter})|${notWordBefore}import\(|${notWordBefore}require\(`,
  "u",
);
const PATH = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-");
const TITLES = {
  1: "root path",
  2: "bare quoted name (classify)",
  3: "renamed name (classify)",
  4: "name after a slash",
  5: "regex alternation",
  "2b": "bare names without extension, mostly words",
};

// The characters a `u` pattern lets one escape outside a class: its syntax characters and `/` (not `-`, which paths
// hold).
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
const byLengthDown = (a, b) => b.length - a.length;
const stem = (file) => file.split("/").at(-1).replace(STRIP, "");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/**
 * `bytes` as UTF-8 text, a byte-order mark kept as a character, or null when they are not UTF-8: the one decoding of
 * every byte the tool reads, never a replacement character. Each caller states what null means for its input.
 */
function textOf(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Git's output as bytes, from the repository at `cwd`. */
const gitBytes = (cwd, args, input) =>
  execFileSync("git", args, { cwd, input, maxBuffer: 1024 * 1024 * 1024 });
/** NUL-separated names, each checked to be UTF-8. */
function namesOf(bytes) {
  const names = [];
  let start = 0;
  for (let at = bytes.indexOf(0); at !== -1; start = at + 1, at = bytes.indexOf(0, start)) {
    names.push(textOf(bytes.subarray(start, at)) ?? refuse("a file name Git reports is not UTF-8"));
  }
  return names;
}

/** The renames of the change from `git merge-base base HEAD` to HEAD: each old path to its one new path. */
export function derivedRenames(cwd, base) {
  const mergeBase = (
    textOf(gitBytes(cwd, ["merge-base", base, "HEAD"])) ??
    refuse("git merge-base printed bytes that are not UTF-8")
  ).trim();
  const fields = namesOf(
    gitBytes(cwd, ["diff", "-z", "-M", "--name-status", "--no-ext-diff", mergeBase, "HEAD"]),
  );
  // No prototype, so a path named `__proto__` is a key like any other.
  const renames = Object.create(null);
  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    if (status.startsWith("R")) {
      renames[fields[i + 1]] = [fields[i + 2]];
      i += 3;
    } else i += status.startsWith("C") ? 3 : 2;
  }
  return renames;
}

/** The JSON of one of the tool's own input files; one that cannot be read, is not UTF-8 or is not JSON cannot run. */
function jsonFile(file, what) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    refuse(`cannot read the ${what} ${file}: ${error.message}`);
  }
  const text = textOf(bytes) ?? refuse(`cannot read the ${what} ${file}: it is not UTF-8`);
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse(`cannot read the ${what} ${file}: ${error.message}`);
  }
}

/** A map file's renames, each old path to its list of new paths. */
function renamesFile(file) {
  const parsed = jsonFile(file, "map");
  if (
    typeof parsed?.renames !== "object" ||
    parsed.renames === null ||
    Array.isArray(parsed.renames)
  )
    refuse(`the map ${file} has no "renames" object`);
  // No prototype, so a path named `__proto__` is a key like any other.
  const renames = Object.create(null);
  for (const [old, next] of Object.entries(parsed.renames)) {
    const list = Array.isArray(next) ? next : [next];
    if (list.length === 0 || !list.every((item) => typeof item === "string"))
      refuse(`the map ${file} gives ${old} no new path`);
    renames[old] = list;
  }
  return renames;
}

/** HEAD's tracked text files, each with its lines, in Git's order, and those not read because they are not UTF-8. */
function treeOf(cwd) {
  const entries = namesOf(gitBytes(cwd, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]));
  const files = [];
  const tracked = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    tracked.push(file);
    if (
      type === "blob" &&
      (mode === "100644" || mode === "100755") &&
      TEXT.test(file) &&
      !file.startsWith("node_modules/") &&
      !file.startsWith("dist/")
    )
      files.push({ file, object });
  }
  const contents = gitBytes(
    cwd,
    ["cat-file", "--batch"],
    files.map((f) => f.object).join("\n") + "\n",
  );
  let at = 0;
  for (const entry of files) {
    const headerEnd = contents.indexOf(10, at);
    const header =
      textOf(contents.subarray(at, headerEnd)) ??
      refuse("git cat-file printed a header that is not UTF-8");
    const size = Number(header.split(" ")[2]);
    const body = contents.subarray(headerEnd + 1, headerEnd + 1 + size);
    at = headerEnd + 1 + size + 1;
    // Not UTF-8 (a binary, a fixture in another encoding): not read, as the Python did not, and listed, as it was not.
    const text = textOf(body);
    const parts = text?.split(/(\r\n|\r|\n)/u) ?? [];
    entry.lines = text === null ? null : parts.filter((_, i) => i % 2 === 0);
    // (each line's end, kept only for a file with a CR: a declaration's text keeps a CR before an LF)
    entry.ends = text?.includes("\r") ? parts.filter((_, i) => i % 2 === 1) : null;
  }
  return {
    tracked,
    files: files.filter((f) => f.lines !== null),
    notRead: files.filter((f) => f.lines === null).map((f) => f.file),
  };
}

/** The path text before the separator at `slash`, with regex escaping undone (`\/` read as `/`). */
function pathBefore(line, slash) {
  let start = slash;
  while (
    start > 0 &&
    (PATH.has(line[start - 1]) || line[start - 1] === "/" || line[start - 1] === "\\")
  )
    start -= 1;
  return line
    .slice(start, slash)
    .replaceAll("\\/", "/")
    .replaceAll("\\.", ".")
    .replace(/\\+$/u, "");
}

/**
 * The hits of every form in `forms` over HEAD's tree at `cwd`, for `renames` (each old path to its new paths), and the
 * files not read.
 */
export function sweep(cwd, renames, forms = new Set(["1", "2", "3", "4", "5"])) {
  const { tracked, files, notRead } = treeOf(cwd);
  const moved = new Set(Object.keys(renames).map(stem));
  const names = [...moved].map(escape).sort(byLengthDown).join("|");
  // (forms 4 and 5: the names of old paths that leave; a name whose every old path stays among its own new paths still
  // names those files wherever a string puts it, and one old path that leaves keeps the name in)
  const left = new Set(
    Object.entries(renames)
      .filter(([old, next]) => !next.includes(old))
      .map(([old]) => stem(old)),
  );
  const leftNames = [...left].map(escape).sort(byLengthDown).join("|");
  const present = new Set(
    tracked.map((f) => `${f.includes("/") ? f.split("/").at(-2) : ""}\0${stem(f)}`),
  );
  const stems = new Set(tracked.map((f) => f.replace(STRIP, "")));
  const folders = new Set();
  for (const f of tracked) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  for (const d of folders)
    present.add(`${d.includes("/") ? d.split("/").at(-2) : ""}\0${d.split("/").at(-1)}`);
  const resolvable = new Set([...stems, ...folders]);

  const roots = [];
  for (const [old, next] of Object.entries(renames)) {
    if (next.includes(old)) continue;
    roots.push(old);
    if (old.endsWith(".ts")) roots.push(`${old.slice(0, -3)}.js`, `dist/${old.slice(0, -3)}.js`);
  }
  const rootSet = new Set(roots);
  const bareRoots = [...new Set(roots.map((r) => r.replace(STRIP, "")))]
    .filter((r) => !rootSet.has(r))
    .sort(byLengthDown);
  const alternation = (list) => list.map(escape).join("|");
  const form1 =
    roots.length > 0
      ? new RegExp(
          String.raw`(?<![${WORD}.\-])(${alternation([...roots].sort(byLengthDown))})(?![${WORD}\-])`,
          "u",
        )
      : null;
  const form1Bare =
    bareRoots.length > 0
      ? new RegExp(
          String.raw`(?<![${WORD}.\-])(${alternation(bareRoots)})(?![${WORD}\-/.\\])`,
          "gu",
        )
      : null;
  const form2 = names ? new RegExp(String.raw`${QUOTE}(?:${names})${EXT}${QUOTE}`, "u") : null;
  const form2Bare = names ? new RegExp(String.raw`${QUOTE}(?:${names})${QUOTE}`, "u") : null;
  const renamedNames = [
    ...new Set(
      Object.entries(renames)
        .filter(([old, next]) => !next.map(stem).includes(stem(old)))
        .map(([old]) => stem(old)),
    ),
  ].sort(byLengthDown);
  const form3 =
    renamedNames.length > 0
      ? new RegExp(String.raw`(?<![${WORD}\-])(${alternation(renamedNames)})${EXT}`, "u")
      : null;
  const form4 = leftNames ? new RegExp(String.raw`${SEP}(?<name>${leftNames})${END}`, "gu") : null;
  const form5 = leftNames
    ? new RegExp(
        String.raw`${SEP}\((?<group>(?:[${WORD}-]+\|)*(?:${leftNames})(?:\|[${WORD}-]+)*)\)${END}`,
        "gu",
      )
    : null;

  /** Whether `before/name` names a tracked file: a path starting with `.` is relative to `file`'s folder, or to its
   * compiled copy under `dist/`; any other path is checked by its last folder and the name. */
  const namesAFile = (file, before, name) => {
    if (before.startsWith(".")) {
      for (const base of [path.posix.dirname(file), `dist/${path.posix.dirname(file)}`]) {
        let target = path.posix.normalize(path.posix.join(base, before, name)).replace(/\/+$/u, "");
        if (target === "") target = ".";
        if (
          resolvable.has(target) ||
          resolvable.has(target.startsWith("dist/") ? target.slice(5) : target)
        )
          return true;
      }
      return false;
    }
    return present.has(`${before.split("/").at(-1)}\0${name}`);
  };

  const hits = { 1: [], 2: [], "2b": [], 3: [], 4: [], 5: [] };
  for (const { file, lines, ends } of files) {
    for (const [index, line] of lines.entries()) {
      const number = index + 1;
      const hit = {
        file,
        line: number,
        text: [...line.replace(STRIP_SPACE, "")].slice(0, 150).join(""),
        // (the line as a declaration names it, `null` where a lone CR ends or precedes it)
        whole:
          ends === null
            ? line
            : ends[index] === "\r" || ends[index - 1] === "\r"
              ? null
              : `${line}${ends[index] === "\r\n" ? "\r" : ""}`,
      };
      if (
        forms.has("1") &&
        ((form1 && form1.test(line)) ||
          (form1Bare && [...line.matchAll(form1Bare)].some((m) => !resolvable.has(m[1]))))
      )
        hits[1].push(hit);
      if (forms.has("2") && CODE.test(file) && form2) {
        if (form2.test(line)) hits[2].push(hit);
        else if (form2Bare.test(line)) hits["2b"].push(hit);
      }
      if (forms.has("3") && form3 && form3.test(line)) hits[3].push(hit);
      if (SPECIFIER.test(line)) continue;
      if (forms.has("4") && form4)
        for (const m of line.matchAll(form4))
          if (!namesAFile(file, pathBefore(line, m.index), m.groups.name)) {
            hits[4].push(hit);
            break;
          }
      if (forms.has("5") && form5)
        for (const m of line.matchAll(form5)) {
          const before = pathBefore(line, m.index);
          if (
            m.groups.group
              .split("|")
              .some((name) => left.has(name) && !namesAFile(file, before, name))
          ) {
            hits[5].push(hit);
            break;
          }
        }
    }
  }
  return { hits, notRead };
}

/** The declarations of `file`, each `{ file, text, reason }`. */
function declarationsOf(file) {
  const parsed = jsonFile(file, "declarations");
  if (!Array.isArray(parsed)) refuse(`the declarations ${file} are not an array`);
  for (const d of parsed) {
    const entry = JSON.stringify(d);
    if (
      d !== null &&
      typeof d === "object" &&
      Object.hasOwn(d, "line") &&
      !Object.hasOwn(d, "text")
    )
      refuse(
        `a declaration names its line by "text" now, not "line": { "file", "text", "reason" }, the text the hit's whole line as pure-move-check reads it: ${entry}`,
      );
    if (d !== null && typeof d === "object" && Object.hasOwn(d, "side"))
      refuse(
        `a declaration of the sweep has no "side" (a pure-move-check declaration's field; its declarations are another file): ${entry}`,
      );
    const valid =
      typeof d?.file === "string" &&
      typeof d.text === "string" &&
      !d.text.includes("\n") &&
      typeof d.reason === "string" &&
      d.reason !== "" &&
      Object.keys(d).every((key) => ["file", "text", "reason"].includes(key));
    if (!valid) refuse(`a declaration is not { file, text, reason }: ${entry}`);
  }
  return parsed;
}

/** The command line, read once: each option takes its value as the next argument or after `=`; the rest is BASE. */
function argumentsOf(argv) {
  const options = new Map();
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") refuse(USAGE);
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    if (!["--renames", "--splits", "--declare", "--forms"].includes(name))
      refuse(`unknown option ${name}\n${USAGE}`);
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined || value === "" || (equals < 0 && value.startsWith("-")))
      refuse(`${name} takes a value\n${USAGE}`);
    if (options.has(name)) refuse(`${name} is given twice\n${USAGE}`);
    options.set(name, value);
  }
  if (rest.length > 1) refuse(`one BASE at most\n${USAGE}`);
  return { base: rest[0], options };
}

/** Runs the sweep for `argv` in `cwd`, printing through `print`; resolves with the exit status. */
export function main(argv, cwd = process.cwd(), print = console.log) {
  const { base, options } = argumentsOf(argv);
  let renames;
  if (options.has("--renames")) renames = renamesFile(options.get("--renames"));
  else if (base === undefined) refuse(`no BASE and no --renames\n${USAGE}`);
  else renames = derivedRenames(cwd, base);
  if (options.has("--splits")) Object.assign(renames, renamesFile(options.get("--splits")));
  const forms = new Set((options.get("--forms") ?? "1,2,3,4,5").split(","));
  for (const form of forms)
    if (!["1", "2", "3", "4", "5"].includes(form)) refuse(`--forms names no form ${form}`);
  const declarations = options.has("--declare") ? declarationsOf(options.get("--declare")) : [];
  const { hits, notRead } = sweep(cwd, renames, forms);

  // (each line once, though more than one form may find it, in each file's order)
  const key = (h) => `${h.file}\0${h.line}`;
  const findings = [
    ...new Map(["1", "4", "5"].flatMap((form) => hits[form]).map((h) => [key(h), h])).values(),
  ].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  // each declaration takes the first line of its file and text that no earlier one took
  const declared = new Map();
  for (const d of declarations) {
    const hit = findings.find(
      (h) => !declared.has(key(h)) && h.file === d.file && h.whole === d.text,
    );
    if (hit === undefined)
      refuse(
        `the declaration ${d.file} ${JSON.stringify(d.text)} matches no hit of form 1, 4 or 5 by its whole line, or none that another declaration did not take`,
      );
    declared.set(key(hit), { ...d, line: hit.line });
  }
  const order = [...forms].sort();
  if (forms.has("2")) order.push("2b");
  for (const form of order) {
    print(`== ${form}. ${TITLES[form]}: ${hits[form].length}`);
    for (const h of hits[form]) print(`${h.file}:${h.line}: ${h.text}`);
  }
  for (const d of declared.values()) print(`declared: ${d.file}:${d.line}: ${d.reason}`);
  if (notRead.length > 0) {
    print(`== not read, not UTF-8: ${notRead.length} files`);
    for (const file of notRead) print(file);
  }
  return findings.some((h) => !declared.has(key(h))) ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof SweepError) && error?.status === undefined) throw error;
    console.error(
      `move-sweep: ${error instanceof SweepError ? error.message : String(error.message ?? error)}`,
    );
    process.exitCode = 2;
  }
}
