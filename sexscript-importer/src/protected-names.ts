import { repositoryBuildUrl } from "./repository-build.ts";

/**
 * TeaseScript's protected names (V30 §38), the grammar keywords, type names and engine names, as the TeaseScript build
 * the importer compiles with exports them (its `src/language-facts.ts`, #954). The repository's sources import one
 * another by their built names (`./token.js`), which Node cannot load from the sources, so they come from the build.
 */
const facts = (await import(repositoryBuildUrl("src/language-facts.js").href)) as {
  readonly TEASESCRIPT_PROTECTED_NAMES: readonly string[];
};

export const TEASESCRIPT_PROTECTED_NAMES: readonly string[] = facts.TEASESCRIPT_PROTECTED_NAMES;
