import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/parser.js";
import {
  execute,
  Interpreter,
  InterpreterCompilationError,
  type BuiltinFunction,
  type InterpreterOptions,
} from "../src/runtime/interpreter.js";
import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

const WAIT_COMPATIBILITY_CODE = "TSC004";
const WAIT_COMPATIBILITY_MESSAGE =
  "Blocking `wait` requires the canonical resumable runtime API.";

const compatibilityEntries = [
  {
    name: "execute(program, ...)",
    invoke: (source: string, options: InterpreterOptions) =>
      execute(parseProgram(source), options),
  },
  {
    name: "Interpreter.execute(program)",
    invoke: (source: string, options: InterpreterOptions) =>
      new Interpreter(options).execute(parseProgram(source)),
  },
] as const;

for (const entry of compatibilityEntries) {
  test(`${entry.name} rejects a wait without returning a partial result or runtime effects`, () => {
    let randomCalls = 0;
    let builtinCalls = 0;
    const observed: unknown[] = [];
    const capture: BuiltinFunction = (call) => {
      builtinCalls += 1;
      observed.push(call.positional[0] ?? null);
      return null;
    };
    const source = [
      'capture(["before"].random)',
      'say "before"',
      "wait 1 s",
      'say "after"',
      "exit",
    ].join("\n");

    const error = assertWaitRejection(() =>
      entry.invoke(source, {
        random: {
          next: () => {
            randomCalls += 1;
            return 0;
          },
        },
        builtins: { capture },
      }),
    );

    assert.deepEqual(error.diagnostics.map((diagnostic) => diagnostic.code), [
      WAIT_COMPATIBILITY_CODE,
    ]);
    assert.deepEqual(observed, []);
    assert.equal(randomCalls, 0);
    assert.equal(builtinCalls, 0);
    assert.deepEqual(
      [error.diagnostics[0]?.span.start.offset, error.diagnostics[0]?.span.end.offset],
      [source.indexOf("wait 1 s"), source.indexOf("wait 1 s") + "wait 1".length],
    );
  });

  test(`${entry.name} rejects a wait before runtime execution`, () => {
    assertWaitRejection(() =>
      entry.invoke("wait 1 ms\nexit", { random: { next: () => 0 } }),
    );
  });

  test(`${entry.name} conservatively rejects waits in control flow and functions`, () => {
    for (const source of [
      "if false {\n  wait 1 ms\n}",
      "repeat 0 {\n  wait 1 ms\n}",
      "if true {\n  if false {\n    wait 1 ms\n  }\n}",
      "function pause {\n  wait 1 ms\n}\npause()",
      "function pause {\n  wait 1 ms\n}\nsay \"never reaches function\"",
    ]) {
      assertWaitRejection(() =>
        entry.invoke(source, { random: { next: () => 0 } }),
      );
    }
  });
}

test("compatibility wait rejection uses the first canonical wait instruction", () => {
  const source = [
    "if true {",
    "  wait 1 ms",
    "}",
    "wait 1 s",
  ].join("\n");
  const error = assertWaitRejection(() =>
    execute(parseProgram(source), { random: { next: () => 0 } }),
  );

  assert.deepEqual(
    [error.diagnostics[0]?.span.start.offset, error.diagnostics[0]?.span.end.offset],
    [source.indexOf("wait 1 ms"), source.indexOf("wait 1 ms") + "wait 1".length],
  );
});

test("all accepted wait units remain syntax-valid but reject at compatibility execution", () => {
  for (const source of ["wait 1", "wait 1 ms", "wait 1 s", "wait 1 min", "wait 1 h"]) {
    assert.deepEqual(parse(source).diagnostics, [], source);
    assertWaitRejection(() =>
      execute(parseProgram(source), { random: { next: () => 0 } }),
    );
  }
});

test("compatibility execution without wait retains its observable behavior", () => {
  const result = execute(parseProgram('say "before"\nexit'), {
    random: { next: () => 0 },
  });

  assert.deepEqual(result.events.map((event) => event.kind), ["say", "exit"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.exited, true);
});

test("the canonical runtime still creates, settles, and resumes blocking waits", () => {
  const compiled = compileSource('say "before"\nwait 1 ms\nsay "after"\nexit');
  assert.notEqual(compiled.plan, null);
  const plan = compiled.plan!;
  const waiting = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.deepEqual(waiting.events.map((event) => event.kind), ["say", "actionRequested"]);

  const settled = observeTime(plan, waiting.snapshot, 1);
  const completed = run(plan, settled.snapshot);
  assert.deepEqual(completed.events.map((event) => event.kind), ["say", "exit"]);
  assert.equal(completed.snapshot.status, "halted");
});

function assertWaitRejection(action: () => unknown): InterpreterCompilationError {
  let captured: InterpreterCompilationError | null = null;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof InterpreterCompilationError);
    captured = error;
    assert.equal(error.name, "InterpreterCompilationError");
    assert.equal(error.message, WAIT_COMPATIBILITY_MESSAGE);
    assert.equal(error.diagnostics.length, 1);
    assert.equal(error.diagnostics[0]?.severity, "error");
    assert.equal(error.diagnostics[0]?.code, WAIT_COMPATIBILITY_CODE);
    return true;
  });
  assert.notEqual(captured, null);
  if (captured === null) {
    throw new Error("Expected an InterpreterCompilationError.");
  }
  return captured;
}

function parseProgram(source: string) {
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.program;
}
