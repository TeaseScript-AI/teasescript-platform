import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { ts } from "ts-morph";

import {
  DIAGNOSTIC_CODES,
  type DiagnosticCodeInfo,
  type DiagnosticOwner,
  type SharedDiagnosticCode,
} from "../src/diagnostic-codes.js";

const root = process.cwd();
const REGISTRY = "src/diagnostic-codes.ts";
const CODE = /^TS[A-Z][0-9]{3}$/;
const CODES = /\bTS[A-Z][0-9]{3}\b/g;
const registry: Readonly<Record<string, DiagnosticCodeInfo>> = DIAGNOSTIC_CODES;

/** The source files of each owner, from `src/`: a file, or a directory ending in `/`. */
const OWNER_SOURCES: Readonly<Record<DiagnosticOwner, readonly string[]>> = {
  lexer: ["lexer.ts"],
  parser: ["parser.ts", "script-header.ts", "ast-validation.ts"],
  "name pass": ["semantic.ts", "switch-cases.ts"],
  "type checker": ["type-checker.ts", "authored-presentation.ts"],
  compiler: ["compiler.ts", "image-catalog.ts", "day-waits.ts"],
  lowering: ["compiler/"],
  "plan analysis": ["reachability.ts", "speaker-flow.ts", "compiler.ts"],
  "plan validation": ["plan/"],
  runtime: ["runtime/", "angle.ts", "numeric-functions.ts"],
  checkpoint: ["runtime/checkpoint.ts"],
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

/**
 * The codes of one source file, read from its syntax, so comments and messages cannot pose as reporting a code. A
 * code table (`const semanticCode = { unknownVariable: "TSV002" }`) or code constant (`const DAY_WAIT_CODE = "TSV061"`)
 * declares codes; the file reports one where it reads the entry or constant, and a literal elsewhere where it uses it.
 * A code that a comparison or a type names is not reported. Tables and constants are matched by name within their file,
 * so a local of the same name can only count as a read of a code that the file declares.
 */
function sourceCodes(file: string, text: string): SourceCodes {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const tables = new Map<string, Map<string, string>>();
  const constants = new Map<string, { readonly node: ts.Identifier; readonly codes: string[] }>();
  const declarations = new Set<ts.Node>();
  const findDeclarations = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = unwrap(node.initializer);
      const properties = ts.isObjectLiteralExpression(initializer) ? initializer.properties : [];
      const entries = properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return [];
        const [literal, ...more] = codeLiteralsOf(property.initializer) ?? [];
        return literal === undefined || more.length > 0
          ? []
          : [{ key: property.name.text, literal }];
      });
      const literals = codeLiteralsOf(node.initializer);
      if (entries.length > 0 && entries.length === properties.length) {
        tables.set(node.name.text, new Map(entries.map(({ key, literal }) => [key, literal.text])));
        for (const { literal } of entries) declarations.add(literal);
      } else if (literals !== undefined) {
        constants.set(node.name.text, {
          node: node.name,
          codes: literals.map((literal) => literal.text),
        });
        for (const literal of literals) declarations.add(literal);
      }
    }
    ts.forEachChild(node, findDeclarations);
  };
  findDeclarations(source);

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
    } else if (ts.isIdentifier(node) && constants.has(node.text)) {
      const constant = constants.get(node.text)!;
      const parent = node.parent;
      const isName =
        node === constant.node ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent)) &&
          parent.name === node);
      if (!isName && reads(node)) for (const code of constant.codes) reported.push(use(node, code));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { named, reported, fragments };
}

const sources = filesUnder(resolve(root, "src"), ".ts")
  .map((path) => relative(root, path).split("\\").join("/"))
  .filter((file) => file !== REGISTRY)
  .map((file) => ({
    file,
    text: readFileSync(resolve(root, file), "utf8"),
    ...sourceCodes(file, readFileSync(resolve(root, file), "utf8")),
  }));

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
    [
      'const table = { used: "TSV001", unused: "TSV002" } as const;',
      'const USED = "TSV003";',
      'const UNUSED = "TSV004";',
      'const either = flag ? "TSV005" : "TSV006";',
      "report(table.used, USED, either);",
      'report("TSV007");',
      'if (code === "TSV008") report(other.USED);',
      'type Code = "TSV009";',
      'push({ severity: "warning", code: "TSW010" satisfies Code });',
      'const built = "TSW" + "099";',
    ].join("\n"),
  );
  assert.deepEqual(
    codes.reported.map(({ line, code, severity }) => [line, code, severity]),
    [
      [5, "TSV001", undefined],
      [5, "TSV003", undefined],
      [5, "TSV005", undefined],
      [5, "TSV006", undefined],
      [6, "TSV007", undefined],
      [9, "TSW010", "warning"],
    ],
  );
  assert.equal(codes.named.length, 10);
  assert.deepEqual(
    codes.fragments.map(({ line }) => line),
    [10],
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
    const owner = fileOwners.find((candidate) => owners.includes(candidate));
    assert.ok(
      owner !== undefined,
      `${where(use)} reports ${use.code} from ${fileOwners.join(", ")}, but the registry ` +
        `gives it to ${owners.join(", ")}. Add the owner to its entry and say how they share it.`,
    );
    reportedBy.set(use.code, (reportedBy.get(use.code) ?? new Set()).add(owner));
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

test("an object literal reports a code with the severity that the registry gives it", () => {
  for (const use of sources.flatMap(({ reported }) => reported))
    if (use.severity !== undefined)
      assert.equal(
        use.severity,
        registry[use.code]!.severity,
        `${where(use)} reports ${use.code} as ${use.severity}.`,
      );
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

function sharedLabel(shared: SharedDiagnosticCode): string {
  if (shared.problems === "two") return "two problems";
  return shared.texts === "same" ? "one problem, same text" : "one problem, different texts";
}

test("DIAGNOSTICS.md lists its codes as the registry does", () => {
  const document = "docs/DIAGNOSTICS.md";
  const text = readFileSync(resolve(root, document), "utf8");
  const tables = new Map<string, string[]>();
  for (const [code, info] of Object.entries(registry)) {
    if (!info.docs.startsWith(`${document}#`)) continue;
    const anchor = info.docs.slice(document.length + 1);
    tables.set(anchor, [
      ...(tables.get(anchor) ?? [
        "| Code | Title | Severity | Owner |",
        "| --- | --- | --- | --- |",
      ]),
      `| \`${code}\` | ${info.title} | ${info.severity} | ${info.owners.join(", ")} |`,
    ]);
  }
  const documented = sections(document);
  for (const [anchor, rows] of tables) {
    const table = rows.join("\n");
    const section = documented.get(anchor)?.lines.join("\n") ?? "";
    assert.ok(section.includes(table), `${document}#${anchor} must hold this table:\n\n${table}\n`);
  }
  const shared = Object.entries(registry).flatMap(([code, info]) =>
    info.shared === undefined
      ? []
      : [
          `- \`${code}\` (${sharedLabel(info.shared)})`,
          ...info.owners.map((owner, index) => `  - ${owner}: ${info.shared!.parts[index]!}`),
        ],
  );
  const list = shared.join("\n");
  assert.ok(
    text.includes(list),
    `${document} must list the codes with several owners:\n\n${list}\n`,
  );
});

test("the documents name only registered codes", () => {
  for (const path of filesUnder(resolve(root, "docs"), ".md"))
    for (const code of readFileSync(path, "utf8").match(CODES) ?? [])
      assert.ok(
        code in registry,
        `${relative(root, path)} names ${code}, which is not registered.`,
      );
});
