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
// - Directives are comments in code files (.ts .tsx .mts .cts .js .jsx .mjs .cjs, and the script blocks that Vue's SFC
//   parser returns for a .vue file), found with TypeScript's parser, so text in a string, template literal, regular
//   expression or JSX text is never a comment. A .vue file the parser reports errors for (a component Vue refuses,
//   kept as a fixture) still counts the blocks it returns, and is named once on stderr; a block Vue refuses adds
//   nothing, and a `src` block's file counts as a file of its own. A lint disable is a comment whose text after `//`
//   or `/*` and any spaces begins with the word `oxlint-disable` or `eslint-disable`, bare or with `-line` or
//   `-next-line`. A `@ts-` directive is one whose text after `//`, `///` or `/*`, any further `*`, and any spaces
//   begins with `@ts-expect-error` or `@ts-ignore`. Each comment counts once. The `@ts-` directives are also counted
//   apart in tests and outside tests: a file is in tests when its path begins `tests/` or its name contains `.test.`.
// - Skipped and todo tests are node:test sites, in three forms: a call `test.skip(…)` (or `it`, `describe`, `suite`);
//   a `skip` property whose value is not `false` in an object literal passed to a call of one of those four names or a
//   member of one, such as `test.only`; and `X.skip(…)` where TypeScript's binder resolves the name X to a test's
//   context: the first parameter of a function passed to such a call as its last argument. So a closer binding of the
//   same name hides the context, as it does when the code runs, and a name with no declaration is no context. Todo is
//   the same with `todo`. Not counted: an aliased import of `test`, and a context's subtests. Each skip is also counted
//   as without a condition, on a condition, or as a platform guard. On a condition: a `skip` option whose value,
//   parentheses removed, is a `?:`, a call, a `!` or a comparison or logical operation (`===` `!==` `==` `!=` `<` `>`
//   `<=` `>=` `&&` `||` `??` `in` `instanceof`); and `X.skip(…)` lying, below its nearest enclosing function, in a
//   branch of an `if` or a `?:`, or the right operand of `&&`, `||` or `??`. Every other skip, `test.skip(…)` among
//   them, is counted as without a condition: a test that never runs. A skip on a condition whose `skip` option is,
//   parentheses removed, a comparison of Node's `process.platform` with a string by `===` `!==` `==` or `!=`, or such
//   comparisons joined by `&&` or `||`, as `skip: process.platform === "win32"`, is a platform guard and counted apart
//   from the others on a condition (#2568): a platform the test cannot run on, not a test switched off. `process` is
//   Node's when the binder finds no other binding of the name in the file, or it is a default or namespace import of
//   `node:process` or `process`. Any other form stays on a condition.
// - The lists count their entries: the `files` of each `.oxlintrc.json` override that is a waiting list (docs/LINTING.md
//   "Waiting lists", by tools/oxlint/check-waiting-overrides.mjs's `isWaitingEntry`), the items of
//   tools/oxlint/comments/comment-forecasts-allowed.json, comment-declarations-waiting.json and
//   comment-external-names.json (a list that may grow), the entries of tools/repository-checks/imports-waiting.json
//   (value cycles and boundary crossings waiting), and the sum of the counts in comment-citations.json; a comments/
//   list not there is read in tools/oxlint/, its earlier place. A list whose file does not exist is null, printed
//   "absent"; an `overrides` or `files` field left out counts 0, and one of another type is malformed.
// - The structure signals are this checkout's tools/structure-report.mjs run in ROOT, so one definition measures any
//   ROOT: its counts of large files, broad folders and long functions, and the largest of the files and the longest of
//   the functions it lists, each null when none passes its threshold. Beside each count, the excess summed over the
//   same list, by structure-report's own thresholds: the lines above the file limit over all large files, the lines
//   above the function limit over all long functions, and the files above the folder limit over all broad folders; 0
//   when the list is empty, so a file shrinking from 2,000 to 1,500 lines lowers its sum by 500. As in the count, a
//   function over the limit inside another is a row of its own, so its lines count in its own excess and again in its
//   holder's. The long functions' count and sum are also given in tests and outside tests, by the `@ts-` rule above.
//
// --json prints {root, commit, counters, sites}: `commit` is ROOT's HEAD (null before the first commit), `counters`
// the values above, and `sites` the `file:line` of every directive and test site, the skips also in their three lists.
// Exit status: 0 when printed, 2 when it cannot run: ROOT is no checkout's top folder, a list file is not JSON of the
// shape named above, or structure-report fails. On SIGINT or SIGTERM it stops
// structure-report, removes its temporary folder and exits 130 or 143.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { parse as parseVue } from "vue/compiler-sfc";

