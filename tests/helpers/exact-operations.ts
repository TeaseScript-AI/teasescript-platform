import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

/*
 * The colour conversion's closed admission (#2147, `tests/runtime/colour-conversion.test.ts`). Its claim, by purpose:
 * every operation reachable from `normalizeColor`, outside colorjs.io's pinned parser, is one whose result ECMAScript
 * specifies for its operand domain, so the text of a normalized colour is the same in every engine. A reproduction that
 * this admits and that is not exact is a defect of this check. Its limits, stated: colorjs.io's parse path (pinned by
 * the lockfile; exact for authored numbers of at most 20 significant digits), and that a finite argument to
 * `cubeRoot`, `atan2Degrees`, `sinDegrees` or `cosDegrees` never brings a non-finite value to `decompose`'s float
 * storage, which the colour path's finite wrappers rely on and a family of finite extremes shows, as evidence.
 *
 * It decides, by TypeScript's symbols and types, for:
 * - all four files: `Math` only as a direct call of an exact member or a read of `PI`; no `globalThis`, `window` or
 *   `self`; no `**` on numbers; imports equal to `PINNED_IMPORTS`; no dynamic `import()`;
 * - `src/color-text.ts`, whole: only `TEXT_KINDS`; numbers become text only by `toPrecision(15)` or `toPrecision(17)` on
 *   a number; string methods with literal arguments on strings; `+` on two strings;
 * - `normalizeColor`: every return is `null` or the one template of three calls of the text module's `formatNumber`;
 * - the closure from `normalizeColor` (every statically resolved callee, the module constants it reads and their
 *   initializers): only `CLOSURE_KINDS`, operators on their own operand types, admitted callees and globals, writes
 *   only to local storage, module constants never written, aliased or passed out, checked functions never reassigned;
 * - the two float-storage bodies (`decompose`, `powerOfTwo`) and the colour path's four finite wrappers, by structure.
 * Anything else is an escape, named by file, line and form.
 */

const CHECKED_FILES = [
  "src/color.ts",
  "src/color-text.ts",
  "src/deterministic-math.ts",
  "src/numeric-functions.ts",
];
const TEXT_MODULE = "src/color-text.ts";

/** Each file's import declarations: a module, its default binding, its named bindings (`type` marked). */
const PINNED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/color.ts": [
    "colorjs.io: Color {}",
    "./deterministic-math.js: {atan2Degrees, cosDegrees, cubeRoot, sinDegrees}",
    "./color-text.js: {formatNumber}",
    "./numeric-functions.js: {positivePower}",
  ],
  "src/color-text.ts": [],
  "src/deterministic-math.ts": [],
  "src/numeric-functions.ts": [
    "./angle.js: {angleValue, formatAngle, type StoredAngle}",
    "./conversions.js: {withoutNegativeZero}",
    "./deterministic-math.js: {acosDegrees, asinDegrees, atan2Degrees, atanDegrees, cosDegrees, degreesToRadians, exp, ln, log10, sinDegrees, tanDegrees}",
    "type ./language-facts.js: {NumericFunctionName}",
  ],
};

/** Math members whose results ECMA-262 specifies for numbers (Math.abs … Math.trunc); `PI` is a constant. */
const EXACT_MATH = new Set([
  "abs",
  "ceil",
  "floor",
  "max",
  "min",
  "round",
  "sign",
  "sqrt",
  "trunc",
]);

const K = ts.SyntaxKind;
/** The syntax of `src/color-text.ts`. */
const TEXT_KINDS = new Set<ts.SyntaxKind>([
  K.SourceFile,
  K.EndOfFileToken,
  K.FunctionDeclaration,
  K.ExportKeyword,
  K.Parameter,
  K.NumberKeyword,
  K.StringKeyword,
  K.Block,
  K.VariableStatement,
  K.VariableDeclarationList,
  K.VariableDeclaration,
  K.Identifier,
  K.NumericLiteral,
  K.StringLiteral,
  K.IfStatement,
  K.WhileStatement,
  K.ReturnStatement,
  K.ExpressionStatement,
  K.ConditionalExpression,
  K.QuestionToken,
  K.ColonToken,
  K.BinaryExpression,
  K.EqualsEqualsEqualsToken,
  K.GreaterThanToken,
  K.PlusToken,
  K.EqualsToken,
  K.PrefixUnaryExpression,
  K.CallExpression,
  K.PropertyAccessExpression,
  K.ElementAccessExpression,
  K.NonNullExpression,
]);

