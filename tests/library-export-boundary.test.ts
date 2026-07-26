import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../src/index.js";
import * as publicLibraries from "../src/libraries/public.js";
import { LibraryCatalog, LibraryCatalogError } from "../src/libraries/public.js";
import { privilegedPlatformAdapterMarker } from "../src/libraries/internal/privileged-platform-adapters.js";

test("public library surface does not export privileged adapter values", () => {
  assert.equal(typeof root.LibraryCatalog, "function");
  assert.equal(typeof root.createExactLibraryIdentity, "function");
  assert.equal("privilegedPlatformAdapterMarker" in publicLibraries, false);
  assert.equal("privilegedPlatformAdapterMarker" in root, false);
  assert.equal(privilegedPlatformAdapterMarker.internalOnly, true);
});

test("public registration accepts inert definitions only and grants no platform capability", () => {
  const catalog = new LibraryCatalog();
  const metadata = catalog.register({
    identity: { token: "package.example.safe@1" },
    source: "export function helper(value: string): string { return value }",
  });

  assert.deepEqual(Object.keys(metadata).sort(), ["exports", "identity"]);
  assert.equal(JSON.stringify(metadata).includes("privileged"), false);
  assert.throws(
    () => catalog.register({
      identity: { token: "package.example.capability@1" },
      source: "export function helper() {}",
      capability: privilegedPlatformAdapterMarker,
    }),
    (error: unknown) =>
      error instanceof LibraryCatalogError && error.code === "invalidDefinition",
  );
});
