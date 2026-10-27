import { ts } from "ts-morph";

/**
 * Stage 3b's narrowing modules walk anything only through `narrowing-iteration.ts`, which charges every step to the work
 * ledger (TABLE §13.3), so an uncharged walk cannot be written in them. This check rejects every other loop, array walk
 * and copy there: `for`, `for…in`, `while` and `do` loops; `for…of` except over `each(…)` or `steps(…)`; the array walks
 * and copies (`map`, `filter`, `some`, `every`, `reduce`, `find`, `forEach`, `flatMap`, `includes`, `indexOf`, `join`,
 * `slice`, `sort`, …); array and argument spreads, rest elements; and constructors and helpers that walk their argument
 * (`new Set(…)`, `new Map(…)` of anything but a table written out in full, `Array.from`, `Object.keys`, …).
 */
export const CHARGED_FILES = new Set([
  "src/type-inference/core/narrowing.ts",
  "src/type-inference/core/narrowing-events.ts",
  "src/type-inference/core/narrowing-routes.ts",
  "src/type-inference/core/narrowing-statements.ts",
]);

const WALKING_METHODS = new Set([
  "concat",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "reverse",
  "slice",
  "some",
  "sort",
  "splice",
  "toReversed",
  "toSorted",
  "toSpliced",
]);

const WALKING_STATICS = new Map([
  ["Array", new Set(["from", "of"])],
  ["Object", new Set(["keys", "values", "entries", "fromEntries", "assign"])],
]);

const WALKING_CONSTRUCTORS = new Set(["Set", "Map", "WeakSet", "WeakMap"]);

const CHARGING_ITERATORS = new Set(["each", "steps"]);

/**
 * @param {string} fileName
 * @param {string} sourceText
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function checkChargedIteration(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const diagnostics = [];
  const report = (node, message) => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({
      fileName,
      line: location.line + 1,
      column: location.character + 1,
      message: `${message} Walk through narrowing-iteration.ts, which charges every step.`,
    });
  };
  const nodes = [sourceFile];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    )
      report(node, "A raw loop goes uncharged.");
    else if (ts.isForOfStatement(node)) {
      const iterated = node.expression;
      if (
        !ts.isCallExpression(iterated) ||
        !ts.isIdentifier(iterated.expression) ||
        !CHARGING_ITERATORS.has(iterated.expression.text)
      )
        report(node, "A `for…of` loop goes uncharged unless it walks `each(…)` or `steps(…)`.");
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const owner = node.expression.expression;
      if (WALKING_METHODS.has(name)) report(node, `\`.${name}(…)\` walks its receiver uncharged.`);
      else if (ts.isIdentifier(owner) && WALKING_STATICS.get(owner.text)?.has(name))
        report(node, `\`${owner.text}.${name}(…)\` walks its argument uncharged.`);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      WALKING_CONSTRUCTORS.has(node.expression.text) &&
      (node.arguments?.length ?? 0) > 0 &&
      // (a table written out in full has a fixed size)
      !(
        ts.isArrayLiteralExpression(node.arguments[0]) &&
        !node.arguments[0].elements.some(ts.isSpreadElement)
      )
    )
      report(node, `\`new ${node.expression.text}(…)\` walks its argument uncharged.`);
    else if (ts.isSpreadElement(node)) report(node, "A spread walks its operand uncharged.");
    else if (ts.isBindingElement(node) && node.dotDotDotToken !== undefined)
      report(node, "A rest element copies uncharged.");
    nodes.push(...node.getChildren(sourceFile));
  }
  return diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
}
