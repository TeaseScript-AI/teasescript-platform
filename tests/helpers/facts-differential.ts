import { readFileSync } from "node:fs";

import { operationRelations } from "../../src/type-inference/adapters/index.js";
import type { FactSite, SolvedTypeFacts, TypeText } from "../../src/type-inference/backend.js";
import { collectGraph } from "../../src/type-inference/collector.js";
import type { ConstraintGraph } from "../../src/type-inference/graph.js";
import { analyzeTypes } from "../../src/type-inference/index.js";
import { exportFacts } from "../../src/type-inference/solver/export.js";
import { solve } from "../../src/type-inference/solver/solve.js";
import { request } from "./type-inference-graph.js";

/**
 * The facts differential (O4 stage 3a, work note §7): a source is collected, solved and exported, and its facts are
 * compared with the legacy's site by site. Every difference is reported; the ledger (`accepted-differences.jsonl`,
 * reviewed entry by entry, and `deferred-differences.jsonl`, pinned by `tools/type-inference-differences.mjs` for the
 * groups a later stage completes) records the exact outcome at each site that is accepted or deferred, with its
 * reason or its group. A difference without a record, or whose texts changed, fails: the ledger is never "whatever
 * the candidate prints". One normalization applies to both sides: a union's members are a set (equal members
 * collapse, their order does not count).
 */

export interface Difference {
  readonly what: "binding" | "value" | "function" | "read";
  readonly site: FactSite;
  readonly name: string;
  readonly legacy: TypeText | null;
  readonly candidate: TypeText | null;
}

export interface Differential {
  /** No control flow, functions, loops, handlers, storage or speakers: the sources 3a solves in full. */
  readonly straightLine: boolean;
  readonly compared: number;
  readonly differences: readonly Difference[];
  readonly legacy: SolvedTypeFacts;
  readonly candidate: SolvedTypeFacts;
}

const GLOBALS = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];
const RELATIONS = operationRelations();

const siteKey = (site: FactSite): string => `${site.file}:${site.start}:${site.end}`;

/** A case's program: one source (`main.tease`), or its files in project order. */
export type CaseSource = string | readonly { readonly path: string; readonly source: string }[];

/** Collects, solves, exports and compares one program; `null` when it does not parse or resolve. */
export function differential(
  source: CaseSource,
  mutate: (facts: SolvedTypeFacts) => SolvedTypeFacts = (facts) => facts,
): Differential | null {
  const files = typeof source === "string" ? [{ path: "main.tease", source }] : [...source];
  const made = request(files, GLOBALS, []);
  if (made === null) return null;
  const legacy = analyzeTypes(made).facts();
  const graph = collectGraph(made);
  const candidate = mutate(exportFacts(solve(graph, { relations: RELATIONS })));
  const differences: Difference[] = [];
  let compared = 0;
  const compare = <T extends { readonly site: FactSite; readonly type: TypeText }>(
    what: Difference["what"],
    left: readonly T[],
    right: readonly T[],
    nameOf: (fact: T) => string,
  ): void => {
    const byKey = new Map<string, { legacy?: T; candidate?: T }>();
    for (const fact of left)
      byKey.set(siteKey(fact.site), { ...byKey.get(siteKey(fact.site)), legacy: fact });
    for (const fact of right)
      byKey.set(siteKey(fact.site), { ...byKey.get(siteKey(fact.site)), candidate: fact });
    for (const pair of byKey.values()) {
      compared += 1;
      const legacyText = pair.legacy?.type ?? null;
      const candidateText = pair.candidate?.type ?? null;
      if (legacyText !== null && candidateText !== null && sameText(legacyText, candidateText))
        continue;
      const fact = pair.legacy ?? pair.candidate!;
      differences.push({
        what,
        site: fact.site,
        name: nameOf(fact),
        legacy: legacyText,
        candidate: candidateText,
      });
    }
  };
  compare("binding", legacy.bindings, candidate.bindings, (fact) => fact.name);
  compare(
    "function",
    legacy.functions.map((fact) => ({ ...fact, type: fact.result ?? "" })),
    candidate.functions.map((fact) => ({ ...fact, type: fact.result ?? "" })),
    (fact) => fact.name,
  );
  compare("value", legacy.values, candidate.values, (fact) => fact.kind);
  const readType = (fact: SolvedTypeFacts["reads"][number]): TypeText =>
    fact.binding === null ? "host" : siteKey(fact.binding);
  compare(
    "read",
    legacy.reads.map((fact) => ({ ...fact, type: readType(fact) })),
    candidate.reads.map((fact) => ({ ...fact, type: readType(fact) })),
    (fact) => fact.name,
  );
  return { straightLine: isStraightLine(graph), compared, differences, legacy, candidate };
}

