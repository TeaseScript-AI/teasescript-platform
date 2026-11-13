// The condition scan of the candidate route's syntax table (#2501's guard, moved here by #2488's step 1, the lead's
// R19): for `src/type-inference/core/slice-syntax.ts`, the scope is every conditional row's `visit` (a row written as an
// object with a `visit` of its own) and every function of the file those reach through calls inside the file, with the
// functions that compute the walk's context a condition reads (`const context: SyntaxWalk = …` in `outsideSyntax`).
// In that scope its tokens are each comparison (`===`, `!==`, `<`, `<=`, `>`, `>=`), each operand of `&&` or `||` that
// is neither, and each `unwrapped(` call. The spec, `tools/slice-conditions.json`, lists mutants, each keyed by its
// scope (`row <kind>` or a function's name), an expression's exact text there and, where the text occurs more than once
// in that scope, its occurrence (1-based): the mutant replaces that expression with `mutant`. A token is covered when a
// spec entry's expression contains it. Its claim, nothing more: every token in scope has a mutant, which the mutants job
// then judges (`expected`: kill, restrict, nobuild or equivalent, with the witness or the reason).
//
// Usage:
//   node tools/slice-conditions.mjs [--file F] [--spec S]             list the scope; exit 1 on an uncovered token or a
//                                                                     stale entry (an expression not in its scope)
//   node tools/slice-conditions.mjs … --patches DIR                   also write one patch per entry, `<id>.patch`, a git
//                                                                     diff of the file against the repository root (the
//                                                                     current folder: a --file outside it cannot run), for
//                                                                     `sx-job mutants --patches DIR`
//   node tools/slice-conditions.mjs … --admitted TREE                 judge only that each `restrict` entry's witness is
//                                                                     admitted by TREE's built syntax rule (a mutant's
//                                                                     run, where the scan of the mutated file is moot)
// Exit: 0 complete; 1 a token uncovered, an entry stale or a witness refused; 2 a usage or a file that cannot be read.
// Writes only under `--patches DIR`. Not part of `npm run check`: its upkeep is paid where the conditions change.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ts } from "ts-morph";

const FILE = "src/type-inference/core/slice-syntax.ts";
const SPEC = "tools/slice-conditions.json";
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]);

const fail = (message) => {
  console.error(`slice-conditions: ${message}`);
  process.exit(2);
};

/** The file's functions by name: `function` declarations and top-level `const` arrows. */
function functionsOf(source) {
  const found = new Map();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      found.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          ts.isArrowFunction(declaration.initializer)
        )
          found.set(declaration.name.text, declaration.initializer);
  }
  return found;
}

/** The conditional rows of `DISPOSITIONS`: each row written as an object literal with its own `visit`, by kind. */
function rowsOf(source) {
  const rows = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "DISPOSITIONS" &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      for (const row of node.initializer.properties)
        if (
          ts.isPropertyAssignment(row) &&
          ts.isObjectLiteralExpression(row.initializer) &&
          row.initializer.properties.some(
            (property) => property.name !== undefined && property.name.getText() === "visit",
          )
        ) {
          // the row's own `visit`: what it checks
          const visit = row.initializer.properties.find(
            (property) => property.name !== undefined && property.name.getText() === "visit",
          );
          rows.set(row.name.getText(), visit);
        }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rows;
}

/** The names of the file's functions that `node` calls. */
function callsIn(node, functions) {
  const called = new Set();
  const visit = (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      functions.has(child.expression.text)
    )
      called.add(child.expression.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return called;
}

/** The scope: each conditional row and each function reached, by name, with its node. */
export function scopeOf(source) {
  const functions = functionsOf(source);
  const rows = rowsOf(source);
  const pending = [...rows.values()].flatMap((row) => [...callsIn(row, functions)]);
  // the walk's context, which a condition reads: the functions its initializer calls
  const context = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "context" &&
      node.initializer !== undefined
    )
      pending.push(...callsIn(node.initializer, functions));
    ts.forEachChild(node, context);
  };
  context(source);
  const reached = new Set();
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    pending.push(...callsIn(functions.get(name), functions));
  }
  const scope = new Map([...rows].map(([kind, node]) => [`row ${kind}`, node]));
  for (const name of [...reached].sort()) scope.set(name, functions.get(name));
  return { scope, outside: [...functions.keys()].filter((name) => !reached.has(name)).sort() };
}

/** The tokens of a scope's node: comparisons, operands of `&&` and `||` that are neither, and `unwrapped(` calls. */
export function tokensOf(node) {
  const tokens = [];
  const isLogical = (child) =>
    ts.isBinaryExpression(child) && LOGICAL.has(child.operatorToken.kind);
  const isComparison = (child) =>
    ts.isBinaryExpression(child) && COMPARISONS.has(child.operatorToken.kind);
  const unparenthesized = (child) =>
    ts.isParenthesizedExpression(child) ? unparenthesized(child.expression) : child;
  const visit = (child) => {
    if (isComparison(child)) tokens.push(child);
    if (isLogical(child))
      for (const operand of [child.left, child.right]) {
        const inner = unparenthesized(operand);
        if (!isLogical(inner) && !isComparison(inner)) tokens.push(operand);
      }
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "unwrapped"
    )
      tokens.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return tokens;
}

