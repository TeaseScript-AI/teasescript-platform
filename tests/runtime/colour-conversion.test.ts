import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import Color from "colorjs.io";
import ts from "typescript";
import { normalizeColor } from "../../src/color.js";

/*
 * Colours normalize to the same text in every JavaScript engine (#2147): `src/color.ts` converts with operations
 * ECMAScript specifies exactly and prints with its own formatter. Clause by clause: agreement with colorjs.io's own
 * conversion within its accurate domain and the same rejections (2, 7), the pinned stored text (5), the formatter (6),
 * and the closed admission over the conversion's files with a run under throwing `Math` members (1).
 */

function oklchCoordinates(color: string): number[] {
  const match = /^oklch\((.*)\)$/u.exec(color);
  assert.ok(match !== null, color);
  return match[1]!.trim().split(/\s+/u).map(Number);
}

/** Integer steps only, so every engine builds the same inputs. */
function colourInputs(
  seed: number,
  count: number,
  make: (next: (low: number, high: number, scale: number) => number) => string,
): string[] {
  let state = seed;
  const next = (low: number, high: number, scale: number) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (low + (state % (high - low + 1))) / scale;
  };
  return Array.from({ length: count }, () => make(next));
}

/**
 * One family per space id `toOklch` converts, within ten times each reference range and hues of two turns either way:
 * colorjs.io turns a hue into radians before reducing it, which loses about C × |h| × 2^-53 for larger hues.
 */
const NOTATION_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  srgb: [
    ...colourInputs(
      1,
      400,
      (n) => `#${[0, 0, 0].map(() => n(0, 255, 1).toString(16).padStart(2, "0")).join("")}`,
    ),
    ...colourInputs(
      2,
      200,
      (n) => `rgb(${n(0, 100000, 1000)}% ${n(0, 100000, 1000)}% ${n(0, 100000, 1000)}%)`,
    ),
    "red",
    "seagreen",
    "#000005",
  ],
  hsl: colourInputs(
    3,
    300,
    (n) => `hsl(${n(-36000, 36000, 10)} ${n(0, 1000, 10)}% ${n(0, 1000, 10)}%)`,
  ),
  hwb: colourInputs(
    4,
    300,
    (n) => `hwb(${n(-36000, 36000, 10)} ${n(0, 1000, 10)}% ${n(0, 1000, 10)}%)`,
  ),
  lab: colourInputs(
    5,
    300,
    (n) => `lab(${n(0, 10000, 100)} ${n(-125000, 125000, 100)} ${n(-125000, 125000, 100)})`,
  ),
  lch: colourInputs(
    6,
    300,
    (n) => `lch(${n(0, 10000, 100)} ${n(0, 150000, 100)} ${n(-7200, 7200, 10)})`,
  ),
  oklab: colourInputs(
    7,
    300,
    (n) => `oklab(${n(0, 1000, 1000)} ${n(-4000, 4000, 1000)} ${n(-4000, 4000, 1000)})`,
  ),
  oklch: colourInputs(
    8,
    300,
    (n) => `oklch(${n(0, 1000, 1000)} ${n(0, 4000, 1000)} ${n(-7200, 7200, 10)})`,
  ),
};

/** Each channel of each notation at magnitudes up to the largest double, where some of today's inputs overflow. */
const EXTREME_INPUTS: readonly string[] = (() => {
  const magnitudes = [
    "1e-320",
    "5e-324",
    "1e-300",
    "1e-15",
    "1e15",
    "1e100",
    "1e300",
    "1e305",
    "5.7e307",
    "5.8e307",
    "1.7976931348623157e308",
  ];
  const values = ["0", ...magnitudes.flatMap((m) => [m, `-${m}`])];
  const forms: readonly [string, readonly string[], string][] = [
    ["rgb", ["128", "64", "32"], ""],
    ["rgb", ["50", "25", "10"], "%"],
    ["hsl", ["30", "50%", "50%"], ""],
    ["hwb", ["30", "10%", "10%"], ""],
    ["lab", ["50", "20", "-30"], ""],
    ["lch", ["50", "40", "30"], ""],
    ["oklab", ["0.5", "0.1", "-0.1"], ""],
    ["oklch", ["0.5", "0.1", "30"], ""],
  ];
  return forms.flatMap(([name, channels, unit]) =>
    [0, 1, 2].flatMap((channel) =>
      values.map((value) => {
        const parts = channels.map((part, index) =>
          index === channel ? `${value}${part.endsWith("%") ? "%" : unit}` : `${part}${unit}`,
        );
        return `${name}(${parts.join(" ")})`;
      }),
    ),
  );
})();

