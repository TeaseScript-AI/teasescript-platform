// Work that grows with the program where reads search: a decided object's property search (#1610), a question every
// read of one place asks (#1167), a place replaced by objects of distinct properties (#1456), and a literal of distinct
// records searched in linear time.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { type WorkCounter } from "../../../src/type-inference/core/budget.js";
import {
  asked,
  coreCheckResult,
  coreFacts,
} from "../../../src/type-inference/core/check-result/check-result.js";
import { SliceIndex } from "../../../src/type-inference/core/check-result/slice-index.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { DefinitionIndex } from "../../../src/type-inference/core/definitions.js";
import {
  withFlatListings,
  withNameRecords,
} from "../../../src/type-inference/core/property-listings.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  PROPERTY_STORE_FAMILIES,
  WIDE_COPIES_READ_TWICE,
} from "../../helpers/type-core/families/candidates.js";
import {
  LAYER_FAMILIES,
  SEARCH_FAMILIES,
} from "../../helpers/type-core/families/property-names.js";
import { type WorkFamily } from "../../helpers/type-core/families/builders.js";
import {
  DOUBLING,
  type Sized,
  sized,
  analysed,
  COUNTER_DOUBLING,
  type Measured,
  steepCounters,
} from "../../helpers/type-core/type-core-work.js";

/**
 * #1610: a decided object's property search in #1466's stack of diamonds of copies, which the stores' checks after the
 * analysis ask once per decided object (`Contracts.stored`), and the search's other askers inside the analysis
 * (`SEARCH_FAMILIES`): the searches' own units and counters (`withNameRecords`) over the analysis and the backend's
 * questions after it, at one small doubling in the four modes. A listing schedules a layer's effective sources only, so
 * the searches grow with the program, where `main`'s grew 4.2 to 6.8 times per doubling (416,963 units at k = 128
 * against the analysis's 226,049). The listing chain shown holds i + 2 names at its i-th copy (`g`, and below it `z` and
 * one per copy before it), so its searches' output is quadratic: its units per name held do not rise.
 * Codex r1's projected feedback, whose sources pump at their take-ups, charges no more than the flat listing
 * (`withFlatListings`): a listing's classification charges what the flat search charges there, never its followers
 * where it pumps. The series to k = 128 is the PR's evidence, outside CI.
 */
test("a decided object's property search grows with the program in a stack of copies, in every mode (#1610)", () => {
  const searched = (
    { name, request }: Sized,
    reversed: boolean,
    unshared: boolean,
  ): { readonly units: number; readonly counts: ReadonlyMap<WorkCounter, number> } => {
    const run = (): number => {
      const answers = analyseCore(request);
      assert.equal(answers.budget.exhausted, null, `${name}: within the allowance`);
      const index = new SliceIndex(request.files.map((file) => file.program));
      asked(answers, (asking) => {
        coreCheckResult(asking, index, request);
        coreFacts(asking, index, request);
      });
      return answers.budget.counts.get("syntaxNodes") ?? 0;
    };
    const ordered = (): number =>
      reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, run),
          )
        : run();
    const { result: nodes, records } = withNameRecords(() =>
      unshared ? withoutSharing(ordered) : ordered(),
    );
    return {
      units: records.units,
      counts: new Map<WorkCounter, number>([
        ["syntaxNodes", nodes],
        ["checks", records.checks],
      ]),
    };
  };
  const stack = new Set(["diamonds", "diamonds-guarded", "diamonds-shared"]);
  const families = [
    ...LAYER_FAMILIES.filter((family) => stack.has(family.name)),
    ...SEARCH_FAMILIES.filter(
      (family) => family.name !== "listing-chain-shown" && family.name !== "projected-feedback",
    ),
  ];
  for (const unshared of [false, true]) {
    const measure = (at: Sized, reversed: boolean): Measured => {
      const { units, counts } = searched(at, reversed, unshared);
      return { total: units, counts };
    };
    assert.deepEqual(steepCounters(families, unshared, measure, [16, 32]), []);
  }
  const chain = SEARCH_FAMILIES.find((family) => family.name === "listing-chain-shown")!;
  const held = (k: number): number => (k * (k + 1)) / 2 + 2 * k;
  for (const unshared of [false, true])
    for (const reversed of [false, true]) {
      const [small, large] = [16, 32].map(
        (k) => searched(sized(chain, k), reversed, unshared).units / held(k),
      );
      assert.ok(
        large! <= small!,
        `the listing chain shown, reversed ${reversed}, unshared ${unshared}: ${small} → ${large}`,
      );
    }
  const feedback = SEARCH_FAMILIES.find((family) => family.name === "projected-feedback")!;
  for (const k of [8, 16])
    for (const unshared of [false, true])
      for (const reversed of [false, true]) {
        const at = sized(feedback, k);
        const [effective, flat] = [
          searched(at, reversed, unshared).units,
          withFlatListings(() => searched(at, reversed, unshared).units),
        ];
        assert.ok(
          effective <= flat,
          `the projected feedback at ${k}, reversed ${reversed}, unshared ${unshared}: ${effective} > ${flat}`,
        );
      }
});

