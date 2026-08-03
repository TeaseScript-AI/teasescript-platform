import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

const forbiddenToolingSpecifiers = ["typescript", "@typescript/native", "ts-morph"] as const;
const staticModuleSpecifierPattern = /\b(?:import|export)\s+(?:(?:type\s+)?[\w*${},\s]+?\s+from\s+)?["']([^"']+)["']/g;

function isForbiddenToolingSpecifier(specifier: string): boolean {
  return forbiddenToolingSpecifiers.some(
    (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );
}

function assertNoTypeScriptToolingInModuleGraph(entry: string): void {
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(staticModuleSpecifierPattern)) {
      const specifier = match[1]!;
      assert.equal(
        isForbiddenToolingSpecifier(specifier),
        false,
        `${file} imports forbidden tooling specifier ${JSON.stringify(specifier)}.`,
      );
      if (specifier.startsWith(".")) {
        visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      }
    }
  };
  visit(resolve(process.cwd(), entry));
}

test("runtime and playground startup graphs do not import TypeScript tooling", () => {
  assertNoTypeScriptToolingInModuleGraph("src/index.ts");
  assertNoTypeScriptToolingInModuleGraph("playground/browser.ts");
  assertNoTypeScriptToolingInModuleGraph("playground/server.ts");
});
