import ts from "typescript";

import { captureExternalData } from "../external-data-limits.js";
import type { ExactLibraryIdentity, PublicLibraryDefinition } from "./catalog.js";

/** Bounds TypeScript parser work at the public tooling-data boundary. */
export const MAX_LIBRARY_SOURCE_LENGTH = 100_000;
export const MAX_LIBRARY_METADATA_TEXT_LENGTH = 16_384;
export const MAX_LIBRARY_METADATA_TOTAL_TEXT_LENGTH = 100_000;

export interface PublicParameterMetadata {
  readonly name: string;
  readonly optional: boolean;
  readonly hasDefault: boolean;
  readonly typeDisplay: string | null;
}

export interface PublicExportMetadata {
  readonly name: string;
  readonly kind: "function" | "type";
  readonly parameters: readonly PublicParameterMetadata[];
  readonly returnTypeDisplay: string | null;
  readonly documentation: string | null;
  readonly deprecation: string | null;
}

export interface PublicLibraryMetadata {
  readonly identity: ExactLibraryIdentity;
  readonly exports: readonly PublicExportMetadata[];
}

export class LibraryMetadataError extends Error {
  public constructor(
    readonly code: "invalidMetadata" | "duplicateExport" | "unsupportedExport" | "invalidSource",
    message: string,
  ) {
    super(message);
    this.name = "LibraryMetadataError";
  }
}

/**
 * Generates only static public metadata from ordinary named TypeScript exports.
 * Supported forms are exported function declarations, type aliases, and interfaces.
 */
export function createPublicLibraryMetadata(
  definition: PublicLibraryDefinition,
): PublicLibraryMetadata {
  const normalizedDefinition = captureLibraryDefinition(definition);
  const sourceFile = ts.createSourceFile(
    "library.ts",
    normalizedDefinition.source,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) {
    throw new LibraryMetadataError("invalidSource", "Library TypeScript source is invalid.");
  }

  const exports: PublicExportMetadata[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isNamespaceExportDeclaration(statement)
    ) {
      throw new LibraryMetadataError(
        "unsupportedExport",
        "Export lists, export assignments, namespace exports, and re-exports are not supported in this POC.",
      );
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      assertSupportedFunction(statement);
      exports.push(freezeExport({
        name: statement.name.text,
        kind: "function",
        parameters: statement.parameters.map((parameter) => parameterMetadata(parameter, sourceFile)),
        returnTypeDisplay: statement.type?.getText(sourceFile) ?? null,
        ...documentationFor(statement, sourceFile),
      }));
      continue;
    }
    if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))) {
      if (!hasOnlyExportModifier(statement) || statement.typeParameters !== undefined) {
        throw new LibraryMetadataError(
          "unsupportedExport",
          "Default and generic type exports are not supported in this POC.",
        );
      }
      exports.push(freezeExport({
        name: statement.name.text,
        kind: "type",
        parameters: [],
        returnTypeDisplay: null,
        ...documentationFor(statement, sourceFile),
      }));
      continue;
    }
    throw new LibraryMetadataError(
      "unsupportedExport",
      "Only named exported function declarations, type aliases, and interfaces are supported in this POC.",
    );
  }
  const names = new Set<string>();
  for (const entry of exports) {
    if (names.has(entry.name)) {
      throw new LibraryMetadataError("duplicateExport", `Duplicate public export '${entry.name}'.`);
    }
    names.add(entry.name);
  }
  exports.sort((left, right) => compareText(left.name, right.name));
  const metadata: PublicLibraryMetadata = Object.freeze({
    identity: Object.freeze({ token: normalizedDefinition.identity.token }),
    exports: Object.freeze(exports),
  });
  assertMetadataTextBounds(metadata);
  return metadata;
}

