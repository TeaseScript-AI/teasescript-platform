import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

/*
 * The colour conversion's static checks (#2147, `tests/runtime/values/colour-conversion.test.ts`). With the counted
 * throwing-`Math` run in that test, they are what the claim "a normalized colour is the same text in every engine"
 * rests on beyond the conversion as it stands, whose evidence is the four-engine job over the sample, not a guard that
 * runs. The checks, over `color.ts`, `color-text.ts`, `deterministic-math.ts` and `numeric-functions.ts`:
 * 1. `Math` only as a direct call of an exact member or a read of `PI`; no `**` on numbers; the identifiers
 *    `globalThis`, `window`, `self` and `require` occur nowhere outside a property-name position; each file's module
 *    references, as the compiler collects them, equal to `PINNED_IMPORTS`, its import declarations equal to it, and no
 *    `import()`;
 * 2. `src/color-text.ts` closed as a whole: numbers become text only by `toPrecision(15)` or `toPrecision(17)`;
 * 3. the exported `normalizeColor` is one exported function declaration whose every return is `null` or the one
 *    template of three calls of the text module's exported `formatNumber`, itself one exported function declaration,
 *    all resolved through the exports by the compiler;
 * 4. every decimal numeric literal has at most 20 significant digits, which ECMAScript reads exactly; non-decimal
 *    integer literals have exactly specified values.
 * Not checked (the residual): a callable reached by property and called (`Number.constructor`, `module.require`); float storage
 * (`DataView` writes and their NaN bits); aliased writes to support data; an implicit number-to-text conversion or a
 * read of host state inside the conversion, which cannot reach the output as text (check 3) but could enter the
 * arithmetic as a value; string-to-number parsing or coercion of a long decimal inside the conversion; colorjs.io's
 * parser beyond 20 significant digits; and that a finite argument to the four
 * deterministic functions the colour path calls never brings a non-finite value to `decompose`.
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

/** Math members whose results ECMA-262 specifies for numbers; `PI` is a constant. */
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
  const escape = (node: ts.Node, form: string) => {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    escapes.push(`${relative(process.cwd(), source.fileName)}:${line} ${form}`);
  };
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
    if (checker.isArrayType(type) || checker.isTupleType(type)) return "array";
    return "other";
  };
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

  // Checks 1 and 4, over all four files.
  for (const file of CHECKED_FILES) {
    const source = sources[file]!;
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const named =
          bindings !== undefined && ts.isNamedImports(bindings)
            ? bindings.elements.map(
                (element) =>
                  `${element.isTypeOnly ? "type " : ""}${element.propertyName ? `${element.propertyName.text} as ` : ""}${element.name.text}`,
              )
            : bindings !== undefined
              ? ["* namespace"]
              : [];
        const typeOnly = clause?.isTypeOnly ? "type " : "";
        const defaultName = clause?.name ? `${clause.name.text} ` : "";
        imports.push(
          `${typeOnly}${node.moduleSpecifier.text}: ${defaultName}{${named.join(", ")}}`,
        );
      }
      if (ts.isCallExpression(node) && node.expression.kind === K.ImportKeyword)
        escape(node, "a dynamic import");
      if (ts.isIdentifier(node) && !isName(node)) {
        const parent = node.parent;
        if (["globalThis", "window", "self", "require"].includes(node.text))
          escape(node, node.text);
        const declares =
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isBindingElement(parent) ||
            ts.isImportSpecifier(parent) ||
            ts.isImportClause(parent)) &&
          parent.name === node;
        if (node.text === "Math" && declares) escape(node, "a binding named Math");
        else if (node.text === "Math" && ts.findAncestor(node, ts.isTypeNode) === undefined) {
          const member =
            ts.isPropertyAccessExpression(parent) && parent.expression === node
              ? parent.name.text
              : null;
          const called =
            member !== null &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent;
          const exact = member === "PI" ? !called : called && EXACT_MATH.has(member ?? "");
          if (!isLibrary(node) || !exact)
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
      // A non-decimal integer literal (0x, 0o, 0b) has an exactly specified value; decimals are read exactly up to 20
      // significant digits.
      if (ts.isNumericLiteral(node) && !/^0[box]/iu.test(node.getText())) {
        const digits = node
          .getText()
          .toLowerCase()
          .split("e")[0]!
          .replace(/[._]/gu, "")
          .replace(/^0+/u, "")
          .replace(/0+$/u, "");
        if (digits.length > 20)
          escape(
            node,
            `a decimal literal of ${digits.length} significant digits: ${node.getText()}`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (JSON.stringify(imports) !== JSON.stringify(PINNED_IMPORTS[file]))
      escape(source, `imports ${JSON.stringify(imports)}`);
    // Every module the file references, as the compiler collects them (import, import … = require, export … from,
    // import(), require): the pinned modules exactly.
    const referenced = ts
      .preProcessFile(source.getFullText(), true, true)
      .importedFiles.map((reference) => reference.fileName);
    const pinned = PINNED_IMPORTS[file]!.map(
      (entry) => entry.replace(/^type /u, "").split(": ")[0]!,
    );
    if (JSON.stringify(referenced) !== JSON.stringify(pinned))
      escape(source, `module references ${JSON.stringify(referenced)}`);
  }

  // Check 2: the text module, whole.
  const text = sources[TEXT_MODULE]!;
  const checkText = (node: ts.Node): void => {
    if (!TEXT_KINDS.has(node.kind)) escape(node, `${K[node.kind]} in the text module`);
    if (
      ts.isIdentifier(node) &&
      !isName(node) &&
      ts.findAncestor(node, ts.isTypeNode) === undefined
    ) {
      const declarations = symbolOf(node)?.declarations ?? [];
      const local = declarations.every((declaration) => declaration.getSourceFile() === text);
      if (!local && node.text !== "Math") escape(node, `a free ${node.text} in the text module`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
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
          first !== undefined &&
          ts.isNumericLiteral(first) &&
          ["15", "17"].includes(first.text)) ||
          (ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Math" &&
            callee.name.text === "abs" &&
            first !== undefined &&
            typeName(first) === "number") ||
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

  // Check 3: the output of the exported `normalizeColor`, through the exports as the compiler resolves them. Each of the
  // two exports must be the one function declaration that carries `export` itself; any other shape fails, named.
  const exported = (file: string, name: string): ts.FunctionDeclaration | undefined => {
    const source = sources[file]!;
    const module = checker.getSymbolAtLocation(source);
    const symbol =
      module === undefined
        ? undefined
        : checker.getExportsOfModule(module).find((each) => each.name === name);
    if (symbol === undefined) {
      escape(source, `no export ${name}`);
      return undefined;
    }
    const declarations = symbol.declarations ?? [];
    const declaration = declarations[0];
    const direct =
      !(symbol.flags & ts.SymbolFlags.Alias) &&
      declarations.length === 1 &&
      declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.body !== undefined &&
      declaration.parent === source &&
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0;
    if (!direct) {
      const shape =
        symbol.flags & ts.SymbolFlags.Alias
          ? "an alias or re-export"
          : declarations.map((each) => K[each.kind]).join(", ");
      escape(
        declaration ?? source,
        `the export ${name} is ${shape}, not one exported function declaration`,
      );
      return undefined;
    }
    return declaration;
  };
  const normalize = exported("src/color.ts", "normalizeColor");
  const formatter = exported(TEXT_MODULE, "formatNumber");
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
  if (normalize !== undefined) ts.forEachChild(normalize, returns);
  return escapes;
}
