// The tracked test files that may reach a module when they run: the test files a move of that module must compare
// (`split-test-compare.mjs --moved`). A reverse closure over the paths the repository's code files name, read as text,
// so it needs no parser and no install in the tree it reads:
//
//   node tools/moves/test-reach.mjs MODULE… [--tree DIR]
//
// MODULE is a tracked file's path from DIR's top folder (default: the current folder's repository). The files are those
// `git ls-files` lists in DIR; a code file is one ending `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or
// `.cjs`. A code file reaches another when one of its quoted strings outside its comments (`stringsOf`) names it: a
// path starting `./` or `../` from the file's folder (a TypeScript file's also from its compiled folder under `dist/`,
// where it runs), any other from the top folder or the file's folder, a leading `dist/` dropped, and an extension read
// as the build maps it (`.js` names a `.ts`, `.tsx`, `.js` or `.jsx` file, `.mjs` a `.mts` or `.mjs`, `.cjs` a `.cts`
// or `.cjs`; none, any of those). A string that is a file name alone with a code extension (`"x.js"`, a piece of a
// joined path) names every tracked code file of that name, wherever it is; and a string ending in a code extension,
// joined to a tracked folder another of the file's strings names (a template's text before its first `${` included),
// names that path. A code file that lists a folder (it calls `readdirSync`, `readdir`, `opendirSync`, `opendir`,
// `globSync` or `glob`, or holds the string `ls-files`) is a generic reader: it reaches every tracked file under each
// tracked folder one of its strings names (`"tests"` in `join(root, "tests")`, as
// `tools/repository-checks/pin-suites.mjs` reads every test file), whether it loads them or reads their text. A test
// file is a code file under `tests/` ending `.test.ts`, or any ending `.test.js`, `.test.mjs` or `.test.cjs`, as
// `split-test-compare.mjs` runs them; a MODULE that is one reaches itself.
//
// What it cannot see: a path built at run time with no quoted piece naming the file by its path or its file name (a
// name computed from data, unless a generic reader lists its folder), a module loaded by a package's name, and a string
// in a comment (which loads nothing). Every other reference only adds test files: a type-only import, a folder listed
// but never read.
//
// Output: `test files reaching: N`, then each test file with one chain of files by which it reaches a MODULE. Exit
// status: 0; 2 when it cannot run (usage, DIR not a Git checkout, a MODULE DIR does not track).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const USAGE = "usage: node tools/moves/test-reach.mjs MODULE… [--tree DIR]";
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const LISTS =
  /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(|["'`]ls-files["'`]/u;
/** The source extensions a built or written extension names. */
const SOURCES = new Map([
  [".js", [".ts", ".tsx", ".js", ".jsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
]);

export class CannotRun extends Error {}

/** Whether `file` is a test file as `split-test-compare.mjs` runs one. */
export const isTestFile = (file) =>
  /^tests\/.+\.test\.ts$/u.test(file) || /\.test\.(?:m?js|cjs)$/u.test(file);

/**
 * The quoted strings of a code file's `text` outside its comments: each `'…'` or `"…"` to its closing quote or the end
 * of its line, each backtick string to its closing backtick, the code of its `${…}` parts read as code, and its text
 * before the first `${` a string of its own. A `/` that starts no comment is code, so a regular expression's quote
 * starts a string, as a quote in a comment does not.
 */
export function stringsOf(text) {
  const out = [];
  // a quoted string from its opening quote at `at`; returns the position after it
  const quoted = (at) => {
    const quote = text[at];
    let value = "";
    let end = at + 1;
    while (end < text.length && text[end] !== quote && text[end] !== "\n") {
      if (text[end] === "\\") end += 1;
      value += text[end] ?? "";
      end += 1;
    }
    out.push(value);
    return end + 1;
  };
  // a backtick string from its backtick at `at`; returns the position after it
  const template = (at) => {
    let value = "";
    let end = at + 1;
    while (end < text.length && text[end] !== "`") {
      if (text[end] === "\\") {
        value += text[end + 1] ?? "";
        end += 2;
      } else if (text[end] === "$" && text[end + 1] === "{") {
        // (the text before the first `${` is a string of its own: a folder a path is built under)
        if (!value.includes("${")) out.push(value);
        value += "${";
        end = code(end + 2, true);
      } else {
        value += text[end];
        end += 1;
      }
    }
    out.push(value);
    return end + 1;
  };
  // code from `at`, to the end or, when `nested`, past the `}` that closes it; returns the position after it
  const code = (at, nested) => {
    let depth = 0;
    while (at < text.length) {
      const char = text[at];
      if (char === "/" && text[at + 1] === "/") {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end;
      } else if (char === "/" && text[at + 1] === "*") {
        const end = text.indexOf("*/", at + 2);
        at = end === -1 ? text.length : end + 2;
      } else if (char === '"' || char === "'") at = quoted(at);
      else if (char === "`") at = template(at);
      else if (nested && char === "}" && depth === 0) return at + 1;
      else {
        if (nested && char === "{") depth += 1;
        if (nested && char === "}") depth -= 1;
        at += 1;
      }
    }
    return at;
  };
  code(0, false);
  return out;
}

/** The repository paths a string `text` in `file` may name, before they are checked against the tracked files. */
function namedBy(file, text) {
  if (!/^[\w.@/-]+$/u.test(text) || !/[\w]/u.test(text)) return [];
  const relative = text.startsWith("./") || text.startsWith("../");
  const from = relative ? [] : [path.posix.normalize(text)];
  // (a TypeScript file runs compiled under `dist/`, so its relative path is also read from there)
  const compiled =
    relative && /\.[cm]?tsx?$/u.test(file)
      ? [path.posix.join("dist", path.posix.dirname(file), text)]
      : [];
  const out = [];
  for (const one of [...from, path.posix.join(path.posix.dirname(file), text), ...compiled]) {
    if (one.startsWith("../") || one.startsWith("/")) continue;
    const bare = one.replace(/^dist\//u, "");
    // (a folder named with its trailing `/` is the folder)
    for (const candidate of new Set([one, bare].map((named) => named.replace(/\/$/u, "")))) {
      out.push(candidate);
      const extension = path.posix.extname(candidate);
      const stem = candidate.slice(0, candidate.length - extension.length);
      for (const source of SOURCES.get(extension) ?? []) out.push(`${stem}${source}`);
      if (extension === "")
        for (const source of [".ts", ".tsx", ".js", ".mjs", ".mts", ".cjs"])
          out.push(`${candidate}${source}`);
    }
  }
  return out;
}

/** The files the Git checkout `tree` tracks. */
export function trackedFiles(tree) {
  let listed;
  try {
    listed = execFileSync("git", ["-C", tree, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new CannotRun(`${tree} is not a Git checkout: its tracked files cannot be listed`);
  }
  return new Set(listed.split("\0").filter((file) => file !== ""));
}

/**
 * The test files that reach `modules` in the Git checkout `tree` (its files `tracked`): a sorted list of `{ test, chain
 * }`, `chain` the files from the test file to a module.
 */
export function testsReaching(tree, modules, tracked = trackedFiles(tree)) {
  for (const module of modules)
    if (!tracked.has(module)) throw new CannotRun(`${tree} does not track ${module}`);
  const folders = new Set();
  for (const file of tracked)
    for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1))
      folders.add(file.slice(0, at));
  // (a file name alone, with a code extension, names every tracked code file of that name: a path joined from pieces)
  const byFileName = new Map();
  for (const file of tracked)
    if (CODE.test(file)) {
      const name = path.posix.basename(file);
      if (!byFileName.has(name)) byFileName.set(name, []);
      byFileName.get(name).push(file);
    }
  const byName = (text) => {
    if (text.includes("/") || !CODE.test(text)) return [];
    const extension = path.posix.extname(text);
    const stem = text.slice(0, text.length - extension.length);
    return [text, ...(SOURCES.get(extension) ?? []).map((source) => `${stem}${source}`)].flatMap(
      (name) => byFileName.get(name) ?? [],
    );
  };
  /** Each file's readers: the code files whose strings name it. */
  const readers = new Map();
  /** Each generic reader's folders. */
  const listers = new Map();
  for (const file of tracked) {
    if (!CODE.test(file)) continue;
    let text;
    try {
      text = readFileSync(path.join(tree, file), "utf8");
    } catch {
      continue;
    }
    const lists = LISTS.test(text);
    const strings = stringsOf(text);
    const reads = (candidate) => {
      if (!readers.has(candidate)) readers.set(candidate, new Set());
      readers.get(candidate).add(file);
    };
    // (the folders the file's strings name, and its strings that end in a code extension: a path joined from the two)
    const named = new Set();
    for (const value of strings)
      for (const candidate of [...namedBy(file, value), ...byName(value)]) {
        if (tracked.has(candidate) && candidate !== file) reads(candidate);
        else if (folders.has(candidate)) {
          named.add(candidate);
          if (lists) {
            if (!listers.has(file)) listers.set(file, new Set());
            listers.get(file).add(candidate);
          }
        }
      }
    for (const folder of named)
      for (const value of strings)
        if (CODE.test(value) && !value.startsWith("."))
          for (const candidate of namedBy(`${folder}/-`, value))
            if (tracked.has(candidate) && candidate !== file) reads(candidate);
  }
  // the reverse closure from the modules, each reached file with the file it reaches next
  const next = new Map(modules.map((module) => [module, null]));
  const queue = [...modules];
  while (queue.length > 0) {
    const file = queue.shift();
    const by = new Set(readers.get(file) ?? []);
    for (const [lister, under] of listers)
      if ([...under].some((folder) => file.startsWith(`${folder}/`))) by.add(lister);
    for (const reader of [...by].sort())
      if (!next.has(reader)) {
        next.set(reader, file);
        queue.push(reader);
      }
  }
  const out = [];
  for (const file of next.keys())
    if (isTestFile(file)) {
      const chain = [file];
      while (next.get(chain.at(-1)) !== null) chain.push(next.get(chain.at(-1)));
      out.push({ test: file, chain });
    }
  return out.sort((one, other) => (one.test < other.test ? -1 : one.test > other.test ? 1 : 0));
}

/** Runs the tool with `argv`; returns the exit status. */
export function main(argv, print = console.log) {
  try {
    const modules = [];
    let tree;
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "--tree" && argv[i + 1] !== undefined) tree = argv[++i];
      else if (argv[i].startsWith("-")) throw new CannotRun(USAGE);
      else modules.push(argv[i]);
    }
    if (modules.length === 0) throw new CannotRun(USAGE);
    if (tree === undefined) {
      try {
        tree = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        throw new CannotRun("the current folder is in no Git checkout: name one with --tree DIR");
      }
    }
    const reached = testsReaching(path.resolve(tree), modules);
    print(`test files reaching: ${reached.length}`);
    for (const { chain } of reached) print(`  ${chain.join(" -> ")}`);
    return 0;
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    console.error(`test-reach: ${error.message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