/** The syntax of the closure from `normalizeColor` (functions, local arrows, module constants and their initializers). */
const CLOSURE_KINDS = new Set<ts.SyntaxKind>([
  ...TEXT_KINDS,
  K.ArrowFunction,
  K.EqualsGreaterThanToken,
  K.ArrayLiteralExpression,
  K.ObjectLiteralExpression,
  K.PropertyAssignment,
  K.ShorthandPropertyAssignment,
  K.SpreadAssignment,
  K.SpreadElement,
  K.ArrayBindingPattern,
  K.BindingElement,
  K.ParenthesizedExpression,
  K.NewExpression,
  K.TemplateExpression,
  K.TemplateHead,
  K.TemplateMiddle,
  K.TemplateTail,
  K.TemplateSpan,
  K.RegularExpressionLiteral,
  K.ForStatement,
  K.SwitchStatement,
  K.CaseBlock,
  K.CaseClause,
  K.DefaultClause,
  K.BreakStatement,
  K.TryStatement,
  K.CatchClause,
  K.ThrowStatement,
  K.TypeOfExpression,
  K.TrueKeyword,
  K.FalseKeyword,
  K.NullKeyword,
  K.AmpersandAmpersandToken,
  K.BarBarToken,
  K.QuestionQuestionToken,
  K.ExclamationEqualsEqualsToken,
  K.LessThanToken,
  K.LessThanEqualsToken,
  K.GreaterThanEqualsToken,
  K.MinusToken,
  K.AsteriskToken,
  K.SlashToken,
  K.PercentToken,
  K.PlusEqualsToken,
  K.MinusEqualsToken,
  K.AsteriskEqualsToken,
  K.SlashEqualsToken,
  // Type syntax: types decide nothing at run time.
  K.TypeReference,
  K.ArrayType,
  K.TupleType,
  K.UnionType,
  K.LiteralType,
  K.TypeOperator,
  K.TypeLiteral,
  K.PropertySignature,
  K.ReadonlyKeyword,
  K.BooleanKeyword,
  K.UndefinedKeyword,
  K.UnknownKeyword,
  K.VoidKeyword,
  K.NamedTupleMember,
  K.QualifiedName,
  K.ImportType,
  K.ImportTypeAssertionContainer,
]);

const ASSIGNMENTS = new Set([
  K.EqualsToken,
  K.PlusEqualsToken,
  K.MinusEqualsToken,
  K.AsteriskEqualsToken,
  K.SlashEqualsToken,
]);
const ARITHMETIC = new Set([K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken]);
const ORDER = new Set([
  K.LessThanToken,
  K.LessThanEqualsToken,
  K.GreaterThanToken,
  K.GreaterThanEqualsToken,
]);
const ANY_OPERANDS = new Set([
  K.EqualsEqualsEqualsToken,
  K.ExclamationEqualsEqualsToken,
  K.AmpersandAmpersandToken,
  K.BarBarToken,
  K.QuestionQuestionToken,
]);

