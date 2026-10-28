import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * Stage 3b's narrowing modules repeat work only through `narrowing-iteration.ts`, which charges every step to the work
 * ledger (TABLE §13.3), or through a function that charges a unit as its first statement. This check guards the
 * ordinary forms of anything else: it is not a proof over every TypeScript execution form (an inline recursive function
 * expression called on the spot, recursion through an interface method, an aliased constructor, a call through a
 * function-typed parameter, a getter behind an interface, a class field initializer and a zero-amount charge pass it;
 * none occurs in the modules). It reads them with their types and rejects:
 * - every loop but `for…of` over that module's `each(…)` or `steps(…)`; spreads, rest elements and parameters, the
 *   spread of an object with an index signature, `yield*` of anything but a call, a callable reached by a computed
 *   member, and an object converted to text (a template, `+`, `String(…)`, `Number(…)`);
 * - a function of these modules on a recursion (a cycle of functions naming each other) or used as a value (passed,
 *   stored, returned) whose first statement does not charge a unit;
 * - any callable declared elsewhere (a library method, a core helper, a getter) that `OUTSIDE` does not list with why a
 *   call to it walks nothing uncharged; the walking collection constructors only with no argument or a table written
 *   out in full.
 * Text the modules make follows the kept-text rule (TABLE r4.58, `tests/type-core-kept.test.ts`), not this one. Calls
 * from the rest of the core into these modules are outside this check: in part 1 only `guards.ts` makes the index.
 */
const CHARGED_FILES = [
  "src/type-inference/core/narrowing.ts",
  "src/type-inference/core/narrowing-events.ts",
  "src/type-inference/core/narrowing-routes.ts",
  "src/type-inference/core/narrowing-statements.ts",
];

const ITERATION_FILE = "src/type-inference/core/narrowing-iteration.ts";
const CHARGE = "src/type-inference/core/budget.ts:WorkLedger.charge";

const core = (file, names) => names.map((name) => `src/${file}:${name}`);

/** A lookup, a field, an arithmetic step or a fixed number of steps; or a lazy iterator, walked through `each`. */
const CONSTANT = [
  ...[
    "Array.at",
    "Array.entries",
    "Array.pop",
    "Array.push",
    "Map.get",
    "Map.has",
    "Map.set",
    "Map.values",
    "Map",
    "Set",
    "WeakMap",
    "Math.max",
    "NumberConstructor.isInteger",
    "ReadonlyArray.entries",
    "ReadonlyMap.get",
    "ReadonlySet.has",
    "Set.add",
    "Set.has",
    "WeakMap.get",
    "WeakMap.set",
  ].map((name) => `lib:${name}`),
  ...core("dict-operations.ts", ["dictMethod"]),
  ...core("list-methods.ts", ["listMethod"]),
  ...core("type-inference/core/budget.ts", ["WorkLedger.charge", "keepText", "textUnits"]),
  ...core("type-inference/core/contract.ts", ["operatorOf"]),
  ...core("type-inference/core/definitions.ts", [
    "DefinitionIndex.declaringCallable",
    "DefinitionIndex.keysBelow",
    "DefinitionLists.live",
    "DefinitionLists.spanBetween",
  ]),
  ...core("type-inference/core/dominators.ts", ["Dominators.dominates", "Dominators.edom"]),
  ...core("type-inference/core/flow-graph/model.ts", [
    "FlowGraph.isDeadEdge",
    "FlowGraph.ownerOf",
    "FlowGraph.statementAt",
  ]),
  ...core("type-inference/core/items.ts", ["makeItem"]),
  ...core("type-inference/core/method-categories.ts", ["selectsElement"]),
  ...core("type-inference/core/program.ts", [
    "CoreProgram.effectNode",
    "CoreProgram.exprAt",
    "CoreProgram.live",
    "CoreProgram.position",
    "CoreProgram.positionEnd",
    "CoreProgram.reached",
    "propertyStep",
    "siteKey",
  ]),
];

