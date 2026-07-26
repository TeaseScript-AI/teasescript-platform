import assert from "node:assert/strict";
import test from "node:test";

import {
  LibraryCatalog,
  LibraryCatalogError,
  LibraryMetadataError,
  MAX_LIBRARY_SOURCE_LENGTH,
  createExactLibraryIdentity,
  createPublicLibraryMetadata,
  validatePublicLibraryMetadata,
} from "../src/libraries/public.js";

const FIXTURE_SOURCE = `
/** Beta documentation.\n * @deprecated Use alpha instead. */
export function beta(required: string, optional?: number, defaulted = false): boolean { return true }
/** Alpha documentation. */
export function alpha(value: number = 1): string { return String(value) }
export interface Thing { value: string }
`;

function definition(token = "org.example.fixture@exact-1"): Record<string, unknown> {
  return { identity: { token }, source: FIXTURE_SOURCE };
}

test("catalog resolves only an exact registered identity without latest or fallback", () => {
  const catalog = new LibraryCatalog();
  catalog.register(definition());

  assert.equal(catalog.resolve({ token: "org.example.fixture@exact-1" }).identity.token, "org.example.fixture@exact-1");
  for (const value of [
    { token: "org.example.fixture@latest" },
    { token: "org.example.fixture" },
    { token: "org.example.fixture@exact-2" },
  ]) {
    assert.throws(() => catalog.resolve(value), isCatalogError("missingIdentity"));
  }
});

test("catalog rejects missing and duplicate identities deterministically", () => {
  const catalog = new LibraryCatalog();
  assert.throws(() => catalog.resolve({ token: "missing@1" }), isCatalogError("missingIdentity"));
  catalog.register(definition());
  assert.throws(() => catalog.register(definition()), isCatalogError("duplicateIdentity"));
});

test("catalog identity lookup rejects accessors and throwing proxy traps as structured input failures", () => {
  const catalog = new LibraryCatalog();
  catalog.register(definition());
  const accessor = {};
  Object.defineProperty(accessor, "token", { enumerable: true, get: () => "org.example.fixture@exact-1" });
  const throwingProxy = new Proxy({}, {
    getPrototypeOf: () => { throw new Error("host trap"); },
  });

  assert.throws(() => catalog.resolve(accessor), isCatalogError("invalidDefinition"));
  assert.throws(() => catalog.resolve(throwingProxy), isCatalogError("invalidDefinition"));
});

test("catalog results do not depend on registration order", () => {
  const first = new LibraryCatalog();
  const second = new LibraryCatalog();
  first.register(definition("z@1"));
  first.register(definition("a@1"));
  second.register(definition("a@1"));
  second.register(definition("z@1"));

  assert.deepEqual(first.list(), second.list());
  assert.deepEqual(first.resolve({ token: "a@1" }), second.resolve({ token: "a@1" }));
});

test("metadata has canonical export ordering and extracts public signatures", () => {
  const metadata = createPublicLibraryMetadata({
    identity: createExactLibraryIdentity("fixture@1"),
    source: FIXTURE_SOURCE,
  });

  assert.deepEqual(metadata.exports.map((entry) => entry.name), ["Thing", "alpha", "beta"]);
  const beta = metadata.exports[2]!;
  assert.deepEqual(beta, {
    name: "beta",
    kind: "function",
    parameters: [
      { name: "required", optional: false, hasDefault: false, typeDisplay: "string" },
      { name: "optional", optional: true, hasDefault: false, typeDisplay: "number" },
      { name: "defaulted", optional: true, hasDefault: true, typeDisplay: null },
    ],
    returnTypeDisplay: "boolean",
    documentation: "Beta documentation.",
    deprecation: "Use alpha instead.",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), metadata);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.exports), true);
});

