import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { runGlobals } from "../../helpers/type-core-route.js";
import { inMode, publishedAnswers, publishedRoute } from "../../helpers/type-core-oracles.js";
import {
  DEFAULT_CHAIN_MATRIX,
  INFERRED_COPY_MATRIX,
  V30_TYPE_MATRIX,
  WRITTEN_DOMAIN_MATRIX,
  type WrittenCase,
} from "../../helpers/type-core/written/type-core-written-matrices.js";
import {
  sorted,
  checksOf,
  GLOBALS,
  prepare,
  decision,
} from "../../helpers/type-core/written/type-core-written-setup.js";

/*
 * The written-domain matrices (`type-core-written-matrices.ts`; the lead's rulings on the merged S6's B1 and B2: A4, F17b,
 * the design's fit rule, ADR 0021 1.3, V30 §13), each source in both orders and with the sharing on and off, in three layers:
 * the decision (the place's admitted kinds at each level, and the program's C9 boundaries, each at its host read with its
 * target's level and `against`, none at a level that admits every kind), the plan (each store that brings a host value
 * checked against the whole written type) and
 * the runs (each host value that fits says DONE, each other one stops at TSR058 at the first checked store's value,
 * nothing said). The decision layer also holds the outcome and every diagnostic: a runtime-check warning at each store
 * that brings a host value to a decided level, nothing else. Whether the candidate route takes a source is each row's
 * own axis (`executable`): a row it takes must plan and run, a row it does not is checked in the decision layer alone
 * (not whether the route still leaves it out: the slice grows). Each exact source is analysed once per mode and planned
 * in each where its row is executable, else in the source order alone; the two orders' plans are compared whole, and
 * each distinct plan runs its host values once; every row that holds the source is compared with that. The same
 * analyses and plans give the sharing differential (`type-core-oracles.ts`) of the sources of the four
 * matrices checked so, which `sharing/type-core-sharing-differential.test.ts` runs for every other program.
 * V30 §13's union rule is a compile error with no plan: its examples in the decision layer and the candidate route's
 * rejection; `UNION_RULE_MATRIX` at the check of written types the analysis reports (`writtenTypeErrors`, which reads
 * the declarations alone), each placement's first error and valid control in the decision layer too.
 */

/** The line of `source` an offset is on. */
function lineAt(source: string, offset: number): string {
  const end = source.indexOf("\n", offset);
  return source.slice(source.lastIndexOf("\n", offset - 1) + 1, end < 0 ? undefined : end);
}

/** A written case's element path down its levels. */
const elementsOf = (c: WrittenCase): string[] => Array<string>(c.levels.length - 1).fill("element");

/**
 * The decision of one source in one mode and what its analysis publishes (`publishedAnswers`; the analysis released
 * before the route compiles), and the route's plan or rejection where `planned` (`publishedRoute`).
 */
function observe(c: WrittenCase, planned: boolean) {
  const { request, ids, bindings } = prepare(c.source);
  const decided = (() => {
    const answers = analyseCore(request);
    return {
      ...decision(answers, ids.get(c.place)!, elementsOf(c)),
      outcome: answers.outcome,
      diagnostics: [
        ...new Set(
          answers.diagnostics.map(
            (found) => `${found.class} ${found.kind} ${lineAt(c.source, found.site.start)}`,
          ),
        ),
      ].sort(),
      published: publishedAnswers(answers, bindings, request),
    };
  })();
  const route = planned
    ? publishedRoute([{ path: "main.tease", source: c.source }], GLOBALS)
    : null;
  return { ...decided, route };
}

/** A plan's run of each host value of `c`, where the route takes the source. */
function runsOf(c: WrittenCase, plan: InstructionPlan | null | "outside") {
  return plan === "outside" || plan === null
    ? []
    : c.runs.map(([value]) => {
        const ran = runGlobals(plan, { ...c.globals, hostValue: value });
        return { status: ran.status, failure: ran.failure, says: ran.said.map(({ text }) => text) };
      });
}

/**
 * Every layer of one exact input in both orders with the sharing on and off: each mode's decision, compared between the
 * orders; its checked stores, planned in both orders where the row is executable (the whole plans compared), else in
 * the source order alone; and the runs of each distinct plan of an executable row, a plan equal to the sharing's own
 * running nothing again. `standing` compares what the input publishes: the orders where the sharing changes it, whether
 * its record changes with the order, the orders whose record is out of source order of its sites, and whether both
 * source-order modes planned it.
 */
