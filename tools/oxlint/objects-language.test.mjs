import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CASES } from "./objects-language.cases.mjs";
import { objectsRules } from "./objects-language.fixture.mjs";

/*
 * objects.ts's admitted language (#1747, #1921): every fixture case is rejected by exactly its
 * pinned rules, or admitted; the witnesses admitted by the stated claim are the named residual.
 */

test("each objects.ts language case is rejected by exactly its rules, or admitted", () => {
  for (const { name, source, expect } of CASES)
    assert.deepEqual(objectsRules(source), expect, name);
});

test("every language rule rejects some case, and every rule but the retained has an admitted control beside it", () => {
  const module = readFileSync(new URL("./objects-language.mjs", import.meta.url), "utf8");
  const rules = new Set([...module.matchAll(/reject\(\s*[^,]+,\s*"([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(rules.size >= 30, String(rules.size));
  const seen = new Set(CASES.flatMap(({ expect }) => expect));
  assert.deepEqual(
    [...rules].filter((rule) => !seen.has(rule)),
    [],
  );
  assert.ok(CASES.filter(({ name }) => name.includes("/control")).length >= 10);
});

test("the residual the lint admits by its claim is named: a caller-supplied subclass of an audited class", () => {
  assert.deepEqual(
    CASES.filter(({ residual }) => residual === true).map(({ name }) => name),
    ["r2/r2NominalEntry"],
  );
});
