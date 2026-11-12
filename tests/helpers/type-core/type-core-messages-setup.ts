// The message tests' shared setup (tests/type-core/messages/): a project of one file, its reported diagnostics, and two
// sentences' words.

import assert from "node:assert/strict";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { coreRequest, type SourceFile } from "../type-core-analysis.js";

export function reported(files: readonly SourceFile[]) {
  const request = coreRequest(files);
  assert.ok(request !== null, "the files parse and resolve");
  const { diagnostics } = analyseCore(request);
  const source = messageSource(
    files.map((file) => file.source),
    diagnostics,
  );
  return diagnostics.map((diagnostic) => ({
    error: diagnostic.class === "compile-error",
    code: diagnostic.code,
    site: source.text(diagnostic.site),
    message: coreMessage(diagnostic, source),
  }));
}

export const main = (source: string): SourceFile[] => [{ path: "main.tease", source }];

export const STOPS = "If it is, the Tease stops with an error at this line.";
export const OUTSIDE = (name: string): string =>
  `'${name}' comes from outside the script, so its type is known only when the script runs.`;
