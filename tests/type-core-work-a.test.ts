// The coarse core's work as a sampled regression oracle (`tests/helpers/type-core-work.ts`), one of three files that
// CI runs side by side.
import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, createFreshRuntimeSession } from "../src/index.js";
import { withMemberOracle, withoutChains } from "../src/type-inference/core/admission.js";
import { analyseCore, coreResult, type Answers } from "../src/type-inference/core/answers.js";
import { WorkLedger, type WorkCounter } from "../src/type-inference/core/budget.js";
import {
  asked,
  coreCheckResult,
  coreFacts,
  storeContracts,
} from "../src/type-inference/core/check-result/check-result.js";
import { SliceIndex } from "../src/type-inference/core/check-result/slice-index.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { DefinitionIndex } from "../src/type-inference/core/definitions.js";
import { isPlusValue, plusIndexVisits } from "../src/type-inference/core/plus-index.js";
import { withFlatListings, withNameRecords } from "../src/type-inference/core/property-names.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import {
  ADMISSION_FAMILIES,
  ADMISSION_SAME_SOURCES,
  COPY_CHAIN_FAMILIES,
  DIRECT_INGRESS_PROGRAMS,
  HOT_CANDIDATE_FAMILIES,
  LAYER_FAMILIES,
  MIXED_ADD_PRODUCTS,
  NARROWING_FAMILIES,
  ORACLE_PROGRAMS,
  PROPERTY_STORE_FAMILIES,
  READ_CHAIN_PRODUCTS,
  SEARCH_FAMILIES,
  VALUE_CLASS_SITES,
  VALUE_SHARING_PROGRAMS,
  W34_VARIANTS,
  W44_VARIANTS,
  W45_VARIANTS,
  WIDE_COPIES_READ_TWICE,
  WORK_FAMILIES,
  type WorkFamily,
} from "./helpers/type-core-families.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { askEveryRead, narrowingPass, narrowingPassIn } from "./helpers/type-core-narrowing.js";
import {
  DOUBLING,
  type Sized,
  sized,
  analysed,
  COUNTER_DOUBLING,
  type Measured,
  steepCounters,
  many,
} from "./helpers/type-core-work.js";

/** The charged work of a family's program at size k, and its syntax nodes. */
function work(family: WorkFamily, k: number): { total: number; nodes: number } {
  const answers = analysed(sized(family, k));
  return { total: answers.budget.total, nodes: answers.budget.counts.get("syntaxNodes") ?? 0 };
}

test("every sampled family's work grows with its program, not with a product of its dimensions", () => {
  const steep = WORK_FAMILIES.flatMap((family) => {
    const small = work(family, 64);
    const large = work(family, 128);
    // the work ratio per doubling of the source: 2 for linear work
    const doubling = (2 * (large.total / small.total)) / (large.nodes / small.nodes);
    return doubling > DOUBLING ? [`${family.name}: ${doubling.toFixed(3)}`] : [];
  });
  assert.deepEqual(steep, []);
});

/**
 * #1573 (Codex r2 on #1628): 33 choices of one class, the k-th list leaving out the choices k and 33 - k, whose ids sum
 * alike in every list: a list's other members are found by their sequence (`setNode`), one step per member, never by
 * comparing them with other lists' members, so the contract's steps the fifth list adds are those the ninth adds, in
 * either order (a search among the sets of equal sums added 30 steps more for each list before); and those steps, one
 * per other member, are charged to the analysis as a shared build, never to a demand (`WorkLedger.shared`): the
 * contract steps a further list adds in shared builds are its 30 other members.
 */
test("a list's other members are found in steps of their own, whatever lists came before (#1573)", () => {
  let shared = 0;
  const original = WorkLedger.prototype.charge;
  WorkLedger.prototype.charge = function (this: WorkLedger, counter: WorkCounter, units = 1) {
    if (this.sharing && this.stopped === null && counter === "invSteps") shared += units;
    original.call(this, counter, units);
  };
  const steps = (lists: number, reversed: boolean): readonly [number, number] => {
    const source = [
      many(
        33,
        (j) =>
          `let p${j} = askChoice {text: "0", value: hostValue.p0}, {text: "1", value: hostValue.p1}`,
      ),
      many(lists, (i) => {
        const left = Array.from({ length: 33 }, (_, j) => j).filter(
          (j) => j !== i + 1 && j !== 32 - i,
        );
        return `let xs${i} = [${left.map((j) => `p${j}`).join(", ")}]\nlet v${i}: integer = xs${i}[hostValue.i]`;
      }),
      "exit",
    ].join("\n");
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    const run = (): Answers => analyseCore(request);
    const answers = reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, run),
        )
      : run();
    return [answers.budget.counts.get("invSteps") ?? 0, shared] as const;
  };
  try {
    for (const reversed of [false, true]) {
      const [fifth, ninth] = [4, 8].map((before) => {
        shared = 0;
        const [steps0, shared0] = steps(before, reversed);
        shared = 0;
        const [steps1, shared1] = steps(before + 1, reversed);
        return [steps1 - steps0, shared1 - shared0] as const;
      });
      assert.deepEqual(ninth, fifth, `reversed: ${reversed}`);
      assert.equal(fifth![1], 30, `reversed: ${reversed}: the lookup's shared steps`);
    }
  } finally {
    WorkLedger.prototype.charge = original;
  }
});

/**
 * #1610: a decided object's property search in #1466's stack of diamonds of copies, which the stores' checks after the
 * analysis ask once per decided object (`Contracts.stored`), and the search's other askers inside the analysis
 * (`SEARCH_FAMILIES`): the searches' own units and counters (`withNameRecords`) over the analysis and the backend's
 * questions after it, at one small doubling in the four modes. A listing schedules a layer's effective sources only, so
 * the searches grow with the program, where `main`'s grew 4.2 to 6.8 times per doubling (416,963 units at k = 128
 * against the analysis's 226,049). The listing chain shown holds i + 2 names at its i-th copy (`g`, and below it `z` and
 * one per copy before it), so its searches' output is quadratic: its units per name held do not rise (TABLE r4.245's
 * reading). Codex r1's projected feedback, whose sources pump at their take-ups, charges no more than the flat listing
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
 * Stage 3b's families (TABLE §13.3, W27–W34 and the tested-copy variant): the narrowing index built and every read's
 * narrowing (N2 with N5) and route (N3) asked, as S10's second part's consumers will ask them, in source order and
 * reversed with the solver's worklist; its total and each counter under the standard gate. The series to k = 1,024 is
 * the step's evidence, outside CI.
 */
