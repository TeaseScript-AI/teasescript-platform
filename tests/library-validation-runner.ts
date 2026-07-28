import {
  LibraryCatalog,
  LibraryCatalogError,
  LibraryMetadataError,
  createExactLibraryIdentity,
  validatePublicLibraryMetadata,
  type PublicLibraryMetadata,
} from "../src/library-tooling/public.js";

/**
 * Development/test-only static validation harness. Its result is deliberately
 * not a library package manifest, runtime value, checkpoint value, or wire format.
 * It parses metadata only: supplied TypeScript source is never imported or executed.
 */
export type LibraryValidationResult =
  | Readonly<{
    readonly ok: true;
    readonly metadata: PublicLibraryMetadata;
    readonly serializedMetadata: string;
  }>
  | Readonly<{
    readonly ok: false;
    readonly category: "catalog" | "metadata";
    readonly code: string;
    readonly message: string;
  }>;

/** Runs deterministic static validation in a fresh exact-identity catalog. */
export function validateDevelopmentLibrary(
  identityToken: string,
  source: string,
): LibraryValidationResult {
  try {
    const identity = createExactLibraryIdentity(identityToken);
    const catalog = new LibraryCatalog();
    const metadata = catalog.register({ identity, source });
    const serializedMetadata = JSON.stringify(metadata);
    const validatedMetadata = validatePublicLibraryMetadata(JSON.parse(serializedMetadata));
    return Object.freeze({ ok: true, metadata: validatedMetadata, serializedMetadata });
  } catch (error) {
    if (error instanceof LibraryCatalogError) {
      return Object.freeze({ ok: false, category: "catalog", code: error.code, message: error.message });
    }
    if (error instanceof LibraryMetadataError) {
      return Object.freeze({ ok: false, category: "metadata", code: error.code, message: error.message });
    }
    throw error;
  }
}
