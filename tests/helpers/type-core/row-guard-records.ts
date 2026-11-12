import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";

/*
 * The differential records the row guard judges (`tests/type-core/type-core-row-guard.test.ts` and
 * `type-core-declared-positions.test.ts`): today's checker and the candidate route in the four held modes, per source,
 * through `tests/families/differential.mjs` on this tree.
 */

/** The host values each plan runs with: a whole number, text, a truth value, a fraction, null (fitting and not). */
export const DOMAIN: readonly SerializableRuntimeValue[] = [2, "text", true, 2.5, null];

export interface Check {
  readonly field: string;
  readonly path: string | null;
  readonly offset: number | null;
  readonly end: number | null;
}

export interface Run {
  readonly status?: string;
  readonly failure?: string | null;
  readonly threw?: string;
}

export interface Entry {
  readonly diagnostics?: readonly {
    readonly code: string;
    readonly severity: string;
    readonly message?: string;
    readonly offset?: number;
    readonly end?: number;
  }[];
  readonly plan?: { readonly checks: readonly Check[] } | null;
  readonly runs?: readonly Run[];
  readonly outside?: string;
  readonly threw?: string;
}

export interface DifferentialRecord {
  readonly name: string;
  readonly checker: Entry;
  readonly candidate: { readonly modes: readonly (Entry & { readonly mode: string })[] };
}

/** A source the guard compiles, or a project's files, and the host values its runs take after `DOMAIN`'s. */
export type RecordCase = { readonly name: string; readonly hosts?: readonly unknown[] } & (
  | { readonly source: string }
  | { readonly files: readonly { readonly path: string; readonly source: string }[] }
);

/** A template as a script: the `exit` each script ends with. */
export const script = (template: string): string => `${template}\nexit\n`;

/** The differential record of each case, on this tree, in the cases' order. */
export function records(cases: readonly RecordCase[], folder: string): DifferentialRecord[] {
  const casesFile = join(folder, "cases.jsonl");
  const out = join(folder, "records.jsonl");
  const lines = cases.map((recordCase) =>
    JSON.stringify({
      name: recordCase.name,
      ...("files" in recordCase ? { files: recordCase.files } : { source: recordCase.source }),
      runs: [...DOMAIN, ...(recordCase.hosts ?? [])].map((hostValue) => ({ hostValue })),
    }),
  );
  writeFileSync(casesFile, lines.map((line) => `${line}\n`).join(""));
  const ran = spawnSync(
    process.execPath,
    [resolve("tests/families/differential.mjs"), resolve("."), casesFile, "--out", out],
    { encoding: "utf8" },
  );
  assert.notEqual(ran.status, 2, ran.stderr);
  const written = readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const found = written.map(
    (line) =>
      // EVIDENCE: invariant: `differential.mjs` writes one record a line (tests/families/README.md).
      JSON.parse(line) as DifferentialRecord,
  );
  assert.deepEqual(
    found.map((record) => record.name),
    cases.map((recordCase) => recordCase.name),
  );
  return found;
}

export const checkKey = (check: Check): string =>
  `${check.field} ${check.path}:${check.offset}:${check.end}`;

export const outcome = (run: Run | undefined): string =>
  run === undefined ? "none" : (run.threw ?? `${run.status} ${run.failure}`);

/** An entry's compile errors, by code, sorted. */
export const errorsOf = (entry: Entry): string[] =>
  (entry.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.code)
    .sort();

/** Each diagnostic of an entry as `severity code start:end`, its offsets through `at` (one it maps to `null` is left out). */
export const diagnosed = (
  entry: Entry,
  at: (offset: number) => number | null = (offset) => offset,
): string[] =>
  (entry.diagnostics ?? []).flatMap((diagnostic) => {
    const [start, end] = [at(diagnostic.offset ?? -1), at(diagnostic.end ?? -1)];
    return start === null || end === null
      ? []
      : [`${diagnostic.severity} ${diagnostic.code} ${start}:${end}`];
  });