/**
 * #1167's shapes, each asking one question per read of one place, read k times: an object replaced k times, once
 * conditionally by one that lacks `n`, then `room.n` read k times, each warning's `missing` word asking whether the
 * object lacking `n` is one of `room`'s own stores; and an unwritten parameter's property read k times in a function
 * called k times, a valid script, each read asking for the parameter's default (ADR 1.5's null default). `own`: how many
 * of its warnings are its reads' own `missing`.
 */
const READ_AGAIN: readonly (WorkFamily & {
  readonly outcome: string;
  readonly own: (k: number) => number;
})[] = [
  {
    name: "missing-read-again",
    measures:
      "#1167: each warning's `missing` word asks whether the receiver's own store lacks `n`",
    outcome: "warning-runtime-check",
    own: (k) => k,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "let flag: boolean = hostValue",
          "let room = {n: 1}",
          ...Array.from({ length: k }, () => "room = {n: 1}"),
          "if flag { room = {other: 0} }",
          ...Array.from({ length: k }, () => "say room.n"),
          'say "DONE"',
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "parameter-read-again",
    measures:
      "#1167: each read of an unwritten parameter's property asks for the parameter's default",
    outcome: "valid",
    own: () => 0,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "function show(item) {",
          ...Array.from({ length: k }, () => "  say item.name"),
          "}",
          ...Array.from({ length: k }, (_, i) => `show({name: "n${i}"})`),
          "exit",
        ].join("\n"),
      },
    ],
  },
];

/**
 * Each read's question is answered by an index built once (`hasWriter`, `defaultOf`): searching `room`'s k stores again
 * per warning made k² `writerOf` visits, and searching the k calls' arguments for the default again per read k²
 * candidate visits, none of them charged. In either order the total, the indexes' steps and the `writerOf` visits,
 * counted by wrapping `writerOf` for these analyses only, grow with the program, so a search through `writerOf` is caught
 * whether or not it is charged. (X2's `rdWalk` carries its log factor on the first shape, at 2.35: k reads lift through
 * k stores of one key.)
 */
