import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The runtime oracle's tools as its test drives them (docs/TESTING.md "Runtime pipeline oracle"): each runs in a process
 * of its own, as `npm run oracle:test` runs it, and reports one JSON document or a reason on standard error.
 */

/** The checkout the compiled test runs from: `dist/tests/helpers` is three levels below it. */
export const checkout = fileURLToPath(new URL("../../..", import.meta.url));
const tool = (name: string) => path.join(checkout, "tools", "runtime-oracle", name);

/** A comparison report, as `tools/runtime-oracle/compare.mjs` prints it. */
export interface OracleReport {
  readonly reproduced: boolean;
  readonly reproduction: readonly { readonly key: string }[];
  readonly restoreAgrees: boolean;
  /** Each run whose restored transcript disagrees with its uninterrupted one, or threw. */
  readonly restore: readonly {
    readonly side: "oracle" | "candidate";
    readonly key: string;
    readonly kind: "disagrees" | "restore-threw";
  }[];
  readonly identical: boolean;
  readonly mismatches: readonly { readonly key: string; readonly path: string }[];
  readonly count: number;
  readonly classifications: Readonly<Record<string, readonly string[]>>;
  readonly results?: Readonly<Record<string, OracleResult>>;
  readonly timing?: { readonly samples: number; readonly matched: boolean };
}

/** One case and route's result, as the oracle's runner records it. */
export interface OracleResult {
  readonly classification: string;
  readonly diagnostics?: readonly { readonly code: string }[];
  readonly runs?: readonly {
    readonly label: string;
    readonly end: string;
    readonly cuts: readonly { readonly failure: string | null }[];
  }[];
}

/** A run of an oracle tool: its exit status, its report when it printed one, and what it said on standard error. */
export function oracle(
  name: "compare.mjs" | "run.mjs" | "materialize.mjs",
  args: readonly string[],
  input = "",
  env: Readonly<Record<string, string>> = {},
): {
  readonly status: number | null;
  readonly report: OracleReport | null;
  readonly stderr: string;
} {
  const child = spawnSync(process.execPath, [tool(name), ...args], {
    cwd: checkout,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: 600_000,
  });
  let report: OracleReport | null = null;
  try {
    // EVIDENCE: validation: the tool prints one JSON report of this shape on standard output, or nothing.
    report = child.stdout.trim() === "" ? null : (JSON.parse(child.stdout) as OracleReport);
  } catch {
    report = null;
  }
  return { status: child.status, report, stderr: child.stderr };
}

/** A temporary directory, removed when `done` runs. */
export function scratch(): { readonly directory: string; readonly done: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-oracle-test-"));
  return { directory, done: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

/** The sealed manifest, read anew each time, as the fields of `T` a test changes. */
export function sealedManifest<T>(): T {
  // EVIDENCE: validation: the sealed manifest is a JSON object with those fields, which the comparison checks completely.
  return JSON.parse(
    fs.readFileSync(path.join(checkout, "tools", "runtime-oracle", "manifest.json"), "utf8"),
  ) as T;
}

/** Writes `files` (relative path to text) under `root`. */
export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}
