import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

function assertNoTypeScriptToolingInModuleGraph(entry: string): void {
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    assert.equal(/from\s+["']typescript["']/.test(source), false, `${file} imports TypeScript tooling.`);
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      visit(resolve(dirname(file), match[1]!.replace(/\.js$/, ".ts")));
    }
  };
  visit(resolve(process.cwd(), entry));
}

test("runtime and playground startup graphs do not import TypeScript tooling", () => {
  assertNoTypeScriptToolingInModuleGraph("src/index.ts");
  assertNoTypeScriptToolingInModuleGraph("playground/browser.ts");
  assertNoTypeScriptToolingInModuleGraph("playground/server.ts");
});
