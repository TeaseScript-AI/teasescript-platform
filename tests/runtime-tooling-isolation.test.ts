import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript-vue";

const forbiddenToolingSpecifiers = [
  "typescript",
  "typescript-vue",
  "@typescript/native",
  "ts-morph",
] as const;
const emittedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isForbiddenToolingSpecifier(specifier: string): boolean {
  return forbiddenToolingSpecifiers.some(
    (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );
}

/** Lists static import/export and literal dynamic `import()` specifiers of emitted JavaScript. */
function moduleSpecifiers(javascript: string): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument))
        specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile("module.js", javascript, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS),
  );
  return specifiers;
}

/** Follows emitted local modules from an entry and returns every forbidden tooling import. */
function forbiddenToolingImports(entry: string): readonly string[] {
  const visited = new Set<string>();
  const found: string[] = [];
  const pending = [resolve(emittedRoot, entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
      if (isForbiddenToolingSpecifier(specifier)) found.push(`${file}: ${specifier}`);
      else if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
    }
  }
  return found;
}

test("module scanner finds runtime imports but ignores erased types and comments", () => {
  assert.deepEqual(
    moduleSpecifiers(
      'import ts from "typescript";\nexport { a } from "./a.js";\nawait import("ts-morph");',
    ),
    ["typescript", "./a.js", "ts-morph"],
  );
  const emitted = ts.transpileModule(
    [
      'import type * as Types from "typescript";',
      '// import ts from "typescript";',
      'export const name: Types.ScriptKind | string = "typescript";',
    ].join("\n"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  assert.deepEqual(moduleSpecifiers(emitted), []);
});

test("runtime and playground startup graphs do not import TypeScript tooling", () => {
  for (const entry of ["src/index.js", "playground/browser.js", "playground/server.js"]) {
    assert.deepEqual(forbiddenToolingImports(entry), [], entry);
  }
});