/** The escapes of the checked files, optionally with some files' text replaced (`overrides`, by path). */
export function exactOperationEscapes(overrides: Readonly<Record<string, string>> = {}): string[] {
  const config = ts.readConfigFile(resolve(process.cwd(), "tsconfig.json"), (file) =>
    readFileSync(file, "utf8"),
  );
  const options = {
    ...ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (file) => overrides[relative(process.cwd(), file)] ?? read(file);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language) => {
    const text = overrides[relative(process.cwd(), file)];
    return text === undefined
      ? getSource(file, language)
      : ts.createSourceFile(file, text, language, true);
  };
  const program = ts.createProgram(
    CHECKED_FILES.map((file) => resolve(process.cwd(), file)),
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const escapes: string[] = [];
  const fileName = (node: ts.Node) => relative(process.cwd(), node.getSourceFile().fileName);
  const escape = (node: ts.Node, form: string) =>
    escapes.push(
      `${fileName(node)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1} ${form}`,
    );
  const symbolOf = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  };
  const isLibrary = (node: ts.Node) =>
    (checker.getSymbolAtLocation(node)?.declarations ?? []).some((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    );
  const typeName = (node: ts.Expression) => {
    const type = checker.getTypeAtLocation(node);
    const all = (flag: ts.TypeFlags) =>
      (type.isUnion() ? type.types : [type]).every((member) => (member.flags & flag) !== 0);
    if (all(ts.TypeFlags.StringLike)) return "string";
    if (all(ts.TypeFlags.NumberLike)) return "number";
    if (all(ts.TypeFlags.BigIntLike)) return "bigint";
    if (all(ts.TypeFlags.BooleanLike)) return "boolean";
    if (checker.isArrayType(type) || checker.isTupleType(type)) return "array";
    return type.getSymbol()?.name ?? "unknown";
  };
  const inTypePosition = (node: ts.Node) =>
    ts.findAncestor(node, (a) => ts.isTypeNode(a)) !== undefined;
  const isName = (node: ts.Identifier) => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
    if (ts.isQualifiedName(parent)) return parent.right === node;
    if (ts.isBindingElement(parent)) return parent.propertyName === node;
    if (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent))
      return parent.name === node;
    return false;
  };
  const sources = Object.fromEntries(
    CHECKED_FILES.map((file) => [file, program.getSourceFile(resolve(process.cwd(), file))!]),
  );

  // All four files: Math, the global object, `**` on numbers, imports.
  for (const file of CHECKED_FILES) {
    const source = sources[file]!;
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const named =
          clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements.map(
                (element) =>
                  `${element.isTypeOnly ? "type " : ""}${element.propertyName ? `${element.propertyName.text} as ` : ""}${element.name.text}`,
              )
            : clause?.namedBindings !== undefined
              ? ["* namespace"]
              : [];
        imports.push(
          `${clause?.isTypeOnly ? "type " : ""}${node.moduleSpecifier.text}: ${clause?.name ? `${clause.name.text} ` : ""}{${named.join(", ")}}`,
        );
      }
      if (ts.isCallExpression(node) && node.expression.kind === K.ImportKeyword)
        escape(node, "a dynamic import");
      if (ts.isIdentifier(node) && !isName(node)) {
        const parent = node.parent;
        if (["globalThis", "window", "self"].includes(node.text)) escape(node, node.text);
        const declares =
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isBindingElement(parent) ||
            ts.isImportSpecifier(parent) ||
            ts.isImportClause(parent)) &&
          parent.name === node;
        if (node.text === "Math" && declares) escape(node, "a binding named Math");
        else if (node.text === "Math" && !inTypePosition(node)) {
          const member =
            ts.isPropertyAccessExpression(parent) && parent.expression === node
              ? parent.name.text
              : null;
          const called =
            member !== null &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent;
          if (
            !isLibrary(node) ||
            member === null ||
            !(member === "PI" ? !called : called && EXACT_MATH.has(member))
          )
            escape(node, member === null ? "Math as a value" : `Math.${member}`);
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === K.AsteriskAsteriskToken ||
          node.operatorToken.kind === K.AsteriskAsteriskEqualsToken) &&
        !(typeName(node.left) === "bigint" && typeName(node.right) === "bigint")
      )
        escape(node, "** on numbers");
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (JSON.stringify(imports) !== JSON.stringify(PINNED_IMPORTS[file]))
      escape(source, `imports ${JSON.stringify(imports)}`);
  }

  // The text module, whole.
  const text = sources[TEXT_MODULE]!;
  const checkText = (node: ts.Node): void => {
    if (!TEXT_KINDS.has(node.kind)) escape(node, `${K[node.kind]} in the text module`);
    if (ts.isIdentifier(node) && !isName(node) && !inTypePosition(node)) {
      const symbol = symbolOf(node);
      const local = (symbol?.declarations ?? []).every(
        (declaration) => declaration.getSourceFile() === text,
      );
      if (!local && node.text !== "Math") escape(node, `a free ${node.text} in the text module`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const literals = node.arguments.every(
        (argument) =>
          ts.isStringLiteral(argument) ||
          ts.isNumericLiteral(argument) ||
          (ts.isPrefixUnaryExpression(argument) && ts.isNumericLiteral(argument.operand)),
      );
      const admitted =
        ts.isPropertyAccessExpression(callee) &&
        ((callee.name.text === "toPrecision" &&
          typeName(callee.expression) === "number" &&
          node.arguments.length === 1 &&
          ts.isNumericLiteral(node.arguments[0]!) &&
          ["15", "17"].includes(node.arguments[0].text)) ||
          (ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Math" &&
            callee.name.text === "abs" &&
            typeName(node.arguments[0]!) === "number") ||
          (typeName(callee.expression) === "string" &&
            ["split", "endsWith", "includes", "slice"].includes(callee.name.text) &&
            literals &&
            node.arguments.length > 0));
      if (!admitted) escape(node, `a call of ${callee.getText()} in the text module`);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === K.PlusToken &&
      !(typeName(node.left) === "string" && typeName(node.right) === "string")
    )
      escape(node, "+ not on two strings in the text module");
    if (ts.isElementAccessExpression(node) && !ts.isNumericLiteral(node.argumentExpression))
      escape(node, "a computed element in the text module");
    if (
      ts.isPropertyAccessExpression(node) &&
      !ts.isCallExpression(node.parent) &&
      !(node.name.text === "length" && typeName(node.expression) === "array")
    )
      escape(node, `a property read ${node.getText()} in the text module`);
    if (
      ts.isVariableDeclaration(node) &&
      node.parent.parent.parent === text &&
      !(node.initializer && ts.isNumericLiteral(node.initializer))
    )
      escape(node, "a module constant that is not a number literal in the text module");
    ts.forEachChild(node, checkText);
  };
  ts.forEachChild(text, checkText);
  for (const statement of text.statements)
    if (!ts.isFunctionDeclaration(statement) && !ts.isVariableStatement(statement))
      escape(statement, "a statement outside a function in the text module");

  // `normalizeColor`'s output.
  const color = sources["src/color.ts"]!;
  const normalize = color.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "normalizeColor",
  )!;
  const formatter = text.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "formatNumber",
  );
  const formatterSymbol =
    formatter?.name === undefined ? undefined : checker.getSymbolAtLocation(formatter.name);
  const returns = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== normalize) return;
    if (ts.isReturnStatement(node)) {
      const value = node.expression;
      const formatted =
        value !== undefined &&
        ts.isTemplateExpression(value) &&
        value.head.text === "oklch(" &&
        value.templateSpans.length === 3 &&
        value.templateSpans.every(
          (span, index) =>
            span.literal.text === (index === 2 ? ")" : " ") &&
            ts.isCallExpression(span.expression) &&
            formatterSymbol !== undefined &&
            symbolOf(span.expression.expression) === formatterSymbol,
        );
      if (!(value?.kind === K.NullKeyword || formatted))
        escape(node, "a normalizeColor return that is not null or the formatted template");
    }
    ts.forEachChild(node, returns);
  };
  ts.forEachChild(normalize, returns);

  // The closure from `normalizeColor`.
  const checked = new Set<ts.Node>();
  const constants = new Set<ts.Symbol>();
  const functions = new Set<ts.Symbol>();
  const queue: ts.Node[] = [normalize];
  const PRIMITIVES = new Set(["decompose", "powerOfTwo"]);
  const enqueue = (symbol: ts.Symbol, at: ts.Node): boolean => {
    const declaration = symbol.declarations?.[0];
    if (declaration === undefined || !CHECKED_FILES.includes(fileName(declaration))) return false;
    if (fileName(declaration) === TEXT_MODULE) return ts.isFunctionDeclaration(declaration);
    if (
      ts.isFunctionDeclaration(declaration) &&
      declaration.parent === declaration.getSourceFile()
    ) {
      functions.add(symbol);
      queue.push(declaration);
      return true;
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.parent.parent.parent === declaration.getSourceFile() &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ) {
      if (declaration.initializer !== undefined && ts.isArrowFunction(declaration.initializer))
        functions.add(symbol);
      else constants.add(symbol);
      queue.push(declaration);
      return true;
    }
    escape(at, `a reference to ${symbol.name}, neither a function nor a module constant`);
    return true;
  };
  const isLocal = (symbol: ts.Symbol | undefined, owner: ts.Node) =>
    (symbol?.declarations ?? []).length > 0 &&
    symbol!.declarations!.every(
      (declaration) => ts.findAncestor(declaration, (a) => a === owner) !== undefined,
    );
  const rootOf = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    )
      current = current.expression;
    return current;
  };
  const colorBinding = color.statements
    .filter(ts.isImportDeclaration)
    .find(
      (statement) =>
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "colorjs.io",
    )?.importClause?.name;
  const colorSymbol =
    colorBinding === undefined ? undefined : checker.getSymbolAtLocation(colorBinding);
  const parsedObjects = new Set<ts.Symbol>();
  const GLOBALS = new Set([
    "Math",
    "Number",
    "Infinity",
    "NaN",
    "undefined",
    "Error",
    "RegExp",
    "DataView",
    "ArrayBuffer",
  ]);

  const checkClosure = (owner: ts.Node) => {
    const primitive =
      ts.isFunctionDeclaration(owner) &&
      PRIMITIVES.has(owner.name?.text ?? "") &&
      fileName(owner) === "src/deterministic-math.ts";
    const visit = (node: ts.Node): void => {
      if (!CLOSURE_KINDS.has(node.kind) && !ts.isTypeNode(node))
        escape(node, `${K[node.kind]} in ${nameOf(owner)}`);
      if (ts.isIdentifier(node) && !isName(node) && !inTypePosition(node)) {
        const parent = node.parent;
        const declares =
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isBindingElement(parent)) &&
          parent.name === node;
        const symbol = symbolOf(node);
        if (!declares && symbol !== undefined && !isLocal(symbol, owner)) {
          if (colorSymbol !== undefined && checker.getSymbolAtLocation(node) === colorSymbol)
            checkColorUse(node);
          else if (isLibrary(node)) {
            if (!GLOBALS.has(node.text)) escape(node, `the global ${node.text}`);
            if (["DataView", "ArrayBuffer"].includes(node.text) && !primitive)
              escape(node, `${node.text} outside the float-storage primitives`);
          } else if (node.text === "undefined" && (symbol.declarations ?? []).length === 0) {
            // The undefined value.
          } else if (!enqueue(symbol, node)) escape(node, `a free ${node.text}`);
          if (functions.has(symbol) && !(ts.isCallExpression(parent) && parent.expression === node))
            escape(node, `the function ${node.text} as a value`);
        }
        if (symbol !== undefined && parsedObjects.has(symbol) && !declares) checkParsedUse(node);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) checkCall(node, owner, primitive);
      if (ts.isBinaryExpression(node)) checkBinary(node, owner);
      if (ts.isTemplateSpan(node) && !["string", "bigint"].includes(typeName(node.expression)))
        escape(node, `a template span of ${typeName(node.expression)}`);
      if (
        ts.isPrefixUnaryExpression(node) &&
        ![K.MinusToken, K.ExclamationToken].includes(node.operator)
      )
        escape(node, `the unary ${K[node.operator]}`);
      if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === K.MinusToken &&
        typeName(node.operand) !== "number"
      )
        escape(node, "unary minus on a non-number");
      if (ts.isElementAccessExpression(node)) {
        const index = node.argumentExpression;
        if (!(
          ts.isNumericLiteral(index) ||
          (typeName(node.expression) === "array" && typeName(index) === "number")
        ))
          escape(node, "an element access other than a numeric index of an array");
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        typeName(node.expression) === "unknown" &&
        !ts.isIdentifier(node.expression)
      )
        escape(node, `a property read of an unknown value: ${node.getText()}`);
      if (ts.isCatchClause(node) && node.variableDeclaration !== undefined)
        escape(node, "a caught error read");
      if (
        ts.isThrowStatement(node) &&
        !(
          ts.isNewExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Error" &&
          (node.expression.arguments ?? []).every(ts.isStringLiteral)
        )
      )
        escape(node, "a throw other than new Error with a literal");
      ts.forEachChild(node, visit);
    };
    if (ts.isVariableDeclaration(owner)) {
      if (owner.initializer !== undefined) visit(owner.initializer);
    } else ts.forEachChild(owner, visit);
  };
  const nameOf = (owner: ts.Node) =>
    (ts.isFunctionDeclaration(owner) || ts.isVariableDeclaration(owner)) &&
    owner.name !== undefined &&
    ts.isIdentifier(owner.name)
      ? owner.name.text
      : "?";
  const checkColorUse = (node: ts.Identifier) => {
    const parent = node.parent;
    const created = ts.isNewExpression(parent) && parent.expression === node;
    const alpha =
      created &&
      ts.isPropertyAccessExpression(parent.parent) &&
      parent.parent.name.text === "alpha";
    const declaration =
      created &&
      ts.isVariableDeclaration(parent.parent) &&
      ts.isIdentifier(parent.parent.name) &&
      (ts.getCombinedNodeFlags(parent.parent) & ts.NodeFlags.Const) !== 0
        ? parent.parent
        : null;
    if (declaration !== null && ts.isIdentifier(declaration.name))
      parsedObjects.add(checker.getSymbolAtLocation(declaration.name)!);
    else if (!alpha) escape(node, "a colorjs.io use");
  };
  const assigned = (target: ts.Node) =>
    ts.isBinaryExpression(target.parent) &&
    target.parent.left === target &&
    ASSIGNMENTS.has(target.parent.operatorToken.kind);
  const checkParsedUse = (node: ts.Identifier) => {
    const read =
      ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        ? node.parent
        : null;
    const grand = read?.parent;
    const admitted =
      read !== null &&
      ((read.name.text === "alpha" && !assigned(read)) ||
        (read.name.text === "space" &&
          grand !== undefined &&
          ts.isPropertyAccessExpression(grand) &&
          grand.name.text === "id") ||
        (read.name.text === "coords" &&
          grand !== undefined &&
          ts.isElementAccessExpression(grand) &&
          ts.isNumericLiteral(grand.argumentExpression) &&
          ["0", "1", "2"].includes(grand.argumentExpression.text) &&
          !assigned(grand)));
    if (!admitted) escape(node, "a parsed colorjs.io object's use");
  };
  const checkCall = (
    node: ts.CallExpression | ts.NewExpression,
    owner: ts.Node,
    primitive: boolean,
  ) => {
    const callee = node.expression;
    const args = node.arguments ?? [];
    const symbol = ts.isIdentifier(callee) ? symbolOf(callee) : undefined;
    if (symbol !== undefined && !isLocal(symbol, owner) && !isLibrary(callee))
      enqueue(symbol, node);
    const admitted =
      (symbol !== undefined &&
        (functions.has(symbol) ||
          isLocal(symbol, owner) ||
          (colorSymbol !== undefined && checker.getSymbolAtLocation(callee) === colorSymbol))) ||
      (symbol !== undefined && fileName(symbol.declarations?.[0] ?? node) === TEXT_MODULE) ||
      (ts.isIdentifier(callee) &&
        callee.text === "Error" &&
        isLibrary(callee) &&
        ts.isNewExpression(node) &&
        args.every(ts.isStringLiteral)) ||
      (ts.isIdentifier(callee) &&
        callee.text === "RegExp" &&
        isLibrary(callee) &&
        ts.isNewExpression(node) &&
        args.every((argument) => typeName(argument) === "string")) ||
      (primitive &&
        ts.isIdentifier(callee) &&
        ["DataView", "ArrayBuffer"].includes(callee.text) &&
        isLibrary(callee)) ||
      (ts.isPropertyAccessExpression(callee) &&
        ((ts.isIdentifier(callee.expression) &&
          callee.expression.text === "Math" &&
          args.every((argument) => typeName(argument) === "number")) ||
          (ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Number" &&
            callee.name.text === "isFinite" &&
            isLibrary(callee.expression)) ||
          (typeName(callee.expression) === "string" &&
            ["trim", "toLowerCase"].includes(callee.name.text) &&
            args.length === 0) ||
          (typeName(callee.expression) === "RegExp" &&
            ["test", "exec"].includes(callee.name.text) &&
            args.length === 1 &&
            typeName(args[0]!) === "string") ||
          (typeName(callee.expression) === "array" &&
            callee.name.text === "every" &&
            args.length === 1 &&
            ts.isArrowFunction(args[0]!)) ||
          (primitive &&
            typeName(callee.expression) === "DataView" &&
            ["setFloat64", "getFloat64", "setUint32", "getUint32"].includes(callee.name.text) &&
            ts.isNumericLiteral(args[0]!) &&
            args.at(-1)!.kind === K.FalseKeyword)));
    if (!admitted) escape(node, `a call of ${callee.getText()} in ${nameOf(owner)}`);
  };
  const checkBinary = (node: ts.BinaryExpression, owner: ts.Node) => {
    const operator = node.operatorToken.kind;
    const left = typeName(node.left);
    const right = typeName(node.right);
    if (ASSIGNMENTS.has(operator)) {
      const root = rootOf(node.left);
      if (!ts.isIdentifier(root) || !isLocal(symbolOf(root), owner))
        escape(node, `a write to ${node.left.getText()}, not local storage`);
      if (
        operator === K.PlusEqualsToken &&
        !((left === "number" && right === "number") || (left === "string" && right === "string"))
      )
        escape(node, `+= on ${left} and ${right}`);
      if (
        operator !== K.EqualsToken &&
        operator !== K.PlusEqualsToken &&
        !(left === "number" && right === "number")
      )
        escape(node, `${K[operator]} on ${left} and ${right}`);
    } else if (operator === K.PlusToken) {
      if (!(
        (left === "number" && right === "number") ||
        (left === "string" && right === "string") ||
        (left === "bigint" && right === "bigint")
      ))
        escape(node, `+ on ${left} and ${right}`);
    } else if (ARITHMETIC.has(operator) || ORDER.has(operator)) {
      if (!((left === "number" && right === "number") || (left === "bigint" && right === "bigint")))
        escape(node, `${K[operator]} on ${left} and ${right}`);
    } else if (!ANY_OPERANDS.has(operator)) escape(node, `the operator ${K[operator]}`);
  };
  while (queue.length > 0) {
    const owner = queue.pop()!;
    if (checked.has(owner)) continue;
    checked.add(owner);
    checkClosure(owner);
  }

  // Module constants: never written, aliased or passed out; checked functions never reassigned. Everywhere in their
  // file, not only in the closure: code outside it could otherwise change what the closure reads.
  for (const symbol of [...constants, ...functions]) {
    const declaration = symbol.declarations![0]!;
    const declaredName =
      ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)
        ? declaration.name
        : undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        !isName(node) &&
        checker.getSymbolAtLocation(node) === symbol &&
        node !== declaredName
      ) {
        let use: ts.Node = node;
        while (
          ts.isPropertyAccessExpression(use.parent) ||
          ts.isElementAccessExpression(use.parent) ||
          ts.isNonNullExpression(use.parent) ||
          ts.isParenthesizedExpression(use.parent) ||
          ts.isAsExpression(use.parent) ||
          ts.isTypeAssertionExpression(use.parent) ||
          ts.isSatisfiesExpression(use.parent)
        ) {
          // An assertion can widen a readonly type to a writable one.
          if (ts.isAsExpression(use.parent) || ts.isTypeAssertionExpression(use.parent))
            escape(node, `a type assertion on ${symbol.name}`);
          use = use.parent;
        }
        const parent = use.parent;
        if (
          assigned(use) ||
          ts.isPostfixUnaryExpression(parent) ||
          (ts.isPrefixUnaryExpression(parent) &&
            [K.PlusPlusToken, K.MinusMinusToken].includes(parent.operator)) ||
          ts.isDeleteExpression(parent)
        )
          escape(node, `a write to ${symbol.name}`);
        const aliasing =
          ts.isVariableDeclaration(parent) ||
          ts.isReturnStatement(parent) ||
          ts.isArrayLiteralExpression(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isShorthandPropertyAssignment(parent) ||
          ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
            parent.expression !== use);
        if (constants.has(symbol) && aliasing && !deeplyReadonly(checker.getTypeAtLocation(use)))
          escape(node, `${use.getText()}, a mutable part of ${symbol.name}, aliased`);
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
  }

  // The float-storage primitives, by structure.
  const math = sources["src/deterministic-math.ts"]!;
  const decompose = math.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "decompose",
  );
  if (decompose !== undefined) {
    const parameter = decompose.parameters[0]!.name;
    const parameterSymbol = ts.isIdentifier(parameter)
      ? checker.getSymbolAtLocation(parameter)
      : undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        ASSIGNMENTS.has(node.operatorToken.kind) &&
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === parameterSymbol
      )
        escape(node, "decompose writes its parameter");
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "setFloat64"
      ) {
        const operand = node.arguments[1];
        const isParameter = (expression: ts.Expression | undefined) =>
          expression !== undefined &&
          ts.isIdentifier(expression) &&
          checker.getSymbolAtLocation(expression) === parameterSymbol;
        const scaled = (expression: ts.Expression) =>
          ts.isBinaryExpression(expression) &&
          expression.operatorToken.kind === K.AsteriskToken &&
          isParameter(expression.left) &&
          ts.isNumericLiteral(expression.right);
        const admitted =
          operand !== undefined &&
          (isParameter(operand) ||
            (ts.isConditionalExpression(operand) &&
              scaled(operand.whenTrue) &&
              isParameter(operand.whenFalse)));
        if (!admitted) escape(node, "decompose stores a value other than its parameter");
      }
      ts.forEachChild(node, visit);
    };
    visit(decompose);
  }
  for (const statement of math.statements)
    if (!(ts.isFunctionDeclaration(statement) && PRIMITIVES.has(statement.name?.text ?? ""))) {
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && ["DataView", "ArrayBuffer"].includes(node.text))
          escape(node, `${node.text} outside the float-storage primitives`);
        ts.forEachChild(node, visit);
      };
      visit(statement);
    }
  // The colour path's finite wrappers: the only callers of the four imports, each checking exactly what it passes on.
  const WRAPPED = new Set(["cubeRoot", "atan2Degrees", "sinDegrees", "cosDegrees"]);
  const visitColor = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && WRAPPED.has(node.text) && !ts.isImportSpecifier(node.parent)) {
      const wrapper = ts.findAncestor(node, ts.isFunctionDeclaration);
      const call = node.parent;
      const parameters = wrapper?.parameters.map((parameter) => parameter.name.getText()) ?? [];
      const first = wrapper?.body?.statements[0];
      const guard =
        first !== undefined &&
        ts.isIfStatement(first) &&
        ts.isReturnStatement(first.thenStatement) &&
        first.thenStatement.expression?.getText() === "Number.NaN" &&
        first.expression.getText().replace(/\s+/g, "") ===
          parameters.map((parameter) => `!Number.isFinite(${parameter})`).join("||");
      const passes =
        ts.isCallExpression(call) &&
        call.expression === node &&
        call.arguments.map((argument) => argument.getText()).join() === parameters.join() &&
        wrapper?.body?.statements.length === 2 &&
        ts.isReturnStatement(wrapper.body.statements[1]!) &&
        wrapper.body.statements[1].expression === call;
      if (!(guard && passes)) escape(node, `${node.text} called outside a finite wrapper`);
    }
    ts.forEachChild(node, visitColor);
  };
  visitColor(color);
  return escapes;

  /** Whether nothing of `type` can be written: a primitive, or readonly arrays, tuples and properties all the way down. */
  function deeplyReadonly(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return true;
    seen.add(type);
    if (type.isUnion()) return type.types.every((member) => deeplyReadonly(member, seen));
    if (
      type.flags &
      (ts.TypeFlags.NumberLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined)
    )
      return true;
    if (checker.isTupleType(type)) {
      // EVIDENCE: invariant: `isTupleType` holds only for a type reference whose target is a tuple type.
      const reference = type as ts.TypeReference;
      // EVIDENCE: invariant: as above, the reference's target is the tuple type.
      if (!(reference.target as ts.TupleType).readonly) return false;
      return checker.getTypeArguments(reference).every((member) => deeplyReadonly(member, seen));
    }
    if (checker.isArrayType(type)) {
      if (type.getSymbol()?.name !== "ReadonlyArray") return false;
      // EVIDENCE: invariant: `isArrayType` holds only for a type reference to Array or ReadonlyArray.
      const reference = type as ts.TypeReference;
      return checker.getTypeArguments(reference).every((member) => deeplyReadonly(member, seen));
    }
    return checker
      .getPropertiesOfType(type)
      .every(
        (property) =>
          (property.declarations ?? []).length > 0 &&
          property.declarations!.every(
            (declaration) =>
              (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0,
          ) &&
          deeplyReadonly(checker.getTypeOfSymbol(property), seen),
      );
  }
}