/** Charges its own work to the ledger: a kept text or array, a memoised list built charged, the items it merges. */
const CHARGING = [
  ...core("type-inference/core/budget.ts", ["keptArray", "keptParts"]),
  ...core("type-inference/core/contract.ts", ["Contract.refReceiver"]),
  ...core("type-inference/core/definitions.ts", [
    "DefinitionLists.definitionsOf",
    "DefinitionLists.eventList",
    "DefinitionLists.singleSite",
  ]),
  ...core("type-inference/core/items.ts", ["mergeItems"]),
  ...core("type-inference/core/operator-table.ts", ["operationItems"]),
  ...core("type-inference/core/program.ts", [
    "CoreProgram.blockReachable",
    "CoreProgram.inBlockCode",
  ]),
  ...core("type-inference/core/values.ts", ["Values.valueItems"]),
];

/**
 * Walks no more than the step that calls it charges (TABLE r4.58: a plain making is that step's own work): a key's or
 * path's text or steps, made or read where the step charges one unit per step or the text as kept; a parenthesis or
 * sign `peel` charges; a literal's parts and text, an expression's parts (`childrenOf`), an operand's items and a
 * read's loops, each charged at the call.
 */
const STEP = [
  "lib:Number",
  "lib:String.startsWith",
  "lib:String.substring",
  ...core("expression-children.ts", ["expressionChildren"]),
  ...core("switch-cases.ts", ["caseValueKey"]),
  ...core("type-inference/core/budget.ts", ["joinParts"]),
  ...core("type-inference/core/definitions.ts", ["keyBelow", "keyOf", "keyPath", "keyPlace"]),
  ...core("type-inference/core/exact-path.ts", ["withoutEmpty"]),
  ...core("type-inference/core/handlers.ts", ["HandlerIndex.afterSomeCreation"]),
  ...core("type-inference/core/program.ts", ["CoreProgram.targetRoot", "propertyName"]),
  ...core("type-inference/narrowing-shapes.ts", ["conditionShape"]),
];

/** Known gaps in the core's own charging, filed: the call is listed, the gap is the core's. */
const FILED = [
  // the prefixes of a key, copied at once and charged one unit each (#1220)
  ...core("type-inference/core/definitions.ts", ["DefinitionIndex.ownedAway", "keptPrefixes"]),
  ...core("type-inference/core/handlers.ts", ["HandlerIndex.handlerTouches"]),
  // the event search's binary search, charged two units whatever its length (#1221)
  ...core("type-inference/core/definitions.ts", ["DefinitionLists.certain"]),
];

const OUTSIDE = new Set([...CONSTANT, ...CHARGING, ...STEP, ...FILED]);

/** The conversions to text, constant only for a primitive. */
const CONVERSIONS = new Set(["lib:Number", "lib:String"]);

/** The collection constructors that walk an argument. */
const WALKING_CONSTRUCTORS = new Set(["lib:Map", "lib:Set", "lib:WeakMap", "lib:WeakSet"]);

