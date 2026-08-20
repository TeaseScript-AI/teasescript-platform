import {
  createLanguageDocument,
  formatLanguageDocument,
  languageCompletions,
  languageDiagnostics,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
} from "../src/language-tooling.js";
import { createSourceSpan } from "../src/source.js";
import {
  toMonacoCompletions,
  toMonacoHover,
  toMonacoMarkers,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
  type MonacoCompletionKindValues,
  type MonacoMarkerDataLike,
  type MonacoPositionLike,
  type MonacoSeverityValues,
} from "./monaco-mapping.js";

export interface MonacoModelView {
  readonly uri: { toString(): string };
  getValue(): string;
  getOffsetAt(position: MonacoPositionLike): number;
}

export function languageDocumentFromMonacoModel(model: MonacoModelView) {
  return createLanguageDocument(model.uri.toString(), model.getValue());
}

export function monacoDiagnostics(model: MonacoModelView, severity: MonacoSeverityValues): readonly MonacoMarkerDataLike[] {
  const document = languageDocumentFromMonacoModel(model);
  return toMonacoMarkers(languageDiagnostics(document), severity);
}

export function monacoCompletions(model: MonacoModelView, position: MonacoPositionLike, kinds: MonacoCompletionKindValues) {
  const document = languageDocumentFromMonacoModel(model);
  const offset = model.getOffsetAt(position);
  const languagePosition = languagePositionAt(document, offset);
  const completions = languageCompletions(document, languagePosition);
  const range = createSourceSpan(languagePosition, languagePosition);
  return Object.freeze({ suggestions: toMonacoCompletions(completions, range, kinds) });
}

export function monacoHover(model: MonacoModelView, position: MonacoPositionLike) {
  const document = languageDocumentFromMonacoModel(model);
  const hover = languageHover(document, languagePositionAt(document, model.getOffsetAt(position)));
  return hover === null ? null : toMonacoHover(hover);
}

export function monacoSignatureHelp(model: MonacoModelView, position: MonacoPositionLike) {
  const document = languageDocumentFromMonacoModel(model);
  const help = languageSignatureHelp(document, languagePositionAt(document, model.getOffsetAt(position)));
  return help === null ? null : toMonacoSignatureHelp(help);
}

export function monacoFormattingEdits(model: MonacoModelView) {
  const document = languageDocumentFromMonacoModel(model);
  return toMonacoTextEdits(formatLanguageDocument(document).edits);
}