function captureLibraryDefinition(value: unknown): PublicLibraryDefinition {
  const captured = captureExternalData(value, "$library");
  if (!captured.ok) {
    throw new LibraryMetadataError(
      "invalidMetadata",
      `Library definition is not supported at ${captured.failure.path}.`,
    );
  }
  const definition = captured.value;
  if (!isPlainRecord(definition) || Object.keys(definition).length !== 2 ||
    !("identity" in definition) || !("source" in definition) ||
    !isIdentity(definition.identity) || typeof definition.source !== "string") {
    throw new LibraryMetadataError("invalidMetadata", "Library definition has an invalid shape.");
  }
  if (definition.source.length > MAX_LIBRARY_SOURCE_LENGTH) {
    throw new LibraryMetadataError(
      "invalidSource",
      `Library TypeScript source exceeds the ${MAX_LIBRARY_SOURCE_LENGTH}-character limit.`,
    );
  }
  return Object.freeze({
    identity: Object.freeze({ token: definition.identity.token }),
    source: definition.source,
  });
}

function assertSupportedFunction(statement: ts.FunctionDeclaration): void {
  if (!hasOnlyExportModifier(statement) || statement.typeParameters !== undefined) {
    throw new LibraryMetadataError(
      "unsupportedExport",
      "Default and generic function exports are not supported in this POC.",
    );
  }
  for (const parameter of statement.parameters) {
    if (parameter.dotDotDotToken !== undefined ||
      (ts.isIdentifier(parameter.name) && parameter.name.text === "this")) {
      throw new LibraryMetadataError(
        "unsupportedExport",
        "Rest and this parameters are not supported in public function metadata.",
      );
    }
  }
}

/** Validates externally supplied POC metadata and returns a frozen JSON-safe copy. */
export function validatePublicLibraryMetadata(value: unknown): PublicLibraryMetadata {
  const captured = captureExternalData(value, "$metadata");
  if (!captured.ok) {
    throw new LibraryMetadataError(
      "invalidMetadata",
      `Library metadata is not supported at ${captured.failure.path}.`,
    );
  }
  const metadata = captured.value;
  if (!isPlainRecord(metadata) || !isIdentity(metadata.identity) || !Array.isArray(metadata.exports) ||
    !isDenseArray(metadata.exports)) {
    throw new LibraryMetadataError("invalidMetadata", "Library metadata has an invalid shape.");
  }
  const normalized: PublicLibraryMetadata = Object.freeze({
    identity: Object.freeze({ token: metadata.identity.token }),
    exports: Object.freeze(metadata.exports.map((entry) => normalizeExport(entry))),
  });
  assertMetadataTextBounds(normalized);
  assertCanonical(normalized);
  return normalized;
}

function parameterMetadata(parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile): PublicParameterMetadata {
  if (!ts.isIdentifier(parameter.name)) {
    throw new LibraryMetadataError("unsupportedExport", "Destructured public parameters are not supported in this POC.");
  }
  return Object.freeze({
    name: parameter.name.text,
    optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
    hasDefault: parameter.initializer !== undefined,
    typeDisplay: parameter.type?.getText(sourceFile) ?? null,
  });
}

function documentationFor(node: ts.Node, sourceFile: ts.SourceFile): Pick<PublicExportMetadata, "documentation" | "deprecation"> {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile));
  const match = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(leading);
  if (match?.[1] === undefined) return { documentation: null, deprecation: null };
  const text = match[1].split("\n").map((line) => line.replace(/^\s*\* ?/, "").trim()).join("\n").trim();
  const deprecated = /@deprecated\s*([^\n]*)/.exec(text);
  const documentation = text.replace(/@deprecated\s*[^\n]*/g, "").trim() || null;
  return { documentation, deprecation: deprecated?.[1]?.trim() || (deprecated ? "Deprecated." : null) };
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword
  ) ?? false;
}

function hasOnlyExportModifier(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return modifiers !== undefined && modifiers.length === 1 && modifiers[0]?.kind === ts.SyntaxKind.ExportKeyword;
}

