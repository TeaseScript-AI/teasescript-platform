import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { ts } from "ts-morph";

import {
  DIAGNOSTIC_CODES,
  type DiagnosticCodeInfo,
  type DiagnosticOwner,
  type OwnedCodeOf,
  type SharedDiagnosticCode,
} from "../src/diagnostic-codes.js";
import { DiagnosticSeverity } from "../src/diagnostics.js";

const root = process.cwd();
const REGISTRY = "src/diagnostic-codes.ts";
const CODE = /^TS[A-Z][0-9]{3}$/;
const CODES = /\bTS[A-Z][0-9]{3}\b/g;
const registry: Readonly<Record<string, DiagnosticCodeInfo>> = DIAGNOSTIC_CODES;

/** The source files of each owner, from `src/`: a file, or a directory ending in `/`. */
const OWNER_SOURCES: Readonly<Record<DiagnosticOwner, readonly string[]>> = {
  lexer: ["lexer.ts"],
  parser: ["parser.ts", "parser/", "script-header.ts", "ast-validation.ts"],
  "name pass": ["semantic.ts", "semantic/", "switch-cases.ts"],
  "type checker": [
    "type-checker.ts",
    "authored-presentation.ts",
    "handle-members.ts",
    "type-inference/core/",
  ],
  compiler: ["compiler.ts", "image-catalog.ts", "day-waits.ts"],
  lowering: ["compiler/"],
  "plan analysis": ["reachability.ts", "speaker-flow.ts", "compiler.ts"],
  "plan validation": ["plan/"],
  runtime: ["runtime/", "angle.ts", "numeric-functions.ts", "list-methods.ts", "handle-members.ts"],
  checkpoint: ["runtime/snapshot/checkpoint.ts"],
};

function filesUnder(directory: string, extension: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return filesUnder(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}

interface CodeUse {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  /** The `severity` of the object literal whose `code` it is, as in `{ severity: "warning", code: … }`. */
  readonly severity?: string;
}

interface SourceCodes {
  /** Every code that a string literal holds, also in a table, a comparison, or a type. */
  readonly named: readonly CodeUse[];
  /** Each place that reports a code: a code literal where it is used, or a table entry or constant where it is read. */
  readonly reported: readonly CodeUse[];
  /** String literals that end with part of a code, as `"TSW" + "099"` would build one. */
  readonly fragments: readonly CodeUse[];
  /** The code tables that the file declares and exports, by name. */
  readonly exportedTables: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const COMPARISONS: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
];

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;
}

/** The code literals of an expression that is a code, or a choice between codes; otherwise `undefined`. */
function codeLiteralsOf(node: ts.Expression): ts.StringLiteralLike[] | undefined {
  const inner = unwrap(node);
  if (ts.isStringLiteralLike(inner)) return CODE.test(inner.text) ? [inner] : undefined;
  if (!ts.isConditionalExpression(inner)) return undefined;
  const whenTrue = codeLiteralsOf(inner.whenTrue);
  const whenFalse = codeLiteralsOf(inner.whenFalse);
  return whenTrue === undefined || whenFalse === undefined
    ? undefined
    : [...whenTrue, ...whenFalse];
}

/** The module-level `const`s of a file whose value is a code, or a choice between codes. */
function moduleCodeConstants(
  source: ts.SourceFile,
): Map<
  string,
  {
    readonly node: ts.Identifier;
    readonly literals: readonly ts.StringLiteralLike[];
    readonly exported: boolean;
  }
> {
  const constants = new Map<
    string,
    {
      readonly node: ts.Identifier;
      readonly literals: readonly ts.StringLiteralLike[];
      readonly exported: boolean;
    }
  >();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    const exported =
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
    for (const declaration of statement.declarationList.declarations) {
      const literals =
        declaration.initializer === undefined ? undefined : codeLiteralsOf(declaration.initializer);
      if (ts.isIdentifier(declaration.name) && literals !== undefined)
        constants.set(declaration.name.text, { node: declaration.name, literals, exported });
    }
  }
  return constants;
}

/**
 * The codes of one source file, read from its syntax, so comments and messages cannot pose as reporting a code. A
 * module-level code table (`const semanticCode = { unknownVariable: "TSV002" }`, or one that `importedTables` lists and
 * the file imports) or code constant (`const DAY_WAIT_CODE = "TSV061"`, or one that `exported` lists and the file
 * imports) declares codes; the file reports one
 * where it reads the entry or constant, and a literal elsewhere where it uses it. A code that a comparison or a type
 * names is not reported. Constants are matched by name within the file, so a local that shadows one would count as
 * reading it.
 */