function isStraightLine(graph: ConstraintGraph): boolean {
  if (graph.functions.length > 0 || graph.handlers.length > 0) return false;
  if (graph.places.some((place) => place.kind.kind === "binding" && place.kind.declared === "loop"))
    return false;
  return !graph.constraints.some(
    (c) =>
      c.kind === "test" ||
      c.kind === "load" ||
      c.kind === "save" ||
      c.kind === "speakerRead" ||
      c.kind === "speakerStore" ||
      c.kind === "call",
  );
}

// ---------- the normalization: a union's members as a set ----------

/**
 * The top-level parts of a type text around a separator. A quoted string (a restricted text value, a property name)
 * is one token whatever it contains: its braces and bars are not type syntax (r5-B7).
 */
function topLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === "\\") i += 1;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(" || ch === "<" || ch === "{") depth += 1;
    else if (ch === ")" || ch === ">" || ch === "}") depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function normalized(text: string): string {
  const body = text.endsWith("!") ? text.slice(0, -1) : text;
  const mark = text.endsWith("!") ? "!" : "";
  if (body.startsWith("(") && body.endsWith(")")) {
    // a union's members are a set, a union inside a union its members (the legacy writes `((a|b)|null)`)
    const members = topLevel(body.slice(1, -1), "|").flatMap((member) => {
      const inner = normalized(member);
      return inner.startsWith("(") && inner.endsWith(")")
        ? topLevel(inner.slice(1, -1), "|")
        : [inner];
    });
    const distinct = [...new Set(members)].sort();
    // one member left (the legacy writes `({"x":integer}|{"x":integer})`): that member
    return distinct.length === 1 ? `${distinct[0]}${mark}` : `(${distinct.join("|")})${mark}`;
  }
  for (const ctor of ["list", "set", "dict"] as const)
    if (body.startsWith(`${ctor}<`) && body.endsWith(">"))
      return `${ctor}<${normalized(body.slice(ctor.length + 1, -1))}>${mark}`;
  if (body.startsWith("{") && body.endsWith("}"))
    return `{${topLevel(body.slice(1, -1), ",")
      .map((entry) => {
        const colon = entry.indexOf(":");
        return colon < 0 ? entry : `${entry.slice(0, colon)}:${normalized(entry.slice(colon + 1))}`;
      })
      .sort()
      .join(",")}}${mark}`;
  return text;
}

function sameText(left: string, right: string): boolean {
  return left === right || normalized(left) === normalized(right);
}

// ---------- the ledger ----------

/** A group a difference is deferred to: a later stage's obligation, or a question for the owner. */
export interface GroupRecord {
  readonly group: string;
  readonly reason: string;
  readonly obligation: string;
}

/** A difference reviewed and accepted: the candidate's exact text at the site is the intended fact. */
export interface AcceptedRecord {
  readonly case: string;
  readonly what: Difference["what"];
  readonly name: string;
  /** The fact's site as `file:start:end` (nested expressions share a start; two files share offsets). */
  readonly site: string;
  readonly legacy: string | null;
  readonly candidate: string | null;
  readonly status: "accepted";
  /** A decided language rule, a recorded design reading of the export (§6), or a legacy bug now fixed. */
  readonly kind: "rule" | "design" | "legacy-bug";
  readonly reason: string;
}

/** A difference deferred to a group: the candidate's exact text is pinned; `final` is what the group owes. */
export interface DeferredRecord {
  readonly case: string;
  readonly what: Difference["what"];
  readonly name: string;
  readonly site: string;
  readonly legacy: string | null;
  readonly candidate: string | null;
  readonly status: "deferred";
  readonly group: string;
  readonly final?: string | null;
  readonly note?: string;
}

export type LedgerRecord = AcceptedRecord | DeferredRecord;

export interface Ledger {
  readonly groups: ReadonlyMap<string, GroupRecord>;
  readonly records: ReadonlyMap<string, LedgerRecord>;
}

const FIXTURES = new URL("../../../tests/fixtures/type-inference/", import.meta.url);
const ACCEPTED_FILE = new URL("accepted-differences.jsonl", FIXTURES);
const DEFERRED_FILE = new URL("deferred-differences.jsonl", FIXTURES);

/** A site as `file:start:end`: two files' equal offsets are two sites (PR review r4-B1). */
const siteText = (site: FactSite): string => `${site.file}:${site.start}:${site.end}`;

export const recordKey = (
  caseName: string,
  d: Pick<Difference, "what" | "name"> & { readonly site: string | FactSite },
): string =>
  `${caseName}|${d.what}|${d.name}|${typeof d.site === "string" ? d.site : siteText(d.site)}`;

function readLines(file: URL): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.length > 0);
}

