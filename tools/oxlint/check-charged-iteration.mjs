import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

import { objectsLanguage } from "./objects-language.mjs";

/**
 * Stage 3b's narrowing modules repeat work only through `charged-iteration.ts`, which charges every step to the work
 * ledger, and every function body in them charges a unit on entry. This check guards the ordinary forms
 * of anything else: it is not a proof over every TypeScript execution form (an aliased constructor and a class field
 * initializer pass it; neither occurs in the modules). It reads them with their types and rejects:
 * - every loop but `for…of` over that module's `each(…)` or `steps(…)`; spreads, rest elements and parameters, the
 *   spread of an object with an index signature, `yield*` of anything but a call, a callable reached by a computed
 *   member, and an object converted to text (a template, `+`, `String(…)`, `Number(…)`);
 * - a function body (a declaration, a method, a constructor, an accessor, a function expression, an arrow) whose first
 *   statement does not charge a positive unit (`charge(counter)`, or an amount written as a positive number), but an
 *   arrow handed straight to the iterator, which charges each step it calls it for: so a recursion, a function used as
 *   a value and a call through an interface or a parameter charge each time they run;
 * - any callable declared elsewhere (a library method, a core helper, a getter) that `OUTSIDE` does not list with why a
 *   call to it walks nothing uncharged; the walking collection constructors only with no argument or a table written
 *   out in full.
 * Text the modules make follows the kept-text rule (`tests/type-core/type-core-kept.test.ts`), not this one. Calls
 * from the rest of the core into these modules are outside this check: in part 1 only `guards.ts` makes the index.
 */
const OBJECTS_FILE = "src/type-inference/core/contract/objects.ts";

const CHARGED_FILES = [
  OBJECTS_FILE,
  "src/type-inference/core/narrowing/narrowings.ts",
  "src/type-inference/core/narrowing/laminar.ts",
  "src/type-inference/core/narrowing/events.ts",
  "src/type-inference/core/narrowing/routes.ts",
  "src/type-inference/core/narrowing/route-tests.ts",
  "src/type-inference/core/narrowing/route-candidates.ts",
  "src/type-inference/core/narrowing/statement-tree.ts",
];

