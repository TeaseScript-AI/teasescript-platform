// The gate variants' swap (`swap.mjs`): which imports each variant swaps, and which builds it refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gateSwap } from "./swap.mjs";

const BROWSER_CLIENT = fileURLToPath(
  new URL("../../../player/engine-bridge/browser-client.ts", import.meta.url),
);

for (const [variant, wrapper] of [
  ["delayed", /delayed-client\.mjs$/u],
  ["instrumented", /instrumented-client\.mjs$/u],
]) {
  test(`${variant} swaps the client import, and refuses a build with none`, () => {
    const swap = gateSwap({ variant });
    assert.match(swap.resolveId("./client.js", BROWSER_CLIENT), wrapper);
    assert.equal(swap.resolveId("./protocol.js", BROWSER_CLIENT), null);
    assert.doesNotThrow(() => swap.buildEnd());
    assert.throws(() => gateSwap({ variant }).buildEnd(), /swapped no client import/u);
  });
}
