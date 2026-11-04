import { globSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ts } from "ts-morph";

/**
 * A site's identity in the shared oracles and runners is its file and its offsets (#1700; Astra's B1 on #1690, Codex
 * r5's item 2 on #1687): every file counts its offsets from 0, so a key of offsets alone joins two files' sites. Read
 * from the syntax alone, in `tests/helpers/` and `tests/families/`: a key handed to a map's or a set's `set`, `get`,
 * `has`, `add` or `delete` that is text (a template or a `+`) holding a site's offset (a member named `so`, `eo`,
 * `offset`, `start` or `end`) must also hold its file (a name or member with `file` in it, or a call of
 * `siteKey`, `planSiteKey` or `placeKey`). A key named by a variable, or made by a call of a function, is read through
 * its nearest binding, one step (a parameter or a binding without an initializer holds none); a call inside a key's text
 * is not followed, so a key whose offsets only a helper's text holds passes. Text that is no key (a message, a comparison's projection) is outside the check, as are the test files'
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
    /**
     * What `name` names at `use`: its nearest binding in a scope holding the use, the variable's initializer or the
     * function it declares; `null` where that binding holds no text a key is read from (a parameter, a loop's or a
     * catch's binding, a destructured name, a declaration without an initializer or after the use), or none is found.
     */
    const declared = (name, use) => {
      for (let scope = use.parent; scope !== undefined; scope = scope.parent) {
        if (ts.isFunctionLike(scope) && scope.parameters.some((each) => binds(each.name, name)))
          return null;
        if (
          ts.isCatchClause(scope) &&
          scope.variableDeclaration !== undefined &&
          binds(scope.variableDeclaration.name, name)
        )
          return null;
        if (
          (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
          scope.initializer !== undefined &&
          ts.isVariableDeclarationList(scope.initializer) &&
          scope.initializer.declarations.some((each) => binds(each.name, name))
        )
          return null;
        const statements =
          ts.isSourceFile(scope) ||
          ts.isBlock(scope) ||
          ts.isModuleBlock(scope) ||
          ts.isCaseClause(scope) ||
          ts.isDefaultClause(scope)
            ? scope.statements
            : null;
        if (statements === null) continue;
        // (`undefined`: no binding of the name in this block; a function is hoisted, a variable shadows the whole block)
        let found;
        for (const statement of statements) {
          if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
            found = statement;
          if (ts.isVariableStatement(statement))
            for (const each of statement.declarationList.declarations)
              if (binds(each.name, name))
                found =
                  ts.isIdentifier(each.name) && each.getStart(source) < use.getStart(source)
                    ? (each.initializer ?? null)
                    : null;
        }
        if (found !== undefined) return found;
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

/** Whether a binding name or pattern binds `name`. */
function binds(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && binds(element.name, name),
  );
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
