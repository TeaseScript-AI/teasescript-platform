import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * No solving path renders a type to text (O4 stage 3a, work note §2): `typeKey` may appear in the solver only in the
 * export, and in no adapter; identity is the type table's.
 */

const SOLVER = new URL("../../src/type-inference/solver/", import.meta.url);
const ADAPTERS = new URL("../../src/type-inference/adapters/", import.meta.url);

test("typeKey is used only by the export", () => {
  const offenders: string[] = [];
  for (const [dir, allowed] of [
    [SOLVER, new Set(["export.ts"])],
    [ADAPTERS, new Set<string>()],
  ] as const)
    for (const file of readdirSync(dir))
      if (
        file.endsWith(".ts") &&
        !allowed.has(file) &&
        /\btypeKey\b/.test(readFileSync(new URL(file, dir), "utf8"))
      )
        offenders.push(file);
  assert.deepEqual(offenders, []);
});