import { isWaitingEntry } from "./oxlint/check-waiting-overrides.mjs";

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/u;
const LINT_DISABLE = /^(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])/u;
const TS_DIRECTIVE = /^(?:\/\/\/?|\/\*\**)\s*@ts-(?:expect-error|ignore)/u;
const TEST_NAMES = new Set(["test", "it", "describe", "suite"]);
const IN_TESTS = /^tests\/|\.test\.[^/]*$/u;
const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const COMPARISONS = new Set([
  ...LOGICAL,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
]);
// Each oxlint list is read in tools/oxlint/comments/, else where it was before that folder (#2633): the worker monitor
// runs this file on runtime-v2's tree, which keeps the old layout until its merge of main carries the move. The second
// path goes when runtime-v2 holds the move.
const commentList = (name) => [`tools/oxlint/comments/${name}`, `tools/oxlint/${name}`];
const LISTS = {
  forecastsAllowed: commentList("comment-forecasts-allowed.json"),
  declarationsWaiting: commentList("comment-declarations-waiting.json"),
  externalNames: commentList("comment-external-names.json"),
  importsWaiting: ["tools/repository-checks/imports-waiting.json"],
};
const CITATIONS = commentList("comment-citations.json");

class CannotRun extends Error {}
class Stopped extends Error {
  constructor(signal) {
    super(signal);
    this.code = 128 + (signal === "SIGINT" ? 2 : 15);
  }
}

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

/** A call of `test`, `it`, `describe` or `suite`, or of a member of one (`test.only`). */
function isTestCall(call) {
  const callee = call.expression;
  const base = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  return ts.isIdentifier(base) && TEST_NAMES.has(base.text);
}

/** Whether a declaration is a test's context: the first parameter of a function that is a test call's last argument. */
function isTestContext(declaration) {
  if (!declaration || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name))
    return false;
  const fn = declaration.parent;
  const call = fn.parent;
  return (
    fn.parameters[0] === declaration &&
    ts.isCallExpression(call) &&
    isTestCall(call) &&
    call.arguments.at(-1) === fn
  );
}

/** Whether a `skip` option's value is a condition: a `?:`, a call, a `!`, or a comparison or logical operation. */
function isCondition(value) {
  const v = ts.skipParentheses(value);
  return (
    ts.isConditionalExpression(v) ||
    ts.isCallExpression(v) ||
    (ts.isPrefixUnaryExpression(v) && v.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(v) && COMPARISONS.has(v.operatorToken.kind))
  );
}

/** Whether a call lies below its nearest function in a branch of an `if` or `?:`, or right of `&&`, `||` or `??`. */
function isBranched(call) {
  for (let node = call; !ts.isFunctionLike(node.parent) && !ts.isSourceFile(node.parent);) {
    const parent = node.parent;
    if (ts.isIfStatement(parent) && parent.expression !== node) return true;
    if (ts.isConditionalExpression(parent) && parent.condition !== node) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === node &&
      LOGICAL.has(parent.operatorToken.kind)
    )
      return true;
    node = parent;
  }
  return false;
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const PROCESS_MODULES = new Set(["process", "node:process"]);

/**
 * Whether `symbol`, what the binder resolves a name `process` to, is Node's `process`: no declaration in the file (the
 * global), or a default or namespace import of `node:process` or `process`. Any other binding of the name is not.
 */
function isNodeProcess(symbol) {
  if (symbol === undefined) return true;
  const declaration = symbol.declarations?.[0];
  const clause =
    declaration && ts.isNamespaceImport(declaration) ? declaration.parent : declaration;
  return (
    clause !== undefined &&
    ts.isImportClause(clause) &&
    !clause.isTypeOnly &&
    ts.isStringLiteral(clause.parent.moduleSpecifier) &&
    PROCESS_MODULES.has(clause.parent.moduleSpecifier.text)
  );
}

