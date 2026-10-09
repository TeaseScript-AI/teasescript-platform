import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
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

test("a division by a zero the compiler can see fails at compile time whatever the dividend", () => {
  for (const [source, at] of [
    ["let x = 5\nsay x / 0", "2:5"],
    ["let x = 5\nsay x % 0", "2:5"],
    ["let x = 5\nsay x / (2 - 2)", "2:5"],
    ["let x = 5\nsay x / -0", "2:5"],
    ["let d = 5 s\nsay d / 0 ms", "2:5"],
    ["function f(x) { return x / 0 }", "1:24"],
  ] as const) {
    assert.deepEqual(diagnostics(source), [`TSV050 ${at}`], source);
  }
  // A computed divisor is known only at runtime, where the same division fails.
  const computed = runValidSource("let x = 5\nlet zero = 2 - 2\nsay x / zero\nexit");
  assert.equal(computed.snapshot.failure?.code, "TSR036");
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

test("values the compiler cannot know fail at runtime with the cause, the values, and the fix", () => {
  for (const [source, code, message] of [
    [
      "let big = 1e308\nsay big * 10\nexit",
      "TSR036",
      "'big * 10' is 1e+308 * 10, which gives a number too large to represent. Use smaller values.",
    ],
    [
      "function grow(x) { return x * 10 }\nsay grow(1e308)\nexit",
      "TSR036",
      "'x * 10' is 1e+308 * 10, which gives a number too large to represent. Use smaller values.",
    ],
    [
      "let zero = 0\nsay 1 / zero\nexit",
      "TSR036",
      "Division by zero: '1 / zero' has no result because 'zero' is 0. Check that 'zero' is not 0 first.",
    ],
    [
      "let count = 0\nsay 7 % count\nexit",
      "TSR036",
      "Remainder by zero: '7 % count' has no result because 'count' is 0. Check that 'count' is not 0 first.",
    ],
    // An operand the source does not spell as a name or a number shows its value instead.
    [
      "let zero = 0\nsay (1 + 2) / (zero * 1)\nexit",
      "TSR036",
      "Division by zero: 3 / 0 has no result. Check that the divisor is not 0 first.",
    ],
    // Dividing exact time by zero keeps TSR036, and a calendar duration TSR009.
    [
      "let n = 0\nsay 1 s / n\nexit",
      "TSR036",
      "Division by zero: 1 second / 0 has no result because 'n' is 0. Check that 'n' is not 0 first.",
    ],
    [
      "let n = 0\nsay 1 calendar month / n\nexit",
      "TSR009",
      "Division by zero: 1 calendar month / 0 has no result because 'n' is 0. Check that 'n' is not 0 first.",
    ],
    [
      "let n = 1e305\nsay 1 h * n\nexit",
      "TSR036",
      "1 hour * 1e+305 gives a duration too long to represent. Use smaller values.",
    ],
  ] as const) {
    assert.deepEqual(diagnostics(source), [], source);
    const failure = runValidSource(source).snapshot.failure;
    assert.deepEqual([failure?.code, failure?.message], [code, message], source);
  }
});

test("large values that stay finite still compile", () => {
  for (const source of [
    "say 1e308 * 1\nexit",
    "say -1e308 - 1e307\nexit",
    "say 9007199254740991 * 2\nexit",
    "say 1e300 * 1e8\nexit",
    "let d = 1 h * 1e9\nexit",
    "wait 1e12 s\nexit",
  ]) {
    assert.deepEqual(diagnostics(source), [], source);
  }
});

test("a wait or timer that scene time cannot reach is a compile error that names the fix", () => {
  for (const [source, subject] of [
    ["wait (1e15) s", "wait"],
    ["wait 1e13 s", "wait"],
    ["wait 1e16 ms", "wait"],
    ["timer (1e15) s", "timer"],
    ["timer async 1e16 ms", "timer"],
    // Every draw of a range is at least its lower bound.
    ["timer (10000000000000..=10000000000001) s", "timer"],
    ["timer (10000000000000..10000000000002) s", "timer"],
    ["timer(duration: (10000000000000..=10000000000001) s, async: true, repeat: true)", "timer"],
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

test("at the last scene time, a positive wait, timer, timeout, or timer round fails with advice that can work", () => {
  const last = Number.MAX_SAFE_INTEGER;
  // Runs until the script stops, letting scene time reach each wait's deadline.
  const failure = (source: string, initialSessionTimeMs = last) => {
    const plan = compileValidPlan(source);
    let result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { initialSessionTimeMs }));
    while (result.snapshot.status === "waiting" && result.snapshot.foregroundAction !== null) {
      result = observeTime(plan, result.snapshot, last);
      result = run(plan, result.snapshot);
    }
    return result.snapshot.failure;
  };
  const round =
    "Scene time has reached its limit, so this timer cannot continue. Stop it, or set its remaining time to 0 s.";
  for (const [source, code, message, initialSessionTimeMs] of [
    [
      "wait 1 s\nexit",
      "TSR050",
      "Scene time has reached its limit, so this wait cannot run. Remove it.",
    ],
    [
      "timer 1 s\nexit",
      "TSR050",
      "Scene time has reached its limit, so this timer cannot run. Remove it, or set its duration to 0 s.",
    ],
    [
      "let t = timer async 1 s\nexit",
      "TSR050",
      "Scene time has reached its limit, so this timer cannot run. Remove it, or set its duration to 0 s.",
    ],
    [
      "let t = timer(duration: 5 s, async: true, repeat: true)\nexit",
      "TSR050",
      "Scene time has reached its limit, so this timer cannot run. Remove it.",
    ],
    [
      'let elapsed = showButton "Go", timeout: 5 s\nexit',
      "TSR050",
      "Scene time has reached its limit, so this showButton timeout cannot run. Remove 'timeout:' to wait without a time limit.",
    ],
    [
      'let answers = askForm fields: { n: { type: "integer", value: 1 } }, timeout: 1 s, onTimeout: "submit"\nexit',
      "TSR052",
      "Scene time has reached its limit, so this askForm timeout cannot run. Remove 'timeout:' and 'onTimeout:' to wait without a time limit.",
    ],
    [
      "let t = timer async 5 s\nt.pause()\nwait 10 s\nt.resume()\nexit",
      "TSR050",
      round,
      last - 10_000,
    ],
    [
      "let t = timer async 5 s\nt.pause()\nwait 10 s\nt.remaining = 3 s\nexit",
      "TSR050",
      round,
      last - 10_000,
    ],
    [
      "let t = timer(duration: 5 s, async: true, repeat: true)\nt.pause()\nwait 10 s\nt.resume()\nexit",
      "TSR050",
      "Scene time has reached its limit, so this timer cannot continue. Stop it.",
      last - 10_000,
    ],
  ] as const) {
    const failed = failure(source, initialSessionTimeMs);
    assert.equal(failed?.code, code, source);
    assert.equal(failed?.message, message, source);
  }
  // The advice works: no wait, a timer of 0 s, a form without a time limit, a stopped repeating timer, and a timer
  // whose remaining time is zero.
  assert.equal(failure("wait 0 s\nexit"), null);
  assert.equal(failure("let t = timer async 0 s\nt.stop()\nexit"), null);
  const untimed = compileValidPlan(
    'let answers = askForm fields: { n: { type: "integer", value: 1 } }\nexit',
  );
  const opened = run(
    untimed,
    createImmediatePacingRuntimeSnapshot(untimed, { initialSessionTimeMs: last }),
  ).snapshot;
  assert.equal(opened.failure, null);
  assert.equal(opened.foregroundAction?.kind, "interaction");
  assert.equal(
    failure(
      "let t = timer(duration: 5 s, async: true, repeat: true)\nt.pause()\nwait 10 s\nt.stop()\nexit",
      last - 10_000,
    ),
    null,
  );
  assert.equal(
    failure(
      "let t = timer async 5 s\nt.pause()\nwait 10 s\nt.remaining = 0 s\nt.resume()\nexit",
      last - 10_000,
    ),
    null,
  );
});
