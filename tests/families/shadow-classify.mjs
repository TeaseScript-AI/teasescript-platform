// node tests/families/shadow-classify.mjs <records.jsonl>... [--expect keys.jsonl]... [--out DIR] [--gate]
// The S11 classification of the shadow comparison (`shadow.mjs`'s `--out` records, and the S11 readiness research's
// `results.jsonl`, whose aborted records have no rows). Every route pair (a source in one mode, legacy against core)
// gets exactly one class of `PAIR_CLASSES`, and every source in each order one class of `SHARING_CLASSES`, the sharing column (#1711: the
// core with sharing on against off). Every class's rule is tested on every pair: none (unclassified) or two
// (ambiguous) fail the run. `--expect` names the sources the campaign owes (one JSON object with `key` a line, as
// `shadow.mjs --manifest` writes them): one without a record is `unavailable`, a record outside them fails the run. A key recorded twice counts once where both records publish the same, else the run fails.
// `--out` gets `pairs.jsonl`, `sharing.jsonl`, `signatures.tsv`, `gate.json` and `gate.md`. Prints the gate table's
// summary as one JSON line and a verdict line (`gate: green` only where no row is `open` and nothing failed to
// classify). Exit 1 for unclassified or ambiguous pairs, invalid input or conflicting duplicates; with `--gate`
// (the S11 checklist's run, which needs `--expect`) also while any row is `open`.
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/** The taxonomy's version: a class added, removed or changed in its rule makes the next. */
export const VERSION = 1;

const S9B = "S9b #1072 (candidate coverage; retired or deferred syntax is no release requirement)";
const S10 = "S10 #1073";
/** Sol's 53 exclusion texts as 48 rules: each text exact, the two that name a variable as one template each. */
const EXCLUSIONS = [
  ["this member or element read", S9B, "9a8e2a853d99 all:ar5-own::own/inferred-widens"],
  ["this function declaration", S9B, "6e50d4087fe3 all:astra::defaults/null/8"],
  [
    "this written type",
    "S9b syntax and contract completion, S10 required union checks",
    "1eca307c695b all:rel-cases::rel/n-z/nest/3",
  ],
  ["this type test expression", S10, "423a03242fd9 direct"],
  ["a value that may be null here", S10, "99dbc4b0df3b all:astra::list-copy/integer?/null"],
  ["this assignment", S9B, "e20bcd61d295 compound-0-0"],
  ["this interaction expression", S9B, "efebe9cb1dc0 g3:nested-choice-literal-1"],
  ["a typed parse's or load's default that reads a variable", S9B, "246d7908638b named-3-3"],
  ["this call expression", S9B, "20d57c8b7a51 all:rv-cases-3::adds/null/xs.add(root)"],
  ["this global statement", S9B, "344a4bbad3e8 W1@8"],
  ["this load expression", S9B, "433896860299 varied"],
  ["this binary expression", S9B, "6f3ab79b48d4 inline-3"],
  ["this set literal", S9B, "6e2e332368a8 all:apr-reduced::reduced/fromJson/set/False/both"],
  ["this dict literal", S9B, "324966d92103 all:apr-reduced::reduced/fromJson/dict/True/both"],
  ["this say", S9B, "95d25e21e5c8 otherwise@4"],
  ["this operand", S9B, "37322197023a all:small::matrix|integer?-3-1"],
  ["this speaker declaration", S9B, "2162c578188d property-store"],
  ["this wait statement", S9B, "9b81214edfde wait-before-store"],
  ["this timer expression", S9B, "f026263201ad present element in timer"],
  ["this unary expression", S9B, "aa142634a81b op-not"],
  ["text with interpolation", S9B, "438473127a75 text-property:fixed"],
  ["this while statement", S9B, "9db4d6d7d832 while-mutator-add(12)"],
  ["this say expression", S9B, "9627e5e6fbd5 text size at say operand/t.length"],
  ["this switch statement", S9B, "b7fe7d230ab6 case/2"],
  ["this timer statement", S9B, "8d317aae58d8 handler-mutation-None"],
  ["this duration literal", S9B, "161bc6b0fe2d a7-composed-nullable"],
  ["this save statement", S9B, "9e17c53058b1 all:fixture-3::cp9-cells/C8/save-pass"],
  ["this show button statement", S9B, "4c830550d816 a6-interaction-parse"],
  [
    "an argument that its built-in checks",
    S9B,
    "499ff86d03a8 all:fixture-3::cp9-cells/3b/review-late/defaults/toNumber-successful",
  ],
  [
    "a value whose structure the slice does not follow",
    S9B,
    "b9cd660dfee0 all:new-cases-2::graph/224",
  ],
  ["this unit expression", S9B, "570a3364de1a original-7"],
  ["this show button expression", S9B, "ff962ec07974 text size at button label/t.length"],
  ["this angle expression", S9B, "6e952f6a5a3f angle-read:fixed"],
  ["this show permanent button statement", S9B, "03c2b71e65d1 prefix/3/handler"],
  ["this call file statement", S9B, "99b37a3f0ccb g1-function-goto-end"],
  ["this show permanent button expression", S9B, "3d91592e2c60 sol-handler-lifecycle/8"],
  ["this label statement", S9B, "05ac79575721 axes/field/main/none/stable/skipped"],
  [
    "this break statement",
    S9B,
    "27e1c9a53ccb all:fixture-1::cp9-cells/r46/m3/astra-m3/loop-exit/break",
  ],
  ["this continue statement", S9B, "aa6a9f277723 repeat-1"],
  [
    "this goto statement",
    S9B,
    "85da9313a057 all:fixture-2::cp9-cells/r46/m3/astra-m3/loop-exit/goto",
  ],
  ["this play media statement", S9B, "458302ad5e26 all:fixture-1::cp9-cells/H7/media"],
  ["this play media expression", S9B, "50454c9c6b23 all:fixture-1::cp9-cells/F25/media"],
  ["this end statement", S9B, "9525bb01a0e1 all:fixture-2::cp9-cells/L12/no-pending-call"],
  [
    "this delete statement",
    S9B,
    "ead9959c8fd1 all:fixture-0::cp9-cells/3b/review-late/storage/delete",
  ],
  [
    "a typed parse or load into a copy of a written type",
    S9B,
    "55c322138997 all:fixture-0::cp9-cells/s9b/f18-held/copy/scalar-load/written-number",
  ],
  [
    "a check of a loop variable",
    S9B,
    "3359b3e4928b all:fixture-1::cp9-cells/s6/rule-function/loop/decided",
  ],
  [
    /^the name '[^']+'$/,
    S9B,
    "1fa64d8f0688 speaker/path/property",
    "the name '<a name the slice does not declare>'",
  ],
  [
    /^the variable '[^']+', whose lists nest deeper than the slice follows$/,
    S9B,
    "df2ae4500b68 deep/256",
    "the variable '<name>', whose lists nest deeper than the slice follows",
  ],
];