/** The ledger's two files: the reviewed records and the pinned deferrals; a duplicate key is a ledger defect. */
export function readLedger(): Ledger {
  const groups = new Map<string, GroupRecord>();
  const records = new Map<string, LedgerRecord>();
  for (const line of [...readLines(ACCEPTED_FILE), ...readLines(DEFERRED_FILE)]) {
    // EVIDENCE: fixture: the ledger files are written by the lead and by `tools/type-inference-differences.mjs` with these fields.
    const parsed = JSON.parse(line) as GroupRecord | LedgerRecord;
    if ("case" in parsed) {
      const key = recordKey(parsed.case, parsed);
      if (records.has(key)) throw new Error(`the ledger records ${key} twice`);
      records.set(key, parsed);
    } else {
      if (groups.has(parsed.group))
        throw new Error(`the ledger defines group ${parsed.group} twice`);
      groups.set(parsed.group, parsed);
    }
  }
  return { groups, records };
}

/**
 * The group a difference falls into by its kind alone, without review: the facts a later stage computes (expression
 * facts at their points, function results, and every binding of a source with control flow or functions); `null`
 * for a binding of a straight-line source, which needs a reviewed record.
 */
export function mechanicalGroup(straightLine: boolean, d: Difference): string | null {
  if (d.what === "value") return "3b-values";
  if (d.what === "function") return "3c-functions";
  if (d.what === "binding" && !straightLine) return "3b-flow";
  return null;
}

export interface Verdict {
  readonly case: string;
  /** Whether the source is straight-line (the mechanical groups depend on it). */
  readonly straightLine: boolean;
  readonly difference: Difference;
  readonly record: LedgerRecord | null;
  /** `changed`: a record exists at the site but the legacy's or the candidate's text differs from the pinned one. */
  readonly outcome: "accepted" | "deferred" | "changed" | "unrecorded";
}

/** Each difference of a case against the ledger. */
export function verdicts(ledger: Ledger, caseName: string, result: Differential): Verdict[] {
  const straightLine = result.straightLine;
  return result.differences.map((difference) => {
    const record = ledger.records.get(recordKey(caseName, difference)) ?? null;
    const base = { case: caseName, straightLine, difference, record };
    if (record === null) return { ...base, outcome: "unrecorded" };
    if (record.legacy !== difference.legacy || record.candidate !== difference.candidate)
      return { ...base, outcome: "changed" };
    return { ...base, outcome: record.status };
  });
}

export const describe = (v: Verdict): string =>
  `${v.case}: ${v.difference.what} ${v.difference.name} @${v.difference.site.start}: legacy ${v.difference.legacy ?? "(none)"} | candidate ${v.difference.candidate ?? "(none)"}${
    v.record === null
      ? ""
      : ` | recorded legacy ${v.record.legacy ?? "(none)"} | candidate ${v.record.candidate ?? "(none)"}`
  }`;

/** The grouped report: how many differences each accepted kind, deferred group and failing outcome has. */
export function summarize(all: readonly Verdict[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const v of all) {
    if (v.outcome === "accepted" && v.record?.status === "accepted")
      bump(`accepted:${v.record.kind}`);
    else if (v.outcome === "deferred" && v.record?.status === "deferred")
      bump(`deferred:${v.record.group}`);
    else bump(v.outcome);
  }
  return counts;
}
