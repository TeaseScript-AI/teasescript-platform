import { ts } from "ts-morph";

/*
 * The admitted language of `objects.ts` (#1747, #1921): the forms the file needs, each admitted
 * by its original declaration's identity, and every other form rejected. It guards the charging invariant against
 * ordinary edits of the file. It does not establish runtime provenance through carriers (stores, aliases, returns,
 * caller-supplied subclasses): that is a reviewed boundary, and the invariant's runtime evidence (its mutants, the
 * family growth bar, the areas with work compared) is what proves the charging.
 */

/** The helpers of `charged-iteration.ts` the file uses; the others are not admitted. */
const HELPERS = new Set([
  "each",
  "steps",
  "some",
  "copied",
  "sorted",
  "indexed",
  "concatenated",
  "sliced",
  "joined",
]);
/** The helpers handed a collection, and its argument's position. */
const COLLECTION_ARGUMENT = new Map([
  ["each", 2],
  ["some", 2],
  ["copied", 2],
  ["sliced", 2],
  ["joined", 2],
]);
/** The helpers whose result is a fresh array or the helper's own generator. */
const FRESH = new Set(["copied", "sliced", "sorted", "concatenated", "each", "indexed", "steps"]);
/** The only local class, and the native constructions. */
const LOCAL_CLASS = "Gathered";
const NATIVE_CONSTRUCTORS = new Set(["Map", "Set"]);
/** The native members that store into their receiver (gate 4 checks the receiver's element kinds). */
const NATIVE_STORES = new Set(["push", "set", "add"]);
/** The native members whose result is the receiver's own stored content. */
const NATIVE_READS = new Set(["get", "keys", "values", "pop"]);
const KEY_WALK = "src/type-inference/core/contract/key-ids.ts:keyWalk";
const KEY_WALK_PREFIX = "src/type-inference/core/contract/key-ids.ts:KeyWalk.prefix";
const PATH_STEPS = "src/type-inference/core/contract/key-ids.ts:PathSteps";
/** Gate 4's closed set of collection shapes, by lib name, with the position of the element's type argument. */
const COLLECTIONS = new Map([
  ["Array", 0],
  ["ReadonlyArray", 0],
  ["Map", 1],
  ["Set", 0],
  ["Generator", 0],
  ["Iterable", 0],
  // (the lib's own iterator of a `Map`: what `keys()` and `values()` give)
  ["MapIterator", 0],
]);
/** The demand and proof objects' callable properties, which the solver calls. */
const DEMAND_CALLBACKS = new Set(["make", "signature"]);

/**
 * @param {{ checker: ts.TypeChecker, sourceFile: ts.SourceFile, iteration: string, outside: ReadonlySet<string>,
 *   fileOf: (node: ts.Node) => string, nameOf: (target: { symbol: ts.Symbol, declaration: ts.Declaration }) => string,
 *   report: (node: ts.Node, message: string) => void }} context
 */
