import { CORE_RUNTIME_BUILTINS } from "../../src/compiler.js";
import { parse } from "../../src/parser.js";
import { compareProjectPaths } from "../../src/project-paths.js";
import { validateProjectSemantics } from "../../src/semantic.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { checkedResult } from "../../src/type-inference/core/consumer.js";
import type { CoreAnalysisRequest } from "../../src/type-inference/core/program.js";
import { coreRecord } from "../../src/type-inference/core/result.js";
import { compactRecord, type CompactRecord } from "./type-core-records.js";

/** A file of a project as the tests write it. */
export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

/**
 * The request the compiler would make of the core for these files, after name checking: the files in project order
 * (`main.tease` first), each with its source and the name pass's picks of its glob targets; `hostValue` is a host
 * global, as the expectation set declares it. `null` when the files do not parse or resolve.
 */
export function coreRequest(
  files: readonly SourceFile[],
  globals: readonly string[] = ["hostValue"],
): CoreAnalysisRequest | null {
  const ordered = [...files].sort((a, b) => compareProjectPaths(a.path, b.path));
  const results = ordered.map((file) => parse(file.source));
  if (results.some((result) => result.diagnostics.length > 0)) return null;
  const parsed = ordered.map((file, index) => ({
    path: file.path,
    program: results[index]!.program,
  }));
  const options = { builtins: [...CORE_RUNTIME_BUILTINS], globals };
  const names = validateProjectSemantics(parsed, options);
  if (
    names.some((result) => result.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
  )
    return null;
  return {
    files: parsed.map((file, index) => ({
      ...file,
      source: ordered[index]!.source,
      picks: names[index]!.picks,
    })),
    options: {
      ...options,
      sharedWrites: new Map(names.flatMap((result) => [...result.sharedWrites])),
      written: {
        lets: new Set(names.flatMap((result) => [...result.writtenLets])),
        globals: new Set(names.flatMap((result) => [...result.writtenGlobals])),
      },
      speakers: new Map(names.flatMap((result) => [...result.speakers])),
    },
  };
}

/**
 * The core's record of a request in the compact shape the expectation set is compared in, with the checks that owe the
 * runtime nothing (`checkedResult`), as the compiler reports them.
 */
export function compactAnalysis(request: CoreAnalysisRequest): CompactRecord {
  const answers = analyseCore(request);
  return compactRecord(
    coreRecord(
      checkedResult(answers, request),
      request.files.map((file) => file.path),
    ),
  );
}