/** colorjs.io's own conversion, as `normalizeColor` did it before it converted itself: the reference of clauses 2 and 7. */
function colorjsOklch(source: string): readonly number[] | null {
  try {
    const parsed = new Color(source);
    if (
      parsed.alpha !== 1 ||
      ![...parsed.coords, parsed.alpha].every((c) => c === null || Number.isFinite(c))
    )
      return null;
    const clamp = (index: 0 | 1 | 2, upper: number) => {
      parsed.coords[index] = Math.min(upper, Math.max(0, parsed.coords[index] ?? 0));
    };
    const id = parsed.space.id;
    if (id === "srgb") for (const index of [0, 1, 2] as const) clamp(index, 1);
    if (id === "hsl" || id === "hwb") {
      clamp(1, 100);
      clamp(2, 100);
    }
    if (id === "lab" || id === "lch") clamp(0, 100);
    if (id === "oklab" || id === "oklch") clamp(0, 1);
    if (id === "lch" || id === "oklch") clamp(1, Infinity);
    const coordinates = parsed.to("oklch").coords.map((c) => c ?? 0);
    return coordinates.every((c) => Number.isFinite(c)) ? coordinates : null;
  } catch {
    return null;
  }
}

test("normalizes each notation as colorjs.io does, rejects exactly what it rejects, and pins the stored text", () => {
  const oklab = ([l, c, h]: readonly number[]) => [
    l!,
    c! * Math.cos((h! * Math.PI) / 180),
    c! * Math.sin((h! * Math.PI) / 180),
  ];
  for (const [space, inputs] of Object.entries(NOTATION_FAMILIES))
    for (const input of inputs) {
      const reference = colorjsOklch(input);
      const normalized = normalizeColor(input);
      assert.equal(normalized === null, reference === null, input);
      if (reference === null) continue;
      assert.equal(new Color(input).space.id, space, input);
      const found = oklab(oklchCoordinates(normalized!));
      oklab(reference).forEach((value, index) =>
        assert.ok(Math.abs(value - found[index]!) <= 1e-12, `${input}: ${normalized}`),
      );
    }
  // Today's rejections of inputs whose conversion overflows stay rejections, so the compiler's TSC008 does not move.
  for (const input of EXTREME_INPUTS)
    assert.equal(normalizeColor(input) === null, colorjsOklch(input) === null, input);
  // Beyond two turns the reference loses accuracy; degrees reduce exactly, so a whole hue gives its remainder's colour.
  for (const hue of [721, 1e6 + 7, 2 ** 40 + 90, 1e15 + 270, 9007199254740991])
    assert.equal(
      normalizeColor(`lch(60 40 ${hue})`),
      normalizeColor(`lch(60 40 ${hue % 360})`),
      String(hue),
    );
  assert.equal(normalizeColor("lch(50 20 1e308)"), null);
  // The stored contract: a change to these strings changes checkpoints and needs the format revisions to move.
  assert.deepEqual(
    [
      "#000005",
      "blue",
      "rgb(12.5% 50% 99%)",
      "hsl(200 50% 40%)",
      "hwb(120 10% 20%)",
      "lab(50 20 -30)",
      "lch(60 40 300)",
      "oklab(0.5 0.1 -0.1)",
      "oklch(0.5 0.1 30)",
    ].map(normalizeColor),
    [
      "oklch(0.05194463737839829 0.03599405766936659 264.0520226163699)",
      "oklch(0.45201371817442365 0.3132143886344849 264.0520226163699)",
      "oklch(0.6156434314975948 0.20500812504392163 257.64866865149116)",
      "oklch(0.5406060090640484 0.08629251387284617 233.32890230157605)",
      "oklch(0.7345181665611441 0.24219119551665366 142.60820861392733)",
      "oklch(0.5802084112971143 0.0972230595785066 301.7691583636796)",
      "oklch(0.6670748543068091 0.1073439269940544 297.2471691165158)",
      "oklch(0.5 0.14142135623730953 315)",
      "oklch(0.5 0.1 30)",
    ],
  );
});

