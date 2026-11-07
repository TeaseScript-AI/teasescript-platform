#!/usr/bin/env node
// Counts what the coordinator's structure check compares over time (docs/ORCHESTRATION.md, "Structure and friction"):
// lint disables, `@ts-` directives, skipped and todo tests, the entries of the shrink-only lists, and the structure
// signals of tools/structure-report.mjs. Read-only; it needs no build.
//
//   node tools/counters.mjs [ROOT] [--json]
//
// ROOT, by default the current directory, is the top folder of a Git checkout. Its working tree is read: for the
// directives and tests only the files Git tracks, as structure-report reads them.
//
// - Directives are comments in code files (.ts .tsx .mts .cts .js .jsx .mjs .cjs, and the <script> blocks of .vue
//   files), found with TypeScript's parser, so text in a string, template literal, regular expression or JSX text is
//   never a comment. A lint disable is a comment whose text after `//` or `/*` and any spaces begins with the word
//   `oxlint-disable` or `eslint-disable`, bare or with `-line` or `-next-line`. A `@ts-` directive is one whose text
//   after `//`, `///` or `/*`, any further `*`, and any spaces begins with `@ts-expect-error` or `@ts-ignore`. Each
//   comment counts once.
// - Skipped and todo tests are node:test sites, in three forms: a call `test.skip(…)` (or `it`, `describe`, `suite`);
//   a `skip` property whose value is not `false` in an object literal passed to a call of one of those four names or a
//   member of one, such as `test.only`; and `.skip(…)` on a test's context, the first parameter of a function passed to
//   such a call. Todo is the same with `todo`. Not counted: an aliased import of `test`, and a context's subtests.
// - The lists count their entries: the `files` of every `.oxlintrc.json` override, the items of
//   tools/oxlint/comment-forecasts-allowed.json, comment-declarations-waiting.json and comment-external-names.json
//   (a list that may grow), and the sum of the counts in comment-citations.json. A list whose file does not exist is
//   null, printed "absent".
// - The structure signals are this checkout's tools/structure-report.mjs run in ROOT, so one definition measures any
//   ROOT: its counts of large files, broad folders and long functions, and the largest file and longest function.
//
// --json prints {root, commit, counters, sites}: `commit` is ROOT's HEAD (null before the first commit), `counters`
// the values above, and `sites` the `file:line` of every directive and test site.
// Exit status: 0 when printed, 2 when it cannot run: ROOT is no checkout's top folder, a list file is not JSON of the
// shape named above, or structure-report fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/u;
const LINT_DISABLE = /^(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])/u;
const TS_DIRECTIVE = /^(?:\/\/\/?|\/\*[*/]*)\s*@ts-(?:expect-error|ignore)/u;
const TEST_NAMES = new Set(["test", "it", "describe", "suite"]);
const LISTS = {
  forecastsAllowed: "tools/oxlint/comment-forecasts-allowed.json",
  declarationsWaiting: "tools/oxlint/comment-declarations-waiting.json",
  externalNames: "tools/oxlint/comment-external-names.json",
};
const CITATIONS = "tools/oxlint/comment-citations.json";

class CannotRun extends Error {}

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

/** The directive a comment's text is, or null. */
function directiveOf(comment) {
  if (LINT_DISABLE.test(comment)) return "lintDisables";
  if (TS_DIRECTIVE.test(comment)) return "tsDirectives";
  return null;
}

/** Every comment range of a parsed file: the leading and trailing ranges at each token's full start. */
function commentRanges(source) {
  const ranges = new Map();
  const jsxText = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxText.push(node);
      return;
    }
    for (const range of [
      ...(ts.getLeadingCommentRanges(source.text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source.text, node.pos) ?? []),
    ])
      ranges.set(range.pos, range);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  // A range scanned from a token's end into the JSX text after it is that text, not a comment.
  return [...ranges.values()].filter((r) => !jsxText.some((t) => r.pos >= t.pos && r.pos < t.end));
}

