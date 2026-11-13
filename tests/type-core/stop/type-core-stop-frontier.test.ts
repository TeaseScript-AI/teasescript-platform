// The bounded host frontier: a read's walk past its bound keeps every check (#1445, #1453, #1509).

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../../src/type-inference/core/budget.js";
import {
  FRONTIER_COPIES,
  FRONTIER_DEPTH,
  withFrontierBound,
  type FrontierRead,
} from "../../../src/type-inference/core/consumers/host-frontier.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  heldDemands,
  HELD_MODES,
  randomCopyGraph,
  topologySources,
} from "../../helpers/type-core-held-host.js";
import { stopIdentity } from "../../helpers/type-core-oracles.js";

/** An analysis and its reads' walks (`withFrontierBound`). */
type Walked = { readonly result: Answers; readonly reads: ReadonlyMap<string, FrontierRead> };

/**
 * A bounded frontier's analysis against the exact walk's at one stop
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-208), whole, and whether a read's walk
 * was cut (`withFrontierBound` keeps a cut when the read is made again, #1509): where none was, the same reads, checks,
 * diagnostics and marks; where one was, every exact check's obligation (its kind, target, requirement, site and
 * boundary flag) kept or owned by a mark. A cut read answers its place's component's host data, a superset of what its
 * walk names, so its consumers may owe checks the exact walk does not, never fewer: those may read more, and one worded
 * for external data needs no read of its receiver (#1449's wording difference at a stop). The exact walk is cut nowhere,
 * so a walk that ignored the bound `withFrontierBound` sets would fail here, its two runs agreeing at the default bound.
 */
function boundedKeepsExact(bounded: Walked, exact: Walked, where: string): boolean {
  for (const [read, walked] of exact.reads)
    assert.equal(walked.cut, false, `${where} ${read}: the exact walk was cut`);
  const cut = [...bounded.reads.values()].some((read) => read.cut);
  if (!cut) {
    const whole = ({ result, reads }: Walked) => ({
      reads: [...reads.keys()].sort(),
      checks: result.checks,
      diagnostics: result.diagnostics.map(stopIdentity),
      deferred: result.budget.deferred.map(stopIdentity),
    });
    assert.deepEqual(whole(bounded), whole(exact), where);
    return cut;
  }
  const obligation = (check: Answers["checks"][number]) =>
    JSON.stringify({ ...check, on: undefined });
  const kept = new Set(
    [
      ...bounded.result.checks,
      ...bounded.result.budget.deferred.map((mark) => mark.obligation),
    ].map(obligation),
  );
  for (const check of exact.result.checks)
    assert.ok(kept.has(obligation(check)), `${where}: ${JSON.stringify(check)}`);
  return cut;
}

/**
 * #1445 (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-208): after a settled stop, a
 * domain read's host data is followed at most two copies deep and over at most eight copies met (`FRONTIER_DEPTH`,
 * `FRONTIER_COPIES`); past them the read answers its place's component's. Against the exact walk (`withFrontierBound`,
 * unbounded), read by read: the same stop guard, the same writers where a read's walk is not cut and a superset where
 * it is; whole, `boundedKeepsExact`. The topologies at k = 4 (rings and chains of own stores are cut there), two reads
 * no place holds whose links count as copies (#1559), and six random copy graphs (two with readers of two places),
 * forward with sharing and reversed without, near the first settled stop and at the last, without a demand cap and
 * under the largest that stops a decision. The same check runs at scale, in all four modes, on the workers.
 */