/** Each expression of `node` whose text is `text`, in source order. */
function expressionsWithText(node, text) {
  const found = [];
  const visit = (child) => {
    if (ts.isExpression(child) && child.getText() === text) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The scan of `text` against `spec`: the scope's names, the functions outside it, each entry's expression node (or why it
 * is stale), and each token no entry covers.
 */
export function scan(text, spec, file = FILE) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const { scope, outside } = scopeOf(source);
  const stale = [];
  const targets = [];
  const ids = new Set();
  for (const entry of spec) {
    if (ids.has(entry.id)) stale.push(`${entry.id}: the id is used twice`);
    ids.add(entry.id);
    const node = scope.get(entry.scope);
    if (node === undefined) {
      stale.push(`${entry.id}: no scope '${entry.scope}'`);
      continue;
    }
    const found = expressionsWithText(node, entry.expression);
    const occurrence = entry.occurrence ?? 1;
    if (found.length === 0)
      stale.push(`${entry.id}: '${entry.expression}' is not in ${entry.scope}`);
    else if (entry.occurrence === undefined && found.length > 1)
      stale.push(
        `${entry.id}: '${entry.expression}' occurs ${found.length} times in ${entry.scope}; name its occurrence`,
      );
    else if (occurrence > found.length)
      stale.push(
        `${entry.id}: '${entry.expression}' occurs ${found.length} times in ${entry.scope}, not ${occurrence}`,
      );
    else targets.push({ entry, node: found[occurrence - 1] });
  }
  const uncovered = [];
  for (const [name, node] of scope)
    for (const token of tokensOf(node))
      if (
        !targets.some(
          ({ node: target }) =>
            target.getStart() <= token.getStart() && token.getEnd() <= target.getEnd(),
        )
      )
        uncovered.push(
          `${name}, line ${source.getLineAndCharacterOfPosition(token.getStart()).line + 1}: ${token.getText()}`,
        );
  return { scope: [...scope.keys()], outside, stale, uncovered, targets, source };
}

/** A file's lines, without the empty string after a final newline. */
function linesOf(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A git diff of `file` from `before` to `after`, with repository paths, as `git diff` writes one: one hunk, three lines
 * of context, and Git's `\ No newline at end of file` after a last line that has no newline.
 */
function patchOf(file, before, after) {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length, endA + 3);
  const toB = Math.min(b.length, endB + 3);
  // (the marker follows the side's last line where the hunk holds it: once after trailing context, else after the
  // last removed line and the last added line)
  const marker = "\\ No newline at end of file";
  const open = (text, lines, end) => !text.endsWith("\n") && end === lines.length;
  const removed = a.slice(start, endA).map((line) => `-${line}`);
  const added = b.slice(start, endB).map((line) => `+${line}`);
  const context = a.slice(endA, toA).map((line) => ` ${line}`);
  if (context.length === 0) {
    if (open(before, a, endA) && removed.length > 0) removed.push(marker);
    if (open(after, b, endB) && added.length > 0) added.push(marker);
  } else if (open(before, a, toA)) context.push(marker);
  const hunk = [
    ...a.slice(from, start).map((line) => ` ${line}`),
    ...removed,
    ...added,
    ...context,
  ];
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...hunk,
    "",
  ].join("\n");
}

/** `file` as a patch names it: its real path from the current folder's, the repository's root, in `/` form. */
function repositoryPath(file) {
  // (both resolved through symbolic links, as Git names a file by its real path)
  const relative = path.relative(realpathSync(process.cwd()), realpathSync(file));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    fail(
      `--file ${file} is not under the current folder, the repository's root a patch names it from`,
    );
  return relative.split(path.sep).join("/");
}

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: "string", default: FILE },
      spec: { type: "string", default: SPEC },
      patches: { type: "string" },
      admitted: { type: "string" },
    },
  });
  let text;
  let spec;
  try {
    text = readFileSync(values.file, "utf8");
    spec = JSON.parse(readFileSync(values.spec, "utf8"));
  } catch (error) {
    fail(String(error.message));
  }
  if (!Array.isArray(spec)) fail(`${values.spec} is not a list of entries`);
  const result = scan(text, spec, values.file);
  console.log(`in scope: ${result.scope.join(", ")}`);
  console.log(`outside: ${result.outside.join(", ")}`);
  console.log(`${spec.length} entries, ${result.targets.length} found`);
  for (const line of result.stale) console.log(`stale: ${line}`);
  for (const line of result.uncovered) console.log(`uncovered: ${line}`);
  // (with --admitted only the witnesses are judged: a mutant run checks them on a file its mutant changed)
  let failed =
    values.admitted === undefined && (result.stale.length > 0 || result.uncovered.length > 0);
  if (values.patches !== undefined) {
    const name = repositoryPath(values.file);
    mkdirSync(values.patches, { recursive: true });
    for (const { entry, node } of result.targets) {
      const after = `${text.slice(0, node.getStart())}${entry.mutant}${text.slice(node.getEnd())}`;
      writeFileSync(path.join(values.patches, `${entry.id}.patch`), patchOf(name, text, after));
    }
    console.log(`${result.targets.length} patches in ${values.patches}`);
  }
  if (values.admitted !== undefined) {
    const load = (file) =>
      import(pathToFileURL(path.join(path.resolve(values.admitted), "dist", file)).href);
    const { parse } = await load("src/parser.js");
    const { outsideSyntax } = await load("src/type-inference/core/slice-syntax.js");
    for (const entry of spec.filter((item) => item.expected === "restrict")) {
      const source = `${entry.witness}\nexit\n`;
      const parsed = parse(source);
      const outside =
        parsed.diagnostics.length > 0
          ? { what: "does not parse" }
          : outsideSyntax(
              [{ path: "main.tease", program: parsed.program, source, picks: new Map() }],
              new Set(["hostValue"]),
            );
      if (outside !== null) {
        console.log(
          `refused today (${outside.what}): ${entry.id}: ${JSON.stringify(entry.witness)}`,
        );
        failed = true;
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