/** The diagnostics of the surviving checks and reachability that S9b has not ported (TSV052 is reachability's). */
const SURVIVING = new Set(["TSV010", "TSV012", "TSV052", "TSV062", "TSV065", "TSV066"]);
/** The rule classes of written copies, absent properties and ingress (C1, C5, C9). */
const RULE = new Set(["TSV041", "TSV043", "TSV044"]);
const COMPLETED = new Set(["plan", "rejected"]);

/**
 * The route pair's classes. `state`: `pass`, `attributed` (the rule class is known; S11 still owes each source's
 * accepted expectation) or `open` (blocks the gate); `witness`: the smallest recorded one (a key's first 12 digits and the
 * source's name, in `tests/fixtures/shadow-classify/witnesses.jsonl`) or the test's synthetic case. `match` reads the
 * pair's facts (`pairFacts`).
 */
export const PAIR_CLASSES = [
  {
    id: "agree",
    state: "pass",
    rule: "both routes completed (plan or rejected) and the diagnostics' identity, their text, the checks and the plan are equal",
    authority: "r4.72, PLAN S11",
    witness: "42b72ef97e45 g3:typed-empty-1",
    match: (f) => f.kind === "compared" && !f.differs,
  },
  {
    id: "differs/stop",
    state: "open",
    rule: "compared, and the diagnostics whose identity (path, code, severity, offsets) one route has more often than the other include TSV076, the core's budget stop",
    authority: "S8 stop acceptance (#1526, #1654, #1658, #1659); r4.295's two columns",
    witness: "d0b20230b9aa copies32",
    match: (f) => f.diag && f.changed.has("TSV076"),
  },
  {
    id: "differs/surviving",
    state: "open",
    rule: "compared, the changed identities include no TSV076 and one of TSV010, TSV012, TSV052, TSV062, TSV065, TSV066 (surviving checks and reachability)",
    authority: "S9b #1072; #1623 (an empty loop's warning); TSV052 is reachability's (PLAN T5)",
    witness: "f824cdfe6f6c fallback-unused",
    match: (f) =>
      f.diag && !f.changed.has("TSV076") && [...f.changed].some((c) => SURVIVING.has(c)),
  },
  {
    id: "differs/integer",
    state: "open",
    rule: "compared, the changed identities include TSV011 and none of the codes of differs/stop and differs/surviving",
    authority: "S9b #1072, S10 #1073; #1173",
    witness: "66158f21e6fd original-1",
    match: (f) =>
      f.diag &&
      f.changed.has("TSV011") &&
      !f.changed.has("TSV076") &&
      ![...f.changed].some((c) => SURVIVING.has(c)),
  },
  {
    id: "differs/rule",
    state: "attributed",
    rule: "compared, and every changed identity is TSV041, TSV043 or TSV044 (written copies, absent properties, ingress)",
    authority:
      "V30 §§12–15, ADR 0021, TABLE A1–A9 C1 C5 C9 F11 F12, #1075; open #1323 #1337 #1382 #1383 #1385 #1399 #1666 where they apply",
    witness: "10b28741346d project-cycle-5",
    match: (f) => f.diag && f.changed.size > 0 && [...f.changed].every((c) => RULE.has(c)),
  },
  {
    id: "differs/checks",
    state: "attributed",
    rule: "compared, the diagnostics' identities equal, the checks a lowering reads differ",
    authority: "TABLE D7, the S3 discharge map, PLAN S7; S9b's storage and form outputs",
    witness: "1955e0106563 inline-1",
    match: (f) => f.kind === "compared" && !f.delta.diagnosticIdentity && f.delta.checks,
  },
  {
    id: "differs/plan",
    state: "attributed",
    rule: "compared, the diagnostics' identities and the checks equal, the plans differ",
    authority: "the core's check and reader metadata, subject to each plan's content",
    witness: "synthetic 'plan-only' (none in the research's records)",
    match: (f) =>
      f.kind === "compared" && !f.delta.diagnosticIdentity && !f.delta.checks && f.delta.plan,
  },
  {
    id: "differs/wording",
    state: "attributed",
    rule: "compared, only the diagnostics' text differs (identities, checks and plan equal)",
    authority: "S11's message classification (#1708's receiver words are such a class)",
    witness: "d746f603736f cell/C13/1",
    match: (f) =>
      f.kind === "compared" &&
      !f.delta.diagnosticIdentity &&
      !f.delta.checks &&
      !f.delta.plan &&
      f.delta.diagnosticText,
  },
  ...EXCLUSIONS.map(([text, owner, witness, words]) => ({
    id: `excluded/${typeof text === "string" ? text : words}`,
    state: "open",
    rule:
      typeof text === "string"
        ? `neither route failed or threw, and the core left its candidate slice at '${text}'`
        : `neither route failed or threw, and the core left its candidate slice at a text of the form '${words}'`,
    authority: owner,
    witness,
    match: (f) =>
      f.kind === "outside" &&
      (typeof text === "string" ? f.outside === text : text.test(f.outside)),
  })),
  {
    id: "failed/legacy-heap",
    state: "pass",
    rule: "the legacy route's run exhausted its heap in its type analysis (phase 'analysis'), the core's run in that mode completed or left its slice",
    authority: "Orchestrator 2 on #1704: legacy behaviour, resolved by the switch (#1075)",
    witness: "cd801dfecac6 1188-sol-candidate-neighbours.mjs/node-graft@64",
    match: (f) => f.kind === "failed" && f.legacyHeap,
  },
  {
    id: "failed/other",
    state: "open",
    rule: "a route's run failed (heap, units, safety net, worker exit) other than failed/legacy-heap",
    authority: "PLAN S11: a missing record fails closed",
    witness: "synthetic 'legacy-lowering', 'core-units'",
    match: (f) => f.kind === "failed" && !f.legacyHeap,
  },
  {
    id: "exception",
    state: "open",
    rule: "neither run failed and a route threw (identical exceptions are no agreement, #1439)",
    authority: "PLAN S11",
    witness: "synthetic 'thrown'",
    match: (f) => f.kind === "exception",
  },
  {
    id: "aborted-record",
    state: "open",
    rule: "the record is incomplete and has no rows (the research's form of a crashed source: the route is not recorded)",
    authority: "PLAN S11; rerun with shadow.mjs, which records the route",
    witness: "5c6d0896b924 node-mixed@64",
    match: (f) => f.kind === "aborted",
  },
  {
    id: "unavailable",
    state: "open",
    rule: "a source of `--expect` without a record",
    authority: "PLAN S11: a missing record fails closed",
    witness: "40e7ee95c5f6 (the research's manifest)",
    match: (f) => f.kind === "unavailable",
  },
];