/** Whether `node` is `process.platform`, its `process` resolved by `resolve` (an identifier to its symbol). */
const isProcessPlatform = (node, resolve) =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === "platform" &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "process" &&
  isNodeProcess(resolve(node.expression));
const isString = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/**
 * Whether a `skip` option's value is a platform guard: Node's `process.platform` compared with a string, or such joined;
 * `resolve` gives an identifier's symbol.
 */
function isPlatformGuard(value, resolve) {
  const v = ts.skipParentheses(value);
  if (!ts.isBinaryExpression(v)) return false;
  const operator = v.operatorToken.kind;
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken)
    return isPlatformGuard(v.left, resolve) && isPlatformGuard(v.right, resolve);
  const [left, right] = [ts.skipParentheses(v.left), ts.skipParentheses(v.right)];
  return (
    EQUALITY.has(operator) &&
    ((isProcessPlatform(left, resolve) && isString(right)) ||
      (isString(left) && isProcessPlatform(right, resolve)))
  );
}

/** How a `skip` option's value holds the test back: `platform`, `conditional` or `unconditional`. */
function skipKind(value, resolve) {
  if (isPlatformGuard(value, resolve)) return "platform";
  return isCondition(value) ? "conditional" : "unconditional";
}

/** The skip-or-todo options of a test call, as [kind, how]: each `skip` or `todo` property not `false`, `how` as
 * `skipKind` gives it (`unconditional` for a shorthand property). */
function optionKinds(call, resolve) {
  const kinds = [];
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
      kinds.push([
        name,
        ts.isPropertyAssignment(property)
          ? skipKind(property.initializer, resolve)
          : "unconditional",
      ]);
    }
  }
  return kinds;
}

/** The binder of one parsed file alone: no library and no imports, which a test context, a parameter, never needs. */
function checkerOf(source) {
  const host = {
    getSourceFile: (name) => (name === source.fileName ? source : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === source.fileName,
    readFile: () => undefined,
  };
  const options = { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] };
  return ts.createProgram({ rootNames: [source.fileName], options, host }).getTypeChecker();
}

/** The skip and todo sites of a parsed file, each as [kind, the position of its call, how, as `skipKind` gives it]. */
function testSites(source) {
  const sites = [];
  const receivers = []; // [kind, call, name] of each `X.skip(…)` or `X.todo(…)` whose X may be a context
  let checker = null; // made only for a file that needs it
  const resolve = (name) => (checker ??= checkerOf(source)).getSymbolAtLocation(name);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const kind = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if ((kind === "skip" || kind === "todo") && ts.isIdentifier(callee.expression)) {
        if (TEST_NAMES.has(callee.expression.text))
          sites.push([kind, node.getStart(source), "unconditional"]);
        else receivers.push([kind, node, callee.expression]);
      }
      if (isTestCall(node))
        for (const [option, how] of optionKinds(node, resolve))
          sites.push([option, node.getStart(source), how]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (receivers.length > 0) {
    for (const [kind, call, name] of receivers)
      if (isTestContext(resolve(name)?.valueDeclaration))
        sites.push([
          kind,
          call.getStart(source),
          isBranched(call) ? "conditional" : "unconditional",
        ]);
  }
  return sites.sort((a, b) => a[1] - b[1]);
}

/** The parsed pieces of a code file: the whole file, or each script block of a .vue file with the lines before it. */
function piecesOf(file, text) {
  if (!file.endsWith(".vue")) return [{ name: file, text, line: 0 }];
  const { descriptor, errors } = parseVue(text, { filename: file });
  if (errors.length > 0)
    console.error(
      `counters: ${file}: ${String(errors[0].message ?? errors[0])}; counted the script blocks Vue returned`,
    );
  return [descriptor.script, descriptor.scriptSetup]
    .filter(Boolean)
    .map((block) => ({
      name: `${file}.${block.lang ?? "js"}`,
      text: block.content,
      line: block.loc.start.line - 1,
    }));
}

const SKIP_LISTS = {
  unconditional: "skippedTestsUnconditional",
  conditional: "skippedTestsConditional",
  platform: "skippedTestsPlatform",
};

function directivesAndTests(root) {
  const listed = git(root, ["ls-files", "-z"]);
  if (listed.status !== 0)
    throw new CannotRun(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  const files = listed.stdout.split("\0").filter((f) => CODE.test(f));
  const sites = {
    lintDisables: [],
    tsDirectives: [],
    skippedTests: [],
    todoTests: [],
    skippedTestsUnconditional: [],
    skippedTestsConditional: [],
    skippedTestsPlatform: [],
  };
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
      for (const [kind, pos, how] of testSites(source)) {
        if (kind === "todo") sites.todoTests.push(at(pos));
        else {
          sites.skippedTests.push(at(pos));
          sites[SKIP_LISTS[how]].push(at(pos));
        }
      }
    }
  }
  return sites;
}

