import ts from "typescript";

import { captureExternalData } from "../external-data-limits.js";
import type { ExactLibraryIdentity, PublicLibraryDefinition } from "./catalog.js";

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
  const sourceFile = ts.createSourceFile(
    "library.ts",
    definition.source,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) {
    throw new LibraryMetadataError("invalidSource", "Library TypeScript source is invalid.");
  }

  const exports: PublicExportMetadata[] = [];
  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
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
  return Object.freeze({
    identity: Object.freeze({ token: definition.identity.token }),
    exports: Object.freeze(exports),
  });
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

function normalizeExport(value: unknown): PublicExportMetadata {
  if (!isPlainRecord(value) || typeof value.name !== "string" ||
    (value.kind !== "function" && value.kind !== "type") || !Array.isArray(value.parameters) ||
    !nullableString(value.returnTypeDisplay) || !nullableString(value.documentation) || !nullableString(value.deprecation)) {
    throw new LibraryMetadataError("invalidMetadata", "Library export metadata has an invalid shape.");
  }
  if (!isDenseArray(value.parameters)) {
    throw new LibraryMetadataError("invalidMetadata", "Library parameter metadata has an invalid shape.");
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

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