test("after a settled stop a read's bounded host frontier names its exact writers, or more where it is cut (#1445)", () => {
  const sources = [
    ...topologySources(4),
    // (reads no place holds, their links counted as copies: a `get`'s default 4 deep, each holding the next in a literal's
    // cell, and a literal below two copies at its root, Astra r1's B1 and B2 on #1559)
    {
      name: "nested-get-cells",
      source: `repeat ${"[1].get(5, default: [".repeat(4)}hostValue${"][0])".repeat(4)} {}\nexit\n`,
    },
    {
      name: "double-copied-literal",
      source: "repeat [[[[[[hostValue]]]]].toList()].toList()[0][0][0][0][0][0] {}\nexit\n",
    },
    ...[1, 2, 3, 4, 5, 6].map((seed) => ({
      name: `random ${seed}`,
      // (seeds 5 and 6 with four readers of two places each, Codex r5's B1)
      source: randomCopyGraph(seed, 6, 4, 18, seed > 4 ? 4 : 0),
    })),
  ];
  const bound = { depth: FRONTIER_DEPTH, copies: FRONTIER_COPIES };
  const exactly = { depth: Infinity, copies: Infinity };
  const seen = { cut: 0, whole: 0, guarded: 0, decisionStops: 0 };
  for (const { name, source } of sources) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null, name);
    for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!]) {
      // (the largest demand allowance under which a decision stops)
      for (const demand of [undefined, ...heldDemands({ source }, mode).slice(0, 1)]) {
        const analyse = (allowance?: number): Answers =>
          mode.run(() => {
            const capped = () =>
              demand === undefined
                ? analyseCore(request)
                : withTestDemandAllowance(demand, () => analyseCore(request));
            return allowance === undefined ? capped() : withTestAllowance(allowance, capped);
          });
        const total = analyse().budget.total;
        // (a settled stop within a 64th of the first: the settled phases, the walk and the publication, are the last)
        let [first, top] = [1, total - 1];
        while (top - first > total >> 6) {
          const middle = (first + top) >> 1;
          if (analyse(middle).budget.settled) top = middle;
          else first = middle + 1;
        }
        for (const allowance of new Set([top, total - 1])) {
          const where = `${name}, ${mode.name}, demand ${demand} @${allowance}`;
          const bounded = withFrontierBound(bound, () => analyse(allowance));
          const exact = withFrontierBound(exactly, () => analyse(allowance));
          assert.ok(bounded.result.budget.settled, where);
          for (const [read, mine] of bounded.reads) {
            const theirs = exact.reads.get(read);
            if (theirs === undefined) continue;
            assert.equal(mine.guarded, theirs.guarded, `${where} ${read}`);
            const missing = [...theirs.writers].filter((writer) => !mine.writers.has(writer));
            assert.equal(missing.length, 0, `${where} ${read}: a writer the exact walk names`);
            if (!mine.cut) assert.equal(mine.writers.size, theirs.writers.size, `${where} ${read}`);
            if (mine.guarded) seen.guarded += 1;
            else if (mine.cut) seen.cut += 1;
            else seen.whole += 1;
          }
          if (bounded.result.budget.decisions.some((d) => d.stopped)) seen.decisionStops += 1;
          boundedKeepsExact(bounded, exact, where);
        }
      }
    }
  }
  assert.ok(
    Object.values(seen).every((count) => count > 0),
    JSON.stringify(seen),
  );
});

/**
 * #1509: a read made again keeps its earlier cut in `withFrontierBound`'s record. Ten copies of a list holding host data,
 * read after a settled stop under a demand allowance that stops a decision: the first read of `c9` is cut past eight
 * copies and answers its place's component's host data, which owes the element's boundary and a null check the exact
 * walk does not; `c9` is read again through the chain the cut compressed (`sameOf`), two copies, uncut. In each mode, at
 * the first settled stop under the largest such allowance, the record says a read was cut, so `boundedKeepsExact`
 * demands the exact checks' obligations, not equality.
 */