/** The first of `paths` that exists in `root`, else the first. */
const firstPresent = (root, paths) =>
  paths.find((file) => existsSync(path.join(root, file))) ?? paths[0];

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
    const overrides = !isObject(config)
      ? null
      : config.overrides === undefined
        ? []
        : config.overrides;
    shape(".oxlintrc.json", Array.isArray(overrides), "an object whose `overrides` is an array");
    counts.oxlintOverrideFiles = 0;
    for (const override of overrides) {
      const files = !isObject(override) ? null : override.files === undefined ? [] : override.files;
      shape(".oxlintrc.json", Array.isArray(files), "overrides with `files` arrays");
      if (isWaitingEntry(override)) counts.oxlintOverrideFiles += files.length;
    }
  }
  for (const [key, paths] of Object.entries(LISTS)) {
    const file = firstPresent(root, paths);
    const list = readJson(root, file);
    if (list !== undefined) shape(file, Array.isArray(list), "an array");
    counts[key] = list === undefined ? null : list.length;
  }
  const citationsFile = firstPresent(root, CITATIONS);
  const citations = readJson(root, citationsFile);
  if (citations === undefined) counts.citations = null;
  else {
    const perFile = isObject(citations) ? Object.values(citations) : [];
    const counted = perFile.flatMap((c) => (isObject(c) ? Object.values(c) : [NaN]));
    shape(
      citationsFile,
      isObject(citations) && counted.every((n) => Number.isInteger(n) && n >= 0),
      "an object of files, each an object of citations to counts",
    );
    counts.citations = counted.reduce((a, b) => a + b, 0);
  }
  return counts;
}

/** Runs structure-report in ROOT and reads its JSON from a temporary folder this run owns and always removes. */
async function structure(root) {
  const report = fileURLToPath(new URL("./structure-report.mjs", import.meta.url));
  let child = null;
  let stopped = null;
  // A signal stops the report; the run then ends below once the report has exited, after `finally` cleans up. The
  // handlers come first, so no signal finds the folder without them; they run only once the report is spawned.
  const stop = (signal) => {
    stopped = signal;
    child?.kill(signal);
  };
  process.on("SIGINT", stop).on("SIGTERM", stop);
  const folder = mkdtempSync(path.join(tmpdir(), "counters-"));
  try {
    const out = path.join(folder, "structure.json");
    const run = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [report, "--json", out], {
        cwd: root,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
    });
    if (stopped) throw new Stopped(stopped);
    if (run.status !== 0)
      throw new CannotRun(`structure-report failed in ${root}: ${run.stderr.trim()}`);
    const r = JSON.parse(readFileSync(out, "utf8"));
    const largest = r.largeFiles[0];
    const longest = r.longFunctions[0];
    const excess = (rows, field, limit) => rows.reduce((sum, row) => sum + row[field] - limit, 0);
    const inTests = r.longFunctions.filter((row) => IN_TESTS.test(row.file));
    const outside = r.longFunctions.filter((row) => !IN_TESTS.test(row.file));
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
        largeFilesExcessLines: excess(r.largeFiles, "lines", r.signals.fileLines),
        broadFoldersExcessFiles: excess(r.broadFolders, "files", r.signals.folderFiles),
        longFunctionsExcessLines: excess(r.longFunctions, "lines", r.signals.functionLines),
        longFunctionsOutsideTests: outside.length,
        longFunctionsOutsideTestsExcessLines: excess(outside, "lines", r.signals.functionLines),
        longFunctionsInTests: inTests.length,
        longFunctionsInTestsExcessLines: excess(inTests, "lines", r.signals.functionLines),
      },
    };
  } finally {
    process.off("SIGINT", stop).off("SIGTERM", stop);
    rmSync(folder, { recursive: true, force: true });
  }
}

