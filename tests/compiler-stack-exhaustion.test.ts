import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

test("compiler explains genuine parser host-stack exhaustion and preserves its cause", () => {
  const source = `let value = ${"(".repeat(96)}1${")".repeat(96)}`;
  const script = `
    import { compileSource } from "./dist/src/compiler.js";
    try {
      compileSource(${JSON.stringify(source)});
      console.log(JSON.stringify({ result: "unexpected-success" }));
    } catch (error) {
      const cause = error.cause;
      console.log(JSON.stringify({
        name: error.name,
        message: error.message,
        cause: { constructor: cause?.constructor?.name, name: cause?.name, message: cause?.message },
      }));
    }
  `;
  const child = spawnSync(process.execPath, ["--stack_size=128", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(child.status, 0);
  assert.equal(child.signal, null);
  const result = JSON.parse(child.stdout) as {
    name: string;
    message: string;
    cause: { constructor: string; name: string; message: string };
  };
  assert.equal(result.name, "CompilerHostStackExhaustionError");
  assert.match(result.message, /Host JavaScript stack exhaustion/u);
  assert.match(result.message, /not a TeaseScript nesting limit/u);
  assert.ok(["RangeError", "SyntaxError"].includes(result.cause.constructor));
  assert.equal(result.cause.name, result.cause.constructor);
  assert.match(result.cause.message, /stack/i);
});

for (const [name, error] of [
  ["RangeError", new RangeError("ordinary range failure")],
  ["SyntaxError", new SyntaxError("ordinary syntax failure")],
] as const) {
  test(`compiler preserves unrelated ${name}`, () => {
    const original = RegExp.prototype.test;
    RegExp.prototype.test = () => { throw error; };
    try {
      assert.throws(() => compileSource("let value = 1"), (received: unknown) => received === error);
    } finally {
      RegExp.prototype.test = original;
    }
  });
}
