import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  LibraryCatalog,
  LibraryCatalogError,
  LibraryMetadataError,
  MAX_LIBRARY_METADATA_TEXT_LENGTH,
  createExactLibraryIdentity,
  createPublicLibraryMetadata,
  validatePublicLibraryMetadata,
} from "../src/library-tooling/public.js";
import { invalidLibraryFixtures, validLibraryFixtures } from "./library-validation-fixtures.js";
import { validateDevelopmentLibrary } from "./library-validation-runner.js";

test("development-only runner validates every neutral valid fixture without source execution", () => {
  for (const fixture of validLibraryFixtures) {
    const result = validateDevelopmentLibrary(fixture.identityToken, fixture.source);
    assert.equal(result.ok, true, fixture.name);
    if (!result.ok) continue;
    assert.deepEqual(result.metadata.exports.map((entry) => entry.name), fixture.exportNames, fixture.name);
    assert.equal(JSON.stringify(result.metadata), result.serializedMetadata, fixture.name);
  }
});

test("development-only runner returns deterministic structured metadata failures", () => {
  for (const fixture of invalidLibraryFixtures) {
    const first = validateDevelopmentLibrary("fixtures.invalid@exact-1", fixture.source);
    const second = validateDevelopmentLibrary("fixtures.invalid@exact-1", fixture.source);
    assert.deepEqual(first, second, fixture.name);
    assert.equal(first.ok, false, fixture.name);
    if (!first.ok) {
      assert.equal(first.category, "metadata", fixture.name);
      assert.equal(first.code, fixture.code, fixture.name);
      assert.equal(typeof first.message, "string", fixture.name);
    }
  }
});

test("catalog exact identity registration, missing identity, and duplicates remain isolated", () => {
  const catalog = new LibraryCatalog();
  const identity = createExactLibraryIdentity("fixtures.identity@exact-1");
  catalog.register({ identity, source: "export function alpha(): void {}" });
  assert.equal(catalog.resolve(identity).identity.token, identity.token);
  assert.throws(() => catalog.register({ identity, source: "export function alpha(): void {}" }), catalogError("duplicateIdentity"));
  assert.throws(() => catalog.resolve({ token: "fixtures.identity@exact-2" }), catalogError("missingIdentity"));
});

test("metadata serialization is repeatable, canonical, round-trippable, and deeply immutable", () => {
  const fixture = validLibraryFixtures[0];
  const first = validateDevelopmentLibrary(fixture.identityToken, fixture.source);
  const second = validateDevelopmentLibrary(fixture.identityToken, fixture.source);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.serializedMetadata, second.serializedMetadata);
  assert.deepEqual(validatePublicLibraryMetadata(JSON.parse(first.serializedMetadata)), first.metadata);
  assert.equal(Object.isFrozen(first.metadata), true);
  assert.equal(Object.isFrozen(first.metadata.identity), true);
  assert.equal(Object.isFrozen(first.metadata.exports), true);
  assert.equal(Object.isFrozen(first.metadata.exports[2]!.parameters), true);
  assert.throws(() => { (first.metadata.identity as { token: string }).token = "mutated"; }, TypeError);
  assert.throws(() => { (first.metadata.exports as unknown as unknown[]).push({}); }, TypeError);
  assert.throws(() => { (first.metadata.exports[2]!.parameters as unknown as unknown[]).push({}); }, TypeError);
});

test("externally supplied metadata rejects hostile shapes and text bounds with structured errors", () => {
  const valid = createPublicLibraryMetadata({
    identity: createExactLibraryIdentity("fixtures.external@exact-1"),
    source: "export function beta(): void {}\nexport function alpha(value: string): void {}",
  });
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, JSON.parse(JSON.stringify(valid)));
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "exports", { enumerable: true, get: () => valid.exports });
  const sparse = { ...valid, exports: new Array(1) };
  const nonCanonical = { ...valid, exports: [...valid.exports].reverse() };
  const duplicate = { ...valid, exports: [...valid.exports, valid.exports[0]! ] };
  const overField = { ...valid, exports: [{ ...valid.exports[0]!, documentation: "x".repeat(MAX_LIBRARY_METADATA_TEXT_LENGTH + 1) }] };
  const overTotal = { ...valid, exports: Array.from({ length: 7 }, (_, index) => ({ ...valid.exports[0]!, name: `${index}${"x".repeat(MAX_LIBRARY_METADATA_TEXT_LENGTH - 1)}`, documentation: "x".repeat(MAX_LIBRARY_METADATA_TEXT_LENGTH) })) };
  for (const malformed of [accessor, sparse, nonCanonical, duplicate, overField, overTotal]) {
    assert.throws(() => validatePublicLibraryMetadata(malformed), metadataError("invalidMetadata"));
  }
  assert.deepEqual(validatePublicLibraryMetadata(nullPrototype), valid);
});

test("runner depends only on public static tooling and cannot expose privileged capabilities", () => {
  const runnerSource = readFileSync(resolve(process.cwd(), "tests/library-validation-runner.ts"), "utf8");
  const imports = [...runnerSource.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["../src/library-tooling/public.js"]);
  assert.doesNotMatch(runnerSource, /privileged-platform-adapters/);
  const result = validateDevelopmentLibrary("fixtures.inert@exact-1", "export function alpha(): void { throw new Error('must not execute') }");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(JSON.stringify(result.metadata).includes("privileged"), false);
});

function catalogError(code: LibraryCatalogError["code"]): (error: unknown) => boolean {
  return (error): boolean => error instanceof LibraryCatalogError && error.code === code;
}

function metadataError(code: LibraryMetadataError["code"]): (error: unknown) => boolean {
  return (error): boolean => error instanceof LibraryMetadataError && error.code === code;
}
