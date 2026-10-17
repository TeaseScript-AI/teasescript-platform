import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { ts } from "ts-morph";

import {
  DIAGNOSTIC_CODES,
  type DiagnosticCodeInfo,
  type DiagnosticOwner,
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

interface CodeLiteral {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  /** False for a code that the source only compares with or names in a type. */
  readonly reported: boolean;
}

/** Reads a code only from string literals, so comments and messages cannot pose as reporting it. */
function codeLiterals(file: string, text: string): CodeLiteral[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const literals: CodeLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && CODE.test(node.text)) {
      const parent = node.parent;
      const compared =
        ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(parent.operatorToken.kind);
      literals.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        code: node.text,
        reported: !compared && !ts.isLiteralTypeNode(parent) && !ts.isCaseClause(parent),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

const sources = filesUnder(resolve(root, "src"), ".ts")
  .map((path) => relative(root, path).split("\\").join("/"))
  .filter((file) => file !== REGISTRY)
  .map((file) => ({ file, text: readFileSync(resolve(root, file), "utf8") }));
const literals = sources.flatMap(({ file, text }) => codeLiterals(file, text));

function ownersOf(file: string): string[] {
  const path = file.slice("src/".length);
  return Object.entries(OWNER_SOURCES).flatMap(([owner, entries]) =>
    entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry))
      ? [owner]
      : [],
  );
}

const where = (literal: CodeLiteral): string => `${literal.file}:${literal.line}`;

test("the source names only registered codes, and reports no retired one", () => {
  for (const { file, text } of sources)
    for (const code of text.match(CODES) ?? [])
      assert.ok(
        code in registry,
        `${file} names ${code}, which src/diagnostic-codes.ts does not register.`,
      );
  for (const literal of literals)
    assert.equal(
      registry[literal.code]!.retired,
      undefined,
      `${where(literal)} uses ${literal.code}, which is retired.`,
    );
});

test("each code is reported by every owner the registry names and by no other", () => {
  const reportedBy = new Map<string, Set<string>>();
  for (const literal of literals.filter((literal) => literal.reported)) {
    const fileOwners = ownersOf(literal.file);
    assert.notEqual(
      fileOwners.length,
      0,
      `${where(literal)} reports ${literal.code} outside every owner's sources.`,
    );
    const owners: readonly string[] = registry[literal.code]!.owners;
    const owner = fileOwners.find((candidate) => owners.includes(candidate));
    assert.ok(
      owner !== undefined,
      `${where(literal)} reports ${literal.code} from ${fileOwners.join(", ")}, but the registry ` +
        `gives it to ${owners.join(", ")}. Add the owner to its entry and say how they share it.`,
    );
    reportedBy.set(literal.code, (reportedBy.get(literal.code) ?? new Set()).add(owner));
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
          `- \`${code}\` (${info.shared.problems === "one" ? "one problem" : "two problems"})`,
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
