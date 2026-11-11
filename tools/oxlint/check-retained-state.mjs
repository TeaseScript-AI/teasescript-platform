import { globSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ts } from "ts-morph";

/**
 * #1072 step 1b: the type core's owners of retained state make each collection they keep through `Retained`
 * (`src/type-inference/core/retained/retained.ts`), so the retained-state recorder sees it. Read from the syntax alone:
 * in the scoped files, a `new Map`, `new Set`, `new WeakMap` or `new WeakSet` stands only where it cannot be kept by
 * an owner as made, which is the closed set below; any other place (a class field, a private field, a member's or a
 * module's variable's assignment, a module's mutable variable, a parameter property's default) is refused.
 * - inside a function: a variable's initializer or an assignment to a variable bound inside a function (not passed on
 *   by a chained assignment to anything else), a `return`'s
 *   value or an arrow's body, an argument of a call or of a `new`, a spread, a `for…of`'s source, the object of a
 *   member access;
 * - at a module's top level: a `const` annotated `ReadonlyMap` or `ReadonlySet` (a constant table);
 * - a parameter's default, where the parameter is no parameter property or is annotated `ReadonlyMap` or `ReadonlySet`;
 * each through parentheses, `as`, `satisfies`, `!`, a conditional's branch, a `??` or `||`'s operand, and an array's
 * element or an object literal's property: such a literal is judged where it stands.
 * What the check does not see is the recorder's: a local filled after it is stored in retained state is walked there by
 * value. In a file scoped `module`, only the top level is checked: its other classes keep no retained state.
 */
const SCOPE = [
  { glob: "src/type-inference/core/contract.ts", level: "file" },
  { glob: "src/type-inference/core/contract/**/*.ts", level: "file" },
  { glob: "src/type-inference/core/inherited/**/*.ts", level: "file" },
  { glob: "src/type-inference/core/values.ts", level: "file" },
  { glob: "src/type-inference/core/definitions.ts", level: "file" },
  { glob: "src/type-inference/core/exact-path.ts", level: "file" },
  { glob: "src/type-inference/core/indexes/guards.ts", level: "file" },
  { glob: "src/type-inference/core/indexes/handlers.ts", level: "file" },
  // (the files holding a module's capture: `retainedModule`)
  { glob: "src/type-inference/core/answers.ts", level: "module" },
  { glob: "src/type-inference/core/consumers.ts", level: "module" },
  { glob: "src/type-inference/core/contract-descriptors.ts", level: "module" },
  { glob: "src/type-inference/core/messages/site.ts", level: "module" },
  { glob: "src/type-inference/core/narrowing/narrowings.ts", level: "module" },
  { glob: "src/type-inference/core/property-names.ts", level: "module" },
];

/** The scoped files the check leaves out, each with why it keeps no retained state. */
const EXCLUDED = new Map([
  [
    "src/type-inference/core/contract/objects.ts",
    "what a query gathers (`Gathered`) becomes its proof, which the solver holds; its collections' shapes are closed by its own language (tools/oxlint/objects-language.mjs)",
  ],
  [
    "src/type-inference/core/contract/contributions.ts",
    "a run's flow (`FlowSink`) is the solver's record of the run, published with its answer",
  ],
]);

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const READONLY = new Set(["ReadonlyMap", "ReadonlySet"]);

export function checkRetainedState(root) {
  const sources = [];
  for (const { glob, level } of SCOPE)
    for (const file of globSync(glob, { cwd: root }).sort())
      if (!EXCLUDED.has(file.split(sep).join("/")))
        sources.push({
          file: file.split(sep).join("/"),
          text: readFileSync(resolve(root, file), "utf8"),
          level,
        });
  return retainedStateDiagnostics(sources);
}

/** The node a collection's value goes to: its parent past the wrappers that pass it on unchanged. */
function holder(node) {
  let at = node;
  for (;;) {
    const parent = at.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== at) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
      ts.isArrayLiteralExpression(parent)
    ) {
      at = parent;
      continue;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === at) {
      at = parent.parent;
      continue;
    }
    return { child: at, parent };
  }
}

/** Whether `node` stands inside a function's body. */
function inFunction(node) {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (ts.isFunctionLike(at)) return true;
  return false;
}

/** Whether an assignment's value goes no further than its variable: not on into another assignment's target. */
function unchained(assignment) {
  const { child, parent } = holder(assignment);
  return (
    !(
      ts.isBinaryExpression(parent) &&
      parent.right === child &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) || admitted(child, parent)
  );
}

/** Whether `type` is written `ReadonlyMap<…>` or `ReadonlySet<…>`. */
function readonlyType(type) {
  return (
    type !== undefined && ts.isTypeReferenceNode(type) && READONLY.has(type.typeName.getText())
  );
}

/** Whether a collection made at `child` (whose holder is `parent`) stands where the closed set admits it. */
function admitted(child, parent) {
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
    if (inFunction(parent)) return true;
    const list = parent.parent;
    const constant = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    return constant && readonlyType(parent.type);
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === child &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  )
    return localBinding(parent.left.text, parent) && unchained(parent);
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isArrowFunction(parent) && parent.body === child) return true;
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.includes(child)
  )
    return true;
  if (ts.isSpreadElement(parent)) return true;
  if (ts.isForOfStatement(parent) && parent.expression === child) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) return true;
  if (ts.isParameter(parent) && parent.initializer === child)
    return (
      readonlyType(parent.type) ||
      !ts
        .getModifiers(parent)
        ?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
            modifier.kind === ts.SyntaxKind.PublicKeyword ||
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword,
        )
    );
  return false;
}

/** The check's diagnostics for `sources` (each `{ file, text, level }`, `level` `file` or `module`). */
export function retainedStateDiagnostics(sources) {
  const diagnostics = [];
  for (const { file, text, level } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        COLLECTIONS.has(node.expression.text) &&
        !(level === "module" && inFunctionOrClass(node))
      ) {
        const { child, parent } = holder(node);
        if (!admitted(child, parent)) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
          diagnostics.push({
            fileName: file,
            line: line + 1,
            column: character + 1,
            message:
              `a ${node.expression.text} made where an owner can keep it: make it through \`Retained\` ` +
              "(src/type-inference/core/retained/retained.ts), so the retained-state recorder sees it (#1072)",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return diagnostics;
}

/**
 * Whether `name`, assigned at `use`, is bound inside a function: by its nearest declaration (a variable, a parameter)
 * in a scope holding the use. A name bound at the module's top level, or not found, is not.
 */
function localBinding(name, use) {
  const binds = (binding) => ts.isIdentifier(binding) && binding.text === name;
  for (let scope = use.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((each) => binds(each.name))) return true;
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : [];
    for (const statement of statements)
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((each) => binds(each.name))
      )
        return !ts.isSourceFile(scope);
    if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope)) &&
      scope.initializer !== undefined &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((each) => binds(each.name))
    )
      return true;
  }
  return false;
}

/** Whether `node` stands inside a function or a class: not at its module's top level. */
function inFunctionOrClass(node) {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (ts.isFunctionLike(at) || ts.isClassLike(at)) return true;
  return false;
}