test("a question asked by every read of one place, read k times, takes work that grows with the program (#1167)", () => {
  const original = DefinitionIndex.prototype.writerOf;
  let visits = 0;
  DefinitionIndex.prototype.writerOf = function (this: DefinitionIndex, d) {
    visits += 1;
    return original.call(this, d);
  };
  const steep: string[] = [];
  try {
    for (const family of READ_AGAIN) {
      const sizes = [64, 128].map((k) => ({ k, at: sized(family, k) }));
      for (const reversed of [false, true]) {
        const [small, large] = sizes.map(({ k, at }) => {
          visits = 0;
          const answers = analysed(at, reversed);
          assert.equal(answers.outcome, family.outcome, at.name);
          const own = answers.diagnostics.filter(
            (found) =>
              found.class === "warning-runtime-check" &&
              "provenance" in found &&
              found.provenance.context === "missing" &&
              found.provenance.detail.direct,
          );
          assert.equal(own.length, family.own(k), `${at.name}: its reads' own warnings`);
          return { counts: answers.budget.counts, total: answers.budget.total, visits };
        });
        const scale =
          (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
        const doubling = (before: number, after: number): number =>
          (2 * (after / Math.max(1, before))) / scale;
        const name = `${family.name}${reversed ? " reversed" : ""}`;
        if (doubling(small!.total, large!.total) > DOUBLING)
          steep.push(`${name}: ${doubling(small!.total, large!.total).toFixed(3)}`);
        for (const [what, before, after] of [
          [
            "indexSteps",
            small!.counts.get("indexSteps") ?? 0,
            large!.counts.get("indexSteps") ?? 0,
          ],
          ["writerOf visits", small!.visits, large!.visits],
        ] as const)
          if (doubling(before, after) > COUNTER_DOUBLING)
            steep.push(`${name} ${what}: ${doubling(before, after).toFixed(3)}`);
      }
    }
  } finally {
    DefinitionIndex.prototype.writerOf = original;
  }
  assert.deepEqual(steep, []);
});

/**
 * A search the ledger does not see (round 13 B2, round 14 H1): over a literal of k records of distinct fields, the
 * analysis's `indexOf` searches inspect entries in proportion to k, never k² (each identity's first element is found in
 * one pass). The count wraps the built-in for this analysis only.
 */
test("a literal of 4,096 distinct records is searched in linear time", () => {
  const k = 4_096;
  const source = `${Array.from({ length: k }, (_, i) => `let a${i} = {f${i}: 1}`).join("\n")}\nlet xs = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const original = Array.prototype.indexOf;
  let inspected = 0;
  Array.prototype.indexOf = function (this: unknown[], ...args: Parameters<typeof original>) {
    if (this.length >= k) inspected += this.length;
    return original.apply(this, args);
  };
  try {
    assert.equal(analyseCore(request).outcome, "valid");
  } finally {
    Array.prototype.indexOf = original;
  }
  assert.ok(inspected <= 64 * k, `${inspected} entries inspected`);
});

/**
 * #1456: a place replaced k times by objects of distinct properties, each read after its store, reads a property from
 * the objects holding it (one `missing` for the others), never every object at every property, so the work grows with
 * the program in every mode: the issue's shape and each control whose objects are closed (two properties each, a
 * property every or every other object holds, open values, values of two provenances, each read before its store too,
 * reversed properties), its total and each counter of at least 200 units at 16 → 32 (2.51 to 2.77 per doubling on
 * `main`); and k places of two wide objects each read twice, whose levels answer them while an index would cost each
 * place every name (`WIDE_COPIES_READ_TWICE`). The series to k = 128 with and without the settled stop, the controls
 * the levels answer and the uncharged-work probe are the step's evidence, outside CI.
 */
test("a place replaced by objects of distinct properties takes work that grows with the program in every mode (#1456)", () => {
  const closed = [
    "plain",
    "two",
    "shared",
    "half",
    "open-value",
    "provenance",
    "before",
    "reverse",
  ];
  const families = [
    ...PROPERTY_STORE_FAMILIES.filter((family) =>
      closed.some((kind) => family.name === `property-stores-${kind}`),
    ),
    WIDE_COPIES_READ_TWICE,
  ];
  assert.equal(families.length, closed.length + 1);
  const steep: string[] = [];
  for (const family of families) {
    const [at16, at32] = [16, 32].map((k): Sized => {
      const request = coreRequest(family.program(k), ["hostValue", "hostOther"]);
      assert.ok(request !== null, `${family.name} at ${k}: its file parses and resolves`);
      return { name: `${family.name} at ${k}`, request };
    });
    for (const reversed of [false, true])
      for (const unshared of [false, true]) {
        const [small, large] = [at16!, at32!].map((at) => analysed(at, reversed, unshared).budget);
        const scale =
          (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
        const doubling = (before: number, after: number): number =>
          (2 * (after / Math.max(1, before))) / scale;
        const name = `${family.name}${reversed ? " reversed" : ""}${unshared ? " unshared" : ""}`;
        if (doubling(small!.total, large!.total) > DOUBLING)
          steep.push(`${name}: ${doubling(small!.total, large!.total).toFixed(3)}`);
        for (const [counter, after] of large!.counts)
          if (
            counter !== "syntaxNodes" &&
            after >= 200 &&
            doubling(small!.counts.get(counter) ?? 0, after) > COUNTER_DOUBLING
          )
            steep.push(
              `${name} ${counter}: ${doubling(small!.counts.get(counter) ?? 0, after).toFixed(3)}`,
            );
      }
  }
  assert.deepEqual(steep, []);
});