function observeModes(c: WrittenCase) {
  const observeIn = (reversed: boolean, shared: boolean) =>
    inMode({ reversed, unshared: !shared }, () => observe(c, c.executable || !reversed));
  // (each order's modes, the sharing on and off)
  const forward = [observeIn(false, true), observeIn(false, false)];
  const reversed = [observeIn(true, true), observeIn(true, false)];
  const orders = [
    ["source order", forward],
    ["reversed", reversed],
  ] as const;
  const standing = {
    differing: orders.flatMap(([order, [on, off]]) =>
      on!.published.text === off!.published.text && on!.route?.text === off!.route?.text
        ? []
        : [order],
    ),
    reordered: forward[0]!.published.record !== reversed[0]!.published.record,
    unsited: orders.flatMap(([order, [on]]) => (on!.published.sited ? [] : [order])),
    planned: forward.every(({ route }) => route !== null),
  };
  const decided = ({ levels, boundaries, outcome, diagnostics }: ReturnType<typeof observe>) => ({
    levels,
    boundaries,
    outcome,
    diagnostics,
  });
  const plans = forward.map(({ route }) => route!.plan);
  for (const [index, other] of reversed.entries()) {
    assert.deepEqual(decided(other), decided(forward[index]!));
    if (c.executable) assert.deepEqual(other.route!.plan, plans[index]);
  }
  const shared = c.executable ? runsOf(c, plans[0]!) : [];
  return {
    modes: plans.map((plan, index) => ({
      ...decided(forward[index]!),
      checks: plan === "outside" ? "outside" : plan === null ? "no plan" : checksOf(plan),
      runs:
        !c.executable || index === 0 || isDeepStrictEqual(plan, plans[0])
          ? shared
          : runsOf(c, plan),
    })),
    standing,
  };
}

/** Each exact input's observations, the sharing on and off, shared by every row that holds it (Astra's D3). */
const observations = new Map<string, ReturnType<typeof observeModes>>();

function observation(c: WrittenCase): ReturnType<typeof observeModes> {
  const key = JSON.stringify([
    c.source,
    c.place,
    c.levels.length,
    c.runs.map(([value]) => value),
    c.globals,
  ]);
  let found = observations.get(key);
  if (found === undefined) observations.set(key, (found = observeModes(c)));
  return found;
}

function observed(c: WrittenCase, shared: boolean) {
  return observation(c).modes[shared ? 0 : 1]!;
}

/**
 * The sources of `cases` that fail a layer, how many the route took in every layer, the forms and the decisions it took
 * in none of their sources, and the rows it took whose kinds no host value has (each runs forbidden values only).
 */
function failing(cases: readonly WrittenCase[]): {
  wrong: string[];
  full: number;
  decisionOnly: string;
  forbiddenOnly: string;
} {
  const wrong: string[] = [];
  const taken = { forms: new Map<string, boolean>(), decisions: new Map<string, boolean>() };
  const forbiddenOnly = new Set<string>();
  let full = 0;
  for (const c of cases) {
    for (const shared of [true, false]) {
      const seen = observed(c, shared);
      const name = `${c.name}${shared ? "" : " (no sharing)"}`;
      if (JSON.stringify(seen.levels) !== JSON.stringify(c.levels.map(sorted)))
        wrong.push(`${name}: admits ${JSON.stringify(seen.levels)}`);
      if (JSON.stringify(seen.boundaries) !== JSON.stringify(c.boundaries))
        wrong.push(`${name}: C9 boundaries ${JSON.stringify(seen.boundaries)}`);
      const diagnostics = [
        ...new Set(c.warned.map((line) => `warning-runtime-check written-target ${line}`)),
      ].sort();
      const outcome = diagnostics.length > 0 ? "warning-runtime-check" : "valid";
      if (
        seen.outcome !== outcome ||
        JSON.stringify(seen.diagnostics) !== JSON.stringify(diagnostics)
      )
        wrong.push(`${name}: ${seen.outcome}, diagnostics ${JSON.stringify(seen.diagnostics)}`);
      const inside = seen.checks !== "outside";
      if (c.executable && !inside) wrong.push(`${name}: the route does not take it`);
      if (shared) {
        taken.forms.set(c.form, (taken.forms.get(c.form) ?? false) || inside);
        taken.decisions.set(c.decision, (taken.decisions.get(c.decision) ?? false) || inside);
      }
      if (!c.executable || !inside) continue;
      if (shared) full += 1;
      const checks = seen.checks;
      if (checks === "no plan" || JSON.stringify(checks) !== JSON.stringify(c.checks))
        wrong.push(`${name}: checks ${JSON.stringify(checks)}`);
      const runs = c.runs.map(([, stop]) =>
        stop === null
          ? { status: "halted", failure: null, says: ["DONE"] }
          : { status: "failed", failure: stop, says: [] },
      );
      if (JSON.stringify(seen.runs) !== JSON.stringify(runs))
        wrong.push(`${name}: runs ${JSON.stringify(seen.runs)}`);
      // (every row the route takes runs a forbidden value, and a conforming one where its kinds are a host value's)
      if (!c.runs.some(([, stop]) => stop !== null)) wrong.push(`${name}: no forbidden run`);
      if (!c.runs.some(([, stop]) => stop === null)) {
        if (!/timer|media|messageHandle|speaker/.test(c.form))
          wrong.push(`${name}: no conforming run`);
        else if (shared) forbiddenOnly.add(c.form);
      }
    }
  }
  const none = (map: Map<string, boolean>): string =>
    [...map].flatMap(([name, inside]) => (inside ? [] : [name])).join(", ") || "none";
  return {
    wrong,
    full,
    decisionOnly: `forms ${none(taken.forms)}; decisions ${none(taken.decisions)}`,
    forbiddenOnly: [...forbiddenOnly].join(", ") || "none",
  };
}