/** The sharing column's classes, per source and order: the core with sharing on against off (#1711). */
export const SHARING_CLASSES = [
  {
    id: "equal",
    state: "pass",
    rule: "both sharing modes completed with the same outcome, diagnostics (their text included), checks and plan",
    authority: "r4.72",
    witness: "42b72ef97e45 g3:typed-empty-1",
    match: (f) => f.kind === "compared" && f.equal,
  },
  {
    id: "one-mode-stop",
    state: "attributed",
    rule: "they differ, and exactly one of them stops at the natural allowance (a TSV076 among its diagnostics)",
    authority:
      "#1711, Sol's option (iii): listed per row for the stop oracle (class (1) only where #1663's ledger shows no lost check)",
    witness: "d0b20230b9aa copies32",
    match: (f) => f.kind === "compared" && !f.equal && f.stops === 1,
  },
  {
    id: "both-stop-differ",
    state: "attributed",
    rule: "they differ, and both stop at the natural allowance",
    authority: "#1711, as one-mode-stop",
    witness:
      "08a8d195fd2e small:sol::deep-type-fixed-depth-copies-8.tease reversed (over the fixture's size; synthetic 'both-stop')",
    match: (f) => f.kind === "compared" && !f.equal && f.stops === 2,
  },
  {
    id: "neither-stops-differ",
    state: "open",
    rule: "they differ, and neither stops",
    authority: "r4.72 (#1703, #1323 were of this class)",
    witness: "ff3bbffa846a dormant@8",
    match: (f) => f.kind === "compared" && !f.equal && f.stops === 0,
  },
  {
    id: "outside",
    state: "open",
    rule: "both core runs ended, and at least one left its candidate slice",
    authority: "the exclusion's own class",
    witness: "95d25e21e5c8 otherwise@4",
    match: (f) => f.kind === "outside",
  },
  {
    id: "uncompared",
    state: "open",
    rule: "a core run of the order failed, threw or is not recorded",
    authority: "PLAN S11: a missing record fails closed",
    witness: "5c6d0896b924 node-mixed@64",
    match: (f) => f.kind === "uncompared",
  },
];

