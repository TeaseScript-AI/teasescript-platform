import assert from "node:assert/strict";

import { CONTEXT_WORDS, type ContextWord } from "../../src/type-inference/core/items.js";
import type {
  CoreOutcome,
  CoreRecord,
  DiagnosticClass,
  ObligationKind,
  RecordDiagnostic,
} from "../../src/type-inference/core/result.js";

/** A site as records are compared: the file's path and the half-open span `[offset, end)` (S6's exact records). */
export interface CompactSite {
  readonly file: string;
  readonly offset: number;
  readonly end: number;
}

export interface CompactDiagnostic {
  readonly kind: RecordDiagnostic["kind"];
  readonly class: DiagnosticClass;
  readonly site: CompactSite;
  /** `null`: not asserted. */
  readonly context: ContextWord | null;
  /** The copy that brought a copied property's rejected kind (TABLE r4.75 (4)), where the diagnostic has one. */
  readonly related?: CompactSite;
}

export interface CompactCheck {
  readonly kind: ObligationKind;
  readonly target: string;
  readonly against: readonly string[];
  readonly boundary: boolean;
  readonly site: CompactSite;
}

/**
 * A record as the expectation set is compared with an analysis (TABLE §10.5, with the check sites of the port plan's
 * §3.1): the outcome, each diagnostic's kind, class, site and context, and each runtime check's kind, target, required
 * kinds, whether it is a boundary check, and site. This is the form of the fixture the core's cells test reads.
 */
export interface CompactRecord {
  readonly outcome: CoreOutcome;
  readonly diagnostics: readonly CompactDiagnostic[];
  readonly checks: readonly CompactCheck[];
}

export function compactRecord(record: CoreRecord): CompactRecord {
  return {
    outcome: record.outcome,
    diagnostics: record.diagnostics.map((diagnostic) => ({
      kind: diagnostic.kind,
      class: diagnostic.class,
      site: {
        file: diagnostic.site.file,
        offset: diagnostic.site.offset,
        end: diagnostic.site.end,
      },
      context: diagnostic.provenance?.context ?? null,
      ...(diagnostic.related === undefined
        ? {}
        : {
            related: {
              file: diagnostic.related.file,
              offset: diagnostic.related.offset,
              end: diagnostic.related.end,
            },
          }),
    })),
    checks: record.runtimeChecks.map((check) => ({
      kind: check.kind,
      target: check.target,
      against: [...check.against],
      boundary: check.boundary === true,
      site: { file: check.site.file, offset: check.site.offset, end: check.site.end },
    })),
  };
}

// Every member of each union, so that the reader accepts exactly the record's values.
const OUTCOMES: Readonly<Record<CoreOutcome, true>> = {
  valid: true,
  "warning-runtime-check": true,
  "compile-error": true,
  "budget-error": true,
};
const CLASSES: Readonly<Record<DiagnosticClass, true>> = {
  "warning-runtime-check": true,
  "compile-error": true,
};
const DIAGNOSTIC_KINDS: Readonly<Record<RecordDiagnostic["kind"], true>> = {
  "written-target": true,
  "member-read": true,
  "integer-use": true,
  operator: true,
  "written-type": true,
};
const OBLIGATION_KINDS: Readonly<Record<ObligationKind, true>> = {
  "copy-type": true,
  "null-check": true,
  operand: true,
  "integer-check": true,
  "empty-check": true,
};