test("every stage 3b family's index and queries grow with the program in either order (§13.3)", () => {
  const measure = ({ name, request }: Sized, reversed: boolean): Measured => {
    const pass = narrowingPassIn(request, reversed);
    askEveryRead(pass, reversed);
    assert.ok(
      pass.program.work.total <= pass.program.work.allowance,
      `${name}: within the allowance`,
    );
    return { total: pass.program.work.total, counts: pass.program.work.counts() };
  };
  assert.deepEqual(steepCounters(NARROWING_FAMILIES, false, measure), []);
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

/** #1199's list with each object `around` the same way, the wide one at `at` among the k small ones. */
const nestedObjects = (
  k: number,
  around: (object: string) => string,
  at: number,
): readonly SourceFile[] => {
  const objects = Array.from({ length: k }, (_, i) => around(`{f${i}: 2}`));
  objects.splice(at, 0, around(`{${many(k, (i) => `f${i}: t`, ", ")}}`));
  return [
    {
      path: "main.tease",
      source: ["let t: integer = 1", `let a = [${objects.join(", ")}]`, "exit"].join("\n"),
    },
  ];
};

/**
 * k elements beside an object of k properties amid them, each property read through the list's first element (below
 * `box`, where the elements are objects holding their values there): #1304's composite fallbacks.
 */
const besideWide = (
  k: number,
  element: (index: number) => string,
  box?: string,
): readonly SourceFile[] => {
  const wide = `{${many(k, (i) => `f${i}: 1`, ", ")}}`;
  const elements = Array.from({ length: k }, (_, i) => element(i));
  elements.splice(k >> 1, 0, box === undefined ? wide : `{${box}: ${wide}}`);
  const at = box === undefined ? "xs[0]" : `xs[0].${box}`;
  return [
    {
      path: "main.tease",
      source: [
        `let xs = [${elements.join(", ")}]`,
        many(k, (i) => `let a${i}: integer = ${at}.f${i}`),
        "exit",
      ].join("\n"),
    },
  ];
};

/** #1313's list: k bindings of `value`, each read in a list beside an object of k properties amid them, at each. */
const named = (k: number, value: (index: number) => string): readonly SourceFile[] => {
  const elements = Array.from({ length: k }, (_, i) => `l${i}`);
  elements.splice(k >> 1, 0, `{${many(k, (i) => `f${i}: 1`, ", ")}}`);
  return [
    {
      path: "main.tease",
      source: [
        many(k, (i) => `let l${i} = ${value(i)}`),
        `let xs = [${elements.join(", ")}]`,
        many(k, (i) => `let a${i}: integer = xs[0].f${i}`),
        "exit",
      ].join("\n"),
    },
  ];
};

/**
 * Scripts that compile and whose work grew with a product of two of their dimensions, each with the counter that grew:
 * a written type of k repeated members copied k times, each copy's alias key spelling the whole type (#1255); a written
 * result of k repeated members read k times, each read merging every written member (#1256); a chain of k calls of one
 * untyped helper, each link discovering the helper's parameter again (#1257); a stored sum of k terms, admission's stop
 * index keeping each operand's chain of operations and evaluation key as a copy one longer than its operation's
 * (#1230); a ring of k copies through a k-element list, the list's index built again for each element and its read
 * re-run whole for each changed element (#1229); k properties read below a choice of k objects holding one value, or k
 * unchanged aliases or wrappers of it, each read walking every object (#1233); a list of a wide object and k small
 * ones, each small one's contract asked at every property of the wide one (#1199), also with all of them below one or
 * two properties they share or in one-element lists there, the wide one first, amid or last (Astra's review B1); a list
 * of k reads of host data, or of k loads defaulting to such a read or to one named copy of it, read at k properties,
 * each element read again at each (#1207); k such loads beside a wide object, each property's decision reading every
 * load before the object (Astra's review B2); k/4 loads, parses and reads of host data beside an object of k
 * properties, the list's touch trie walking the object again for each (#1307); k `load(…) otherwise {…}` beside a wide
 * object, directly or each in an object, each member read again at each property (#1304); k named bindings of
 * loads, of host reads or of alike objects beside one, each binding read again at each (#1313); and a run of k joined
 * lists ending in a list of another type, the class of each join naming the joins below it in full, also with each
 * prefix the property of an object of its own, each prefix's roles' writers listed though no peer compares them; and
 * two peers of one short class around a wide operand without writers or a deep one with a single writer, read in k
 * lists, each list's writer walk entering the operand again (#1357). A read of host data compiles with its runtime
 * check.
 */
const PRODUCTS: readonly (WorkFamily & {
  readonly counter: WorkCounter;
  /** A script that stops at run time, measured for its work alone, its outcome not pinned. */
  readonly stops?: true;
  readonly outcome?: Answers["outcome"];
})[] = [
  {
    name: "repeated-written-type-copies",
    measures: "#1255: each copy's alias key names its written type, spelled once",
    counter: "literalUnits",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `let root: (${many(k, () => "integer", " | ")})[] = [1]`,
          many(k, (i) => `let c${i} = root`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "repeated-written-result-reads",
    measures:
      "#1256: a written result stands for its distinct types, whatever its repeated members",
    counter: "mergeItems",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `function make: ${many(k, (i) => ["integer", "string", "null"][i % 3]!, " | ")} { return 1 }`,
          many(k, (i) => `let c${i} = make()\nsay c${i}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "helper-chain",
    measures: "#1257: the helper's parameter discovered once, never again for each link",
    counter: "invSteps",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "function identity(x) { return x }",
          "let c0 = 1",
          many(k, (i) => `let c${i + 1} = identity(c${i})`),
          `say c${k}`,
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "stored-sum",
    measures: "#1230: each operand's chain and key one link onto its operation's, kept once",
    counter: "literalUnits",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          many(k, (i) => `let a${i} = 1`),
          "let total = 0",
          `total = ${many(k, (i) => `a${i}`, " + ")}`,
          "say total",
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "list-ring",
    measures: "#1229: the list's index built once, a changed element re-running the reads above it",
    counter: "sccDeps",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          'let flag = askBoolean "flag"',
          "let i = 0",
          many(k, (i) => `let a${i} = 1`),
          "while flag {",
          `let xs = [${many(k, (i) => `a${i}`, ", ")}]`,
          many(k - 1, (i) => `a${i} = a${i + 1}`),
          `a${k - 1} = xs[i]`,
          "if flag { a0 = 2.5 }",
          "}",
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "choice-properties",
    measures: "#1233: a choice's objects holding one value read once for each property",
    counter: "invSteps",
    // (an option's value that is an object stops the choice at run time, TSR052)
    stops: true,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
          `let options = [${many(k, (i) => `{text: "${i}", value: payload}`, ", ")}]`,
          "let picked = askChoice options",
          many(k, (i) => `repeat picked.f${i} {}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "choice-aliases",
    measures: "#1233: k unchanged aliases of one value, one class, read once for each property",
    counter: "invSteps",
    stops: true,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
          many(k, (i) => `let p${i} = payload`),
          `let options = [${many(k, (i) => `{text: "${i}", value: p${i}}`, ", ")}]`,
          "let picked = askChoice options",
          many(k, (i) => `repeat picked.f${i} {}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "choice-wrapped",
    measures:
      "#1233: k lists each wrapping one value in two objects that select, one class, read once for each property",
    counter: "invSteps",
    stops: true,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
          `let options = [${many(k, (i) => `{text: "${i}", value: [{value: payload}, {value: payload}]}`, ", ")}]`,
          "let picked = askChoice options",
          many(k, (i) => `repeat picked.first.value.f${i} {}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "wide-object-beside-small-ones",
    measures: "#1199: each object of a list asked at its own properties only",
    counter: "mergeItems",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "let t: integer = 1",
          `let a = [{${many(k, (i) => `f${i}: t`, ", ")}}, ${many(k, (i) => `{f${i}: 2}`, ", ")}]`,
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "nested-wide-object-beside-small-ones",
    measures: "#1199: each object asked at its own properties only, below the property they share",
    counter: "mergeItems",
    program: (k) => nestedObjects(k, (object) => `{box: ${object}}`, 0),
  },
  {
    name: "twice-nested-wide-object-amid-small-ones",
    measures: "#1199: each object asked at its own properties only, two properties below the list",
    counter: "mergeItems",
    program: (k) => nestedObjects(k, (object) => `{box: {box: ${object}}}`, k >> 1),
  },
  {
    name: "listed-wide-object-after-small-ones",
    measures: "#1199: each object asked at its own properties only, through a list",
    counter: "mergeItems",
    program: (k) => nestedObjects(k, (object) => `{box: [${object}]}`, k),
  },
  {
    name: "host-reads-read-at-properties",
    measures: "#1207: the reads of one host global one class of a list's elements",
    counter: "checks",
    outcome: "warning-runtime-check",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `let wide = [${many(k, () => "hostValue", ", ")}]`,
          many(k, (i) => `let a${i}: integer = wide[0].f${i}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "host-loads-read-at-properties",
    measures: "#1207: one load of a class read at each property, naming every load's leaves",
    counter: "mergeItems",
    outcome: "warning-runtime-check",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `let wide = [${many(k, () => 'load("k", default: hostValue)', ", ")}]`,
          many(k, (i) => `let a${i}: integer = wide[0].f${i}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "named-default-loads-read-at-properties",
    measures: "#1207: one load of a class read at each property, its named default once",
    counter: "eventSteps",
    outcome: "warning-runtime-check",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "let raw = hostValue",
          `let wide = [${many(k, () => 'load("k", default: raw)', ", ")}]`,
          "let first = wide[0]",
          many(k, (i) => `let a${i}: integer = first.f${i}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "host-loads-beside-a-wide-object",
    measures: "#1207: each property decided by the loads' first of a class, then the object",
    counter: "mergeItems",
    outcome: "warning-runtime-check",
    program: (k) => {
      const elements = Array.from({ length: k }, () => 'load("k", default: hostValue)');
      elements.splice(k >> 1, 0, `{${many(k, (i) => `f${i}: 1`, ", ")}}`);
      return [
        {
          path: "main.tease",
          source: [
            `let xs = [${elements.join(", ")}]`,
            many(k, (i) => `let a${i}: integer = xs[0].f${i}`),
            "exit",
          ].join("\n"),
        },
      ];
    },
  },
  {
    name: "host-data-beside-a-wide-object",
    measures: "#1307: the touch trie walks only the nodes a merge asks, never the object again",
    counter: "indexSteps",
    outcome: "warning-runtime-check",
    program: (k) => {
      const kinds = [
        'load("k", default: hostValue)',
        'fromJson("{}", default: hostValue)',
        'load("k", default: raw)',
        "hostValue",
      ];
      const elements = Array.from({ length: k >> 2 }, (_, i) => kinds[i % kinds.length]!);
      elements.splice(k >> 3, 0, `{${many(k, (i) => `f${i}: 1`, ", ")}}`);
      return [
        {
          path: "main.tease",
          source: ["let raw = hostValue", `let xs = [${elements.join(", ")}]`, "exit"].join("\n"),
        },
      ];
    },
  },
  {
    name: "composite-fallbacks-beside-a-wide-object",
    measures: "#1304: one composite of a class read at each property, naming every member's leaves",
    counter: "mergeItems",
    outcome: "warning-runtime-check",
    program: (k) => besideWide(k, () => '(load("k", default: hostValue) otherwise {f0: 1})'),
  },
  {
    name: "boxed-composite-fallbacks-beside-a-wide-object",
    measures: "#1304: objects holding composites of one class one class of the list's elements",
    counter: "mergeItems",
    outcome: "warning-runtime-check",
    program: (k) =>
      besideWide(k, () => '{box: (load("k", default: hostValue) otherwise {f0: 1})}', "box"),
  },
  {
    name: "named-loads-beside-a-wide-object",
    measures: "#1313: bindings of loads of one default one class, one read at each property",
    counter: "mergeItems",
    outcome: "warning-runtime-check",
    program: (k) => named(k, () => 'load("k", default: hostValue)'),
  },
  {
    name: "named-host-reads-and-objects-beside-a-wide-object",
    measures: "#1313: bindings of host reads, and of alike objects, one class each",
    counter: "mergeItems",
    outcome: "warning-runtime-check",
    program: (k) => named(k, (i) => (i % 2 === 0 ? "hostValue" : "{f0: 1}")),
  },
  {
    name: "choice-own-objects",
    measures:
      "#1278: a choice's objects each holding its own property, which reads a value, read only where they may hold it",
    counter: "invSteps",
    stops: true,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "let n = 1",
          many(k, (i) => `let p${i} = {f${i}: n}`),
          `let options = [${many(k, (i) => `{text: "${i}", value: p${i}}`, ", ")}]`,
          "let picked = askChoice options",
          many(k, (i) => `repeat picked.f${i} {}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "choice-redefined-object",
    measures:
      "#1278: a choice's object read through a binding stored k objects, each added to its names once",
    counter: "invSteps",
    stops: true,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "let p = {f: 1}",
          many(k - 1, (i) => `p = {f: ${i + 2}}`),
          'let options = [{text: "a", value: p}, {text: "b", value: p}]',
          "let picked = askChoice options",
          "repeat picked.f {}",
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "choice-two-shared",
    measures:
      "#1291: a choice's objects over two values whose properties differ in type, one per class on the value side",
    counter: "invSteps",
    stops: true,
    program: (k) => [
      {
        path: "main.tease",
        source: [
          `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
          `let second = {${many(k, (i) => `f${i}: ${i % 2 ? "1" : "2.5"}`, ", ")}}`,
          `let options = [${many(k, (i) => `{text: "${i}", value: ${i % 2 ? "second" : "payload"}}`, ", ")}]`,
          "let picked = askChoice options",
          many(k, (i) => `repeat picked.f${i} {}`),
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "join-run-ending-in-another-type",
    measures: "#1357: each join's class naming its operands' by their short names",
    counter: "literalUnits",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          "let xs: (integer | string)[] = [0]",
          `let s = xs + ${many(k, (i) => `[${i + 1}]`, " + ")} + ["x"]`,
          "say s.length",
          "exit",
        ].join("\n"),
      },
    ],
  },
  {
    name: "join-prefixes-each-in-an-object",
    measures: "#1357: a member alone in its class read without its roles' writers",
    counter: "literalUnits",
    program: (k) => {
      let joined = "xs";
      for (let i = 0; i < k; i += 1) joined = `({n: ${joined} + [${i}]}).n`;
      return [
        {
          path: "main.tease",
          source: [
            "let xs: (integer | string)[] = [0]",
            `let s = ${joined} + ["x"]`,
            "say s.length",
            "exit",
          ].join("\n"),
        },
      ];
    },
  },
  {
    name: "peers-over-operands-without-writers",
    measures:
      "#1357: a peer's writer walk entering only the parts that hold a role (Codex r1 on #1417)",
    counter: "invSteps",
    outcome: "warning-runtime-check",
    program: (k) => {
      const wide = `{v: max(${many(k, () => "f()", ", ")})}`;
      const deep = `{v: ${"max(".repeat(k)}x${", f())".repeat(k)}}`;
      return [
        {
          path: "main.tease",
          source: [
            "function f { return 1 }",
            "let x = 1",
            `let wideLeft = ${wide}`,
            `let wideRight = ${wide}`,
            `let deepLeft = ${deep}`,
            `let deepRight = ${deep}`,
            many(
              k,
              (i) =>
                `let xs${i} = [wideLeft, wideRight]\nlet ys${i} = [deepLeft, deepRight]\n` +
                `let n${i}: integer = xs${i}[0].v + ys${i}[0].v`,
            ),
            "exit",
          ].join("\n"),
        },
      ];
    },
  },
];

/**
 * Each family's total and its counter in either order under the standard gates; only the named counter, since the
 * helper's parameter's k definitions are sorted and lifted (the TABLE's `n log n` structures), which measure 2.37 here,
 * as they do with a written parameter, and the ring's changed elements each re-run the depth of the list's tree of
 * demands, one more here (its members' signatures 2.41, and 2.33 at k = 128 → 256).
 */
test("each product a repair removed grows with the program in either order (#1199, #1207, #1229, #1230, #1233, #1255–#1257, #1278, #1291, #1304, #1307, #1313, #1357)", () => {
  const steep: string[] = [];
  for (const family of PRODUCTS) {
    const [at64, at128] = [sized(family, 64), sized(family, 128)];
    for (const reversed of [false, true]) {
      const [small, large] = [at64, at128].map((at) => {
        const answers = analysed(at, reversed);
        if (family.stops !== true)
          assert.equal(answers.outcome, family.outcome ?? "valid", at.name);
        return answers.budget;
      });
      const scale =
        (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      const name = `${family.name}${reversed ? " reversed" : ""}`;
      if (doubling(small!.total, large!.total) > DOUBLING)
        steep.push(`${name}: ${doubling(small!.total, large!.total).toFixed(3)}`);
      const [before, after] = [small!, large!].map(
        (budget) => budget.counts.get(family.counter) ?? 0,
      );
      if (doubling(before!, after!) > COUNTER_DOUBLING)
        steep.push(`${name} ${family.counter}: ${doubling(before!, after!).toFixed(3)}`);
    }
  }
  assert.deepEqual(steep, []);
});

/**
 * The holder cache's witness: k variables holding `q` joined in another run, then a run of k variables lacking it and
 * one holding it with k properties below it, asked at each of them, so each question looks for the bindings holding
 * `q` among many.
 */
const underOne = (k: number): string =>
  [
    many(k, (i) => `let h${i} = [{q: 1, t${i}: 1}]`),
    `let ys = ${many(k, (i) => `h${i}`, " + ")}`,
    "say ys[0].t0\nsay ys[1].t1\nsay ys[2].t2",
    many(k, (i) => `let l${i} = [{u${i}: 1}]`),
    `let c = [{q: {${many(k, (i) => `x${i}: 1`, ", ")}}}]`,
    `let xs = ${many(k, (i) => `l${i}`, " + ")} + c`,
    "say xs[0].u0\nsay xs[1].u1",
    many(k, (i) => `say xs[${k}].q.x${i}`),
    "exit",
  ].join("\n");

/** Codex r2 on #1562: k variables of one property each, joined once each, each element read at its own property. */
const sparse = (k: number): string =>
  `${many(k, (i) => `let o${i} = [{p${i}: 1}]`)}\nlet xs = ${many(k, (i) => `o${i}`, " + ")}\n${many(k, (i) => `say xs[${i}].p${i}`)}\nexit`;

/**
 * #1384: k joins of lists of objects of distinct properties, a variable of objects read beside each operand, along the
 * left operands and each join in the next one's right, and both with one property throughout: a run's terms are indexed
 * by the properties they hold once its root is asked at a third (`plusRun`), so the value side, the contract side and
 * admission's decider read each property's holders and the ranges between them, never every join below (3.1 to 3.3 at
 * 16 → 32 before, its counters near 4; 3.7 at 64 → 128). And a variable of k properties joined k times, alone and
 * beside k objects of distinct properties (Codex r1 on #1562: its properties posted at every read measured 3.9 at
 * 256 → 512): its reads are one binding's, its properties never posted per read; and k variables of one property each
 * joined once, each element read at its own (Codex r2: every query visited every binding, k(2k − 4) uncharged visits):
 * a query visits the bindings holding its property and one more (the holder bound). One doubling in the four modes; the
 * series to k = 512 is the evidence, outside CI. Each source at the smaller size compiles and runs, saying its list's length
 * or its first element's three properties.
 */
test("a run of joins read beside a variable of objects grows with the program in the four modes (#1384)", () => {
  const joins = (k: number, term: (i: number) => string, o = "{q: 1}"): string =>
    `let o = [${o}]\nlet xs = o + ${many(k, (i) => `${term(i)} + o`, " + ")}\nsay xs.length\nexit`;
  const nested = (k: number, term: (i: number) => string, last: string): string =>
    `let o = [{q: 1}]\nlet xs = ${Array.from({ length: k }).reduce<string>((e, _, i) => `${term(i)} + (o + (${e}))`, last)}\nsay xs.length\nexit`;
  const wide = (k: number): string => `{${many(k, (i) => `p${i}: 1`, ", ")}}`;
  const family = (
    name: string,
    sizes: readonly [number, number],
    said: (k: number) => readonly string[],
    source: (k: number) => string,
  ) => ({
    name: `plus-run-${name}`,
    measures: "#1384: a run's terms by the properties they hold",
    program: (k: number) => [{ path: "main.tease", source: source(k) }],
    sizes,
    said,
  });
  const runs = [
    family(
      "left",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => joins(k, (i) => `[{p${i}: 1}]`),
    ),
    family(
      "right",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => nested(k, (i) => `[{p${i}: 1}]`, "[{lastValue: 0}]"),
    ),
    family(
      "left-one-name",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => joins(k, () => "[{q: 1}]"),
    ),
    family(
      "right-one-name",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => nested(k, () => "[{q: 1}]", "[{q: 0}]"),
    ),
    family(
      "wide-reuse",
      [64, 128],
      () => ["1", "1", "1"],
      (k) =>
        `let o = [${wide(k)}]\nlet xs = ${many(k, () => "o", " + ")}\nsay xs.first.p0\nsay xs.first.p1\nsay xs.first.p2\nexit`,
    ),
    family(
      "wide-beside",
      [64, 128],
      (k) => [String(2 * k + 1)],
      (k) => joins(k, (i) => `[{x${i}: 1}]`, wide(k)),
    ),
    family("sparse-bindings", [64, 128], (k) => Array.from({ length: k }, () => "1"), sparse),
  ];
  for (const { name, program, sizes, said } of runs) {
    const compiled = compileProject(program(sizes[0]));
    assert.ok(compiled.plan !== null, `${name} at ${sizes[0]} compiles`);
    const events = createFreshRuntimeSession(compiled.plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).run().events;
    assert.deepEqual(
      events.flatMap((event) =>
        event.kind === "say" || event.kind === "runtimeFailure"
          ? [event.kind === "say" ? event.text : event.code]
          : [],
      ),
      said(sizes[0]),
      `${name} at ${sizes[0]} runs`,
    );
  }
  assert.deepEqual(
    runs.flatMap((run) => [
      ...steepCounters([run], false, undefined, run.sizes),
      ...steepCounters([run], true, undefined, run.sizes),
    ]),
    [],
  );
});

/**
 * The holder bound (#1384, Codex r2 on #1562): an indexed run's query takes one step per literal and per binding holding
 * its property and per item of their answers and one more in each order of its bindings, each charged before it runs. The index counts its query
 * steps (`plusIndexVisits`): on k variables of one property each, joined once and each read at its own, the steps stay
 * under the charged `indexSteps` and grow with the program in either order, the sharing on and off; visiting every
 * binding per query made 32,256 steps at k = 128, none charged. A run asked at k paths below one property that k
 * bindings elsewhere hold looks for its holders once, not at every question.
 */
test("an indexed run's queries take charged steps bounded by the bindings holding their properties (#1384)", () => {
  const steep: string[] = [];
  // (the bindings holding `q` found once per run and property: asked again they took k² steps; in the source order,
  // where the run's root is indexed before its questions below `q`)
  for (const [shape, sizes, modes] of [
    [
      sparse,
      [64, 128],
      [
        [false, false],
        [true, true],
      ],
    ],
    [underOne, [32, 64], [[false, false]]],
  ] as const)
    for (const [reversed, unshared] of modes) {
      const [small, large] = sizes.map((k) => {
        const before = plusIndexVisits();
        const program = () => [{ path: "main.tease", source: shape(k) }];
        const { budget } = analysed(
          sized({ name: shape.name, measures: "", program }, k),
          reversed,
          unshared,
        );
        return {
          visits: plusIndexVisits() - before,
          charged: budget.counts.get("indexSteps") ?? 0,
          nodes: budget.counts.get("syntaxNodes") ?? 0,
        };
      });
      const name = `${shape.name}, ${reversed ? "reversed" : "source order"}${unshared ? ", unshared" : ""}`;
      assert.ok(large!.visits > 0, `${name}: the run is indexed`);
      assert.ok(
        large!.visits <= large!.charged,
        `${name}: ${large!.visits} steps, ${large!.charged} charged`,
      );
      const doubling = (2 * (large!.visits / small!.visits)) / (large!.nodes / small!.nodes);
      if (doubling > DOUBLING) steep.push(`${name}: ${doubling.toFixed(3)}`);
    }
  assert.deepEqual(steep, []);
});

/**
 * The holder bound's whole query (#1384, Codex r3 on #1562): an indexed root asked at a new path below a property whose
 * holders its run already found charges `indexSteps` for exactly the steps it counts, on both sides: with no term holding
 * the property the same few at every width (a range's earliest object is its first literal's, not a tree's height), and
 * with every term holding it one per term and per item, linear (its holders kept in first-read order, never sorted per
 * query: k variables read in another order than the pass found them sorted them at every query, k log k uncounted).
 */
test("an indexed run's warm query charges its counted steps alone, a few without holders, linear in them (#1384)", () => {
  const shuffled = (k: number): string =>
    Array.from({ length: k }, (_, i) => `b${(i * 37 + 11) % k}`).join(" + ");
  const shapes: readonly (readonly [string, string, readonly number[], (k: number) => string])[] = [
    [
      "no holder",
      "c",
      [16, 64, 256],
      (k) =>
        `${many(k, (i) => `let o${i} = [{p${i}: 1}]`)}\nlet xs = ${many(k, (i) => (i % 2 ? `o${i}` : `[{s${i}: 1}]`), " + ")}\nsay xs.length\nexit`,
    ],
    [
      "holding variables",
      "q",
      [16, 64],
      (k) =>
        `${many(k, (i) => `let b${i} = [{q: {p${i}: 1}}]`)}\nlet ys = ${many(k, (i) => `b${i}`, " + ")}\nlet xs = ${shuffled(k)}\nsay ys.length\nsay xs.length\nexit`,
    ],
    [
      "holding literals",
      "q",
      [16, 64],
      (k) => `let xs = ${many(k, (i) => `[{q: {p${i}: 1}}]`, " + ")}\nsay xs.length\nexit`,
    ],
  ];
  const failing: string[] = [];
  for (const [name, step, sizes, source] of shapes) {
    const steps = sizes.map((k) => {
      const request = coreRequest([{ path: "main.tease", source: source(k) }]);
      assert.ok(request !== null, `${name} at ${k}: its files parse and resolve`);
      const pass = narrowingPass(request);
      const { program } = pass;
      const ask = (value: PlaceId, path: readonly string[], exact: boolean) => {
        const c = program.opOf.get(value)!;
        const node = c.kind === "operation" ? program.exprAt(c.site) : null;
        pass.solver.run(
          exact
            ? pass.values.valueItems(value, node, path)
            : pass.contract.contractOfValueAt(value, path),
        );
      };
      const roots = [...program.opOf.values()].flatMap((c) =>
        c.kind === "operation" &&
        isPlusValue(pass, c.result) &&
        !(program.consumersOf.get(c.result) ?? []).some(
          (use) => use.kind === "operand" && isPlusValue(pass, use.operation.result),
        )
          ? [c.result]
          : [],
      );
      // (each root indexed and its holders of the property found; the last asked at a new path below it)
      for (const exact of [true, false])
        for (const root of roots)
          for (const first of ["t", "u", "v", step]) ask(root, ["element", first, "warm"], exact);
      return [true, false].map((exact) => {
        const charged = () => program.work.counts().get("indexSteps") ?? 0;
        const [visits, units] = [plusIndexVisits(), charged()];
        ask(roots.at(-1)!, ["element", step, "fresh"], exact);
        const counted = plusIndexVisits() - visits;
        if (counted === 0 || charged() - units !== counted)
          failing.push(
            `${name} at ${k}, ${exact ? "value" : "contract"}: ${counted} steps, ${charged() - units} charged`,
          );
        return counted;
      });
    });
    for (const side of [0, 1]) {
      const [small, ...larger] = steps.map((counted) => counted[side]!);
      for (const [index, counted] of larger.entries())
        if (
          name === "no holder"
            ? counted !== small
            : counted > (small! * sizes[index + 1]!) / sizes[0]!
        )
          failing.push(
            `${name} at ${sizes[index + 1]}, side ${side}: ${counted} steps, ${small} at ${sizes[0]}`,
          );
    }
  }
  assert.deepEqual(failing, []);
});

/**
 * #1397: k/8 choices of k host reads each, read in k lists, each list the choices in a shuffled order of its own
 * (#1359's B1 family, `leaf-permuted` in `tests/families/joins/1359-peer-set-orders.mjs`). Each list's item unites its
 * elements in its own order, a node of its own, and C1's site walked each such node's leaves though no list's store
 * lands any or brings an ingress at a siting: k orders × k²/8 leaves. With the sharing off the total and each counter
 * grow with the program in either order; with it on only `checks` is gated, since the sharing's union nodes and the
 * contract's class parts grow faster than the program in the fixed order too (#1573). At 20 → 40, the smallest pair
 * that shows the walk (18 → 36 does not), the walk grew `checks` ×2.97 per doubling in every mode. The series to
 * k = 128, the four modes, the subsets and the other orders are the step's evidence, outside CI; a store that reads
 * the leaves it walks is #1579.
 */
test("lists of one set of choices in many orders site their host data without walking each order (#1397)", () => {
  const shuffled = (m: number, seed: number): number[] => {
    const order = Array.from({ length: m }, (_, j) => j);
    let state = (seed * 2654435761 + 12345) >>> 0;
    for (let j = m - 1; j > 0; j -= 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      const at = state % (j + 1);
      [order[j], order[at]] = [order[at]!, order[j]!];
    }
    return order;
  };
  const family: WorkFamily = {
    name: "choice lists in shuffled orders",
    measures:
      "k lists of k/8 choices of k host reads, each list in its own order: C1's site per list",
    program: (k) => {
      const m = Math.max(2, Math.floor(k / 8));
      const rows = (n: number, row: (i: number) => string, separator = "\n") =>
        Array.from({ length: n }, (_, i) => row(i)).join(separator);
      const choice = `askChoice ${rows(k, (r) => `{text: "${r}", value: hostValue.p${r}}`, ", ")}`;
      const source = [
        rows(m, (j) => `let p${j} = ${choice}`),
        rows(k, (i) => {
          const list = shuffled(m, i).map((j) => `p${j}`);
          return `let xs${i} = [${list.join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`;
        }),
        "exit",
      ].join("\n");
      return [{ path: "main.tease", source }];
    },
  };
  const steep = steepCounters([family], true, undefined, [20, 40]);
  for (const reversed of [false, true]) {
    const [small, large] = [20, 40].map((k) => analysed(sized(family, k), reversed).budget.counts);
    const scale = large!.get("syntaxNodes")! / small!.get("syntaxNodes")!;
    const doubling = (2 * (large!.get("checks")! / small!.get("checks")!)) / scale;
    if (doubling > COUNTER_DOUBLING)
      steep.push(`${family.name}${reversed ? " reversed" : ""} checks: ${doubling.toFixed(3)}`);
  }
  assert.deepEqual(steep, []);
});

/**
 * The value side's gated known limits (TABLE r4.83 (2), (5)): read chains through nested literals, each link's key one
 * step longer (`READ_CHAIN_PRODUCTS`), and adds of several sources into one list in turn (`MIXED_ADD_PRODUCTS`); a
 * regression check on the 64 → 128 step only, each held to its measured doubling in either order. On CI (GitHub
 * Actions sets `CI`) the mixed adds run in the source order only: their orders differ by at most 0.0001 (TABLE r4.85).
 */
test("read chains and mixed-source adds grow no faster than measured", () => {
  const steep: string[] = [];
  const mixedOrders = process.env["CI"] === "true" ? [false] : [false, true];
  for (const family of [...READ_CHAIN_PRODUCTS, ...MIXED_ADD_PRODUCTS]) {
    const [at64, at128] = [sized(family, 64), sized(family, 128)];
    for (const reversed of MIXED_ADD_PRODUCTS.includes(family) ? mixedOrders : [false, true]) {
      const small = analysed(at64, reversed).budget;
      const large = analysed(at128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const doubling = (2 * (large.total / small.total)) / scale;
      if (doubling > family.measured)
        steep.push(`${family.name}${reversed ? " reversed" : ""}: ${doubling.toFixed(3)}`);
    }
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
 * A value's identity names its inputs by their own identities (TABLE §8, round 12 B4): a chain of 32 `otherwise`s, each
 * of the one before twice, is a source of 32 lines, never an identity of 2^32 characters.
 */
test("a chain of carriers over shared inputs is identified in linear space", () => {
  const levels = Array.from(
    { length: 32 },
    (_, index) => `let a${index + 1} = a${index} otherwise a${index}`,
  );
  const source = `let a0 = {n: 1}\n${levels.join("\n")}\nlet xs = [a32, a32]\nlet n: integer = xs[0].n\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  assert.equal(analyseCore(request).outcome, "valid");
});

/** A program's published record in one order, as the oracle's analysis gives it, which the chain control reuses. */
const resolvedRecords = new Map<string, string>();

const recordKey = (files: readonly SourceFile[], reversed: boolean): string =>
  `${reversed}|${JSON.stringify(files)}`;

function publishedRecord(answers: Answers, files: readonly SourceFile[]): string {
  return JSON.stringify(
    coreRecord(
      coreResult(answers),
      files.map((file) => file.path),
    ),
  );
}

/**
 * S6-CARRIERS §4.1's member-answer oracle (the orchestrator's condition (a)), as a generated family: at every decided
 * path, each alias member's own answer equals its class representative's, each with its own guard applied, its items
 * compared whole (tags, certainty, reasons, context words, writers, leaves, marks). It runs over every work family at
 * small sizes, Astra's two M1 witnesses (a conditional store below the copied path before and between the copies) and
 * every alias form beside the events its class answers through, in both orders, and over the fixture's records.
 */
test("every alias member answers as its class does at every decided path, in both orders (§4.1, condition (a))", (t) => {
  const differences: string[] = [];
  let compared = 0;
  const report = (difference: string | null): void => {
    compared += 1;
    if (difference !== null) differences.push(difference);
  };
  const run = (
    files: readonly SourceFile[],
    request: CoreAnalysisRequest,
    reversed: boolean,
  ): void => {
    const answers = withMemberOracle(report, () =>
      reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
          )
        : analyseCore(request),
    );
    resolvedRecords.set(recordKey(files, reversed), publishedRecord(answers, files));
  };

  // each program prepared once, then analysed in each order
  const inBoth = (name: string, files: readonly SourceFile[]): void => {
    const request = coreRequest(files);
    assert.ok(request !== null, `${name}: its files parse and resolve`);
    for (const reversed of [false, true]) run(files, request, reversed);
  };
  for (const family of [
    ...WORK_FAMILIES,
    ...W34_VARIANTS,
    ...W44_VARIANTS,
    ...W45_VARIANTS,
    ...ADMISSION_FAMILIES,
    ...HOT_CANDIDATE_FAMILIES,
    ...ADMISSION_SAME_SOURCES,
    ...VALUE_CLASS_SITES,
  ])
    for (const k of [2, 3, 5]) inBoth(`${family.name} at ${k}`, family.program(k));
  for (const { name, files } of [
    ...ORACLE_PROGRAMS,
    ...VALUE_SHARING_PROGRAMS,
    ...DIRECT_INGRESS_PROGRAMS,
  ])
    inBoth(name, files);
  for (const record of readFixture()) {
    const request = coreRequest(record.files);
    if (request !== null) run(record.files, request, false);
  }
  t.diagnostic(`${compared} member answers compared with their classes'`);
  assert.deepEqual(differences, []);
  assert.ok(compared > 1_000, `${compared} member answers compared`);
});

/**
 * S6-CARRIERS §4.1's chains: a member read through a chain of copies keeps its own links' writers, which the oracle
 * sets aside, so this guards what they are for: every published record, its diagnostics' F28 writers included, is the
 * same with every chain resolved and with none (`withoutChains`), over every work family at small sizes in both orders
 * and over the fixture's records. The resolved side is the oracle's analysis of the same program where it ran.
 */
test("resolving chains of copies changes no published record or writer, in both orders (§4.1)", () => {
  const differing: string[] = [];
  const compare = (
    name: string,
    files: readonly SourceFile[],
    request: CoreAnalysisRequest,
    reversed: boolean,
  ): void => {
    const run = (): string => {
      const analysed = (): Answers => analyseCore(request);
      const answers = reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, analysed),
          )
        : analysed();
      return publishedRecord(answers, files);
    };
    const resolved = resolvedRecords.get(recordKey(files, reversed)) ?? run();
    if (resolved !== withoutChains(run)) differing.push(`${name}${reversed ? " reversed" : ""}`);
  };
  // each program prepared once, then compared in each order
  for (const family of [
    ...WORK_FAMILIES,
    ...W34_VARIANTS,
    ...W44_VARIANTS,
    ...W45_VARIANTS,
    ...ADMISSION_FAMILIES,
    ...ADMISSION_SAME_SOURCES,
  ])
    for (const k of [2, 3, 5]) {
      const name = `${family.name} at ${k}`;
      const files = family.program(k);
      const request = coreRequest(files);
      assert.ok(request !== null, `${name}: its files parse and resolve`);
      for (const reversed of [false, true]) compare(name, files, request, reversed);
    }
  for (const record of readFixture()) {
    const request = coreRequest(record.files);
    if (request !== null) compare(record.name, record.files, request, false);
  }
  assert.deepEqual(differing, []);
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

/**
 * The work the store checks charge after a family's analysis (`storeContracts`), every unit by counter (apart work
 * too, as #1605 measured it) with the analysis's syntax nodes, in a mode; and the analysis's charged total.
 */
function storeWork(
  { name, request }: Sized,
  reversed: boolean,
  unshared: boolean,
): Measured & { readonly analysis: number } {
  const counts = new Map<WorkCounter, number>();
  let total = 0;
  let analysis = 0;
  const { charge } = WorkLedger.prototype;
  const run = (): void => {
    const answers = analyseCore(request);
    assert.equal(answers.budget.exhausted, null, `${name}: within the allowance`);
    analysis = answers.budget.total;
    counts.set("syntaxNodes", answers.budget.counts.get("syntaxNodes") ?? 0);
    WorkLedger.prototype.charge = function (this: WorkLedger, counter, units = 1) {
      if (counter !== "syntaxNodes") counts.set(counter, (counts.get(counter) ?? 0) + units);
      total += units;
      charge.call(this, counter, units);
    };
    try {
      assert.deepEqual(
        [...storeContracts(answers, request).values()].map((result) => result.state),
        ["complete"],
        name,
      );
    } finally {
      WorkLedger.prototype.charge = charge;
    }
  };
  const ordered = (): void =>
    reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, run),
        )
      : run();
  if (unshared) withoutSharing(ordered);
  else ordered();
  return { total, counts, analysis };
}

/**
 * #1605: a value copied through a chain of wrappers, a store at its long key or the key's element checked: the check's
 * contract at each level of the stored value (its element, its element's element) stands one step below its parent's
 * position (`positions.ts`), never every wrapper's whole path again, so the work the store checks charge after the
 * analysis, in total and by each counter of at least 200 units, grows with the chain at k = 16 → 32 in every mode
 * (3.38 to 3.76 per doubling on `3d052bf43`). The series to k = 128 and the analysis beside a long key without copies
 * are the PR's evidence, outside CI.
 */
test("a long copied key's store check grows with its copy chain in every mode (#1605)", () => {
  const measure =
    (unshared: boolean) =>
    (at: Sized, reversed: boolean): Measured =>
      storeWork(at, reversed, unshared);
  assert.deepEqual(
    [
      ...steepCounters(COPY_CHAIN_FAMILIES, false, measure(false), [16, 32]),
      ...steepCounters(COPY_CHAIN_FAMILIES, true, measure(true), [16, 32]),
    ],
    [],
  );
});

/**
 * #1605: what a long copied key's store check charges at k = 16 in each mode (source order shared and not, then
 * reversed), with its analysis's charged total: a regression oracle of this construction only, so a level's work
 * charged nowhere shows. Since #1526 phase B the analysis captures the store's contract before its walk, so most of the
 * check's work is charged there: on `c0ab92ced`, before the capture, the analyses charged 7,843 / 7,003, 8,971 / 8,098
 * and 10,226 / 9,225 (10,228 reversed) and the checks after them 451 / 380, 274 / 236 and 518 / 429. The store at the
 * element (`b.q….f[0] = …`) is outside the candidate slice's syntax, so the analysis captures nothing there and its work
 * is main's (`slice-syntax.ts`). On `3d052bf43`
 * the store at the long key's check charged 3,266 and 2,197 units; the store at its element's analysis asked its
 * element levels through every wrapper (10,329 and 8,632), its check 1,101 and 889; the store at a property of its
 * element's 12,448 and 10,225, its check 2,353 and 1,880. Since #1221 the analyses charge the event searches by
 * comparison (8,257 / 7,346, 8,971 / 8,098 and 10,707 / 9,617 (10,709 reversed) before), and since #1251 they make no
 * narrowing index for these programs without a test (8,257 / 7,344, 8,963 / 8,088 and 10,690 / 9,598 before), and since
 * #1822 a read signature's prefixes come from its charged trie walk (`rdWalk`: 7,986 / 7,073, 8,689 / 7,814 and
 * 10,411 / 9,319 (10,413 reversed) before).
 */
test("a long copied key's store check charges its positions' work, in every mode (#1605)", () => {
  const measured = COPY_CHAIN_FAMILIES.map((family) => {
    const at = sized(family, 16);
    return [false, true].flatMap((reversed) =>
      [false, true].map((unshared) => {
        const { total, analysis } = storeWork(at, reversed, unshared);
        return [analysis, total];
      }),
    );
  });
  assert.deepEqual(measured, [
    [
      [7995, 60],
      [7081, 60],
      [7995, 60],
      [7081, 60],
    ],
    [
      [8698, 274],
      [7822, 236],
      [8698, 274],
      [7822, 236],
    ],
    [
      [10420, 64],
      [9327, 64],
      [10422, 64],
      [9327, 64],
    ],
  ]);
});
