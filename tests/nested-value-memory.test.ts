import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/*
 * Memory regressions of deeply nested values (#1160): the compiler's known value of a list, set, or dict literal copied
 * the value below it at every level, and a set kept its member's whole `valueKey`, so each level of a nested value kept
 * memory in proportion to its depth, and a set literal nested 4,096 deep kept 787 MiB. Each test runs in a child process
 * whose V8 heap is capped at about twice what it needs, far below what it needed before: scale regressions, not supported
 * maxima.
 */

const url = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);

/** The lines `script` prints in a child process with a V8 heap of `heapMib` MiB; a crash or an error fails the test. */
function childLines(script: string, heapMib: number): string[] {
  const child = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMib}`, "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `killed by ${child.signal}`);
  assert.equal(child.status, 0, `exit ${child.status}\n${child.stderr.slice(-2_000)}`);
  return child.stdout.trim().split("\n");
}

test("the known value of a list, set, or dict literal nested 2,048 deep fits a 64 MiB heap", () => {
  const script = `
    import {parse} from ${url("../src/parser.js")};
    import {KnownValues} from ${url("../src/static-evaluation.js")};
    for (const [open, close] of [["[", "]"], ["set[", "]"], ["dict{x:", "}"]]) {
      const literal = open.repeat(2048) + "1" + close.repeat(2048);
      const call = parse("inspect(" + literal + ")\\n").program.statements[0].expression;
      console.log(open + " " + (new KnownValues().known(call.arguments[0].value) !== undefined));
    }
  `;
  assert.deepEqual(childLines(script, 64), ["[ true", "set[ true", "dict{x: true"]);
});

test("a set nested 256 deep with a text of 2,000 characters at every level fits a 16 MiB heap", () => {
  // Each level takes the one below as it is, as the runtime builds a set literal.
  const script = `
    import {addOwnedSerializableSetValue, serializableSetContains} from ${url("../src/runtime/values/serializable-values.js")};
    let value = 1;
    for (let level = 0; level < 256; level += 1) {
      const set = {kind: "set", items: []};
      addOwnedSerializableSetValue(set, value);
      addOwnedSerializableSetValue(set, String(level).padStart(2000, "x"));
      value = set;
    }
    console.log(serializableSetContains(value, value.items[0]), serializableSetContains(value, value.items[1]));
  `;
  assert.deepEqual(childLines(script, 16), ["true true"]);
});