function object(value: unknown, where: string): Readonly<Record<string, unknown>> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${where}: an object`,
  );
  // EVIDENCE: validation: the assertion above admits only plain non-array objects, read here by key.
  return value as Readonly<Record<string, unknown>>;
}

function list(value: unknown, where: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `${where}: a list`);
  return value;
}

function text(value: unknown, where: string): string {
  assert.equal(typeof value, "string", `${where}: a text`);
  return String(value);
}

function member<T extends string>(
  members: Readonly<Record<T, true>>,
  value: unknown,
  where: string,
): T {
  // EVIDENCE: invariant: the keys of a `Record<T, true>` are the members of `T`.
  const found = (Object.keys(members) as T[]).find((name) => name === value);
  assert.ok(found !== undefined, `${where}: one of ${Object.keys(members).join(", ")}`);
  return found;
}

function site(value: unknown, where: string): CompactSite {
  const fields = object(value, where);
  assert.ok(Number.isSafeInteger(fields["offset"]), `${where}.offset: an offset`);
  assert.ok(
    Number.isSafeInteger(fields["end"]) && Number(fields["end"]) >= Number(fields["offset"]),
    `${where}.end: an offset at or after the start`,
  );
  return {
    file: text(fields["file"], `${where}.file`),
    offset: Number(fields["offset"]),
    end: Number(fields["end"]),
  };
}

/** One fixture line, parsed, as a compact record: every field checked, so a malformed line fails where it is. */
export function readCompactRecord(value: unknown, where = "record"): CompactRecord {
  const fields = object(value, where);
  return {
    outcome: member(OUTCOMES, fields["outcome"], `${where}.outcome`),
    diagnostics: list(fields["diagnostics"], `${where}.diagnostics`).map((entry, index) => {
      const at = `${where}.diagnostics[${index}]`;
      const diagnostic = object(entry, at);
      const context =
        diagnostic["context"] === null
          ? null
          : CONTEXT_WORDS.find((word) => word === diagnostic["context"]);
      assert.ok(context !== undefined, `${at}.context: a context word or null`);
      return {
        kind: member(DIAGNOSTIC_KINDS, diagnostic["kind"], `${at}.kind`),
        class: member(CLASSES, diagnostic["class"], `${at}.class`),
        site: site(diagnostic["site"], `${at}.site`),
        context,
        ...(diagnostic["related"] === undefined
          ? {}
          : { related: site(diagnostic["related"], `${at}.related`) }),
      };
    }),
    checks: list(fields["checks"], `${where}.checks`).map((entry, index) => {
      const at = `${where}.checks[${index}]`;
      const check = object(entry, at);
      assert.equal(typeof check["boundary"], "boolean", `${at}.boundary: true or false`);
      return {
        kind: member(OBLIGATION_KINDS, check["kind"], `${at}.kind`),
        target: text(check["target"], `${at}.target`),
        against: list(check["against"], `${at}.against`).map((kind, position) =>
          text(kind, `${at}.against[${position}]`),
        ),
        boundary: check["boundary"] === true,
        site: site(check["site"], `${at}.site`),
      };
    }),
  };
}

/** The entries one multiset has more often than the other, with the count by which it exceeds. */
function excess(more: readonly string[], fewer: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of more) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  for (const entry of fewer) counts.set(entry, (counts.get(entry) ?? 0) - 1);
  return [...counts].filter(([, count]) => count > 0).map(([entry, count]) => `${entry} ×${count}`);
}

/**
 * How `actual` differs from `expected`: the outcome; the diagnostics as a multiset of kind, class, site and related
 * site, and each context `expected` asserts at least as often; the checks as a multiset. Every site is compared whole,
 * its start and end (TABLE §3.4, D2, r4.62). Order never matters, multiplicity does.
 */
export function recordDifferences(expected: CompactRecord, actual: CompactRecord): string[] {
  const at = (site: CompactSite): string => `${site.file}:${site.offset}-${site.end}`;
  const span = (entry: CompactDiagnostic | CompactCheck): string => at(entry.site);
  const diagnostic = (entry: CompactDiagnostic): string =>
    `${entry.kind} ${entry.class} ${span(entry)}` +
    (entry.related === undefined ? "" : ` related ${at(entry.related)}`);
  const withContext = (entry: CompactDiagnostic): string => `${diagnostic(entry)} ${entry.context}`;
  const check = (entry: CompactCheck): string =>
    `${entry.kind} ${entry.target} [${entry.against.join("|")}]${entry.boundary ? " boundary" : ""} ${span(entry)}`;
  const differences: string[] = [];
  if (expected.outcome !== actual.outcome)
    differences.push(`outcome ${expected.outcome}, got ${actual.outcome}`);
  const wanted = expected.diagnostics.map(diagnostic);
  const got = actual.diagnostics.map(diagnostic);
  differences.push(...excess(wanted, got).map((entry) => `missing diagnostic ${entry}`));
  differences.push(...excess(got, wanted).map((entry) => `extra diagnostic ${entry}`));
  differences.push(
    ...excess(
      expected.diagnostics.filter((entry) => entry.context !== null).map(withContext),
      actual.diagnostics.map(withContext),
    ).map((entry) => `missing context ${entry}`),
  );
  const checks = expected.checks.map(check);
  const gotChecks = actual.checks.map(check);
  differences.push(...excess(checks, gotChecks).map((entry) => `missing check ${entry}`));
  differences.push(...excess(gotChecks, checks).map((entry) => `extra check ${entry}`));
  return differences;
}

/**
 * A compact record written as lines, the carrier witnesses' notation: `outcome …`; a diagnostic per `D kind class
 * start:end context` (`class` `warning` or `error`, `context` `-` where none is asserted); a check per `B kind target
 * [against] start:end`, a boundary check, or `C …` for any other; every site in `main.tease`. Read as a fixture's record
 * is, each field checked (`readCompactRecord`).
 */
export function recordOf(text: string): CompactRecord {
  const [head, ...lines] = text
    .trim()
    .split("\n")
    .map((line) => line.trim());
  const outcome = /^outcome (\S+)$/u.exec(head ?? "");
  assert.ok(outcome !== null, `an outcome line: ${head}`);
  const site = (start: string, end: string) => ({
    file: "main.tease",
    offset: Number(start),
    end: Number(end),
  });
  const diagnostics: unknown[] = [];
  const checks: unknown[] = [];
  for (const line of lines) {
    const diagnostic = /^D (\S+) (warning|error) (\d+):(\d+) (\S+)$/u.exec(line);
    if (diagnostic !== null) {
      const [, kind, severity, start, end, context] = diagnostic;
      diagnostics.push({
        kind,
        class: severity === "warning" ? "warning-runtime-check" : "compile-error",
        site: site(start!, end!),
        context: context === "-" ? null : context,
      });
      continue;
    }
    const check = /^([BC]) (\S+) (.+) \[([^\]]*)\] (\d+):(\d+)$/u.exec(line);
    assert.ok(check !== null, `a diagnostic or a check: ${line}`);
    const [, boundary, kind, target, against, start, end] = check;
    checks.push({
      kind,
      target,
      against: against!.split("|"),
      boundary: boundary === "B",
      site: site(start!, end!),
    });
  }
  return readCompactRecord({ outcome: outcome[1], diagnostics, checks }, text);
}