test("a read made again keeps its earlier cut in the bounded frontier's record (#1509)", () => {
  const source = [
    "let c0: list = [hostValue, 4]",
    ...Array.from({ length: 9 }, (_, i) => `let c${i + 1} = c${i}`),
    'say "BEFORE"',
    'repeat c9[0] {say "ok"}',
    'say "AFTER"',
    "exit\n",
  ].join("\n");
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  for (const mode of HELD_MODES) {
    const demand = heldDemands({ source }, mode)[0];
    assert.ok(demand !== undefined, mode.name);
    const capped = () => withTestDemandAllowance(demand, () => analyseCore(request));
    const analyse = (allowance: number): Answers =>
      mode.run(() => withTestAllowance(allowance, capped));
    let first = 1;
    for (let top = mode.run(capped).budget.total - 1; first < top;) {
      const middle = (first + top) >> 1;
      if (analyse(middle).budget.settled) top = middle;
      else first = middle + 1;
    }
    const where = `${mode.name}, demand ${demand} @${first}`;
    const bounded = withFrontierBound({ depth: FRONTIER_DEPTH, copies: FRONTIER_COPIES }, () =>
      analyse(first),
    );
    const exact = withFrontierBound({ depth: Infinity, copies: Infinity }, () => analyse(first));
    assert.ok(bounded.result.budget.settled, where);
    assert.ok(boundedKeepsExact(bounded, exact, where), `${where}: no read's walk is cut`);
  }
});

/**
 * #1453: after a settled stop, a read whose walk is cut answers its place's component's host data, so it
 * keeps every check: through 257 copies of a host object (the store's record-level boundary, `copy-type root against
 * object`, which #1453 lost at 256), through 33 copies each storing its own property, and in a ring of 64 copies. In
 * each, at its first settled stop, its last and halfway between, in both orders, every check of the unstopped compile is
 * kept or owned by a mark, and some read's walk is cut.
 */
test("a read past the bounded walk keeps every check: #1453's 257 copies, copies each storing, and a ring", () => {
  const chain = (length: number, store: boolean) =>
    [
      "let root = {f: hostValue, g: 1}",
      ...Array.from(
        { length },
        (_, i) => `let c${i} = ${i ? `c${i - 1}` : "root"}${store ? `\nc${i}.g = ${i}` : ""}`,
      ),
      'say "BEFORE"',
      `repeat c${length - 1}.f {say "ok"}`,
      'say "AFTER"',
    ].join("\n");
  const ring = [
    ...Array.from({ length: 64 }, (_, i) => `let c${i} = {f: hostValue}`),
    ...Array.from({ length: 64 }, (_, i) => `c${i} = c${(i + 1) % 64}`),
    ...Array.from({ length: 64 }, (_, i) => `repeat c${i}.f {}`),
  ].join("\n");
  const bound = { depth: FRONTIER_DEPTH, copies: FRONTIER_COPIES };
  for (const [name, text] of [
    ["257 copies", chain(257, false)],
    ["33 copies, each storing", chain(33, true)],
    ["a ring of 64", ring],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source: `${text}\nexit\n` }], ["hostValue"]);
    assert.ok(request !== null, name);
    for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!]) {
      const analyse = (allowance?: number): Answers =>
        mode.run(() =>
          allowance === undefined
            ? analyseCore(request)
            : withTestAllowance(allowance, () => analyseCore(request)),
        );
      const unstopped = analyse();
      if (name !== "a ring of 64")
        assert.ok(
          unstopped.checks.some((check) =>
            JSON.stringify(check).includes('"kind":"copy-type","target":"root"'),
          ),
          name,
        );
      const total = unstopped.budget.total;
      // (the first settled stop, where the most reads are left to the finishing walk)
      let first = 1;
      for (let top = total - 1; first < top;) {
        const middle = (first + top) >> 1;
        if (analyse(middle).budget.settled) top = middle;
        else first = middle + 1;
      }
      let cut = false;
      for (const allowance of new Set(
        [0, 1, 2].map((i) => first + (((total - 1 - first) * i) >> 1)),
      )) {
        const where = `${name}, ${mode.name} @${allowance}`;
        const { result, reads } = withFrontierBound(bound, () => analyse(allowance));
        assert.ok(result.budget.settled, where);
        cut ||= [...reads.values()].some((read) => read.cut);
        const kept = new Set(result.checks.map((check) => JSON.stringify(check)));
        const owned = new Set(
          result.budget.deferred.map((mark) => JSON.stringify(mark.obligation)),
        );
        for (const check of unstopped.checks.map((each) => JSON.stringify(each)))
          assert.ok(kept.has(check) || owned.has(check), `${where}: ${check}`);
      }
      assert.ok(cut, `${name}, ${mode.name}: no read's walk is cut`);
    }
  }
});
