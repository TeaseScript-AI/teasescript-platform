import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ts } from "ts-morph";

const forbiddenToolingSpecifiers = ["typescript", "@typescript/native", "ts-morph"] as const;

function isForbiddenToolingSpecifier(specifier: string): boolean {
  return forbiddenToolingSpecifiers.some(
    (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );
}

// Reads static, re-export, side-effect, and literal dynamic imports from syntax nodes, so comments, strings,
// and regular expressions cannot pose as imports.
function moduleSpecifiers(javascript: string): string[] {
  const source = ts.createSourceFile("module.js", javascript, ts.ScriptTarget.Latest);
  const specifiers: string[] = [];
  const pending: ts.Node[] = [source];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
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
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return specifiers;
}

// Walks emitted JavaScript, where type-only imports are already erased, through its real local module files.
function assertNoTypeScriptToolingInModuleGraph(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [fileURLToPath(new URL(entry, import.meta.url))];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file)) continue;
    assert.ok(existsSync(file), `Emitted module ${file} must exist.`);
    visited.add(file);
    for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
      assert.equal(
        isForbiddenToolingSpecifier(specifier),
        false,
        `${file} imports forbidden tooling specifier ${JSON.stringify(specifier)}.`,
      );
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
    }
  }
  return visited;
}

test("module specifier scanning finds executable imports but not erased types or comments", () => {
  assert.deepEqual(moduleSpecifiers('import ts from "typescript";\nexport * from "./local.js";'), [
    "typescript",
    "./local.js",
  ]);
  assert.deepEqual(moduleSpecifiers('const tooling = await import("ts-morph");'), ["ts-morph"]);
  assert.deepEqual(
    moduleSpecifiers(
      '// import ts from "typescript";\nconst text = \'await import("typescript")\';',
    ),
    [],
  );
  assert.deepEqual(moduleSpecifiers('const pattern = /import("typescript")/;'), []);
  const erased = ts.transpileModule(
    'import type { Node } from "typescript";\nexport const value: Node | null = null;',
    { compilerOptions: { module: ts.ModuleKind.ESNext } },
  ).outputText;
  assert.deepEqual(moduleSpecifiers(erased), []);
});

test("runtime and playground startup graphs do not import TypeScript tooling", () => {
  for (const entry of ["../src/index.js", "../playground/browser.js", "../playground/server.js"]) {
    assert.ok(assertNoTypeScriptToolingInModuleGraph(entry).size > 1, entry);
  }
});