/** The class of the facts among `classes`, or why there is none: `{ id }` or `{ error, ids }`. */
export function classify(classes, facts) {
  const ids = classes.filter((each) => each.match(facts)).map((each) => each.id);
  if (ids.length === 1) return { id: ids[0] };
  return { error: ids.length === 0 ? "unclassified" : "ambiguous", ids };
}

const identityOf = (d) =>
  JSON.stringify([d.path ?? null, d.code, d.severity, d.span?.start?.offset, d.span?.end?.offset]);
const stops = (summary) => (summary.diagnostics ?? []).some((d) => d.code === "TSV076");

/** The codes of the diagnostics one route has more often than the other, by identity. */
function changedCodes(left, right) {
  const count = new Map();
  for (const d of left) count.set(identityOf(d), (count.get(identityOf(d)) ?? 0) + 1);
  for (const d of right) count.set(identityOf(d), (count.get(identityOf(d)) ?? 0) - 1);
  const codes = new Set();
  for (const [identity, n] of count) if (n !== 0) codes.add(JSON.parse(identity)[1]);
  return codes;
}

/** What a route pair's class reads: its kind, and for a compared pair its delta and changed codes. */
export function pairFacts(row) {
  const { legacy: l, core: c } = row;
  if (l.outcome === "failed" || c.outcome === "failed")
    return {
      kind: "failed",
      legacyHeap:
        l.outcome === "failed" &&
        l.failure === "heap" &&
        l.phase === "analysis" &&
        (COMPLETED.has(c.outcome) || c.outcome === "outside"),
    };
  if (l.outcome === "exception" || c.outcome === "exception") return { kind: "exception" };
  if (c.outcome === "outside" && COMPLETED.has(l.outcome))
    return { kind: "outside", outside: c.outside };
  if (!COMPLETED.has(l.outcome) || !COMPLETED.has(c.outcome) || row.delta === undefined)
    return { kind: "unknown" };
  const delta = row.delta;
  const differs = Object.values(delta).some(Boolean);
  const changed = delta.diagnosticIdentity
    ? changedCodes(l.diagnostics ?? [], c.diagnostics ?? [])
    : new Set();
  return { kind: "compared", delta, differs, diag: delta.diagnosticIdentity === true, changed };
}

/** The core's publication in one mode as the sharing column compares it. */
const publication = (c) =>
  JSON.stringify([c.outcome, c.diagnostics ?? null, c.checks ?? null, c.planHash ?? null]);

