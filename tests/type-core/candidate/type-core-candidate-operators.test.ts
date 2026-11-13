// The candidate route's operators (#2488's step 2c, #2688): each operand of each unary and binary operator, from the host
// and from a typed place, compiles on the route in the four held modes, and every run ends as today's and as the
// derived oracle's (`derived-operators.ts`); `and` and `or` skip a right side that would fail.

import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../../src/compiler.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";
import { recordOfFile, runGlobals } from "../../helpers/type-core-route.js";
import { syntaxOf } from "../../helpers/type-core/derived/type-core-derived.js";
import { derive } from "../../helpers/type-core/derived/type-core-derived-checks.js";
import { evaluateProject } from "../../helpers/type-core/derived/derived-transfers.js";
import { DOMAIN } from "../../helpers/type-core/row-guard-records.js";
import { OPTIONS } from "../../helpers/type-core/type-core-candidate-setup.js";

const ARITHMETIC = ["+", "-", "*", "/", "%"] as const;
const COMPARISONS = ["<", "<=", ">", ">=", "==", "!="] as const;

/** The host values of the runs: the domain's, a zero divisor, a list, and a number at the largest safe whole number. */
const HOSTS: readonly SerializableRuntimeValue[] = [
  ...DOMAIN,
  0,
  { kind: "list", items: [2] },
  Number.MAX_SAFE_INTEGER,
];

/**
 * Each operand position of each operator, with the host global there and with a read of a typed place, and each
 * operation's value stored, said or tested: every one of them today's checker publishes.
 */
const SOURCES: readonly string[] = [
  ...[...ARITHMETIC, ...COMPARISONS].flatMap((operator) => [
    `let x = hostValue ${operator} 2\nsay "x"`,
    `let x = 2 ${operator} hostValue\nsay "x"`,
    `let a: integer = hostValue\nlet x = a ${operator} 2\nsay "x"`,
    `let a: number = hostValue\nlet x = 3 ${operator} a\nsay "x"`,
  ]),
  'let t = "a" + hostValue\nsay t',
  'let t: string = hostValue\nlet u = t + "b"\nsay u',
  "let xs = [1] + hostValue",
  "let x: integer = hostValue * 2 - 1",
  "let x: number = (hostValue + 1) / 2",
  'let b = hostValue < 3\nif b {\n  say "small"\n}',
  'let a: integer = hostValue\nif a > 1 {\n  say "big"\n} else {\n  say "small"\n}',
  "let x = -hostValue",
  "let x = +hostValue",
  "let x: integer = -hostValue",
  "let a: number = hostValue\nlet x = -a",
  "let b = not hostValue",
  "let a: boolean = hostValue\nlet b = not a",
  'if hostValue {\n  say "y"\n} else {\n  say "n"\n}',
  'if not (hostValue == 2) {\n  say "not two"\n}',
  // `and` and `or`: a right side that would fail is skipped where the left decides
  "let b = hostValue == null or hostValue > 1",
  "let b = hostValue != null and hostValue > 1",
  'let b = hostValue is integer and hostValue * 2 > 3\nsay "x"',
  'if hostValue == 2 or hostValue == "text" {\n  say "known"\n}',
  "let a: boolean = hostValue\nlet b = a and not a\nlet c = a or b",
  "let b = false and hostValue\nlet c = true or hostValue",
  "let n: integer? = hostValue\nlet b = n != null and n > 1",
];

/** A source as the oracle reads it: the files' syntax and their entries of the core's record, never the plan. */
function derivedProject(files: readonly { readonly path: string; readonly source: string }[]) {
  const request = coreRequest(files);
  assert.ok(request !== null, files[0]!.source);
  const record = compactAnalysis(request);
  return request.files.map((file) => {
    const syntax = syntaxOf(file.source);
    return { path: file.path, syntax, ...derive(syntax, recordOfFile(record, file.path)) };
  });
}

test("each operand of each operator publishes on the route, and every run ends as today's and as derived", () => {
  const failures: string[] = [];
  const failed = new Set<string>();
  for (const body of SOURCES) {
    const files = [{ path: "main.tease", source: `${body}\nexit\n` }];
    const today = compileProject(files, OPTIONS);
    assert.ok(today.plan !== null, `${body}: today's plan`);
    const project = derivedProject(files);
    for (const mode of HELD_MODES) {
      const where = `${body} [${mode.name}]`;
      const route = mode.run(() => compileProjectWithBackend(files, OPTIONS, CORE_BACKEND));
      if (route.plan === null) {
        failures.push(`${where}: no plan`);
        continue;
      }
      for (const hostValue of HOSTS) {
        const ran = runGlobals(route.plan, { hostValue });
        const label = `${where} with ${JSON.stringify(hostValue)}`;
        const expected = runGlobals(today.plan, { hostValue });
        if (JSON.stringify(ran) !== JSON.stringify(expected))
          failures.push(
            `${label}: route ${JSON.stringify(ran)}, today ${JSON.stringify(expected)}`,
          );
        const derived = evaluateProject(project, { hostValue }).run;
        if (JSON.stringify(ran) !== JSON.stringify(derived))
          failures.push(
            `${label}: route ${JSON.stringify(ran)}, derived ${JSON.stringify(derived)}`,
          );
        if (ran.failure !== null) failed.add(ran.failure.split("@")[0]!);
      }
    }
  }
  assert.deepEqual(failures, []);
  // (the family reaches each of the operators' own failures and a typed place's check)
  assert.deepEqual([...failed].sort(), ["TSR009", "TSR026", "TSR027", "TSR036", "TSR058"]);
});

test("a typed place stores no operation none of whose possible types fits it: ADR 0021 rule 1.7's error", () => {
  // (`x / 4` of an unknown `x` may be a number, a duration, a calendar duration or an angle, none an integer)
  const files = [{ path: "main.tease", source: "let n: integer = hostValue / 2\nexit\n" }];
  for (const mode of HELD_MODES) {
    const route = mode.run(() => compileProjectWithBackend(files, OPTIONS, CORE_BACKEND));
    assert.equal(route.plan, null, mode.name);
    assert.deepEqual(
      route.diagnostics.filter((d) => d.severity === "error").map(({ code }) => code),
      ["TSV041"],
      mode.name,
    );
  }
});
