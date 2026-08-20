import { registerTeaseScriptMonaco, TEASESCRIPT_LANGUAGE_ID, type MonacoApi } from "./monaco-provider.js";

export const EDITOR_POC_DEFAULT_SOURCE = `speaker mistress {
  name: "Mistress"
}

say as mistress "Welcome."
showButton as mistress "Continue"
`;

export function startTeaseScriptEditor(monaco: MonacoApi): void {
  const host = document.querySelector<HTMLElement>("#editor");
  if (host === null) throw new Error("Editor host element is missing.");

  registerTeaseScriptMonaco(monaco);
  const model = monaco.editor.createModel(
    EDITOR_POC_DEFAULT_SOURCE,
    TEASESCRIPT_LANGUAGE_ID,
    monaco.Uri.parse("file:///main.tease"),
  );
  monaco.editor.create(host, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    glyphMargin: false,
    folding: false,
    lineNumbersMinChars: 3,
    scrollBeyondLastLine: false,
    wordWrap: "on",
  });
  document.body.dataset.editorState = "ready";
}
