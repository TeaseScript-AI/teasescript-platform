import { IndentationText, NewLineKind, Project, QuoteKind } from "ts-morph";

export const CODEMOD_MANIPULATION_SETTINGS = Object.freeze({
  indentationText: IndentationText.TwoSpaces,
  newLineKind: NewLineKind.LineFeed,
  quoteKind: QuoteKind.Double,
  useTrailingCommas: true,
});

export function createCodemodProject(tsConfigFilePath) {
  return new Project({
    tsConfigFilePath,
    manipulationSettings: CODEMOD_MANIPULATION_SETTINGS,
  });
}
