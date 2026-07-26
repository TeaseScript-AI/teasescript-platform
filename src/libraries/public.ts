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
  createPublicLibraryMetadata,
  validatePublicLibraryMetadata,
  type PublicExportMetadata,
  type PublicLibraryMetadata,
  type PublicParameterMetadata,
} from "./metadata.js";