function checkoutTop(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root))
    throw new CannotRun(`${root} is not the top folder of a Git checkout`);
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.status === 0 ? head.stdout.trim() : null;
}

async function main(argv) {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  if (rest.length > 1 || rest.some((a) => a.startsWith("-")))
    throw new CannotRun("usage: node tools/counters.mjs [ROOT] [--json]");
  const root = path.resolve(rest[0] ?? ".");
  if (!existsSync(root)) throw new CannotRun(`${root} does not exist`);
  const commit = checkoutTop(root);
  const sites = directivesAndTests(root);
  const listCounts = lists(root);
  const { signals, counters: structureCounts } = await structure(root);
  const tsInTests = sites.tsDirectives.filter((s) => IN_TESTS.test(s.slice(0, s.lastIndexOf(":"))));
  const counters = {
    ...Object.fromEntries(Object.entries(sites).map(([key, list]) => [key, list.length])),
    tsDirectivesOutsideTests: sites.tsDirectives.length - tsInTests.length,
    tsDirectivesInTests: tsInTests.length,
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
  console.log(`@ts- directives outside tests: ${c.tsDirectivesOutsideTests}`);
  console.log(`@ts- directives in tests: ${c.tsDirectivesInTests}`);
  console.log(`Skipped tests: ${c.skippedTests}`);
  console.log(`Skipped tests without a condition: ${c.skippedTestsUnconditional}`);
  console.log(`Skipped tests on a condition: ${c.skippedTestsConditional}`);
  console.log(`Skipped tests on the platform: ${c.skippedTestsPlatform}`);
  console.log(`Todo tests: ${c.todoTests}`);
  console.log(`.oxlintrc.json waiting-list files: ${value(c.oxlintOverrideFiles)}`);
  console.log(`Comment forecasts allowed: ${value(c.forecastsAllowed)}`);
  console.log(`Comment citations: ${value(c.citations)}`);
  console.log(`Comment declarations waiting: ${value(c.declarationsWaiting)}`);
  console.log(`Comment external names (may grow): ${value(c.externalNames)}`);
  console.log(`Imports waiting (cycles and crossings): ${value(c.importsWaiting)}`);
  console.log(`Files over ${signals.fileLines} lines: ${c.largeFiles}`);
  console.log(
    `Lines above ${signals.fileLines}, summed over those files: ${c.largeFilesExcessLines}`,
  );
  console.log(`Folders over ${signals.folderFiles} files: ${c.broadFolders}`);
  console.log(
    `Files above ${signals.folderFiles}, summed over those folders: ${c.broadFoldersExcessFiles}`,
  );
  console.log(`Functions over ${signals.functionLines} lines: ${c.longFunctions}`);
  console.log(
    `Lines above ${signals.functionLines}, summed over those functions: ${c.longFunctionsExcessLines}`,
  );
  for (const [where, key] of [
    ["outside tests", "OutsideTests"],
    ["in tests", "InTests"],
  ]) {
    console.log(
      `Functions over ${signals.functionLines} lines ${where}: ${c[`longFunctions${key}`]}`,
    );
    console.log(
      `Lines above ${signals.functionLines}, summed over those ${where}: ${c[`longFunctions${key}ExcessLines`]}`,
    );
  }
  const { largestFile: f, longestFunction: fn } = c;
  console.log(
    `Largest file: ${f ? `${f.lines} lines, ${f.file}` : `none over ${signals.fileLines} lines`}`,
  );
  console.log(
    `Longest function: ${fn ? `${fn.lines} lines, ${fn.name} in ${fn.file}` : `none over ${signals.functionLines} lines`}`,
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Stopped) process.exitCode = error.code;
  else if (error instanceof CannotRun) {
    console.error(`counters: ${error.message}`);
    process.exitCode = 2;
  } else throw error;
}