const ITERATION_FILE = "src/type-inference/core/charged-iteration.ts";
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
  ...core("type-inference/core/contract/operations.ts", ["operatorOf"]),
  ...core("type-inference/core/definitions.ts", [
    "DefinitionIndex.declaringCallable",
    "DefinitionIndex.keysBelow",
    "DefinitionLists.live",
    "DefinitionLists.spanBetween",
  ]),
  ...core("type-inference/core/flow-graph/dominators.ts", [
    "Dominators.dominates",
    "Dominators.edom",
  ]),
  ...core("type-inference/core/flow-graph/model.ts", [
    "FlowGraph.isDeadEdge",
    "FlowGraph.ownerOf",
    "FlowGraph.statementAt",
  ]),
  ...core("type-inference/core/items.ts", ["makeItem"]),
  ...core("type-inference/core/method-categories.ts", ["selectsElement"]),
  // (#1072 1b: a retained collection made, or a module's capture found: native, or a test's recorder's)
  ...core("type-inference/core/retained/retained.ts", ["retainedModule", "weakMap"]),
  ...core("type-inference/core/program.ts", [
    "CoreProgram.effectNode",
    "CoreProgram.exprAt",
    "CoreProgram.functionRegion",
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
  // (a store's value demand, N5's leaf: what it reads is the value side's charged work)
  ...core("type-inference/core/exact-path.ts", ["ExactPath.defVal"]),
  ...core("type-inference/core/definitions.ts", [
    "DefinitionLists.definitionsOf",
    // (a key's prefixes among a set, one charged visit per trie step, its build the program's shared work: G3 3b)
    "KeyTrie.above",
    "keptParent",
    "DefinitionLists.eventList",
    "DefinitionLists.readSignature",
    "DefinitionLists.singleSite",
  ]),
  ...core("type-inference/core/items.ts", ["mergeItems"]),
  ...core("type-inference/core/operator-table.ts", ["operationItems"]),
  ...core("type-inference/core/program.ts", [
    "CoreProgram.blockReachable",
    "CoreProgram.inBlockCode",
  ]),
  // (a key's read at a node: the value side's charged work, as `valueItems`)
  ...core("type-inference/core/values.ts", ["Values.keyItems", "Values.valueItems"]),
];

/**
 * Walks no more than the step that calls it charges (a plain making is that step's own work): a key's or
 * path's text or steps, made or read where the step charges one unit per step or the text as kept (a key's text escaped
 * as its label is made, `stepLabel`); a parenthesis or sign `peel` charges; a literal's parts and text, an expression's
 * parts (`childrenOf`), an operand's items and a read's loops, each charged at the call.
 */
const STEP = [
  "lib:Number",
  "lib:String.replace",
  "lib:String.startsWith",
  ...core("expression-children.ts", ["expressionChildren"]),
  ...core("switch-cases.ts", ["caseLiteral"]),
  ...core("type-inference/core/budget.ts", ["joinParts"]),
  ...core("type-inference/core/definitions.ts", ["keyBelow", "keyOf", "keyPath", "keyPlace"]),
  ...core("type-inference/core/exact-path.ts", ["withoutEmpty"]),
  ...core("type-inference/core/indexes/handlers.ts", ["HandlerIndex.afterSomeCreation"]),
  // (a site's source text, kept as charged text at the call: `RouteTests.text`)
  ...core("type-inference/core/program.ts", [
    "CoreProgram.targetRoot",
    "CoreProgram.textAt",
    "propertyName",
  ]),
  ...core("type-inference/narrowing-shapes.ts", ["conditionShape"]),
];

/** Known gaps in the core's own charging, filed: the call is listed, the gap is the core's. */
const FILED = [
  // the prefixes of a key, copied at once and charged one unit each (#1220)
  ...core("type-inference/core/definitions.ts", ["DefinitionIndex.ownedAway", "keptPrefixes"]),
  ...core("type-inference/core/indexes/handlers.ts", ["HandlerIndex.handlerTouches"]),
  // the event search's binary search, charged two units whatever its length (#1221)
  ...core("type-inference/core/definitions.ts", ["DefinitionLists.certain"]),
];

const OUTSIDE = new Set([...CONSTANT, ...CHARGING, ...STEP, ...FILED]);

/**
 * objects.ts's own allowlist, the whole of what it may call outside the charged helpers: none of the narrowing modules'
 * entries apply to it. Each is only called there, never used as a value, and a call handed a collection of any size
 * must be in `OBJECTS_COLLECTIONS`.
 */
const OBJECTS_OUTSIDE = new Set([
  // Fixed work: a lookup, a store of a value whole, a charge, a key's own text, a step's name.
  ...[
    "Array.pop",
    "Array.push",
    "Map",
    "Map.get",
    "Map.has",
    "Map.keys",
    "Map.set",
    "Map.values",
    "Set",
    "Set.add",
    "Set.has",
    "WeakMap.get",
  ].map((name) => `lib:${name}`),
  ...core("type-inference/core/budget.ts", ["WorkLedger.charge", "joinParts", "keptArray"]),
  ...core("type-inference/core/contract.ts", [
    "Contract.work",
    "Contract.keep",
    "Contract.keepText",
  ]),
  ...core("type-inference/core/definitions.ts", ["keyOf", "keyPlace", "DefinitionLists.live"]),
  ...core("type-inference/core/program.ts", [
    "CoreProgram.place",
    "CoreProgram.isHost",
    "stepName",
  ]),
  ...core("type-inference/core/contract/terms.ts", ["writtenOf"]),
  ...core("type-inference/core/items.ts", ["firstWriter"]),
  ...core("type-inference/core/contract/value-kinds.ts", ["valueRoute", "resultOf"]),
  ...core("type-inference/core/method-categories.ts", ["measuresLength", "selectsElement"]),
  ...core("type-inference/core/contract/literal-index.ts", ["nodeAt", "pathAt"]),
  ...core("type-inference/core/contract/key-ids.ts", ["isPathSteps", "restRef", "stepsRest"]),
  // Solver, index and receiver boundaries, charged as they build, and the inherited key and type bridges, among them
  // `Contract.keyStopped`, which scans the stopped paths: reviewed inherited dependencies, not fixed work.
  ...core("type-inference/core/solver.ts", ["Solver.proven"]),
  ...core("type-inference/core/contract.ts", [
    "Contract.keyStopped",
    "Contract.literalIndex",
    "Contract.valueReceiver",
    "Contract.prefixStores",
  ]),
  ...core("type-inference/core/contract/literal-index.ts", ["lackingAt"]),
  ...core("type-inference/core/contract/others.ts", ["readGroupsAt", "othersAt"]),
  ...core("type-inference/core/contract/key-contract.ts", ["receiverWalk"]),
  ...core("type-inference/core/contract/frontier.ts", ["pushedSlot"]),
  ...core("type-inference/core/contract/terms.ts", ["termAt"]),
  ...core("type-inference/core/contract/key-ids.ts", [
    "canonicalKey",
    "keyBelowIn",
    "keptKeyBelowIn",
    "keyWalk",
    "KeyWalk.prefix",
    "memberStepOf",
  ]),
]);

/**
 * The calls objects.ts may hand a collection of any size (an array, an iterable, an unknown type; not a literal one),
 * each with what it does with it. Any other allowed call handed one fails: it could walk it for one charge.
 */
const OBJECTS_COLLECTIONS = new Set([
  // no walk: a collection stored, looked up or added whole, as one value
  ...["Array.push", "Map.get", "Map.has", "Map.set", "Set.add", "Set.has", "WeakMap.get"].map(
    (name) => `lib:${name}`,
  ),
  // no walk: an instanceof test, a record's rest or the array itself, a lazy view of the steps
  ...core("type-inference/core/contract/key-ids.ts", ["isPathSteps", "stepsRest", "restRef"]),
  // charged as they build: each entry of a list once (`invSteps`), the list's groups kept per list
  ...core("type-inference/core/contract/others.ts", ["readGroupsAt", "othersAt"]),
  // no walk, the array kept whole and charged by its length (`keepArray`)
  ...core("type-inference/core/budget.ts", ["keptArray"]),
  // charged by the text it scans (`invSteps`)
  ...core("type-inference/core/contract/key-ids.ts", ["memberStepOf"]),
  // the pushed slot's text charged as kept (`keptParts`)
  ...core("type-inference/core/contract/frontier.ts", ["pushedSlot"]),
  // the made key's text charged as kept; an array rest's text per call is the inherited key/path bridge's accounting,
  // as `KeyWalk.prefix`'s is
  ...core("type-inference/core/contract/key-ids.ts", ["keptKeyBelowIn"]),
  // inherited: the written type's walk (`writtenTypeSteps`, #1194)
  ...core("type-inference/core/contract/terms.ts", ["termAt"]),
]);

/** The conversions to text, constant only for a primitive. */
const CONVERSIONS = new Set(["lib:Number", "lib:String"]);

/** The collection constructors that walk an argument. */
const WALKING_CONSTRUCTORS = new Set(["lib:Map", "lib:Set", "lib:WeakMap", "lib:WeakSet"]);

/** The checker's configured scope, so a fixture can run through it as `checkChargedIteration` does. */
export const CONFIGURED = Object.freeze({
  files: CHARGED_FILES,
  iteration: ITERATION_FILE,
  charge: CHARGE,
  outside: OUTSIDE,
});

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
  /** Whether a value of a type may be a collection of any size: an array, an iterable, or a type not known. */
  const collection = (type) => {
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0)
      return true;
    if (type.isUnion()) return type.types.some(collection);
    // (a branded primitive is a primitive)
    if (type.isIntersection()) return !type.types.some(primitive) && type.types.some(collection);
    if (primitive(type)) return false;
    return (
      checker.isArrayLikeType(type) ||
      type
        .getProperties()
        .some((property) => String(property.escapedName).startsWith("__@iterator"))
    );
  };
  /** The call a name stands at the callee of, if any. */
  const callAt = (node) => {
    const at =
      ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
    return (ts.isCallExpression(at.parent) || ts.isNewExpression(at.parent)) &&
      at.parent.expression === at
      ? at.parent
      : undefined;
  };
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

  /** Whether a function is an arrow handed straight to the iterator, which charges each step it calls it for. */
  const iterated = (fn) => {
    if (!ts.isArrowFunction(fn) || !ts.isCallExpression(fn.parent)) return false;
    const callee = fn.parent.expression;
    const target = declarationOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    return (
      fn.parent.arguments.includes(fn) &&
      target !== undefined &&
      fileOf(target.declaration) === rules.iteration
    );
  };
  /** Whether a statement charges a positive unit: `charge(counter)`, or `charge(counter, n)` with `n` a positive number. */
  const charges = (statement) => {
    if (
      statement === undefined ||
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression) ||
      !ts.isPropertyAccessExpression(statement.expression.expression) ||
      !names(statement.expression.expression.name, rules.charge)
    )
      return false;
    const amount = statement.expression.arguments[1];
    return amount === undefined || (ts.isNumericLiteral(amount) && Number(amount.text) > 0);
  };

  for (const file of rules.files) {
    const sourceFile = program.getSourceFile(resolve(root, file));
    if (sourceFile === undefined) throw new Error(`${file} is not in the program.`);
    const outside = file === OBJECTS_FILE ? OBJECTS_OUTSIDE : rules.outside;
    const visit = (node) => {
      // Unresolved/opaque calls could hide a native copy (including an any-cast method).
      if (file === OBJECTS_FILE && ts.isCallExpression(node)) {
        const expression = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression;
        const target = declarationOf(expression);
        if (target === undefined)
          report(node, "An unresolved call escapes charged-work checking. Name a typed callable.");
        else if (
          fileOf(target.declaration) === OBJECTS_FILE &&
          !ts.isFunctionLike(target.declaration) &&
          !(
            ts.isVariableDeclaration(target.declaration) &&
            target.declaration.initializer !== undefined &&
            ts.isFunctionLike(target.declaration.initializer)
          )
        )
          report(node, "An opaque local callable has no checked body. Name its charged function.");
      }
      if (file === OBJECTS_FILE && ts.isClassLike(node) && (node.heritageClauses?.length ?? 0) > 0)
        report(
          node,
          "Class inheritance can copy through a base constructor. Use an explicit charged operation.",
        );
      // A local constructor alias bypasses the ordinary declaration check; fail closed in the newly covered module.
      if (file === OBJECTS_FILE && ts.isNewExpression(node)) {
        const target = declarationOf(node.expression);
        if (
          target === undefined ||
          (!ts.isClassLike(target.declaration) && !WALKING_CONSTRUCTORS.has(nameOf(target)))
        )
          report(node, "A constructor alias escapes charged-copy checking. Name the constructor.");
      }
      // Instance fields run before a constructor body: only fixed, non-calling initializers here.
      if (
        file === OBJECTS_FILE &&
        ts.isPropertyDeclaration(node) &&
        node.initializer !== undefined
      ) {
        const value = node.initializer;
        const fixed =
          ts.isLiteralExpression(value) ||
          value.kind === ts.SyntaxKind.TrueKeyword ||
          value.kind === ts.SyntaxKind.FalseKeyword ||
          value.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isNewExpression(value) &&
            (value.arguments?.length ?? 0) === 0 &&
            (() => {
              const target = declarationOf(value.expression);
              return target !== undefined && WALKING_CONSTRUCTORS.has(nameOf(target));
            })());
        if (!fixed)
          report(
            value,
            "A field initializer can run before entry charging. Move it into the charged constructor.",
          );
      }
      // a body repeats as often as it is entered: a recursion, a function used as a value, a call through anything
      if (ts.isFunctionLike(node) && node.body !== undefined && !iterated(node)) {
        const first = ts.isBlock(node.body) ? node.body.statements[0] : undefined;
        if (!charges(first))
          report(
            node.name ?? node,
            "A function body goes uncharged: charge a positive unit as its first statement, or hand it as an " +
              "arrow straight to `charged-iteration.ts`.",
          );
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
        // (in objects.ts any object spread: an `object`-typed operand may be an array)
        const type = checker.getTypeAtLocation(node.expression);
        if (
          file === OBJECTS_FILE ||
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
          if (!charged.has(where) && where !== rules.iteration) {
            const name = nameOf(target);
            if (!outside.has(name))
              report(
                node,
                `\`${name}\` is not in OUTSIDE (tools/oxlint/check-charged-iteration.mjs): list it with why a call ` +
                  "walks nothing uncharged, or walk through charged-iteration.ts.",
              );
            // (in objects.ts an allowed function is only called, so the rule below sees each call's arguments; a getter
            // is read, not handed on)
            else if (
              file === OBJECTS_FILE &&
              callAt(node) === undefined &&
              !ts.isGetAccessor(target.declaration)
            )
              report(
                node,
                `\`${name}\` is used as a value, so its calls' arguments escape this check: call it directly, ` +
                  "in an arrow if a helper needs a callback.",
              );
            else if (
              file === OBJECTS_FILE &&
              !OBJECTS_COLLECTIONS.has(name) &&
              (callAt(node)?.arguments ?? []).some(
                (argument) =>
                  !ts.isArrayLiteralExpression(argument) &&
                  collection(checker.getTypeAtLocation(argument)),
              )
            )
              report(
                node,
                `\`${name}\` is handed a collection of any size, which it may walk for one charge: walk it ` +
                  "through charged-iteration.ts, or list the call in OBJECTS_COLLECTIONS with what it does with it.",
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
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (file === OBJECTS_FILE)
      objectsLanguage({
        checker,
        sourceFile,
        iteration: rules.iteration,
        outside,
        fileOf,
        nameOf,
        report,
      });
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