export function objectsLanguage({
  checker,
  sourceFile,
  iteration,
  outside,
  fileOf,
  nameOf,
  report,
}) {
  const original = (symbol) =>
    symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const targetOf = (node) => {
    const symbol = original(checker.getSymbolAtLocation(node));
    const declaration = symbol?.declarations?.[0];
    return declaration === undefined ? undefined : { symbol, declaration };
  };
  const local = (node) => node.getSourceFile() === sourceFile;
  const strip = (e) => {
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return e;
  };
  const isConstDeclaration = (d) =>
    ts.isVariableDeclaration(d) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
  /** The helper a call calls, by its original export, or `undefined`. */
  const helperOf = (call) => {
    const target = ts.isCallExpression(call) ? targetOf(strip(call.expression)) : undefined;
    return target !== undefined && fileOf(target.declaration) === iteration
      ? target.symbol.name
      : undefined;
  };
  const kind = (type) => {
    if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void))
      return "none";
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unknown";
    if (
      type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.EnumLike |
        ts.TypeFlags.ESSymbolLike)
    )
      return "primitive";
    return checker.isArrayLikeType(type) ? "array" : "object";
  };
  /** Whether every value of a type is a primitive, `null` or `undefined`. */
  const primitiveOnly = (type) =>
    type.isUnion() ? type.types.every(primitiveOnly) : ["primitive", "none"].includes(kind(type));
  /**
   * Gate 4's view of a type: `{ elements }` for a collection of the closed set (`COLLECTIONS`, by its lib name, with
   * the resolved reference's arguments, never an alias's; a union's collection members together), `null` for a value
   * that is no collection, and `"unknown"` for any other shape that can be walked: an interface extending one, an
   * intersection, a tuple, an unrecognised iterable, `any` or `unknown`.
   */
  const shapeOf = (type) => {
    if (type.isUnion()) {
      const elements = [];
      for (const part of type.types) {
        if (kind(part) === "none") continue;
        const shape = shapeOf(part);
        if (shape === "unknown") return "unknown";
        if (shape !== null) elements.push(...shape.elements);
      }
      return elements.length === 0 ? null : { elements };
    }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unknown";
    if (kind(type) === "primitive" || kind(type) === "none") return null;
    if (type.isIntersection())
      return type.types.some((part) => shapeOf(part) !== null) ? "unknown" : null;
    const symbol = type.getSymbol();
    const at = symbol === undefined ? undefined : COLLECTIONS.get(symbol.name);
    const lib = symbol?.declarations?.some((d) => fileOf(d) === "lib") ?? false;
    if (
      at !== undefined &&
      lib &&
      type.flags & ts.TypeFlags.Object &&
      type.objectFlags & ts.ObjectFlags.Reference &&
      !checker.isTupleType(type)
    ) {
      const element = checker.getTypeArguments(type)[at];
      return element === undefined
        ? "unknown"
        : { elements: element.isUnion() ? element.types : [element] };
    }
    const walkable =
      checker.isArrayLikeType(type) ||
      type
        .getProperties()
        .some((property) => String(property.escapedName).startsWith("__@iterator"));
    return walkable ? "unknown" : null;
  };
  /** Whether a collection's elements are of unlike kinds: a primitive beside an array or an object, or two array or object types. */
  const unlike = (elements) => {
    const members = elements.filter((member) => kind(member) !== "none");
    const kinds = members.map(kind);
    const distinct = new Set(members);
    return (
      kinds.includes("unknown") ||
      (distinct.size > 1 && (kinds.includes("array") || kinds.includes("object")))
    );
  };
  /** Gate 4 on a binding, parameter or field: a collection of the closed set of like elements, or no collection. */
  const mixedElements = (type) => {
    const shape = shapeOf(type);
    return shape === "unknown" || (shape !== null && unlike(shape.elements));
  };
  const assignable = (a, b) =>
    typeof checker.isTypeAssignableTo === "function"
      ? checker.isTypeAssignableTo(a, b)
      : checker.typeToString(a) === checker.typeToString(b);
  /**
   * Gate 1's only exceptions, values that carry nothing in: `null`, a primitive literal (a boolean, or a number with its
   * sign, included), `[]`, and a `new` without arguments.
   */
  const trivial = (e) =>
    e.kind === ts.SyntaxKind.NullKeyword ||
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(e) &&
      (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
      (ts.isNumericLiteral(e.operand) || ts.isBigIntLiteral(e.operand))) ||
    (ts.isArrayLiteralExpression(e) && e.elements.length === 0) ||
    (ts.isNewExpression(e) && (e.arguments?.length ?? 0) === 0);
  /**
   * Gate 3: the module's callable exports (an export list's, a default's and a re-export's included), each once, by
   * its declaration, or by its export where it resolves to none here. Only a local function declaration is an entry.
   */
  const callableExports = () => {
    const module = checker.getSymbolAtLocation(sourceFile);
    const found = new Map();
    for (const exported of module === undefined ? [] : checker.getExportsOfModule(module)) {
      const target = original(exported);
      const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
      const at = declaration ?? exported.declarations?.[0];
      if (at === undefined) continue;
      const type = checker.getTypeOfSymbolAtLocation(target ?? exported, at);
      // (each constituent classified: a primitive or `null` is data, an object with no signature data, an object with a
      // call or construct signature callable, anything else unclassifiable and so rejected as callable)
      const callable = (type.isUnion() ? type.types : [type]).some(
        (part) =>
          (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
          part.getCallSignatures().length > 0 ||
          part.getConstructSignatures().length > 0 ||
          (part.isIntersection() &&
            part.types.some(
              (member) =>
                member.getCallSignatures().length > 0 || member.getConstructSignatures().length > 0,
            )),
      );
      if (!callable) continue;
      found.set(declaration ?? at, exported.declarations?.[0] ?? at);
    }
    return found;
  };
  const exportedFunctions = () => {
    const found = new Set();
    for (const declaration of callableExports().keys())
      if (ts.isFunctionDeclaration(declaration) && local(declaration)) found.add(declaration);
    return found;
  };

  // ---- origin: a native receiver's or a helper collection's, traced to a construction or a named reviewed leaf ----
  const tracing = new Set();
  /** `null` where the value's origin is established, else why not. */
  const origin = (e) => {
    e = strip(e);
    if (ts.isArrayLiteralExpression(e)) return null;
    if (ts.isNewExpression(e)) {
      const target = targetOf(e.expression);
      return target !== undefined &&
        fileOf(target.declaration) === "lib" &&
        NATIVE_CONSTRUCTORS.has(target.symbol.name)
        ? null
        : "a construction other than `new Map`/`new Set`";
    }
    if (ts.isConditionalExpression(e)) return origin(e.whenTrue) ?? origin(e.whenFalse);
    if (
      ts.isBinaryExpression(e) &&
      (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
    )
      return (
        (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
          ? null
          : origin(e.left)) ?? origin(e.right)
      );
    if (ts.isYieldExpression(e) && e.asteriskToken !== undefined && e.expression !== undefined)
      return origin(e.expression);
    if (ts.isCallExpression(e)) {
      const callee = strip(e.expression);
      const target = targetOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      if (target === undefined) return "an unresolved call's result";
      const { symbol, declaration } = target;
      if (fileOf(declaration) === iteration)
        return FRESH.has(symbol.name) ? null : `\`${symbol.name}\`'s result`;
      if (outside.has(nameOf(target))) {
        // (a native read gives the receiver's stored content: as established as the receiver)
        if (fileOf(declaration) === "lib")
          return NATIVE_READS.has(symbol.name) && ts.isPropertyAccessExpression(callee)
            ? origin(callee.expression)
            : `\`${symbol.name}\`'s result`;
        return null; // an audited result: a reviewed leaf
      }
      if (
        local(declaration) &&
        (ts.isFunctionDeclaration(declaration) || isConstDeclaration(declaration))
      )
        return returnsOrigin(declaration);
      return "a call result of no admitted callee";
    }
    if (ts.isPropertyAccessExpression(e)) {
      if (e.expression.kind === ts.SyntaxKind.ThisKeyword) return null; // a field of `Gathered`, built in its initializers
      const type = checker.getTypeAtLocation(e.expression);
      const declaration = (type.getSymbol() ?? type.aliasSymbol)?.declarations?.find((d) =>
        ts.isClassLike(d),
      );
      if (declaration !== undefined && !local(declaration) && outsideClass(declaration))
        return null; // an audited record
      return origin(e.expression);
    }
    if (ts.isElementAccessExpression(e)) return origin(e.expression);
    if (e.kind === ts.SyntaxKind.ThisKeyword) return null;
    if (ts.isIdentifier(e)) {
      const symbol = checker.getSymbolAtLocation(e);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration === undefined) return "an unresolved name";
      if (tracing.has(declaration)) return null; // (a cycle adds nothing; its other routes decide)
      tracing.add(declaration);
      try {
        return bindingOrigin(symbol, declaration);
      } finally {
        tracing.delete(declaration);
      }
    }
    return `a ${ts.SyntaxKind[e.kind]}`;
  };
  const outsideClass = (declaration) => {
    const name = declaration.name?.text;
    if (name === undefined) return false;
    const prefix = `${fileOf(declaration)}:${name}.`;
    for (const entry of outside) if (entry.startsWith(prefix)) return true;
    return false;
  };
  const returnsOrigin = (declaration) => {
    const body = ts.isFunctionDeclaration(declaration)
      ? declaration.body
      : declaration.initializer?.body;
    if (body === undefined) return "a local function without a body";
    if (!ts.isBlock(body)) return origin(body);
    let reason = null;
    const visit = (node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined)
        reason ??= origin(node.expression);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return reason;
  };
  const bindingOrigin = (symbol, declaration) => {
    if (ts.isVariableDeclaration(declaration)) {
      const statement = declaration.parent.parent;
      if (ts.isForOfStatement(statement)) return origin(statement.expression);
      let reason = declaration.initializer === undefined ? null : origin(declaration.initializer);
      if (!isConstDeclaration(declaration))
        for (const value of assigned(symbol)) reason ??= origin(value);
      if (declaration.initializer === undefined && assigned(symbol).length === 0)
        return "a binding never given a value";
      return reason;
    }
    if (ts.isBindingElement(declaration)) {
      let top = declaration.parent;
      while (!ts.isVariableDeclaration(top) && !ts.isParameter(top)) top = top.parent;
      if (ts.isParameter(top)) return parameterOrigin(top);
      if (ts.isForOfStatement(top.parent.parent)) return origin(top.parent.parent.expression);
      return top.initializer === undefined
        ? "a destructuring without a value"
        : origin(top.initializer);
    }
    if (ts.isParameter(declaration)) return parameterOrigin(declaration);
    return `a ${ts.SyntaxKind[declaration.kind]}`;
  };
  const assigned = (symbol) => {
    const found = [];
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(
          node.operatorToken.kind,
        ) &&
        checker.getSymbolAtLocation(node.left) === symbol
      )
        found.push(node.right);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  };
  /** An exported function's parameter: the caller's input, a reviewed boundary. Else every call site's argument. */
  const parameterOrigin = (parameter) => {
    const fn = parameter.parent;
    if (ts.isArrowFunction(fn) && ts.isCallExpression(fn.parent)) {
      // an inline callback's item: the helper's collection's
      const helper = helperOf(fn.parent);
      const at = helper === undefined ? undefined : COLLECTION_ARGUMENT.get(helper);
      return at === undefined ? "a callback's parameter" : origin(fn.parent.arguments[at]);
    }
    if (ts.isFunctionDeclaration(fn) && exportedFunctions().has(fn)) return null;
    const index = fn.parameters.indexOf(parameter);
    const owner = ts.isConstructorDeclaration(fn) ? fn.parent : fn;
    const name = owner.name;
    if (name === undefined) return "a parameter of an unnamed function";
    const symbol = checker.getSymbolAtLocation(name);
    let reason = null;
    let calls = 0;
    const visit = (node) => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments !== undefined) {
        const callee = strip(node.expression);
        const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
        if (checker.getSymbolAtLocation(at) === symbol) {
          calls += 1;
          const argument = node.arguments[index];
          if (argument !== undefined) reason ??= origin(argument);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return calls === 0 ? "a parameter of a function never called here" : reason;
  };

  // ---- the forms -------------------------------------------------------------------------------------------------
  const reject = (node, rule, message) =>
    report(
      node,
      `objects.ts admits no ${message} [${rule}] (its language: tools/oxlint/type-core/objects-language.mjs).`,
    );
  /** Whether an arrow stands in one of its three admitted places. */
  const arrowAdmitted = (arrow) => {
    const parent = arrow.parent;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === arrow &&
      isConstDeclaration(parent)
    )
      return true;
    if (ts.isCallExpression(parent) && parent.arguments.includes(arrow))
      return ["steps", "some"].includes(helperOf(parent));
    return (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === arrow &&
      ts.isIdentifier(parent.name) &&
      DEMAND_CALLBACKS.has(parent.name.text)
    );
  };
  /**
   * Whether an expression is written: read through parentheses, non-null and type assertions, and through the array
   * and object literals of a destructuring, up to an assignment's target, an update's operand, a `delete`'s operand or
   * a `for…in`/`for…of` initializer.
   */
  const written = (e) => {
    let at = e;
    for (;;) {
      const p = at.parent;
      if (
        ts.isParenthesizedExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isTypeAssertionExpression(p) ||
        ts.isSatisfiesExpression(p) ||
        ts.isSpreadElement(p) ||
        ts.isSpreadAssignment(p) ||
        ts.isArrayLiteralExpression(p) ||
        ts.isObjectLiteralExpression(p) ||
        (ts.isPropertyAssignment(p) && p.initializer === at) ||
        ts.isShorthandPropertyAssignment(p)
      ) {
        // (a literal is a target only as a destructuring's whole: climb to it, and on)
        at = p;
        continue;
      }
      if (
        ts.isBinaryExpression(p) &&
        p.left === at &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        return true;
      if (
        (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator)
      )
        return true;
      if (ts.isDeleteExpression(p)) return true;
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === at) return true;
      return false;
    }
  };
  const sortedArgument = (call) => {
    if (call.arguments.length > 3) return reject(call, "comparator", "sort comparator");
    if (!ts.isExpressionStatement(call.parent))
      reject(call, "sorted-result", "`sorted` but as a statement, its result discarded");
    const argument = strip(call.arguments[2]);
    const symbol = ts.isIdentifier(argument) ? checker.getSymbolAtLocation(argument) : undefined;
    const declaration = symbol?.valueDeclaration;
    if (
      declaration === undefined ||
      !isConstDeclaration(declaration) ||
      declaration.initializer === undefined ||
      declaration.type !== undefined
    )
      return reject(call, "sorted-made", "`sorted` but over an unannotated `const` made here");
    const made = strip(declaration.initializer);
    const helper = ts.isCallExpression(made) ? helperOf(made) : undefined;
    if (!(ts.isArrayLiteralExpression(made) || helper === "copied" || helper === "concatenated"))
      return reject(
        call,
        "sorted-made",
        "`sorted` but over an array made here by a literal, `copied` or `concatenated`",
      );
    const element = checker.getIndexTypeOfType(
      checker.getTypeAtLocation(declaration),
      ts.IndexKind.Number,
    );
    if (element === undefined || !primitiveOnly(element) || kind(element) === "none")
      return reject(call, "sorted-elements", "`sorted` over elements that are not primitive");
    // never aliased: read only by `.length`, as `sorted`'s array, or as a source `concatenated` copies the elements of;
    // an exported candidate is used by every importer
    if (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export)
      reject(declaration, "sorted-alias", "alias of an array `sorted` sorts (an exported one)");
    /** The symbol an identifier refers to: a shorthand's value, an export specifier's local target. */
    const referent = (node) => {
      const p = node.parent;
      if (ts.isShorthandPropertyAssignment(p) && p.name === node)
        return checker.getShorthandAssignmentValueSymbol(p);
      if (ts.isExportSpecifier(p)) return checker.getExportSpecifierLocalTargetSymbol(p);
      return checker.getSymbolAtLocation(node);
    };
    const visit = (node) => {
      if (ts.isIdentifier(node) && node !== declaration.name && referent(node) === symbol) {
        const p = node.parent;
        // gate 2: only these uses, nothing that writes or keeps it
        const read =
          (ts.isPropertyAccessExpression(p) &&
            p.expression === node &&
            p.name.text === "length" &&
            !written(p)) ||
          (ts.isCallExpression(p) &&
            helperOf(p) === "sorted" &&
            p.arguments[2] === node &&
            ts.isExpressionStatement(p.parent)) ||
          (ts.isArrayLiteralExpression(p) &&
            ts.isCallExpression(p.parent) &&
            helperOf(p.parent) === "concatenated" &&
            p.parent.arguments[2] === p);
        if (!read) reject(node, "sorted-alias", "alias of an array `sorted` sorts");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  };
  /** Gate 4 where the file walks or writes a collection: its element kinds alike. */
  const mixedAt = (e) => {
    const shape = shapeOf(checker.getTypeAtLocation(e));
    if (shape === null || shape === "unknown")
      reject(e, "collection-shape", "walked or written collection but of the closed set of shapes");
    else if (unlike(shape.elements))
      reject(e, "mixed-elements", "collection of mixed element kinds");
  };
  const helperContract = (call, helper) => {
    const at = COLLECTION_ARGUMENT.get(helper);
    if (at !== undefined && call.arguments[at] !== undefined) {
      mixedAt(call.arguments[at]);
      const reason = origin(call.arguments[at]);
      if (reason !== null)
        reject(
          call.arguments[at],
          "helper-origin",
          `\`${helper}\` collection of unestablished origin (${reason})`,
        );
    }
    if (helper === "some" || helper === "steps") {
      const callback = call.arguments[helper === "some" ? 3 : 2];
      if (callback === undefined || !ts.isArrowFunction(strip(callback)))
        reject(call, "callback", `\`${helper}\` callback but an inline arrow`);
    }
    if (helper === "concatenated") {
      const sources = strip(call.arguments[2]);
      if (!ts.isArrayLiteralExpression(sources))
        reject(call, "concatenated-literal", "`concatenated` but over a literal array of sources");
      else
        for (const source of sources.elements) {
          mixedAt(source);
          const reason = origin(source);
          if (reason !== null)
            reject(
              source,
              "concatenated-origin",
              `\`concatenated\` source of unestablished origin (${reason})`,
            );
        }
    }
    if (helper === "indexed") {
      const type = checker.getTypeAtLocation(call.arguments[2]);
      const declaration = (type.getSymbol() ?? type.aliasSymbol)?.declarations?.[0];
      if (
        declaration === undefined ||
        !ts.isClassDeclaration(declaration) ||
        `${fileOf(declaration)}:${declaration.name?.text}` !== PATH_STEPS
      )
        reject(call, "indexed-class", "`indexed` but over the exact `PathSteps`");
    }
    if (helper === "sorted") sortedArgument(call);
  };
  const checkCall = (call) => {
    if (
      ts.isCallExpression(call) &&
      (call.questionDotToken !== undefined ||
        (ts.isPropertyAccessExpression(call.expression) &&
          call.expression.questionDotToken !== undefined))
    )
      return reject(call, "optional-call", "optional call");
    const callee = strip(call.expression);
    if (ts.isIdentifier(callee)) {
      const target = targetOf(callee);
      if (target === undefined) return reject(call, "unresolved", "unresolved callee");
      const { symbol, declaration } = target;
      if (
        (symbol.declarations?.length ?? 0) > 1 &&
        symbol.declarations.some((d) => ts.isFunctionDeclaration(d))
      )
        return reject(call, "overload", "overload");
      if (ts.isNewExpression(call)) {
        if (fileOf(declaration) === "lib" && NATIVE_CONSTRUCTORS.has(symbol.name)) return;
        if (local(declaration) && ts.isClassDeclaration(declaration) && symbol.name === LOCAL_CLASS)
          return;
        return reject(call, "construction", `construction of \`${symbol.name}\``);
      }
      if (fileOf(declaration) === iteration) {
        if (!HELPERS.has(symbol.name)) return reject(call, "helper", `helper \`${symbol.name}\``);
        return helperContract(call, symbol.name);
      }
      if (outside.has(nameOf(target))) return;
      if (
        local(declaration) &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.body !== undefined
      )
        return;
      if (
        local(declaration) &&
        isConstDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        ts.isArrowFunction(declaration.initializer)
      )
        return;
      return reject(
        call,
        "callee",
        `callee \`${symbol.name}\` (a ${ts.SyntaxKind[declaration.kind]})`,
      );
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(call)) {
      const target = targetOf(callee.name);
      if (target === undefined) return reject(call, "unresolved", "unresolved member");
      const { symbol, declaration } = target;
      const owner = declaration.parent;
      if (local(declaration)) {
        if (
          owner !== undefined &&
          ts.isClassDeclaration(owner) &&
          owner.name?.text === LOCAL_CLASS &&
          "body" in declaration &&
          declaration.body !== undefined
        )
          return;
        return reject(call, "local-member", `member \`${symbol.name}\` of a local type`);
      }
      const name = nameOf(target);
      if (name === KEY_WALK_PREFIX) {
        const receiver = strip(callee.expression);
        const bound = ts.isIdentifier(receiver)
          ? checker.getSymbolAtLocation(receiver)?.valueDeclaration
          : undefined;
        const factory =
          bound !== undefined &&
          isConstDeclaration(bound) &&
          bound.initializer !== undefined &&
          ts.isCallExpression(strip(bound.initializer))
            ? targetOf(strip(strip(bound.initializer).expression))
            : undefined;
        if (factory === undefined || nameOf(factory) !== KEY_WALK)
          reject(call, "keywalk", "`KeyWalk.prefix` but on a `const` bound to `keyWalk(…)`");
        return;
      }
      if (!outside.has(name)) return; // (the retained OUTSIDE rule reports it)
      if (fileOf(declaration) === "lib") {
        if (NATIVE_STORES.has(symbol.name)) mixedAt(callee.expression);
        const reason = origin(callee.expression);
        if (reason !== null)
          reject(
            call,
            "native-origin",
            `\`${symbol.name}\` on a receiver of unestablished origin (${reason})`,
          );
      }
      return;
    }
    reject(call, "callee-form", `callee form ${ts.SyntaxKind[callee.kind]}`);
  };

  /** An exported function's parameter: a primitive, a native array of primitives, or an audited class's instance. */
  const entryType = (type) => {
    if (type.isUnion()) return type.types.every(entryType);
    const k = kind(type);
    if (k === "primitive" || k === "none") return true;
    if (k === "array") {
      const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      return element !== undefined && primitiveOnly(element);
    }
    const declaration = (type.getSymbol() ?? type.aliasSymbol)?.declarations?.find((d) =>
      ts.isClassLike(d),
    );
    return declaration !== undefined && !local(declaration) && outsideClass(declaration);
  };
  // gate 3, the module's entries: every callable export a local function declaration, its parameters entry types
  for (const [declaration, exportedAt] of callableExports())
    if (
      ts.isFunctionDeclaration(declaration) &&
      local(declaration) &&
      declaration.body !== undefined
    ) {
      for (const parameter of declaration.parameters)
        if (!entryType(checker.getTypeAtLocation(parameter)))
          reject(
            parameter,
            "entry-parameter",
            "entry parameter but a primitive, a native array of primitives or an audited class",
          );
    } else
      reject(
        local(exportedAt) ? exportedAt : sourceFile,
        "export-form",
        "callable export but a local function declaration",
      );
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) checkCall(node);
    else if (ts.isTaggedTemplateExpression(node))
      reject(node, "tagged-template", "tagged template");
    else if (ts.isAsExpression(node) && node.type.getText(sourceFile) !== "const")
      reject(node, "cast", "cast");
    else if (ts.isTypeAssertionExpression(node)) reject(node, "cast", "cast");
    else if (ts.isSatisfiesExpression(node)) reject(node, "satisfies", "`satisfies`");
    else if (ts.isNamespaceImport(node)) reject(node, "namespace", "namespace import");
    else if (ts.isFunctionExpression(node))
      reject(node, "function-expression", "function expression");
    else if (ts.isArrowFunction(node) && !arrowAdmitted(node))
      reject(
        node,
        "arrow",
        "arrow but a `const` one, a `steps`/`some` callback or a demand's `make`/`signature`",
      );
    else if (
      ts.isClassLike(node) &&
      (node.name?.text !== LOCAL_CLASS || (node.heritageClauses?.length ?? 0) > 0)
    )
      reject(node, "class", "class but `Gathered`, without heritage");
    else if (ts.isObjectLiteralExpression(node)) {
      for (const member of node.properties)
        if (ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member))
          reject(member, "object-method", "object literal method or accessor");
    } else if (
      (ts.isParameter(node) || ts.isBindingElement(node)) &&
      node.initializer !== undefined
    )
      reject(node, "default", "default value");
    else if (ts.isFunctionDeclaration(node) && node.body === undefined)
      reject(node, "bodiless", "overload or bodiless function");
    if (
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      node.initializer !== undefined
    ) {
      // gate 1: the whole value typed as the binding, both ways, but for the four trivial values
      const declared = checker.getTypeFromTypeNode(node.type);
      const given = checker.getTypeAtLocation(node.initializer);
      if (
        !trivial(node.initializer) &&
        (!assignable(declared, given) || !assignable(given, declared))
      )
        reject(node, "widening", "binding typed otherwise than its value (a widening alias)");
    }
    // gate 4 on every binding, parameter and field (and, in `helperContract` and `checkCall`, on every collection the
    // file walks or writes); gate 5 on every value expression, `this` and `yield` included
    const value = valueExpression(node);
    // (a binding by its name's type: a destructuring's elements each by their own names)
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isBindingElement(node)) &&
      !ts.isObjectBindingPattern(node.name) &&
      !ts.isArrayBindingPattern(node.name) &&
      mixedElements(checker.getTypeAtLocation(node.name))
    )
      reject(node, "mixed-elements", "collection of mixed element kinds");
    if (value) {
      const type = checker.getTypeAtLocation(node);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
        reject(node, "any", "`any` or `unknown` value");
    }
    ts.forEachChild(node, visit);
  };
  /**
   * Whether a node is a value expression whose value is used: an expression (`this` included) outside types, imports
   * and exports, not a declared or member name, and not a `yield` whose value is discarded.
   */
  const valueExpression = (node) =>
    (ts.isExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword) &&
    // (a parenthesised expression is its content's value, checked there)
    !ts.isParenthesizedExpression(node) &&
    !inType(node) &&
    !(ts.isYieldExpression(node) && discarded(node)) &&
    !ts.isOmittedExpression(node) &&
    valuePosition(node);
  /** Whether an expression's value is discarded: a statement's whole, through parentheses. */
  const discarded = (node) => {
    let at = node;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    return ts.isExpressionStatement(at.parent);
  };
  /** Whether a node stands inside a type (a literal type's literal included). */
  const inType = (node) => {
    for (let at = node; at !== undefined; at = at.parent) if (ts.isTypeNode(at)) return true;
    return false;
  };
  const valuePosition = (node) => {
    for (let at = node; at !== undefined; at = at.parent)
      if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return false;
    const p = node.parent;
    if (p === undefined) return false;
    // (a declared name is no value; a shorthand property's name is its value's reference)
    if (
      "name" in p &&
      p.name === node &&
      !ts.isPropertyAccessExpression(p) &&
      !ts.isShorthandPropertyAssignment(p)
    )
      return false;
    if (ts.isBindingElement(p) && p.propertyName === node) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
    return true;
  };
  visit(sourceFile);
}