test("a written type or a copy of it admits its written domain at every level, null alone included (merged S6 B1)", (t) => {
  const { wrong, full } = failing(WRITTEN_DOMAIN_MATRIX);
  t.diagnostic(
    `${WRITTEN_DOMAIN_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("V30 §13's written types, each form and copy, admit what they permit in every layer (merged S6 B1, B2)", (t) => {
  const { wrong, full, decisionOnly, forbiddenOnly } = failing(V30_TYPE_MATRIX);
  t.diagnostic(
    `${V30_TYPE_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off; ` +
      `decision layer only (outside the candidate slice): ${decisionOnly}; forbidden values only (no host value is ` +
      `a timer, media or message handle or a speaker): ${forbiddenOnly}`,
  );
  assert.deepEqual(wrong, []);
});

test("a copy of an unannotated source has its whole-source type, a later fraction or null included (ADR 0021 1.1, 1.2)", (t) => {
  const { wrong, full } = failing(INFERRED_COPY_MATRIX);
  t.diagnostic(
    `${INFERRED_COPY_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("a copy of an unannotated parameter whose default copies a written binding has the written type (F21)", (t) => {
  const { wrong, full } = failing(DEFAULT_CHAIN_MATRIX);
  t.diagnostic(
    `${DEFAULT_CHAIN_MATRIX.length} sources (${full} in all three layers; a function is outside the candidate slice), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

/**
 * The sharing differential of the four matrices' sources above, each exact source once, on those
 * tests' observations (made here where those tests did not run): in each order its answers, every binding's
 * admitted types at its root and its element and the candidate route's plan or rejection (in the source order alone
 * where its row is not executable) are byte-identical with the sharing on and off; its record is the same in both
 * orders, each of its lists in source order of its sites.
 */
test("each source of the written-domain, V30 type, inferred-copy and default-chain matrices is output-neutral with the sharing on and off, in both orders, and its record is the same in both", (t) => {
  const differing: string[] = [];
  const reordered: string[] = [];
  const unsited: string[] = [];
  const sources = new Set<string>();
  let planned = 0;
  for (const c of [
    ...WRITTEN_DOMAIN_MATRIX,
    ...V30_TYPE_MATRIX,
    ...INFERRED_COPY_MATRIX,
    ...DEFAULT_CHAIN_MATRIX,
  ]) {
    if (sources.has(c.source)) continue;
    sources.add(c.source);
    const { standing } = observation(c);
    differing.push(...standing.differing.map((order) => `${c.name} (${order})`));
    if (standing.reordered) reordered.push(c.name);
    unsited.push(...standing.unsited.map((order) => `${c.name} (${order})`));
    if (standing.planned) planned += 1;
  }
  t.diagnostic(
    `${sources.size} sources in both orders with the sharing on and off, ${planned} of them planned so in the ` +
      "source order",
  );
  assert.deepEqual(differing, []);
  assert.deepEqual(reordered, []);
  assert.deepEqual(unsited, []);
  assert.equal(planned, sources.size);
});