function sourceCodes(
  file: string,
  source: ts.SourceFile,
  exported: ReadonlyMap<string, readonly string[]> = new Map(),
  importedTables: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): SourceCodes {
  const declarations = new Set<ts.Node>();
  const constants = new Map<
    string,
    { readonly node: ts.Identifier; readonly codes: readonly string[] }
  >();
  for (const [name, constant] of moduleCodeConstants(source)) {
    constants.set(name, {
      node: constant.node,
      codes: constant.literals.map((literal) => literal.text),
    });
    for (const literal of constant.literals) declarations.add(literal);
  }
  const tables = new Map<string, ReadonlyMap<string, string>>();
  const exportedTables = new Map<string, ReadonlyMap<string, string>>();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const codes = exported.get((element.propertyName ?? element.name).text);
      if (codes !== undefined) constants.set(element.name.text, { node: element.name, codes });
      const table = importedTables.get((element.propertyName ?? element.name).text);
      if (table !== undefined) tables.set(element.name.text, table);
    }
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exportsTable =
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
    for (const declaration of statement.declarationList.declarations) {
      const initializer =
        declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
      if (!ts.isIdentifier(declaration.name) || initializer === undefined) continue;
      if (!ts.isObjectLiteralExpression(initializer)) continue;
      const entries = initializer.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return [];
        const value = unwrap(property.initializer);
        const codes = ts.isIdentifier(value)
          ? constants.get(value.text)?.codes
          : codeLiteralsOf(value)?.map((literal) => literal.text);
        return codes?.length === 1 ? [{ key: property.name.text, code: codes[0]!, value }] : [];
      });
      if (entries.length === 0 || entries.length !== initializer.properties.length) continue;
      const table = new Map(entries.map(({ key, code }) => [key, code]));
      tables.set(declaration.name.text, table);
      if (exportsTable) exportedTables.set(declaration.name.text, table);
      for (const { value } of entries) declarations.add(value);
    }
  }

  const named: CodeUse[] = [];
  const reported: CodeUse[] = [];
  const fragments: CodeUse[] = [];
  const use = (node: ts.Node, code: string): CodeUse => {
    let expression: ts.Node = node;
    while (ts.isAsExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent))
      expression = expression.parent;
    const property = expression.parent;
    const severity =
      ts.isPropertyAssignment(property) &&
      property.name.getText(source) === "code" &&
      ts.isObjectLiteralExpression(property.parent)
        ? property.parent.properties.find(
            (other): other is ts.PropertyAssignment =>
              ts.isPropertyAssignment(other) && other.name.getText(source) === "severity",
          )?.initializer
        : undefined;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return severity !== undefined && ts.isStringLiteralLike(severity)
      ? { file, line, code, severity: severity.text }
      : { file, line, code };
  };
  const reads = (node: ts.Node): boolean => {
    const parent = node.parent;
    return !(
      (ts.isBinaryExpression(parent) && COMPARISONS.includes(parent.operatorToken.kind)) ||
      ts.isLiteralTypeNode(parent) ||
      ts.isCaseClause(parent)
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      if (/\bTS(?:[A-Z][0-9]{0,2})?$/.test(node.text)) fragments.push(use(node, node.text));
      if (ts.isStringLiteralLike(node) && CODE.test(node.text)) {
        named.push(use(node, node.text));
        if (!declarations.has(node) && reads(node)) reported.push(use(node, node.text));
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      tables.get(node.expression.text)?.has(node.name.text) === true &&
      reads(node)
    ) {
      reported.push(use(node, tables.get(node.expression.text)!.get(node.name.text)!));
    } else if (ts.isIdentifier(node) && constants.has(node.text) && !declarations.has(node)) {
      const constant = constants.get(node.text)!;
      const parent = node.parent;
      const isName =
        node === constant.node ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isBindingElement(parent)) &&
          parent.name === node);
      if (!isName && reads(node)) for (const code of constant.codes) reported.push(use(node, code));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { named, reported, fragments, exportedTables };
}

const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

/**
 * The codes of every source file. Each file is parsed once for the three passes, which read its syntax and do not
 * change it, and the syntax is released after them.
 */
function scanSources() {
  const files = filesUnder(resolve(root, "src"), ".ts")
    .map((path) => relative(root, path).split("\\").join("/"))
    .filter((file) => file !== REGISTRY)
    .map((file) => {
      const text = readFileSync(resolve(root, file), "utf8");
      return { file, text, syntax: parse(file, text) };
    });
  const exportedConstants = new Map(
    files.flatMap(({ syntax }) =>
      [...moduleCodeConstants(syntax)]
        .filter(([, constant]) => constant.exported)
        .map(
          ([name, constant]) => [name, constant.literals.map((literal) => literal.text)] as const,
        ),
    ),
  );
  const exportedTables = new Map(
    files.flatMap(({ file, syntax }) => [
      ...sourceCodes(file, syntax, exportedConstants).exportedTables,
    ]),
  );
  return files.map(({ file, text, syntax }) => ({
    file,
    text,
    ...sourceCodes(file, syntax, exportedConstants, exportedTables),
  }));
}
const sources = scanSources();