/** The test-site kinds ("skip", "todo") a call is, given the test-context names in scope. */
function testSiteKinds(call, contexts) {
  const kinds = [];
  const callee = call.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "skip" || callee.name.text === "todo") &&
    ts.isIdentifier(callee.expression) &&
    (TEST_NAMES.has(callee.expression.text) || contexts.includes(callee.expression.text))
  )
    kinds.push(callee.name.text);
  if (isTestCall(call))
    for (const argument of call.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const property of argument.properties) {
        const name =
          property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : null;
        if (name !== "skip" && name !== "todo") continue;
        if (
          ts.isPropertyAssignment(property) &&
          property.initializer.kind === ts.SyntaxKind.FalseKeyword
        )
          continue;
        kinds.push(name);
      }
    }
  return kinds;
}

/** A call of `test`, `it`, `describe` or `suite`, or of a member of one (`test.only`). */
function isTestCall(call) {
  const callee = call.expression;
  const base = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  return ts.isIdentifier(base) && TEST_NAMES.has(base.text);
}

/** The test-context names a test call brings into scope: each function argument's first parameter. */
function contextsOf(call) {
  if (!isTestCall(call)) return [];
  return call.arguments
    .filter((a) => ts.isFunctionLike(a) && a.parameters[0] && ts.isIdentifier(a.parameters[0].name))
    .map((a) => a.parameters[0].name.text);
}

/** The parsed pieces of a code file: the whole file, or each <script> block of a .vue file with its first line. */
function piecesOf(file, text) {
  if (!file.endsWith(".vue")) return [{ name: file, text, line: 0 }];
  return [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)].map((m) => {
    const lang = /\blang\s*=\s*["']([a-z]+)["']/u.exec(m[1])?.[1] ?? "js";
    const start = m.index + m[0].indexOf(">") + 1;
    return {
      name: `${file}.${lang}`,
      text: m[2],
      line: text.slice(0, start).split("\n").length - 1,
    };
  });
}

function directivesAndTests(root) {
  const listed = git(root, ["ls-files", "-z"]);
  if (listed.status !== 0)
    throw new CannotRun(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  const files = listed.stdout.split("\0").filter((f) => CODE.test(f));
  const sites = { lintDisables: [], tsDirectives: [], skippedTests: [], todoTests: [] };
  for (const file of files) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue; // tracked but deleted in the working tree
    for (const piece of piecesOf(file, readFileSync(full, "utf8"))) {
      const source = ts.createSourceFile(piece.name, piece.text, ts.ScriptTarget.Latest, true);
      const at = (pos) =>
        `${file}:${source.getLineAndCharacterOfPosition(pos).line + 1 + piece.line}`;
      for (const range of commentRanges(source)) {
        const kind = directiveOf(piece.text.slice(range.pos, range.end));
        if (kind) sites[kind].push(at(range.pos));
      }
      const contexts = [];
      const visit = (node) => {
        let added = 0;
        if (ts.isCallExpression(node)) {
          for (const kind of testSiteKinds(node, contexts))
            sites[kind === "skip" ? "skippedTests" : "todoTests"].push(at(node.getStart(source)));
          const own = contextsOf(node);
          contexts.push(...own);
          added = own.length;
        }
        ts.forEachChild(node, visit);
        contexts.length -= added;
      };
      visit(source);
    }
  }
  return sites;
}

function readJson(root, file) {
  const full = path.join(root, file);
  if (!existsSync(full)) return undefined;
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new CannotRun(`${file} is not JSON: ${error.message}`);
  }
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const shape = (file, ok, expected) => {
  if (!ok) throw new CannotRun(`${file} is not ${expected}`);
};

function lists(root) {
  const counts = {};
  const config = readJson(root, ".oxlintrc.json");
  if (config === undefined) counts.oxlintOverrideFiles = null;
  else {
    const overrides = isObject(config) ? (config.overrides ?? []) : null;
    shape(".oxlintrc.json", Array.isArray(overrides), "an object whose `overrides` is an array");
    counts.oxlintOverrideFiles = 0;
    for (const override of overrides) {
      const files = override?.files ?? [];
      shape(
        ".oxlintrc.json",
        isObject(override) && Array.isArray(files),
        "overrides with `files` arrays",
      );
      counts.oxlintOverrideFiles += files.length;
    }
  }
  for (const [key, file] of Object.entries(LISTS)) {
    const list = readJson(root, file);
    if (list !== undefined) shape(file, Array.isArray(list), "an array");
    counts[key] = list === undefined ? null : list.length;
  }
  const citations = readJson(root, CITATIONS);
  if (citations === undefined) counts.citations = null;
  else {
    const perFile = isObject(citations) ? Object.values(citations) : [];
    const counted = perFile.flatMap((c) => (isObject(c) ? Object.values(c) : [NaN]));
    shape(
      CITATIONS,
      isObject(citations) && counted.every((n) => Number.isInteger(n) && n >= 0),
      "an object of files, each an object of citations to counts",
    );
    counts.citations = counted.reduce((a, b) => a + b, 0);
  }
  return counts;
}

