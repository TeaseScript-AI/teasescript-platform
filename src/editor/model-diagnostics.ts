import type { ProjectImageFile } from "../image-catalog.js";
import { languageProjectOverview } from "../language-tooling.js";
import type { ScriptHeader } from "../script-header.js";
import { toMonacoMarkers, type MonacoMarker } from "./monaco-mapping.js";

export interface DiagnosticModel {
  getValue(): string;
  onDidChangeContent(listener: () => void): { dispose(): void };
}

/** An editor model holding one project file. */
export interface ProjectModel {
  readonly path: string;
  readonly model: DiagnosticModel;
}

/** A project file as the editor's file overview shows it. */
export interface ProjectFileView {
  readonly path: string;
  readonly header: ScriptHeader | null;
  readonly markers: readonly MonacoMarker[];
}

/**
 * Compiles the models as one project, with the package images when given, whenever any of them changes, and publishes
 * every file's header and markers, `main.tease` first.
 */
export function watchProjectDiagnostics(
  models: readonly ProjectModel[],
  severity: { readonly Error: number; readonly Warning: number },
  publish: (files: readonly ProjectFileView[]) => void,
  options: { readonly images?: readonly ProjectImageFile[] } = {},
): { dispose(): void } {
  const refresh = () => {
    const overview = languageProjectOverview(
      models.map(({ path, model }) => ({ path, text: model.getValue() })),
      options,
    );
    publish(
      overview.map((file) => ({
        path: file.path,
        header: file.header,
        markers: toMonacoMarkers(file.diagnostics, severity),
      })),
    );
  };
  const subscriptions = models.map(({ model }) => model.onDidChangeContent(refresh));
  refresh();
  return {
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
