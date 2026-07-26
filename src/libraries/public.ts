/**
 * Internal POC library infrastructure.  Its identity and metadata shapes are
 * deliberately not package-manifest, lockfile, plan, or checkpoint formats.
 */
export {
  LibraryCatalog,
  LibraryCatalogError,
  createExactLibraryIdentity,
  type ExactLibraryIdentity,
  type PublicLibraryDefinition,
} from "./catalog.js";
export {
  LibraryMetadataError,
  MAX_LIBRARY_SOURCE_LENGTH,
  createPublicLibraryMetadata,
  validatePublicLibraryMetadata,
  type PublicExportMetadata,
  type PublicLibraryMetadata,
  type PublicParameterMetadata,
} from "./metadata.js";