test("prints each coordinate as Number::toString with its recommended choice, also at ties and powers of two", () => {
  // An OKLCH hue is not converted, so the hue channel carries any finite double to the formatter.
  const doubles = [
    0.30000000000000004, 2.9802322387695312e-8, 7.120236347223045e-307, 5e-324,
    1.7976931348623157e308, 1e21, 1e-7, 123e-20, 0.1, 100, 1.0000000000000002,
  ];
  for (let exponent = -1074; exponent <= 1023; exponent += 1) doubles.push(2 ** exponent);
  for (const value of doubles.flatMap((x) => [x, -x]))
    assert.equal(normalizeColor(`oklch(0 0 ${value})`), `oklch(0 0 ${value})`, String(value));
});

test("converts with no host transcendental, colorjs.io's parsing included", () => {
  const exact = new Set(["abs", "ceil", "floor", "max", "min", "round", "sign", "sqrt", "trunc"]);
  const host = Math as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(Math))
    if (typeof host[name] === "function" && !exact.has(name)) {
      saved.set(name, host[name]);
      host[name] = () => {
        throw new Error(`Math.${name} was called`);
      };
    }
  const parsing = [
    "hsl(1rad 50% 50%)",
    "hsl(200grad 50% 50%)",
    "hsl(.5turn 50% 50%)",
    "hsl(30deg 50% 50%)",
    "lch(50% 40% 30deg)",
    "oklch(50% 50% 1rad)",
    "rgb(255 0 0 / 1)",
    "rgba(255, 0, 0, 1)",
    "#ff0000ff",
    "lab(50% 20% -30%)",
  ];
  try {
    for (const input of [...Object.values(NOTATION_FAMILIES).flat(), ...EXTREME_INPUTS, ...parsing])
      normalizeColor(input);
  } finally {
    for (const [name, value] of saved) host[name] = value;
  }
});

const CONVERSION_FILES = ["src/color.ts", "src/deterministic-math.ts", "src/numeric-functions.ts"];
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
/** The imports `src/color.ts` admits: colorjs.io's default binding, and these named functions. */
const COLOR_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "colorjs.io": [],
  "./deterministic-math.js": ["atan2Degrees", "cosDegrees", "cubeRoot", "sinDegrees"],
  "./numeric-functions.js": ["positivePower"],
};
/** Methods `src/color.ts` may call, by the receiver's type; `toExponential` and `String` only in `formatNumber`. */
const COLOR_METHODS: Readonly<Record<string, readonly string[]>> = {
  string: ["endsWith", "repeat", "replace", "slice", "split", "toLowerCase", "trim"],
  RegExp: ["exec", "test"],
  array: ["every", "push", "slice"],
  RegExpExecArray: ["slice"],
  DataView: ["getBigUint64", "setFloat64"],
};
const COLOR_GLOBALS = new Set(["ArrayBuffer", "BigInt", "DataView", "Error", "Number", "RegExp"]);

/**
 * Clause 1's closed admission over the conversion's files, as `file:line form` for each use outside it. In all three
 * files, every reference to the global `Math` is a direct call of an exact member or a read of `PI`; `globalThis`,
 * `window`, `self`, a binding named `Math`, and `**` or `**=` other than between bigints are refused. In `src/color.ts`, imports are the admitted
 * ones; colorjs.io's binding is only `new Color(…)`, either read for `.alpha` or the initializer of one `const` whose
 * every use reads `.space.id`, `.coords[0]` to `[2]` or `.alpha`; every call's callee is one of the file's own
 * functions, an admitted import, an admitted global or method; and every template span and string `+` operand is a
 * string or a bigint. Anything else is an escape: the files' own code reaches no host transcendental and writes no
 * number as text except through `formatNumber`. colorjs.io's parsing is outside it (the throwing-`Math` run covers it).
 */
