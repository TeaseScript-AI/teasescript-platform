import { createLanguageDocument, languageDiagnostics } from "../language-tooling.js";
import { toMonacoMarkers, type MonacoMarker } from "./monaco-mapping.js";

export interface DiagnosticModel {
  readonly uri: { toString(): string };
  getValue(): string;
  onDidChangeContent(listener: () => void): { dispose(): void };
}

export function watchModelDiagnostics(
  model: DiagnosticModel,
  severity: { readonly Error: number; readonly Warning: number },
  publish: (markers: readonly MonacoMarker[]) => void,
): { dispose(): void } {
  const refresh = () => {
    const document = createLanguageDocument(model.uri.toString(), model.getValue());
    publish(toMonacoMarkers(languageDiagnostics(document), severity));
  };
  const subscription = model.onDidChangeContent(refresh);
  refresh();
  return subscription;
}
