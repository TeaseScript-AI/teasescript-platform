import { captureExternalData } from "../external-data-limits.js";
import {
  createPublicLibraryMetadata,
  type PublicLibraryMetadata,
} from "./metadata.js";

const MAX_IDENTITY_TOKEN_LENGTH = 256;

export interface ExactLibraryIdentity {
  readonly token: string;
}

export interface PublicLibraryDefinition {
  readonly identity: ExactLibraryIdentity;
  readonly source: string;
}

export class LibraryCatalogError extends Error {
  public constructor(
    readonly code: "invalidDefinition" | "duplicateIdentity" | "missingIdentity",
    message: string,
  ) {
    super(message);
    this.name = "LibraryCatalogError";
  }
}

/** Creates an opaque exact POC identity; no range or latest resolution exists. */
export function createExactLibraryIdentity(token: string): ExactLibraryIdentity {
  if (!isIdentityToken(token)) {
    throw new LibraryCatalogError(
      "invalidDefinition",
      "A library identity token must be a non-empty bounded string.",
    );
  }
  return Object.freeze({ token });
}

/** A synchronous, in-memory exact-identity catalog. It is never checkpoint data. */
export class LibraryCatalog {
  readonly #entries = new Map<string, PublicLibraryMetadata>();

  public register(definition: unknown): PublicLibraryMetadata {
    const captured = captureExternalData(definition, "$library");
    if (!captured.ok) {
      throw new LibraryCatalogError(
        "invalidDefinition",
        `Library definition is not supported at ${captured.failure.path}.`,
      );
    }
    const normalized = normalizeDefinition(captured.value);
    if (this.#entries.has(normalized.identity.token)) {
      throw new LibraryCatalogError(
        "duplicateIdentity",
        `Library identity '${normalized.identity.token}' is already registered.`,
      );
    }
    const metadata = createPublicLibraryMetadata(normalized);
    this.#entries.set(normalized.identity.token, metadata);
    return metadata;
  }

  public resolve(identity: unknown): PublicLibraryMetadata {
    const captured = captureExternalData(identity, "$identity");
    if (!captured.ok) {
      throw new LibraryCatalogError(
        "invalidDefinition",
        `Library identity is not supported at ${captured.failure.path}.`,
      );
    }
    const token = normalizeIdentity(captured.value);
    const entry = this.#entries.get(token);
    if (entry === undefined) {
      throw new LibraryCatalogError(
        "missingIdentity",
        `No library is registered for exact identity '${token}'.`,
      );
    }
    return entry;
  }

  public list(): readonly PublicLibraryMetadata[] {
    return Object.freeze(
      [...this.#entries.values()].sort((left, right) => compareText(left.identity.token, right.identity.token)),
    );
  }
}

function normalizeDefinition(value: unknown): PublicLibraryDefinition {
  if (!isPlainRecord(value) || typeof value.source !== "string" ||
    Object.keys(value).length !== 2 || !("identity" in value) || !("source" in value)) {
    throw new LibraryCatalogError(
      "invalidDefinition",
      "A library definition must contain a plain exact identity and TypeScript source.",
    );
  }
  return Object.freeze({
    identity: createExactLibraryIdentity(normalizeIdentity(value.identity)),
    source: value.source,
  });
}

function normalizeIdentity(value: unknown): string {
  if (!isPlainRecord(value) || !isIdentityToken(value.token)) {
    throw new LibraryCatalogError(
      "invalidDefinition",
      "A library identity must contain one exact bounded token.",
    );
  }
  return value.token;
}

function isIdentityToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_IDENTITY_TOKEN_LENGTH;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