/** The diagnostics of the narrowing modules of the repository at `root`. */
export function checkChargedIteration(root) {
  const project = new Project({
    tsConfigFilePath: resolve(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of CHARGED_FILES) project.addSourceFileAtPath(resolve(root, file));
  project.resolveSourceFileDependencies();
  return chargedIterationDiagnostics(project.getProgram().compilerObject, root, {
    files: CHARGED_FILES,
    iteration: ITERATION_FILE,
    charge: CHARGE,
    outside: OUTSIDE,
  });
}

/**
 * @param {ts.Program} program
 * @param {string} root
 * @param {{ files: readonly string[], iteration: string, charge: string, outside: ReadonlySet<string> }} rules
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function chargedIterationDiagnostics(program, root, rules) {
  const checker = program.getTypeChecker();
  const fileOf = (node) => {
    const sourceFile = node.getSourceFile();
    return program.isSourceFileDefaultLibrary(sourceFile)
      ? "lib"
      : relative(root, sourceFile.fileName).split(sep).join("/");
  };
  const charged = new Set(rules.files);
  const diagnostics = [];
  const report = (node, message) => {
    const sourceFile = node.getSourceFile();
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({
      fileName: fileOf(node),
      line: location.line + 1,
      column: location.character + 1,
      message,
    });
  };

  /** The declaration a name refers to, through imports. */
  const declarationOf = (node) => {
    let symbol =
      node.parent !== undefined && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.declarations?.[0];
    return declaration === undefined ? undefined : { symbol, declaration };
  };
  /** The name `OUTSIDE` lists a declaration by: its file, then its class or interface and its own name. */
  const nameOf = ({ symbol, declaration }) => {
    // (a constructor's parameter property is its class's)
    const owner =
      ts.isParameter(declaration) && ts.isConstructorDeclaration(declaration.parent)
        ? declaration.parent.parent
        : declaration.parent;
    const member =
      owner !== undefined &&
      (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) &&
      owner.name !== undefined
        ? `${owner.name.text}.`
        : "";
    return `${fileOf(declaration)}:${member}${symbol.name}`;
  };
  const names = (node, name) => {
    const target = declarationOf(node);
    return target !== undefined && nameOf(target) === name;
  };
  const callable = ({ symbol, declaration }, node) => {
    if (ts.isFunctionLike(declaration) || ts.isClassLike(declaration)) return true;
    const type = checker.getTypeOfSymbolAtLocation(symbol, node);
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
  };
  /** Whether a name stands where it is called (`f(…)`, `this.#f(…)`, `new F(…)`), not used as a value. */
  const called = (node) => {
    const at =
      ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
    return (
      (ts.isCallExpression(at.parent) || ts.isNewExpression(at.parent)) &&
      at.parent.expression === at
    );
  };
  /** Whether every value a type holds is a primitive, which converts to text in constant work. */
  const primitive = (type) =>
    type.isUnion()
      ? type.types.every(primitive)
      : (type.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.BigIntLike |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined |
            ts.TypeFlags.Void |
            ts.TypeFlags.EnumLike)) !==
        0;
  const converts = (expression) => !primitive(checker.getTypeAtLocation(expression));
  const calls = (expression, file, names) => {
    if (!ts.isCallExpression(expression)) return false;
    const target = declarationOf(
      ts.isPropertyAccessExpression(expression.expression)
        ? expression.expression.name
        : expression.expression,
    );
    return (
      target !== undefined && fileOf(target.declaration) === file && names.has(target.symbol.name)
    );
  };

  // The functions of the modules and the functions each names, for the recursion check; and the ones used as values.
  const functions = new Map();
  const values = new Set();
  /** The function a body belongs to: a declaration, a method, or a function a variable or field holds. */
  const functionOf = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    )
      return node.body === undefined ? undefined : node;
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      (ts.isVariableDeclaration(node.parent) ||
        ts.isPropertyDeclaration(node.parent) ||
        ts.isPropertyAssignment(node.parent)) &&
      node.parent.initializer === node
    )
      return node;
    return undefined;
  };
  const targetFunction = (declaration) => {
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration)
    )
      return declaration.initializer === undefined
        ? undefined
        : functionOf(declaration.initializer);
    if (ts.isClassLike(declaration))
      return declaration.members.find(
        (member) => ts.isConstructorDeclaration(member) && member.body,
      );
    return functionOf(declaration);
  };

  for (const file of rules.files) {
    const sourceFile = program.getSourceFile(resolve(root, file));
    if (sourceFile === undefined) throw new Error(`${file} is not in the program.`);
    const visit = (node, within) => {
      const own = functionOf(node);
      if (own !== undefined) {
        within = own;
        if (!functions.has(own)) functions.set(own, new Set());
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      )
        report(node, "A raw loop goes uncharged. Walk with `each` or `steps`.");
      else if (
        ts.isForOfStatement(node) &&
        !calls(node.expression, rules.iteration, new Set(["each", "steps"]))
      )
        report(node, "A `for…of` loop goes uncharged unless it walks `each(…)` or `steps(…)`.");
      else if (ts.isSpreadElement(node)) report(node, "A spread walks its operand uncharged.");
      else if (ts.isBindingElement(node) && node.dotDotDotToken !== undefined)
        report(node, "A rest element copies uncharged.");
      else if (ts.isParameter(node) && node.dotDotDotToken !== undefined)
        report(node, "A rest parameter copies uncharged.");
      else if (ts.isSpreadAssignment(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        if (
          type.getStringIndexType() !== undefined ||
          type.getNumberIndexType() !== undefined ||
          checker.isArrayLikeType(type)
        )
          report(node, "The spread of an object with an index signature copies it uncharged.");
      } else if (
        ts.isYieldExpression(node) &&
        node.asteriskToken !== undefined &&
        (node.expression === undefined || !ts.isCallExpression(node.expression))
      )
        report(node, "A `yield*` walks its operand uncharged unless the operand is a call.");
      else if (ts.isElementAccessExpression(node)) {
        const type = checker.getTypeAtLocation(node);
        if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0)
          report(node, "A callable reached by a computed member escapes this check. Name it.");
      } else if (ts.isTemplateSpan(node) && converts(node.expression))
        report(node.expression, "A template converts an object to text uncharged.");
      else if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
        (converts(node.left) || converts(node.right))
      )
        report(node, "A `+` converts an object to text uncharged.");
      else if (
        (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
        !ts.isPartOfTypeNode(node) &&
        !declares(node)
      ) {
        const target = declarationOf(node);
        if (target !== undefined && callable(target, node)) {
          const where = fileOf(target.declaration);
          if (charged.has(where)) {
            const callee = targetFunction(target.declaration);
            if (callee !== undefined) {
              if (within !== undefined) functions.get(within).add(callee);
              // (an accessor runs where it is read)
              if (!called(node) && !ts.isAccessor(callee)) values.add(callee);
            }
          } else if (where !== rules.iteration) {
            const name = nameOf(target);
            if (!rules.outside.has(name))
              report(
                node,
                `\`${name}\` is not in OUTSIDE (tools/oxlint/check-charged-iteration.mjs): list it with why a call ` +
                  "walks nothing uncharged, or walk through narrowing-iteration.ts.",
              );
            else if (CONVERSIONS.has(name) && called(node) && node.parent.arguments.some(converts))
              report(node, `\`${symbolText(node)}(…)\` converts an object to text uncharged.`);
            else if (
              WALKING_CONSTRUCTORS.has(name) &&
              ts.isNewExpression(node.parent) &&
              node.parent.expression === node &&
              (node.parent.arguments?.length ?? 0) > 0 &&
              // (a table written out in full has a fixed size)
              !ts.isArrayLiteralExpression(node.parent.arguments[0])
            )
              report(node, `\`new ${symbolText(node)}(…)\` walks its argument uncharged.`);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, within));
    };
    visit(sourceFile, undefined);
  }

  // A recursion repeats as often as its input asks, and a function used as a value as often as what holds it calls it:
  // each charges a unit as its first statement.
  for (const fn of new Set([...cyclesOf(functions).flat(), ...values])) {
    const first = ts.isBlock(fn.body) ? fn.body.statements[0] : undefined;
    if (
      first === undefined ||
      !ts.isExpressionStatement(first) ||
      !ts.isCallExpression(first.expression) ||
      !ts.isPropertyAccessExpression(first.expression.expression) ||
      !names(first.expression.expression.name, rules.charge)
    )
      report(
        fn.name ?? fn.parent.name ?? fn,
        "A recursion, or a function used as a value, repeats uncharged: charge a unit as its first statement, or " +
          "walk with `steps`.",
      );
  }
  return diagnostics.sort(
    (a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line || a.column - b.column,
  );
}

/** Whether a name is the one a declaration gives (a function's, a field's, a variable's), not a reference. */
function declares(node) {
  const parent = node.parent;
  return (
    parent !== undefined &&
    parent.name === node &&
    (ts.isDeclarationStatement(parent) ||
      ts.isClassElement(parent) ||
      ts.isTypeElement(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassExpression(parent))
  );
}

function symbolText(node) {
  return ts.isIdentifier(node) ? node.text : node.getText();
}

/** The functions on a cycle of `edges`, one array per strongly connected component (Tarjan). */
function cyclesOf(edges) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  let counter = 0;
  const connect = (fn) => {
    index.set(fn, counter);
    low.set(fn, counter);
    counter += 1;
    stack.push(fn);
    onStack.add(fn);
    for (const next of edges.get(fn) ?? []) {
      if (!index.has(next)) {
        connect(next);
        low.set(fn, Math.min(low.get(fn), low.get(next)));
      } else if (onStack.has(next)) low.set(fn, Math.min(low.get(fn), index.get(next)));
    }
    if (low.get(fn) !== index.get(fn)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== fn);
    if (component.length > 1 || edges.get(fn)?.has(fn)) cycles.push(component);
  };
  for (const fn of edges.keys()) if (!index.has(fn)) connect(fn);
  return cycles;
}