/** What the sharing column reads for one order: the core in its shared and its unshared mode. */
export function sharingFacts(shared, unshared) {
  if (shared === undefined || unshared === undefined) return { kind: "uncompared" };
  const ended = (c) => COMPLETED.has(c.outcome) || c.outcome === "outside";
  if (!ended(shared) || !ended(unshared)) return { kind: "uncompared" };
  if (shared.outcome === "outside" || unshared.outcome === "outside") return { kind: "outside" };
  return {
    kind: "compared",
    equal: publication(shared) === publication(unshared),
    stops: Number(stops(shared)) + Number(stops(unshared)),
  };
}

/** The pair's component columns: what else differs beside its class. */
function components(row, facts) {
  if (facts.kind !== "compared") return undefined;
  const { legacy: l, core: c } = row;
  return {
    identity: facts.delta.diagnosticIdentity,
    wording: !facts.delta.diagnosticIdentity && facts.delta.diagnosticText,
    checks: facts.delta.checks,
    plan: facts.delta.plan,
    outcomes: l.outcome === c.outcome ? null : `${l.outcome} -> ${c.outcome}`,
    frontEnd: c.checks === null || c.checks === undefined,
  };
}

/** The research's inventory signatures of a differing pair (one per differing component). */
function signatures(row, facts) {
  const { legacy: l, core: c } = row;
  const out = [];
  const codeText = (ds) => {
    const count = new Map();
    for (const d of ds)
      count.set(`${d.code}:${d.severity}`, (count.get(`${d.code}:${d.severity}`) ?? 0) + 1);
    return (
      [...count]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}*${v}`)
        .join(",") || "-"
    );
  };
  if (facts.delta.diagnosticIdentity) {
    const count = new Map();
    for (const d of l.diagnostics ?? [])
      count.set(identityOf(d), (count.get(identityOf(d)) ?? 0) + 1);
    for (const d of c.diagnostics ?? [])
      count.set(identityOf(d), (count.get(identityOf(d)) ?? 0) - 1);
    const removed = (l.diagnostics ?? []).filter((d) => count.get(identityOf(d)) > 0);
    const added = (c.diagnostics ?? []).filter((d) => count.get(identityOf(d)) < 0);
    out.push(`DIAG remove ${codeText(removed)}; add ${codeText(added)}`);
  } else if (facts.delta.diagnosticText) out.push(`WORDING ${codeText(c.diagnostics ?? [])}`);
  if (facts.delta.checks) {
    const lc = l.checks ?? {};
    const cc = c.checks ?? {};
    const keys = [...new Set([...Object.keys(lc), ...Object.keys(cc)])]
      .sort()
      .filter((k) => JSON.stringify(lc[k]) !== JSON.stringify(cc[k]));
    out.push(`CHECKS ${keys.join(",")}`);
  }
  if (facts.delta.plan) {
    const paths = new Set(
      (row.planDelta?.diffs ?? []).map((d) => d.path.replace(/\/\d+(?=\/|$)/g, "/[]")),
    );
    out.push(
      `PLAN ${l.outcome !== c.outcome ? "outcome" : [...paths].sort().join(",").slice(0, 700)}`,
    );
  }
  return out;
}

const MODE = (m) =>
  `${m.reversed ? "reversed" : "source order"}, sharing ${m.unshared ? "off" : "on"}`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A record's publication, as two records of one key must agree on it. */
function publicationOf(record) {
  const route = (x) => ({
    outcome: x.outcome,
    diagnostics: x.diagnostics,
    checks: x.checks,
    planHash: x.planHash,
    outside: x.outside,
    failure: x.failure,
    phase: x.phase,
  });
  return sha(
    JSON.stringify(
      record.rows === undefined
        ? { aborted: true }
        : record.rows.map((r) => [r.mode, route(r.legacy), route(r.core), r.delta ?? null]),
    ),
  );
}

/** Problems with a record's shape, or null: the classifier refuses what it cannot read. */
function invalid(record) {
  if (typeof record.key !== "string") return "no key";
  if (record.rows === undefined) return record.incomplete === true ? null : "no rows";
  if (!Array.isArray(record.rows) || record.rows.length !== 4) return "not four rows";
  const modes = new Set();
  for (const row of record.rows) {
    const m = row.mode;
    if (typeof m?.reversed !== "boolean" || typeof m?.unshared !== "boolean")
      return "a row without its mode";
    modes.add(`${m.reversed}/${m.unshared}`);
    for (const route of ["legacy", "core"])
      if (typeof row[route]?.outcome !== "string") return `a row without the ${route} outcome`;
  }
  return modes.size === 4 ? null : "a mode twice";
}

/** The classification of records (each `{ record, bytes }`) against the expected keys (null: not checked). */
export function classifyRecords(entries, expected = null) {
  const problems = [];
  const byKey = new Map();
  let duplicates = 0;
  for (const { record, bytes, where } of entries) {
    const why = invalid(record);
    if (why !== null) {
      problems.push({ problem: "invalid", where, why });
      continue;
    }
    const seen = byKey.get(record.key);
    if (seen === undefined) byKey.set(record.key, { record, bytes, hash: publicationOf(record) });
    else {
      duplicates += 1;
      if (seen.hash !== publicationOf(record))
        problems.push({ problem: "conflicting duplicate", key: record.key, where });
    }
  }
  if (expected !== null)
    for (const key of byKey.keys())
      if (!expected.has(key)) problems.push({ problem: "outside the manifest", key });

  const rows = new Map();
  const row = (classes, id) => {
    if (!rows.has(id)) {
      const of = classes.find((each) => each.id === id);
      rows.set(id, {
        id,
        state: of.state,
        rule: of.rule,
        authority: of.authority,
        pairs: 0,
        sources: new Set(),
        witnesses: [],
        texts: new Map(),
      });
    }
    return rows.get(id);
  };
  const witness = (r, key, name, bytes, mode) => {
    if (r.witnesses.some((w) => w.key === key)) return;
    r.witnesses.push({ key, name, bytes, mode });
    r.witnesses.sort((a, b) => a.bytes - b.bytes || (a.key < b.key ? -1 : 1));
    r.witnesses.length = Math.min(r.witnesses.length, 3);
  };
  const pairs = [];
  const sharing = [];
  const sigs = new Map();
  const totals = {
    sources: byKey.size,
    pairs: 0,
    compared: 0,
    duplicates,
    identity: 0,
    wording: 0,
    text: 0,
    checks: 0,
    plan: 0,
    outcomes: {},
    frontEnd: 0,
    ordinaryRecordRuns: 0,
    completionRecordRuns: 0,
    fourModeDifferences: 0,
  };
  const place = (record, facts, classes, list, extra) => {
    const result = classify(classes, facts);
    const name = record.name ?? record.origins?.[0]?.name ?? null;
    if (result.error !== undefined) {
      problems.push({ problem: result.error, key: record.key, name, ...extra, ids: result.ids });
      return null;
    }
    list.push({ key: record.key, name, ...extra, class: result.id });
    return result.id;
  };

  for (const { record, bytes } of byKey.values()) {
    const name = record.name ?? record.origins?.[0]?.name ?? null;
    if (record.rows === undefined) {
      for (let mode = 0; mode < 4; mode += 1) {
        const id = place(record, { kind: "aborted" }, PAIR_CLASSES, pairs, { mode });
        if (id !== null) {
          const r = row(PAIR_CLASSES, id);
          r.pairs += 1;
          r.sources.add(record.key);
          witness(r, record.key, name, bytes, null);
        }
      }
      for (const reversed of [false, true])
        if (
          place(record, { kind: "uncompared" }, SHARING_CLASSES, sharing, { reversed }) !== null
        ) {
          const r = row(SHARING_CLASSES, "uncompared");
          r.pairs += 1;
          r.sources.add(record.key);
          witness(r, record.key, name, bytes, null);
        }
      totals.pairs += 4;
      continue;
    }
    const published = [];
    for (const each of record.rows) {
      totals.pairs += 1;
      const decisions = each.core.decisionCounts;
      if ((decisions?.ordinary ?? []).some(Boolean)) totals.ordinaryRecordRuns += 1;
      if ((decisions?.completion ?? []).some(Boolean)) totals.completionRecordRuns += 1;
      const facts = pairFacts(each);
      const mode = MODE(each.mode);
      const id = place(record, facts, PAIR_CLASSES, pairs, {
        mode,
        components: components(each, facts),
      });
      if (facts.kind === "compared") {
        totals.compared += 1;
        published.push(publication(each.core));
        const parts = components(each, facts);
        if (parts.frontEnd) totals.frontEnd += 1;
        if (facts.differs) {
          if (parts.identity) totals.identity += 1;
          if (parts.wording) totals.wording += 1;
          if (facts.delta.diagnosticText) totals.text += 1;
          if (parts.checks) totals.checks += 1;
          if (parts.plan) totals.plan += 1;
          if (parts.outcomes !== null)
            totals.outcomes[parts.outcomes] = (totals.outcomes[parts.outcomes] ?? 0) + 1;
          for (const signature of signatures(each, facts)) {
            if (!sigs.has(signature))
              sigs.set(signature, {
                signature,
                class: id,
                pairs: 0,
                sources: new Set(),
                witnesses: [],
              });
            const s = sigs.get(signature);
            s.pairs += 1;
            s.sources.add(record.key);
            witness(s, record.key, name, bytes, mode);
          }
        }
      }
      if (id === null) continue;
      const r = row(PAIR_CLASSES, id);
      r.pairs += 1;
      r.sources.add(record.key);
      witness(r, record.key, name, bytes, mode);
      if (facts.kind === "outside")
        r.texts.set(facts.outside, (r.texts.get(facts.outside) ?? 0) + 1);
    }
    // (the research's count: sources whose core published in all four modes, not the same in all)
    if (published.length === 4 && new Set(published).size > 1) totals.fourModeDifferences += 1;
    for (const reversed of [false, true]) {
      const at = (unshared) =>
        record.rows.find((r) => r.mode.reversed === reversed && r.mode.unshared === unshared)?.core;
      const id = place(record, sharingFacts(at(false), at(true)), SHARING_CLASSES, sharing, {
        reversed,
      });
      if (id === null) continue;
      const r = row(SHARING_CLASSES, id);
      r.pairs += 1;
      r.sources.add(record.key);
      witness(r, record.key, name, bytes, reversed ? "reversed" : "source order");
    }
  }
  if (expected !== null)
    for (const key of expected)
      if (!byKey.has(key)) {
        const record = { key };
        for (let mode = 0; mode < 4; mode += 1)
          if (place(record, { kind: "unavailable" }, PAIR_CLASSES, pairs, { mode }) !== null) {
            const r = row(PAIR_CLASSES, "unavailable");
            r.pairs += 1;
            r.sources.add(key);
            witness(r, key, null, 0, null);
          }
        for (const reversed of [false, true])
          if (
            place(record, { kind: "uncompared" }, SHARING_CLASSES, sharing, { reversed }) !== null
          ) {
            const r = row(SHARING_CLASSES, "uncompared");
            r.pairs += 1;
            r.sources.add(key);
          }
        totals.pairs += 4;
        totals.unavailableSources = (totals.unavailableSources ?? 0) + 1;
      }

  const table = (classes) =>
    classes.map((each) => {
      const r = rows.get(each.id);
      return {
        id: each.id,
        state: each.state,
        pairs: r?.pairs ?? 0,
        sources: r?.sources.size ?? 0,
        witnesses: r?.witnesses ?? [],
        ...(r !== undefined && r.texts.size > 0 ? { texts: Object.fromEntries(r.texts) } : {}),
        rule: each.rule,
        authority: each.authority,
      };
    });
  const pairTable = table(PAIR_CLASSES);
  const sharingTable = table(SHARING_CLASSES);
  const coverage = {
    state: totals.ordinaryRecordRuns > 0 && totals.completionRecordRuns > 0 ? "pass" : "open",
    ordinaryRecordRuns: totals.ordinaryRecordRuns,
    completionRecordRuns: totals.completionRecordRuns,
  };
  const open = [
    ...pairTable.filter((r) => r.state === "open" && r.pairs > 0).map((r) => r.id),
    ...sharingTable.filter((r) => r.state === "open" && r.pairs > 0).map((r) => `sharing ${r.id}`),
    ...(coverage.state === "open" ? ["coverage"] : []),
    ...(expected === null ? ["unavailable (no --expect)"] : []),
  ];
  const failed = problems.length > 0;
  return {
    version: VERSION,
    verdict: failed ? "failed" : open.length === 0 ? "green" : "open",
    open,
    problems,
    totals,
    coverage,
    pairs: pairTable,
    sharing: sharingTable,
    signatures: [...sigs.values()].map((s) => ({ ...s, sources: s.sources.size })),
    perPair: pairs,
    perOrder: sharing,
  };
}

/** The gate table as markdown: one line a class with pairs, sources, state and its first witness. */
function markdown(result) {
  const line = (r) =>
    `| ${r.id} | ${r.state} | ${r.pairs} | ${r.sources} | ${r.witnesses
      .map((w) => `${w.key.slice(0, 12)} ${w.name ?? ""}${w.mode ? ` (${w.mode})` : ""}`)
      .join("; ")} |`;
  const t = result.totals;
  return [
    `# Shadow gate (taxonomy v${result.version}): ${result.verdict}`,
    "",
    "| Route pair class | State | Pairs | Sources | Smallest witnesses |",
    "| --- | --- | ---: | ---: | --- |",
    ...result.pairs.filter((r) => r.pairs > 0 || r.state !== "open").map(line),
    "",
    "| Sharing column (core, sharing on against off, per order) | State | Orders | Sources | Smallest witnesses |",
    "| --- | --- | ---: | ---: | --- |",
    ...result.sharing.map(line),
    "",
    `Components of the differing pairs: identity ${t.identity}, same-identity wording ${t.wording}, checks ${t.checks}, plan ${t.plan}; outcomes ${JSON.stringify(t.outcomes)}; front-end rejections among compared pairs ${t.frontEnd}.`,
    `Coverage (${result.coverage.state}): ordinary record runs ${result.coverage.ordinaryRecordRuns}, completion runs ${result.coverage.completionRecordRuns}.`,
    `Information (not gated): sources whose core publication differs across the four modes ${t.fourModeDifferences}.`,
    `Open: ${result.open.join(", ") || "none"}. Problems: ${result.problems.length}.`,
    "",
  ].join("\n");
}

