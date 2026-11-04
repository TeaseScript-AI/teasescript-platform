import { globSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ts } from "ts-morph";

/**
 * A site's identity in the shared oracles and runners is its file and its offsets (#1700; Astra's B1 on #1690, Codex
 * r5's item 2 on #1687): every file counts its offsets from 0, so a key of offsets alone joins two files' sites. Read
 * from the syntax alone, in `tests/helpers/` and `tests/families/`: a key handed to a map's or a set's `set`, `get`,
 * `has`, `add` or `delete` that is text (a template or a `+`) holding a site's offset (a member named `so`, `eo`,
 * `offset`, `start` or `end`) must also hold its file (a name or member with `file` in it, or a call of
 * `siteKey`, `planSiteKey` or `placeKey`). A key named by a variable, or made by a call of a function, declared in a block
 * holding the call (the nearest, before it), is read through that declaration, one step; a call inside a key's text is
 * not followed. Text that is no key (a message, a comparison's projection) is outside the check, as are the test files'
 * assertion texts.
 */
const SCOPE = ["tests/helpers/**/*.ts", "tests/families/**/*.{mjs,ts}"];

const KEYED = new Set(["set", "get", "has", "add", "delete"]);
const OFFSETS = new Set(["so", "eo", "offset", "start", "end"]);
const KEYS = new Set(["siteKey", "planSiteKey", "placeKey"]);
const FILE = /file/i;

export function checkSiteKeys(root) {
  const sources = globSync(SCOPE, { cwd: root })
    .map((file) => file.split(sep).join("/"))
    .sort()
    .map((file) => ({ file, text: readFileSync(resolve(root, file), "utf8") }));
  return siteKeyDiagnostics(sources);
}

/** The check's diagnostics for `sources` (each `{ file, text }`). */
export function siteKeyDiagnostics(sources) {
  const diagnostics = [];
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    /** What `name` names at `use`: the nearest declaration before it in a block holding it, or `null`. */
    const declared = (name, use) => {
      for (let scope = use.parent; scope !== undefined; scope = scope.parent) {
        const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : null;
        if (statements === null) continue;
        let found = null;
        for (const statement of statements) {
          if (statement.getStart(source) > use.getStart(source)) break;
          if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
            found = statement;
          if (ts.isVariableStatement(statement))
            for (const each of statement.declarationList.declarations)
              if (ts.isIdentifier(each.name) && each.name.text === name)
                found = each.initializer ?? null;
        }
        // (a function declared after its call is hoisted)
        for (const statement of statements)
          if (
            found === null &&
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === name
          )
            found = statement;
        if (found !== null) return found;
      }
      return null;
    };
    /** The text a key is made of: itself, or one step through its variable or its function's returns. */
    const madeOf = (key) => {
      const inner = skipped(key);
      if (ts.isIdentifier(inner)) {
        const initializer = declared(inner.text, inner);
        return initializer === null ? [] : [skipped(initializer)].filter(isText);
      }
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
        if (KEYS.has(inner.expression.text)) return [];
        const callee = declared(inner.expression.text, inner);
        return callee === null || !ts.isFunctionLike(callee)
          ? []
          : returnsOf(callee).map(skipped).filter(isText);
      }
      return isText(inner) ? [inner] : [];
    };
    const check = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        KEYED.has(node.expression.name.text) &&
        node.arguments.length > 0
      )
        for (const made of madeOf(node.arguments[0]))
          if (holds(made, (name) => OFFSETS.has(name)) && !holdsFile(made)) {
            const { line, character } = source.getLineAndCharacterOfPosition(
              node.arguments[0].getStart(source),
            );
            diagnostics.push({
              fileName: file,
              line: line + 1,
              column: character + 1,
              message:
                "A map's or a set's key holds a site's offsets without its file: key it by its file too " +
                "(`siteKey`, `planSiteKey`, tests/helpers/site-keys.ts).",
            });
          }
      ts.forEachChild(node, check);
    };
    check(source);
  }
  return diagnostics;
}

/** An expression without its parentheses, `as`, `!` and `satisfies`. */
function skipped(node) {
  let at = node;
  while (
    ts.isParenthesizedExpression(at) ||
    ts.isAsExpression(at) ||
    ts.isNonNullExpression(at) ||
    ts.isSatisfiesExpression(at)
  )
    at = at.expression;
  return at;
}

/** Whether an expression is text a key is made of: a template, or a `+` of parts. */
function isText(node) {
  return (
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

/** A function's returned expressions: an arrow's body expression, or each `return`'s, its nested functions' not. */
function returnsOf(declared) {
  if (declared.body === undefined) return [];
  if (!ts.isBlock(declared.body)) return [declared.body];
  const out = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declared.body, visit);
  return out;
}

/** Whether `node` names a member whose name `is`. */
function holds(node, is) {
  let found = false;
  const visit = (at) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(at) && is(at.name.text)) found = true;
    else ts.forEachChild(at, visit);
  };
  visit(node);
  return found;
}

/** Whether `node` holds a file: a name or member with `file` in it, or a call of a site's key. */
function holdsFile(node) {
  let found = false;
  const visit = (at) => {
    if (found) return;
    if (ts.isIdentifier(at) && (FILE.test(at.text) || KEYS.has(at.text))) found = true;
    else ts.forEachChild(at, visit);
  };
  visit(node);
  return found;
}
