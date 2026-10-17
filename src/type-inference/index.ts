import type { Program } from "../ast.js";
import type {
  TypeAnalysisBackend,
  TypeAnalysisOutcome,
  TypeAnalysisRequest,
  TypeCheckOptions,
  TypeCheckResult,
} from "./backend.js";
import { LEGACY_BACKEND } from "./legacy-rounds.js";

/** Analyzes the types of a project with `backend`: the legacy inference unless another is given. */
export function analyzeTypes(
  request: TypeAnalysisRequest,
  backend: TypeAnalysisBackend = LEGACY_BACKEND,
): TypeAnalysisOutcome {
  return backend.analyze(request);
}

/**
 * Checks that every variable, list or set element, object property, function parameter, and function result keeps one
 * type, and that operations receive values they support (ADR 0021). It runs after name validation succeeded, so every
 * name resolves; a value it cannot know has the type `unknown` and is never rejected. The files of a project, in
 * project order, are checked together, because globals, global functions, and speakers belong to all of them.
 * `onFile` hears of each file whose source the check enters.
 */
export function checkTypes(
  files: readonly { readonly path: string; readonly program: Program }[],
  options: TypeCheckOptions = {},
  onFile: (file: number) => void = () => {},
): TypeCheckResult {
  return analyzeTypes({ files, options, onFile }).checked;
}