async function* jsonLines(file) {
  let n = 0;
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    n += 1;
    if (line.trim() === "") continue;
    yield { line, where: `${file}:${n}` };
  }
}

async function main(argv) {
  const refused = (why) => {
    process.stderr.write(`shadow-classify.mjs: ${why}\n`);
    process.exit(2);
  };
  const files = [];
  const expects = [];
  let out;
  let gate = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--expect") expects.push(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--gate") gate = true;
    else if (argv[i].startsWith("--")) refused(`unknown option ${argv[i]}`);
    else files.push(argv[i]);
  }
  if (files.length === 0)
    refused(
      "usage: shadow-classify.mjs <records.jsonl>... [--expect keys.jsonl]... [--out DIR] [--gate]",
    );
  if (gate && expects.length === 0)
    refused("--gate needs --expect: the gate counts unavailable sources");
  const entries = [];
  const unreadable = [];
  for (const file of files)
    for await (const { line, where } of jsonLines(file))
      try {
        entries.push({ record: JSON.parse(line), bytes: line.length, where });
      } catch (error) {
        unreadable.push({ problem: "invalid", where, why: error.message });
      }
  let expected = null;
  if (expects.length > 0) {
    expected = new Set();
    for (const file of expects)
      for await (const { line, where } of jsonLines(file))
        try {
          expected.add(JSON.parse(line).key);
        } catch (error) {
          unreadable.push({ problem: "invalid", where, why: error.message });
        }
  }
  const result = classifyRecords(entries, expected);
  result.problems.unshift(...unreadable);
  if (unreadable.length > 0) result.verdict = "failed";
  const { perPair, perOrder, signatures: sigs, ...gateTable } = result;
  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      path.join(out, "pairs.jsonl"),
      perPair.map((p) => `${JSON.stringify(p)}\n`).join(""),
    );
    writeFileSync(
      path.join(out, "sharing.jsonl"),
      perOrder.map((p) => `${JSON.stringify(p)}\n`).join(""),
    );
    writeFileSync(
      path.join(out, "signatures.tsv"),
      [
        "signature\tclass\tsources\tpairs\twitnesses (JSON: key, name)",
        ...sigs
          .sort((a, b) => b.pairs - a.pairs || (a.signature < b.signature ? -1 : 1))
          .map((s) =>
            [
              s.signature,
              s.class,
              s.sources,
              s.pairs,
              JSON.stringify(s.witnesses.map((w) => [w.key, w.name])),
            ].join("\t"),
          ),
      ].join("\n") + "\n",
    );
    writeFileSync(path.join(out, "gate.json"), `${JSON.stringify(gateTable, null, 1)}\n`);
    writeFileSync(path.join(out, "gate.md"), markdown(result));
  }
  const brief = (table) =>
    Object.fromEntries(table.filter((r) => r.pairs > 0).map((r) => [r.id, r.pairs]));
  console.log(
    JSON.stringify({
      version: VERSION,
      totals: result.totals,
      pairs: brief(result.pairs),
      sharing: brief(result.sharing),
      signatures: sigs.length,
      problems: result.problems.length,
    }),
  );
  for (const problem of result.problems.slice(0, 20))
    process.stderr.write(`shadow-classify.mjs: ${JSON.stringify(problem)}\n`);
  console.log(
    `gate: ${result.verdict}${result.open.length > 0 ? ` (open: ${result.open.join(", ")})` : ""}`,
  );
  if (result.problems.length > 0) return 1;
  return gate && result.verdict !== "green" ? 1 : 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = await main(process.argv.slice(2));
