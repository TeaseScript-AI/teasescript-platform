import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { NUMERIC_FUNCTIONS } from "../src/numeric-functions.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

function said(source: string, seed?: number): string[] {
  const result = runValidSource(source, seed);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function failure(source: string): [string | undefined, string | undefined] {
  const failed = runValidSource(source).snapshot.failure;
  return [failed?.code, failed?.message];
}

/** Hides a value's type from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

function apply(name: string, ...values: number[]): number | undefined {
  const result = NUMERIC_FUNCTIONS.get(name)!.apply(values, {}, () => {
    throw new Error("no draws");
  });
  return typeof result === "number" ? result : undefined;
}

test("angles are in degrees, and exact angles give exact results", () => {
  assert.deepEqual(
    said(
      [
        'say "${sin(30)} ${sin(90)} ${sin(180)} ${sin(-390)} ${cos(60)} ${cos(90)} ${cos(120)} ${tan(45)} ${tan(135)}"',
        'say "${asin(0.5)} ${asin(-1)} ${acos(0.5)} ${acos(-1)} ${acos(0)} ${atan(1)} ${atan(1e300)}"',
        'say "${atan2(1, 1)} ${atan2(1, -1)} ${atan2(0, -1)} ${atan2(-1, 0)} ${atan2(0, 0)}"',
        'say "${exp(0)} ${ln(1)} ${log10(1000)} ${log10(0.001)} ${round(exp(1), decimals: 5)}"',
        "let rise: number = sin(30) * 10",
        "exit",
      ].join("\n"),
    ),
    [
      "0.5 1 0 -0.5 0.5 0 -0.5 1 -1",
      "30 -90 60 180 90 45 90",
      "45 135 180 -90 0",
      "1 0 3 -3 2.71828",
    ],
  );
});

test("exponentials, logarithms, and angles round correctly with the same operations on every JavaScript engine", () => {
  // Correctly rounded values from 60-digit mpmath arithmetic on the exact binary arguments. V8's Math.exp, Math.log,
  // and Math.log10 are one unit in the last place off for these, and degrees converted to radians lose more for tan.
  const cases: [string, number[], number][] = [
    ["exp", [-5.240182620473206], 0.005299288988835954],
    ["exp", [1.865231073461473], 6.457427853813894],
    ["ln", [6.985742112079858], 1.9438712307418948],
    ["log10", [3.8478154432198406], 0.5852142333467013],
    ["sin", [1], 0.01745240643728351],
    ["cos", [123.456], -0.5512964442855824],
    ["tan", [89.9], 572.9572133543203],
    ["atan2", [3, 4], 36.86989764584402],
    ["asin", [0.3], 17.45760312372209],
    ["acos", [-0.1185152162797749], 96.80641923801664],
  ];
  for (const [name, values, expected] of cases)
    assert.equal(apply(name, ...values), expected, `${name}(${values.join(", ")})`);
});

test("a call without a finite result is a compile error when the arguments are known, and a runtime error otherwise", () => {
  const cases: [string, string][] = [
    ["ln(0)", "ln(0) has no result: only a number above 0 has a logarithm."],
    ["log10(-1)", "log10(-1) has no result: only a number above 0 has a logarithm."],
    ["asin(2)", "asin(2) has no result: only a number from -1 through 1 has an arcsine."],
    ["acos(-1.5)", "acos(-1.5) has no result: only a number from -1 through 1 has an arccosine."],
    ["tan(90)", "tan(90) has no result: the tangent of 90 degrees is infinite."],
    ["tan(-270)", "tan(-270) has no result: the tangent of -270 degrees is infinite."],
    ["exp(1000)", "exp(1000) gives a number too large to represent. Use smaller values."],
  ];
  for (const [call, message] of cases) {
    assert.deepEqual(diagnostics(`say ${call}\nexit`), [["TSV043", message, call]], call);
    const hidden = call.replace(/\((-?[\d.]+)\)/u, "(dynamic($1))");
    assert.deepEqual(failure(`${DYNAMIC}say ${hidden}\nexit`), ["TSR036", message], hidden);
  }
  assert.deepEqual(diagnostics('say sin("30")\nexit')[0]?.[0], "TSV043");
  assert.deepEqual(diagnostics("say atan2(1)\nexit"), [
    ["TSV020", "atan2(...) takes 2 arguments (y, x), received 1.", "atan2(1)"],
  ]);
  assert.deepEqual(diagnostics("let ln = 2\nexit")[0]?.[0], "TSV001");
});

test("random distributions draw from the session generator", () => {
  for (const seed of [11, 4242, 987654321]) {
    // randomNormal always makes two draws: the random() after it is the generator's third number.
    const plain = said('say "${random()}"\nsay "${random()}"\nsay "${random()}"\nexit', seed);
    const [, after] = said('say "${randomNormal(20, 5)}"\nsay "${random()}"\nexit', seed);
    assert.equal(after, plain[2], `seed ${seed}`);
    // The same seed gives the same values.
    const source =
      'say "${randomNormal(20, 5)} ${randomBeta(2, 5)} ${randomPert(5, 10, 20)} ${randomPert(4, 4, 4)}"\nexit';
    const [values] = said(source, seed);
    assert.equal(said(source, seed)[0], values);
    const [normal, beta, pert, point] = values!.split(" ").map(Number);
    assert.equal(Number.isFinite(normal), true);
    assert.equal(beta! >= 0 && beta! <= 1, true, `beta ${beta}`);
    assert.equal(pert! >= 5 && pert! <= 20, true, `pert ${pert}`);
    assert.equal(point, 4);
  }
  assert.deepEqual(diagnostics("say randomNormal(1, -1)\nexit"), [
    ["TSV043", "randomNormal(...) needs a spread of at least 0, not -1.", "randomNormal(1, -1)"],
  ]);
  assert.deepEqual(failure(`${DYNAMIC}say randomBeta(dynamic(0), 1)\nexit`), [
    "TSR039",
    "randomBeta(...) needs an alpha and a beta above 0, not 0 and 1.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}say randomPert(dynamic(5), 1, 2)\nexit`), [
    "TSR039",
    "randomPert(...) needs min <= mostLikely <= max, not 5, 1, and 2.",
  ]);
});

test("random distributions follow their means", () => {
  const count = 4000;
  let state = 2463534242;
  const draw = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  const mean = (name: string, values: number[], expected: number, tolerance: number): void => {
    const sampler = NUMERIC_FUNCTIONS.get(name)!;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const sample = sampler.apply(values, {}, draw);
      if (typeof sample !== "number") throw new Error(`${name} failed: ${sample.failure}`);
      total += sample;
    }
    const average = total / count;
    assert.equal(Math.abs(average - expected) < tolerance, true, `${name}: ${average}`);
  };
  // Expected means: the mean itself, alpha / (alpha + beta), and (min + 4 × mostLikely + max) / 6.
  mean("randomNormal", [20, 5], 20, 0.3);
  mean("randomBeta", [2, 5], 2 / 7, 0.01);
  mean("randomPert", [5, 10, 20], 65 / 6, 0.15);
});

test("drawn values survive checkpoint resume", () => {
  const source = [
    "let pause = randomNormal(30, 5)",
    "wait 1 s",
    "let share = randomBeta(2, 2)",
    "wait 1 s",
    "let count = randomPert(5, 10, 20)",
    "wait 1 s",
    'say "${pause > 0} ${share >= 0 and share <= 1} ${count >= 5 and count <= 20} ${sin(30)}"',
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    equivalent.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["true true true 0.5"],
  );
});