function ownersOf(file: string): string[] {
  const path = file.slice("src/".length);
  return Object.entries(OWNER_SOURCES).flatMap(([owner, entries]) =>
    entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry))
      ? [owner]
      : [],
  );
}

const where = (use: CodeUse): string => `${use.file}:${use.line}`;

test("the scanner counts the codes that a source reads, not those it declares, compares, or types", () => {
  const codes = sourceCodes(
    "probe.ts",
    parse(
      "probe.ts",
      [
        'import { SHARED, OTHER } from "./codes.js";',
        'const table = { used: "TSV001", unused: "TSV002", shared: SHARED } as const;',
        'const USED = "TSV003";',
        'const UNUSED = "TSV004";',
        'const either = flag ? "TSV005" : "TSV006";',
        "report(table.used, table.shared, USED, either, SHARED, OTHER);",
        'report("TSV007");',
        'if (code === "TSV008") report(other.USED);',
        'type Code = "TSV009";',
        'push({ severity: "warning", code: "TSW010" satisfies Code });',
        'const built = "TSW" + "099";',
        'function local() { const code = flag ? "TSV011" : "TSV012"; report(code, code); }',
      ].join("\n"),
    ),
    new Map([["SHARED", ["TSV013"]]]),
  );
  assert.deepEqual(
    codes.reported.map(({ line, code, severity }) => [line, code, severity]),
    [
      [6, "TSV001", undefined],
      [6, "TSV013", undefined],
      [6, "TSV003", undefined],
      [6, "TSV005", undefined],
      [6, "TSV006", undefined],
      [6, "TSV013", undefined],
      [7, "TSV007", undefined],
      [10, "TSW010", "warning"],
      [12, "TSV011", undefined],
      [12, "TSV012", undefined],
    ],
  );
  assert.equal(codes.named.length, 12);
  assert.deepEqual(
    codes.fragments.map(({ line }) => line),
    [11],
  );
});

test("the source names only registered codes, builds none from parts, and uses no retired one", () => {
  for (const { file, text, named, fragments } of sources) {
    for (const code of text.match(CODES) ?? [])
      assert.ok(
        code in registry,
        `${file} names ${code}, which src/diagnostic-codes.ts does not register.`,
      );
    for (const fragment of fragments)
      assert.fail(
        `${where(fragment)} builds a code from parts. Write the code whole, so it is checked.`,
      );
    for (const use of named)
      assert.equal(
        registry[use.code]!.retired,
        undefined,
        `${where(use)} uses ${use.code}, which is retired.`,
      );
  }
});

test("each code is reported by every owner the registry names and by no other", () => {
  const reportedBy = new Map<string, Set<string>>();
  for (const use of sources.flatMap(({ reported }) => reported)) {
    const fileOwners = ownersOf(use.file);
    assert.notEqual(
      fileOwners.length,
      0,
      `${where(use)} reports ${use.code} outside every owner's sources.`,
    );
    const owners: readonly string[] = registry[use.code]!.owners;
    // A file that several owners share, such as the handles' members, reports a code for each owner that has it.
    const matching = fileOwners.filter((candidate) => owners.includes(candidate));
    assert.ok(
      matching.length > 0,
      `${where(use)} reports ${use.code} from ${fileOwners.join(", ")}, but the registry ` +
        `gives it to ${owners.join(", ")}. Add the owner to its entry and say how they share it.`,
    );
    const reporters = reportedBy.get(use.code) ?? new Set();
    for (const owner of matching) reporters.add(owner);
    reportedBy.set(use.code, reporters);
  }
  for (const [code, info] of Object.entries(registry)) {
    if (info.retired === true) continue;
    assert.deepEqual(
      [...(reportedBy.get(code) ?? [])].sort(),
      [...info.owners].sort(),
      `${code} must be reported by each of its owners, or be marked as retired.`,
    );
  }
});

test("an object literal reports a code with a severity that the registry gives it", () => {
  for (const use of sources.flatMap(({ reported }) => reported))
    if (use.severity !== undefined)
      assert.ok(
        registry[use.code]!.severities.some((severity) => severity === use.severity),
        `${where(use)} reports ${use.code} as ${use.severity}.`,
      );
});

