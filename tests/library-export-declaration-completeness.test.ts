import assert from "node:assert/strict";
import test from "node:test";

import {
  LibraryMetadataError,
  createExactLibraryIdentity,
  createPublicLibraryMetadata,
} from "../src/libraries/public.js";

const identity = createExactLibraryIdentity("export-completeness@1");

function isUnsupportedExport(error: unknown): boolean {
  return error instanceof LibraryMetadataError && error.code === "unsupportedExport";
}

test("metadata rejects TypeScript export assignments and namespace exports", () => {
  for (const source of [
    "function alpha(): void {}\nexport = alpha",
    "function alpha(): void {}\nexport default alpha",
    "export as namespace PublicNamespace",
  ]) {
    assert.throws(
      () => createPublicLibraryMetadata({ identity, source }),
      isUnsupportedExport,
      source,
    );
  }
});

test("private declarations remain absent after exhaustive export-statement checks", () => {
  const metadata = createPublicLibraryMetadata({
    identity,
    source: "function alpha(): void {}\ntype Local = string\ninterface Hidden { value: string }",
  });
  assert.deepEqual(metadata.exports, []);
});
