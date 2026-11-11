// The gate variants' swap (`swap.mjs`): which imports each variant swaps, and which builds it refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gateSwap, IN_PROCESS } from "./swap.mjs";

const ROOT = IN_PROCESS.slice(0, -"/player/engine-bridge/in-process.ts".length);
const BROWSER_CLIENT = `${ROOT}/player/engine-bridge/browser-client.ts`;
const SESSION = `${ROOT}/player/vue/src/session/useEngineConnection.ts`;

/** Runs `swap` over `imports` (`[source, importer]`), then its `buildEnd` over a graph of `modules`. */
function build(swap, imports, modules) {
  const resolved = imports.map(([source, importer]) => swap.resolveId(source, importer));
  const end = () => swap.buildEnd.call({ getModuleIds: () => modules[Symbol.iterator]() });
  return { resolved, end };
}

test("delayed on a Worker Player: its client is swapped, and with no in-process backend in the graph it builds", () => {
  const { resolved, end } = build(
    gateSwap({ variant: "delayed" }),
    [["./client.js", BROWSER_CLIENT]],
    [BROWSER_CLIENT],
  );
  assert.match(resolved[0], /delayed-client\.mjs$/u);
  assert.doesNotThrow(end);
});

test("delayed refuses a build whose client import it never swapped", () => {
  const { end } = build(gateSwap({ variant: "delayed" }), [], [BROWSER_CLIENT]);
  assert.throws(end, /the delayed variant swapped no client import/u);
});

test("delayed refuses a build that holds an in-process backend it did not swap", () => {
  // The client is swapped; `in-process.ts` is in the graph, imported by another module than the one the swap knows.
  const { end } = build(
    gateSwap({ variant: "delayed" }),
    [
      ["./client.js", BROWSER_CLIENT],
      ["../../../engine-bridge/in-process.js", `${ROOT}/player/vue/src/session/elsewhere.ts`],
    ],
    [BROWSER_CLIENT, IN_PROCESS],
  );
  assert.throws(end, /the delayed variant swapped no in-process import/u);
});

test("delayed on a Player from before the activation swaps its in-process backend too", () => {
  const { resolved, end } = build(
    gateSwap({ variant: "delayed" }),
    [
      ["../../../engine-bridge/in-process.js", SESSION],
      ["./client.js", IN_PROCESS],
      ["../../../engine-bridge/client.js", SESSION],
    ],
    [SESSION, IN_PROCESS],
  );
  assert.match(resolved[0], /delayed-in-process\.mjs$/u);
  assert.equal(resolved[1], null, "the in-process backend's own client is left alone");
  assert.doesNotThrow(end);
});

test("instrumented swaps every client import and refuses a build with none", () => {
  const { resolved, end } = build(
    gateSwap({ variant: "instrumented" }),
    [["./client.js", BROWSER_CLIENT]],
    [BROWSER_CLIENT],
  );
  assert.match(resolved[0], /instrumented-client\.mjs$/u);
  assert.doesNotThrow(end);
  assert.throws(
    build(gateSwap({ variant: "instrumented" }), [], []).end,
    /swapped no client import/u,
  );
});