function structure(root) {
  const report = fileURLToPath(new URL("./structure-report.mjs", import.meta.url));
  const folder = mkdtempSync(path.join(tmpdir(), "counters-"));
  const remove = () => rmSync(folder, { recursive: true, force: true });
  const stop = (signal) => {
    remove();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  };
  process.once("SIGINT", stop).once("SIGTERM", stop);
  try {
    const out = path.join(folder, "structure.json");
    const run = spawnSync(process.execPath, [report, "--json", out], {
      cwd: root,
      encoding: "utf8",
    });
    if (run.status !== 0)
      throw new CannotRun(`structure-report failed in ${root}: ${run.stderr.trim()}`);
    const r = JSON.parse(readFileSync(out, "utf8"));
    const largest = r.largeFiles[0];
    const longest = r.longFunctions[0];
    return {
      signals: r.signals,
      counters: {
        largeFiles: r.largeFiles.length,
        broadFolders: r.broadFolders.length,
        longFunctions: r.longFunctions.length,
        largestFile: largest ? { file: largest.file, lines: largest.lines } : null,
        longestFunction: longest
          ? { file: longest.file, name: longest.name, lines: longest.lines }
          : null,
      },
    };
  } finally {
    process.off("SIGINT", stop).off("SIGTERM", stop);
    remove();
  }
}

function checkoutTop(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root))
    throw new CannotRun(`${root} is not the top folder of a Git checkout`);
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.status === 0 ? head.stdout.trim() : null;
}

function main(argv) {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  if (rest.length > 1 || rest.some((a) => a.startsWith("-")))
    throw new CannotRun("usage: node tools/counters.mjs [ROOT] [--json]");
  const root = path.resolve(rest[0] ?? ".");
  if (!existsSync(root)) throw new CannotRun(`${root} does not exist`);
  const commit = checkoutTop(root);
  const sites = directivesAndTests(root);
  const listCounts = lists(root);
  const { signals, counters: structureCounts } = structure(root);
  const counters = {
    ...Object.fromEntries(Object.entries(sites).map(([key, list]) => [key, list.length])),
    ...listCounts,
    ...structureCounts,
  };
  if (json) {
    console.log(JSON.stringify({ root, commit, counters, sites }, null, 2));
    return;
  }
  const value = (n) => (n === null ? "absent" : String(n));
  const c = counters;
  console.log(`Counters of ${root} at ${commit ?? "no commit"}`);
  console.log(`Lint disables: ${c.lintDisables}`);
  console.log(`@ts-expect-error and @ts-ignore: ${c.tsDirectives}`);
  console.log(`Skipped tests: ${c.skippedTests}`);
  console.log(`Todo tests: ${c.todoTests}`);
  console.log(`.oxlintrc.json override files: ${value(c.oxlintOverrideFiles)}`);
  console.log(`Comment forecasts allowed: ${value(c.forecastsAllowed)}`);
  console.log(`Comment citations: ${value(c.citations)}`);
  console.log(`Comment declarations waiting: ${value(c.declarationsWaiting)}`);
  console.log(`Comment external names (may grow): ${value(c.externalNames)}`);
  console.log(`Files over ${signals.fileLines} lines: ${c.largeFiles}`);
  console.log(`Folders over ${signals.folderFiles} files: ${c.broadFolders}`);
  console.log(`Functions over ${signals.functionLines} lines: ${c.longFunctions}`);
  const { largestFile: f, longestFunction: fn } = c;
  console.log(
    `Largest file: ${f ? `${f.lines} lines, ${f.file}` : `none over ${signals.fileLines} lines`}`,
  );
  console.log(
    `Longest function: ${fn ? `${fn.lines} lines, ${fn.name} in ${fn.file}` : `none over ${signals.functionLines} lines`}`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof CannotRun)) throw error;
  console.error(`counters: ${error.message}`);
  process.exitCode = 2;
}
