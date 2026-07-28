import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const checker = path.resolve("tools/check-legacy-imports.mjs");
const fixtures = path.resolve("tests/fixtures/legacy-import-checker");

function checkFixture(name: string): { readonly status: number; readonly output: string } {
  try {
    const output = execFileSync(process.execPath, [checker, "--root", path.join(fixtures, name)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error: unknown) {
    const failure = error as { readonly status: number | null; readonly stdout: string; readonly stderr: string };
    return { status: failure.status ?? 1, output: `${failure.stdout}${failure.stderr}` };
  }
}

test("legacy import checker resolves relative legacy specifiers and exceptions", () => {
  for (const name of ["one-level", "deep", "source-local", "workspace", "validation-testing"]) {
    const result = checkFixture(name);
    assert.equal(result.status, 1, `${name}: ${result.output}`);
    assert.match(result.output, /resolves to/u);
  }
  for (const name of ["valid", "validation-testing-valid"]) {
    const valid = checkFixture(name);
    assert.equal(valid.status, 0, `${name}: ${valid.output}`);
    assert.match(valid.output, /passed/u);
  }
});
