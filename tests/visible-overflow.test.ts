import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

function diagnostics(source: string): string[] {
  return compileSource(source).diagnostics.map(
    (item) => `${item.code} ${item.span.start.line + 1}:${item.span.start.column + 1}`,
  );
}

test("the compiler reports visible overflow in every expression position", () => {
  for (const [source, at] of [
    ["let n = 2\nlet x = n + 1e308 * 10", "2:13"],
    ["say round(1e308 * 10)", "1:11"],
    ['say "${1e308 * 10}"', "1:8"],
    ["wait 1e308 * 10 s", "1:6"],
    ["timer async 1e300 s * 1e10", "1:13"],
    ['showButton "Go", timeout: 1e308 * 10', "1:27"],
    ["function f(x = 1e308 * 10) { return x }", "1:16"],
    ["say [1, 2][1e308 * 10]", "1:12"],
  ] as const) {
    assert.deepEqual(diagnostics(source), [`TSV050 ${at}`], source);
  }
  const [overflow] = compileSource("let x = 1e308 * 10").diagnostics;
  assert.equal(
    overflow?.message,
    "This calculation gives a number too large to represent. Use smaller values.",
  );
});

test("a visible division by zero is a compile error that names the fix", () => {
  for (const source of ["say 1 / 0", "say 5 % 0", "say 0 / 0", "say 1 s / 0 s", "say 1 h / 0"]) {
    const [division, ...rest] = compileSource(source).diagnostics;
    assert.equal(division?.code, "TSV050", source);
    assert.equal(
      division?.message,
      "This divides by zero, so it has no result. Divide by a value other than zero.",
    );
    assert.deepEqual(rest, [], source);
  }
});

test("only the overflowing step is reported, once", () => {
  assert.deepEqual(diagnostics("say (1e308 * 10) * 2 + 1"), ["TSV050 1:6"]);
  // Checks of a known wait, timer, or repeat value leave an overflow to the overflow error.
  assert.deepEqual(diagnostics("wait -1e308 * 10"), ["TSV050 1:6"]);
  assert.deepEqual(diagnostics("timer -1e308 * 10"), ["TSV050 1:7"]);
  assert.deepEqual(diagnostics("repeat 1e308 * 10 { }"), ["TSV050 1:8"]);
  assert.deepEqual(diagnostics("say 1e308 + 1e308 - 1e308"), ["TSV050 1:5"]);
  assert.deepEqual(diagnostics("say 1e308 * 10\nsay 1 / 0"), ["TSV050 1:5", "TSV050 2:5"]);
});

test("values the compiler cannot know stay runtime checks", () => {
  for (const source of [
    "let big = 1e308\nsay big * 10",
    "function grow(x) { return x * 10 }\nsay grow(1e308)",
    "let zero = 0\nsay 1 / zero",
  ]) {
    assert.deepEqual(diagnostics(source), [], source);
    const result = runValidSource(source);
    assert.equal(result.snapshot.status, "failed", source);
    assert.equal(result.snapshot.failure?.code, "TSR036", source);
  }
});

test("large values that stay finite still compile", () => {
  for (const source of [
    "say 1e308 * 1",
    "say -1e308 - 1e307",
    "say 9007199254740991 * 2",
    "say 1e300 * 1e8",
    "let d = 1 h * 1e9",
    "wait 1e12",
  ]) {
    assert.deepEqual(diagnostics(source), [], source);
  }
});

test("a wait or timer that scene time cannot reach is a compile error that names the fix", () => {
  for (const [source, subject] of [
    ["wait 1e306", "wait"],
    ["wait 1e13", "wait"],
    ["wait 1e16 ms", "wait"],
    ["timer 1e306", "timer"],
    ["timer async 1e16 ms", "timer"],
    // Every draw of a range is at least its lower bound.
    ["timer 10000000000000..=10000000000001", "timer"],
    ["timer 10000000000000..10000000000002", "timer"],
    ["timer(duration: 10000000000000..=10000000000001, async: true, repeat: true)", "timer"],
  ] as const) {
    const [reach, ...rest] = compileSource(source).diagnostics;
    assert.equal(reach?.code, "TSV011", source);
    assert.equal(
      reach?.message,
      `This ${subject} is too long for scene time to reach. Use a shorter duration.`,
    );
    assert.deepEqual(rest, [], source);
  }
});