function conversionEscapes(overrides: Readonly<Record<string, string>> = {}): string[] {
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
    CONVERSION_FILES.map((file) => resolve(process.cwd(), file)),
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const escapes: string[] = [];
  const isGlobal = (node: ts.Node) =>
    (checker.getSymbolAtLocation(node)?.declarations ?? []).some((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    );
  for (const name of CONVERSION_FILES) {
    const file = program.getSourceFile(resolve(process.cwd(), name))!;
    const color = name === "src/color.ts";
    const escape = (node: ts.Node, form: string) =>
      escapes.push(
        `${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${form}`,
      );
    const ownFunctions = new Set<ts.Symbol>();
    const colorBindings = new Set<ts.Symbol>();
    const parsedBindings = new Set<ts.Symbol>();
    const inFormatter = (node: ts.Node) =>
      ts.findAncestor(
        node,
        (a) => ts.isFunctionDeclaration(a) && a.name?.text === "formatNumber",
      ) !== undefined;
    const typeName = (node: ts.Expression) => {
      const type = checker.getTypeAtLocation(node);
      const all = (flag: ts.TypeFlags) =>
        (type.isUnion() ? type.types : [type]).every((member) => (member.flags & flag) !== 0);
      if (all(ts.TypeFlags.StringLike)) return "string";
      if (all(ts.TypeFlags.NumberLike)) return "number";
      if (all(ts.TypeFlags.BigIntLike)) return "bigint";
      if (checker.isArrayType(type) || checker.isTupleType(type)) return "array";
      return type.getSymbol()?.name ?? "unknown";
    };
    const collect = (node: ts.Node): void => {
      if (color && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const admitted = COLOR_IMPORTS[node.moduleSpecifier.text];
        const clause = node.importClause;
        if (admitted === undefined || clause === undefined || clause.isTypeOnly)
          escape(node, `import ${node.moduleSpecifier.text}`);
        else if (node.moduleSpecifier.text === "colorjs.io") {
          if (clause.name === undefined || clause.namedBindings !== undefined)
            escape(node, "import colorjs.io");
          else colorBindings.add(checker.getSymbolAtLocation(clause.name)!);
        } else if (
          clause.name !== undefined ||
          clause.namedBindings === undefined ||
          !ts.isNamedImports(clause.namedBindings)
        )
          escape(node, `import ${node.moduleSpecifier.text}`);
        else
          for (const element of clause.namedBindings.elements) {
            if (!admitted.includes(element.name.text) || element.propertyName !== undefined)
              escape(element, `import ${element.name.text}`);
            else ownFunctions.add(checker.getSymbolAtLocation(element.name)!);
          }
      }
      if (ts.isFunctionDeclaration(node) && node.name)
        ownFunctions.add(checker.getSymbolAtLocation(node.name)!);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        ownFunctions.add(checker.getSymbolAtLocation(node.name)!);
      ts.forEachChild(node, collect);
    };
    collect(file);
    const visit = (node: ts.Node): void => {
      const parent = node.parent;
      if (ts.isIdentifier(node)) {
        const declaresName =
          parent !== undefined &&
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isImportSpecifier(parent) ||
            ts.isImportClause(parent) ||
            ts.isBindingElement(parent)) &&
          parent.name === node;
        if (declaresName && node.text === "Math") escape(node, "a binding named Math");
        if (["globalThis", "window", "self"].includes(node.text) && isGlobal(node))
          escape(node, node.text);
        if (
          node.text === "Math" &&
          !declaresName &&
          !(ts.isPropertyAccessExpression(parent) && parent.name === node)
        ) {
          const member =
            ts.isPropertyAccessExpression(parent) && parent.expression === node
              ? parent.name.text
              : null;
          const called =
            member !== null &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent;
          if (
            !isGlobal(node) ||
            member === null ||
            !(member === "PI" ? !called : called && EXACT_MATH.has(member))
          )
            escape(node, member === null ? "Math as a value" : `Math.${member}`);
        }
        const symbol = checker.getSymbolAtLocation(node);
        if (
          color &&
          symbol !== undefined &&
          colorBindings.has(symbol) &&
          !ts.isImportClause(parent)
        ) {
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
          if (declaration !== null)
            parsedBindings.add(checker.getSymbolAtLocation(declaration.name)!);
          else if (!alpha) escape(node, "a colorjs.io use");
        }
        if (
          color &&
          symbol !== undefined &&
          parsedBindings.has(symbol) &&
          !(ts.isVariableDeclaration(parent) && parent.name === node)
        ) {
          const read =
            ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : null;
          const grand = read?.parent;
          const assigned = (target: ts.Node) =>
            ts.isBinaryExpression(target.parent) &&
            target.parent.left === target &&
            target.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            target.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
          const admitted =
            read !== null &&
            ((read.name.text === "alpha" && !assigned(read)) ||
              (read.name.text === "space" &&
                ts.isPropertyAccessExpression(grand!) &&
                grand.name.text === "id") ||
              (read.name.text === "coords" &&
                ts.isElementAccessExpression(grand!) &&
                ts.isNumericLiteral(grand.argumentExpression) &&
                ["0", "1", "2"].includes(grand.argumentExpression.text) &&
                !assigned(grand)));
          if (!admitted) escape(node, "a parsed colorjs.io object's use");
        }
        if (
          color &&
          node.text === "String" &&
          isGlobal(node) &&
          !(ts.isCallExpression(parent) && parent.expression === node && inFormatter(node))
        )
          escape(node, "String");
      }
      // `**` is admitted between bigints only, where it is exact.
      if (
        ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken].includes(
          node.operatorToken.kind,
        ) &&
        !(typeName(node.left) === "bigint" && typeName(node.right) === "bigint")
      )
        escape(node, node.operatorToken.getText());
      if (color && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
        const callee = node.expression;
        const symbol = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee) : undefined;
        const admitted =
          (symbol !== undefined && (ownFunctions.has(symbol) || colorBindings.has(symbol))) ||
          (ts.isIdentifier(callee) &&
            isGlobal(callee) &&
            (COLOR_GLOBALS.has(callee.text) || (callee.text === "String" && inFormatter(node)))) ||
          (ts.isPropertyAccessExpression(callee) &&
            ((ts.isIdentifier(callee.expression) && callee.expression.text === "Math") ||
              (ts.isIdentifier(callee.expression) &&
                callee.expression.text === "Number" &&
                callee.name.text === "isFinite" &&
                isGlobal(callee.expression)) ||
              (COLOR_METHODS[typeName(callee.expression)] ?? []).includes(callee.name.text) ||
              (callee.name.text === "toExponential" &&
                typeName(callee.expression) === "number" &&
                inFormatter(node))));
        if (!admitted) escape(node, `a call of ${callee.getText()}`);
      }
      if (
        color &&
        (ts.isTemplateSpan(node) ||
          (ts.isBinaryExpression(node) &&
            [ts.SyntaxKind.PlusToken, ts.SyntaxKind.PlusEqualsToken].includes(
              node.operatorToken.kind,
            )))
      ) {
        const operands = ts.isTemplateSpan(node) ? [node.expression] : [node.left, node.right];
        const types = operands.map(typeName);
        if (
          (ts.isTemplateSpan(node) || types.includes("string")) &&
          !types.every((type) => type === "string" || type === "bigint")
        )
          escape(node, `text from ${types.join(" and ")}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return escapes;
}

test("the colour conversion's files admit only exact operations and write numbers as text only through the formatter", () => {
  assert.deepEqual(conversionEscapes(), []);
  // Each form outside the admission is an escape, added to the file it is about.
  const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
  for (const [file, addition] of [
    ["src/color.ts", "export const a = () => Math.cbrt(2);"],
    ["src/color.ts", 'export const a = () => Math["sqrt"](2);'],
    ["src/color.ts", "const m = Math;\nexport const a = () => m.sqrt(2);"],
    ["src/color.ts", "const { sqrt } = Math;\nexport const a = () => sqrt(2);"],
    ["src/color.ts", "export const a = () => [1].map(Math.floor);"],
    ["src/color.ts", "export const a = () => globalThis.Math.sqrt(2);"],
    ["src/color.ts", "export const a = (x: number) => x ** 2;"],
    [
      "src/color.ts",
      "export const a = (x: number) => {\n  let y = x;\n  y **= 2;\n  return y;\n};",
    ],
    ["src/color.ts", 'export const a = (s: string) => new Color(s).to("oklch");'],
    [
      "src/color.ts",
      'export const a = (s: string) => {\n  const c = new Color(s);\n  const n: Pick<Color, "to"> = c;\n  return n.to("oklch");\n};',
    ],
    [
      "src/color.ts",
      "export const a = (s: string) => {\n  const c = new Color(s);\n  return c.coords;\n};",
    ],
    ["src/color.ts", 'export const a = (x: number) => [x].join("");'],
    ["src/color.ts", "export const a = (x: number) => `${x}`;"],
    ["src/color.ts", "export const a = (x: number) => String(x);"],
    ["src/color.ts", "export const a = (x: number) => x.toFixed(3);"],
    ["src/color.ts", 'export const a = (x: number) => "" + x;'],
    [
      "src/color.ts",
      'import { exp } from "./deterministic-math.js";\nexport const a = () => exp(1);',
    ],
    ["src/deterministic-math.ts", "export const a = (x: number) => Math.exp(x);"],
    ["src/numeric-functions.ts", "export const a = (x: number) => x ** 0.5;"],
  ] as const)
    assert.notDeepEqual(
      conversionEscapes({ [file]: `${source(file)}\n${addition}\n` }),
      [],
      `${file}: ${addition}`,
    );
});