/** Checks that a code has one known severity, or both in the order of {@link DiagnosticSeverity}. */
function checkSeverities(code: string, info: DiagnosticCodeInfo): void {
  const known: readonly string[] = Object.values(DiagnosticSeverity);
  const declared: readonly string[] = info.severities;
  assert.ok(declared.length > 0, `${code} has no severity.`);
  assert.deepEqual(
    declared,
    known.filter((severity) => declared.includes(severity)),
    `${code} must list known severities (${known.join(", ")}), each once and in this order.`,
  );
}

test("each code has one severity, or both", () => {
  for (const [code, info] of Object.entries(registry)) checkSeverities(code, info);
});

test("a code with both severities is an error code and a warning code", () => {
  const docs = "docs/DIAGNOSTICS.md#names-types-and-values-tsv";
  const fixture = {
    TSV901: { owners: ["type checker"], severities: ["error", "warning"], title: "Both", docs },
    TSV902: { owners: ["type checker"], severities: ["error"], title: "Error", docs },
    TSV903: { owners: ["type checker"], severities: ["warning"], title: "Warning", docs },
  } as const satisfies Record<string, DiagnosticCodeInfo>;
  type Code<S extends DiagnosticSeverity = DiagnosticSeverity> = OwnedCodeOf<
    typeof fixture,
    "type checker",
    S
  >;
  // Each pair is a code as an error code and as a warning code.
  const pairs: [Code<"error">, Code<"warning">][] = [
    ["TSV901", "TSV901"],
    ["TSV902", "TSV903"],
    // @ts-expect-error -- a code with only the error severity is no warning code
    ["TSV902", "TSV902"],
    // @ts-expect-error -- a code with only the warning severity is no error code
    ["TSV903", "TSV903"],
  ];
  const all: Code[] = ["TSV901", "TSV902", "TSV903"];
  assert.equal(pairs.length + all.length, 7);

  for (const [code, info] of Object.entries(fixture)) checkSeverities(code, info);
});

test("a shared code is one problem with one text", () => {
  // The registry has no form for two problems under one code, or for one problem with different texts.
  const forms: SharedDiagnosticCode[] = [
    // @ts-expect-error -- two problems need a code each
    { problems: "two", parts: [] },
    // @ts-expect-error -- the owners of a code report it with one text
    { texts: "different", parts: [] },
  ];
  assert.equal(forms.length, 2);
});

test("a code with several owners says how they share it", () => {
  for (const [code, info] of Object.entries(registry)) {
    assert.equal(new Set(info.owners).size, info.owners.length, `${code} names an owner twice.`);
    if (info.owners.length === 1) assert.equal(info.shared, undefined, `${code} has one owner.`);
    else
      assert.equal(
        info.shared?.parts.length,
        info.owners.length,
        `${code} has ${info.owners.length} owners, so it says what each of them reports.`,
      );
  }
});

interface Section {
  readonly anchor: string;
  readonly level: number;
  readonly lines: string[];
}

/** The sections of a Markdown document by their anchors, as GitHub derives them from the headings. */
function sections(path: string): ReadonlyMap<string, Section> {
  const result = new Map<string, Section>();
  const open: Section[] = [];
  const counts = new Map<string, number>();
  let fenced = false;
  for (const line of readFileSync(resolve(root, path), "utf8").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6}) (.*)$/.exec(line);
    if (heading === null) {
      for (const section of open) section.lines.push(line);
      continue;
    }
    const level = heading[1]!.length;
    const base = heading[2]!
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const section = { anchor: count === 0 ? base : `${base}-${count}`, level, lines: [] };
    while (open.length > 0 && open.at(-1)!.level >= level) open.pop();
    open.push(section);
    result.set(section.anchor, section);
  }
  return result;
}

test("each code's document section exists and explains the code", () => {
  const documents = new Map<string, ReadonlyMap<string, Section>>();
  for (const [code, info] of Object.entries(registry)) {
    const hash = info.docs.indexOf("#");
    const path = info.docs.slice(0, hash);
    const anchor = info.docs.slice(hash + 1);
    assert.ok(
      hash > 0 && existsSync(resolve(root, path)),
      `${code}: ${info.docs} is not a section.`,
    );
    if (!documents.has(path)) documents.set(path, sections(path));
    const section = documents.get(path)!.get(anchor);
    assert.ok(section !== undefined, `${code}: ${path} has no section '#${anchor}'.`);
    assert.ok(
      section.lines.some((line) => line.includes(`\`${code}\``)),
      `${code}: ${info.docs} does not name ${code}.`,
    );
  }
});

test("the documents name only registered codes", () => {
  for (const path of filesUnder(resolve(root, "docs"), ".md"))
    for (const code of readFileSync(path, "utf8").match(CODES) ?? [])
      assert.ok(
        code in registry,
        `${relative(root, path)} names ${code}, which is not registered.`,
      );
});