function normalizeExport(value: unknown): PublicExportMetadata {
  if (!isPlainRecord(value) || typeof value.name !== "string" ||
    (value.kind !== "function" && value.kind !== "type") || !Array.isArray(value.parameters) ||
    !nullableString(value.returnTypeDisplay) || !nullableString(value.documentation) || !nullableString(value.deprecation)) {
    throw new LibraryMetadataError("invalidMetadata", "Library export metadata has an invalid shape.");
  }
  if (!isDenseArray(value.parameters)) {
    throw new LibraryMetadataError("invalidMetadata", "Library parameter metadata has an invalid shape.");
  }
  if (!isBoundedMetadataText(value.name) || !isBoundedNullableMetadataText(value.returnTypeDisplay) ||
    !isBoundedNullableMetadataText(value.documentation) || !isBoundedNullableMetadataText(value.deprecation)) {
    throw new LibraryMetadataError("invalidMetadata", "Library export metadata text exceeds the supported limit.");
  }
  const parameters = value.parameters.map((parameter) => normalizeParameter(parameter));
  if (value.kind === "type" && (parameters.length !== 0 || value.returnTypeDisplay !== null)) {
    throw new LibraryMetadataError("invalidMetadata", "Type exports cannot declare function metadata.");
  }
  return freezeExport({ name: value.name, kind: value.kind, parameters, returnTypeDisplay: value.returnTypeDisplay, documentation: value.documentation, deprecation: value.deprecation });
}

function normalizeParameter(value: unknown): PublicParameterMetadata {
  if (!isPlainRecord(value) || typeof value.name !== "string" || typeof value.optional !== "boolean" ||
    typeof value.hasDefault !== "boolean" || !nullableString(value.typeDisplay)) {
    throw new LibraryMetadataError("invalidMetadata", "Library parameter metadata has an invalid shape.");
  }
  if (!isBoundedMetadataText(value.name) || !isBoundedNullableMetadataText(value.typeDisplay)) {
    throw new LibraryMetadataError("invalidMetadata", "Library parameter metadata text exceeds the supported limit.");
  }
  return Object.freeze({
    name: value.name,
    optional: value.optional,
    hasDefault: value.hasDefault,
    typeDisplay: value.typeDisplay,
  });
}

function assertCanonical(metadata: PublicLibraryMetadata): void {
  const names = new Set<string>();
  let previous = "";
  for (const entry of metadata.exports) {
    if (entry.name.length === 0 || names.has(entry.name) || (previous !== "" && compareText(previous, entry.name) >= 0)) {
      throw new LibraryMetadataError("invalidMetadata", "Library exports must have unique canonical names.");
    }
    names.add(entry.name);
    previous = entry.name;
  }
}

function assertMetadataTextBounds(metadata: PublicLibraryMetadata): void {
  let total = metadata.identity.token.length;
  for (const entry of metadata.exports) {
    total = addMetadataText(total, entry.name);
    total = addMetadataText(total, entry.returnTypeDisplay);
    total = addMetadataText(total, entry.documentation);
    total = addMetadataText(total, entry.deprecation);
    for (const parameter of entry.parameters) {
      total = addMetadataText(total, parameter.name);
      total = addMetadataText(total, parameter.typeDisplay);
    }
  }
}

function addMetadataText(total: number, value: string | null): number {
  if (value !== null && !isBoundedMetadataText(value)) {
    throw new LibraryMetadataError("invalidMetadata", "Library metadata text exceeds the supported field limit.");
  }
  const next = total + (value?.length ?? 0);
  if (next > MAX_LIBRARY_METADATA_TOTAL_TEXT_LENGTH) {
    throw new LibraryMetadataError("invalidMetadata", "Library metadata exceeds the supported total text limit.");
  }
  return next;
}

function freezeExport(value: PublicExportMetadata): PublicExportMetadata {
  return Object.freeze({ ...value, parameters: Object.freeze([...value.parameters]) });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIdentity(value: unknown): value is ExactLibraryIdentity {
  return isPlainRecord(value) && typeof value.token === "string" && value.token.length > 0 && value.token.length <= 256;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isBoundedMetadataText(value: string): boolean {
  return value.length <= MAX_LIBRARY_METADATA_TEXT_LENGTH;
}

function isBoundedNullableMetadataText(value: unknown): value is string | null {
  return nullableString(value) && (value === null || isBoundedMetadataText(value));
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
