// The sharing tests' shared setup (tests/type-core/sharing/): a program of one file, in the orders a test samples.

import assert from "node:assert/strict";
import { type CoreAnalysisRequest, CoreProgram } from "../../../src/type-inference/core/program.js";
import type { PlaceId } from "../../../src/type-inference/graph.js";
import { coreRequest, type SourceFile } from "../type-core-analysis.js";

export interface Program {
  readonly name: string;
  readonly files: readonly SourceFile[];
  /** A fixture's record or a written-domain matrix's source, in the source order only outside the sweep (`SWEEP`). */
  readonly sourceOrderSampled?: true;
}

export const one = (name: string, source: string): Program => ({
  name,
  files: [{ path: "main.tease", source }],
});

// (a written-domain matrix's host-started binding reads `hostInit`, `WrittenCase.globals`)
export const GLOBALS = ["hostValue", "hostInit"];

/** A program's request and its bindings, built once for its four analyses. */
export interface Prepared {
  readonly program: Program;
  readonly request: CoreAnalysisRequest;
  readonly bindings: readonly PlaceId[];
}

export function prepared(program: Program): Prepared {
  const request = coreRequest(program.files, GLOBALS);
  assert.ok(request !== null, `${program.name}: its files parse and resolve`);
  const bindings = new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);
  return { program, request, bindings };
}