test("unsupported exports and duplicate public names fail clearly", () => {
  const identity = createExactLibraryIdentity("fixture@1");
  assert.throws(
    () => createPublicLibraryMetadata({ identity, source: "export const value = 1" }),
    isMetadataError("unsupportedExport"),
  );
  assert.throws(
    () => createPublicLibraryMetadata({
      identity,
      source: "export function repeated() {}\nexport interface repeated {}",
    }),
    isMetadataError("duplicateExport"),
  );
  for (const source of [
    "export default function named() {}",
    "export async function asynchronous() {}",
    "export declare function declared(): void",
    "export function generic<T>(value: T): T { return value }",
    "export interface Generic<T> { value: T }",
    "export type Alias<T> = T",
    "export function rest(...values: string[]): void {}",
    "export function receiver(this: { value: string }, value: string): string { return value }",
  ]) {
    assert.throws(
      () => createPublicLibraryMetadata({ identity, source }),
      isMetadataError("unsupportedExport"),
    );
  }
});

test("metadata generation captures external definitions and bounds TypeScript source", () => {
  const identity = createExactLibraryIdentity("fixture@1");
  const accessor = { identity } as Record<string, unknown>;
  Object.defineProperty(accessor, "source", { enumerable: true, get: () => "export function value() {}" });
  const throwingProxy = new Proxy({}, {
    getPrototypeOf: () => { throw new Error("host trap"); },
  });

  assert.throws(() => createPublicLibraryMetadata(accessor as never), isMetadataError("invalidMetadata"));
  assert.throws(() => createPublicLibraryMetadata(throwingProxy as never), isMetadataError("invalidMetadata"));
  assert.throws(
    () => createPublicLibraryMetadata({ identity, source: "x".repeat(MAX_LIBRARY_SOURCE_LENGTH + 1) }),
    isMetadataError("invalidSource"),
  );
});

test("catalog captures data before caller mutation", () => {
  const catalog = new LibraryCatalog();
  const input = definition();
  catalog.register(input);
  (input.identity as { token: string }).token = "changed@1";
  input.source = "export const changed = 1";

  const registered = catalog.resolve({ token: "org.example.fixture@exact-1" });
  assert.equal(registered.exports[1]!.name, "alpha");
  assert.throws(() => catalog.resolve({ token: "changed@1" }), isCatalogError("missingIdentity"));
});

test("external metadata validation rejects sparse, oversized, executable, cyclic, accessor, and non-plain values", () => {
  const valid = createPublicLibraryMetadata({
    identity: createExactLibraryIdentity("fixture@1"),
    source: FIXTURE_SOURCE,
  });
  const malformed: unknown[] = [
    { ...valid, exports: new Array(4) },
    { ...valid, exports: new Array(100_001) },
    { ...valid, exports: [() => undefined] },
    { ...valid, exports: [Promise.resolve()] },
    { ...valid, exports: [new Date()] },
  ];
  const cyclic: Record<string, unknown> = { ...valid };
  cyclic.exports = [cyclic];
  malformed.push(cyclic);
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "exports", { enumerable: true, get: () => valid.exports });
  malformed.push(accessor);

  for (const value of malformed) {
    assert.throws(() => validatePublicLibraryMetadata(value), isMetadataError("invalidMetadata"));
  }
});

test("externally supplied metadata is frozen, canonical, and has no executable values", () => {
  const value = {
    identity: { token: "fixture@1" },
    exports: [{
      name: "one",
      kind: "function",
      parameters: [{ name: "value", optional: false, hasDefault: false, typeDisplay: "string" }],
      returnTypeDisplay: "void",
      documentation: null,
      deprecation: null,
    }],
  };
  const metadata = validatePublicLibraryMetadata(value);
  value.identity.token = "mutated@1";
  value.exports[0]!.name = "mutated";
  assert.deepEqual(metadata.exports.map((entry) => entry.name), ["one"]);
  assert.equal(metadata.identity.token, "fixture@1");
  assert.throws(() => validatePublicLibraryMetadata({
    ...value,
    exports: [
      ...metadata.exports,
      { ...metadata.exports[0]!, name: "aardvark" },
    ],
  }), isMetadataError("invalidMetadata"));
});

function isCatalogError(code: LibraryCatalogError["code"]): (error: unknown) => boolean {
  return (error): boolean => error instanceof LibraryCatalogError && error.code === code;
}

function isMetadataError(code: LibraryMetadataError["code"]): (error: unknown) => boolean {
  return (error): boolean => error instanceof LibraryMetadataError && error.code === code;
}
