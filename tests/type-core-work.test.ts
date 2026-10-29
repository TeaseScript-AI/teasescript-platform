import assert from "node:assert/strict";
import test from "node:test";

import { withMemberOracle, withoutChains } from "../src/type-inference/core/admission.js";
import { analyseCore, coreResult, type Answers } from "../src/type-inference/core/answers.js";
import type { WorkCounter } from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { writtenTypeSteps } from "../src/type-inference/core/contract.js";
import { DefinitionIndex } from "../src/type-inference/core/definitions.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import {
  ADMISSION_FAMILIES,
  ADMISSION_INGRESS_PRESETS,
  ADMISSION_KNOWN_PRODUCTS,
  ADMISSION_SAME_SOURCES,
  COPY_RING_FAMILIES,
  DIRECT_INGRESS_PROGRAMS,
  HOT_CANDIDATE_FAMILIES,
  INHERITED_FIELD_FAMILIES,
  JOIN_REACH_FAMILIES,
  MIXED_ADD_PRODUCTS,
  NARROWING_FAMILIES,
  ORACLE_PROGRAMS,
  READ_CHAIN_PRODUCTS,
  VALUE_CLASS_SITES,
  VALUE_SHARING_PROGRAMS,
  W34_KNOWN_PRODUCTS,
  W34_VARIANTS,
  W44_VARIANTS,
  W45_VARIANTS,
  WORK_FAMILIES,
  type WorkFamily,
} from "./helpers/type-core-families.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { askEveryRead, narrowingPassIn } from "./helpers/type-core-narrowing.js";

/**
 * The work of the coarse core (checkpoint 9, TABLE §8 and §10.1's W rows) as a sampled regression oracle: every
 * family's charged work at k = 128 against k = 64, per doubling of the programs' syntax nodes, since a family's source
 * need not double exactly. Linear work doubles; a structure bounded by a product of two program dimensions about
 * quadruples. The TABLE's `n log n` structures (a key's definitions sorted, its lifting table, its own events) give up
 * to 2.33 at these sizes where nothing else is charged: W26's k stores of one place in one block measure 2.12 here and
 * 2.08 at k = 1,024, while the products the reference model's calibration found measured 2.56 and more. Two sizes
 * calibrate on known products; they prove no bound: the full series to k = 1,024 is the step's evidence, outside CI.
 */
const DOUBLING = 2.15;

/** A family's program at size k, prepared once for each of its analyses. */
interface Sized {
  readonly name: string;
  readonly request: CoreAnalysisRequest;
}

function sized(family: WorkFamily, k: number): Sized {
  const name = `${family.name} at ${k}`;
  const request = coreRequest(family.program(k));
  assert.ok(request !== null, `${name}: its files parse and resolve`);
  return { name, request };
}

/**
 * A fresh analysis of a family's program, in the source order or with the consumers' and the solver's orders reversed,
 * with the sharing of answers on or off (`withoutSharing`).
 */
function analysed({ name, request }: Sized, reversed = false, unshared = false): Answers {
  const run = (): Answers =>
    reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
        )
      : analyseCore(request);
  const answers = unshared ? withoutSharing(run) : run();
  assert.equal(answers.budget.exhausted, null, `${name}: within the allowance`);
  return answers;
}

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
 * S3 §5, revision 14: an admission decision is a demand with the program's nodes' allowance, since a key's stores come
 * from every call site. W5's `shown` places, each a function's own, read a record that every chapter's call stores
 * (their callables' allowances it crossed 4.08 and 8.08 times, reversed): at k = 64 and 128 in either order no decision
 * stops, and the work stays linear.
 */
test("W5's decisions stop at no demand allowance, in either order, and its work stays linear", () => {
  const w5 = WORK_FAMILIES.find((family) => family.name === "W5")!;
  const [at64, at128] = [sized(w5, 64), sized(w5, 128)];
  for (const reversed of [false, true]) {
    const [small, large] = [analysed(at64, reversed).budget, analysed(at128, reversed).budget];
    for (const budget of [small, large])
      assert.deepEqual(
        budget.decisions.filter((d) => d.stopped),
        [],
        `reversed: ${reversed}`,
      );
    const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
    assert.ok((2 * (large.total / small.total)) / scale <= DOUBLING, `reversed: ${reversed}`);
  }
});

/**
 * W34 (TABLE §13.3, r4.33–r4.38), W44 and W45 (r4.46 (3)): every variant in the source order and with the consumers'
 * and the solver's orders reversed, its total and each counter of at least 200 units per doubling of the source. A counter is the raw count of
 * one structure's steps, so a copy walked per field or a mark set made per copy shows in its own counter where the
 * total would hide it; a counter may carry its structure's log factor (a sort, a table of jumps: 2.33 at these sizes
 * where nothing else is charged to it), a product of two dimensions measures 3 and more. The full series to k = 1,024
 * is the step's evidence, outside CI.
 */
const COUNTER_DOUBLING = 2.35;

/** A program's charged work, in total and by counter. */
type Measured = Pick<Answers["budget"], "total" | "counts">;

/**
 * The families of `families` whose total or a counter of at least 200 units grows faster than linearly, either order;
 * `unshared`: with the sharing of answers off; `measure`: the work of another run than the analysis's.
 */
function steepCounters(
  families: readonly WorkFamily[],
  unshared = false,
  measure: (at: Sized, reversed: boolean) => Measured = (at, reversed) =>
    analysed(at, reversed, unshared).budget,
  sizes: readonly [number, number] = [64, 128],
): string[] {
  const steep: string[] = [];
  for (const family of families) {
    const [at64, at128] = [sized(family, sizes[0]), sized(family, sizes[1])];
    for (const reversed of [false, true]) {
      const small = measure(at64, reversed);
      const large = measure(at128, reversed);
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const name = `${family.name}${reversed ? " reversed" : ""}${unshared ? " unshared" : ""}${sizes[0] === 64 ? "" : ` ${sizes[0]} → ${sizes[1]}`}`;
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      if (doubling(small.total, large.total) > DOUBLING)
        steep.push(`${name}: ${doubling(small.total, large.total).toFixed(3)}`);
      for (const [counter, after] of large.counts)
        if (
          counter !== "syntaxNodes" &&
          after >= 200 &&
          doubling(small.counts.get(counter) ?? 0, after) > COUNTER_DOUBLING
        )
          steep.push(
            `${name} ${counter}: ${doubling(small.counts.get(counter) ?? 0, after).toFixed(3)}`,
          );
    }
  }
  return steep;
}

test("every W34, W44 and W45 variant's work and each of its counters grow with the program in either order", () => {
  assert.deepEqual(steepCounters([...W34_VARIANTS, ...W44_VARIANTS, ...W45_VARIANTS]), []);
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
 * N5's families through the analysis (S10 part 2b): a read in a stored value takes its narrowing, so the stores' own
 * preserving tests run as the analysis asks them, components included; the same gate.
 */
test("stage 3b's N5 families grow with the program through the analysis too, in either order (§13.3)", () => {
  assert.deepEqual(
    steepCounters(NARROWING_FAMILIES.filter((family) => family.name.startsWith("W29"))),
    [],
  );
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

const many = (k: number, row: (index: number) => string, by = "\n"): string =>
  Array.from({ length: k }, (_, index) => row(index)).join(by);

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
 * #1310 (the lead's rule): an operand that reaches an earlier join, through a literal's property, a nested list element,
 * an `otherwise`'s side, a kept variable or a copy, takes that join's composed type, so the join check composes each
 * tree once (beside #1357's prefixes each in an object above): each family's total and its counters grow with the
 * program in either order, the sharing on and off. The kept variables and copies of a written union without a conflicting
 * leaf are reported, not gated: admission's landings walk the chain once per link on `main` too (#1428), the copies'
 * charged work (`landedBelow`'s `copiesAlong`, `landsThrough` and `emit` from `hotSets`) and both forms' ids, made
 * there below the charged length (`keptParts` in `landedBelow`, 14,470 → 57,510 code units kept, 28,974 → 115,217
 * copied, as on `main`); at k = 64 → 128 total and `indexSteps`:
 *
 * | copies of a written union | `main` | this head |
 * | joined at each link | 2.18, 2.47 | 2.16, 2.45 |
 * | only copied | 2.02, 2.04 | 2.02, 2.04 |
 * | joined, from an unwritten list | 2.01, 2.03 | 2.01, 2.02 |
 *
 * Each link an object of its own property, the composed type grows with the chain (Codex r15's and r16's B1): the
 * projections' members are gated at 64 → 128 and 128 → 256, the growing join an operand's first part (an `otherwise`'s
 * first side); a kept variable's and a copy's are reported, a variable read beside each join of distinct properties
 * growing on `main` too (#1384: about 3.4 total, `exactValues` 3.9). An `otherwise` holding the earlier join on its
 * later side is reported too: its charged work is linear, but on `main` too the fallback check makes its labels below
 * the charged length, 4.0 per doubling for any nested `otherwise` (#1433); the composition's own invariant is gated on
 * it below. (A literal's later element, the other later part, is #1192's accepted nested-literal product on `main`.)
 */
test("a join's operand reaching an earlier join takes its composed type, its work linear either way (#1310)", () => {
  const gated = JOIN_REACH_FAMILIES.filter(
    (family) =>
      !/^join-reach-(kept|copy)-(left|right)(-width)?$/.test(family.name) &&
      !family.name.startsWith("join-reach-choice-later-"),
  );
  assert.equal(gated.length, 22);
  // (a composed type growing with the chain: its second doubling too, where a walk of a growing part first crosses the
  // total's gate, Codex r16's B1)
  const growing = gated.filter((family) => family.name.endsWith("-width"));
  assert.deepEqual(
    [
      ...steepCounters(gated),
      ...steepCounters(gated, true),
      ...steepCounters(growing, false, undefined, [128, 256]),
      ...steepCounters(growing, true, undefined, [128, 256]),
    ],
    [],
  );
});

/**
 * #1310: composing an operand's parts visits the smaller part only, so an earlier join growing with a chain is never
 * walked again where it stands as an operand's later part (`join-reach-choice-later-*`, an `otherwise`'s later side).
 * This gates that one operation, its visits (`partVisits`) at most 2.15 per doubling in either order; a walk of the
 * later part measures 3.9. It claims nothing about the shape: the shape's total is #1433's, the fallback check making
 * its labels below the charged length (4.0 per doubling, on `main` too), and the shape stays out of the gate above.
 */
test("the composition of an operand's parts visits only its smaller part, on a shape whose total is #1433's (#1310)", () => {
  const steep: string[] = [];
  const later = JOIN_REACH_FAMILIES.filter((family) =>
    family.name.startsWith("join-reach-choice-later-"),
  );
  assert.equal(later.length, 6);
  for (const family of later)
    for (const reversed of [false, true]) {
      const [small, large] = [64, 128].map((k) => analysed(sized(family, k), reversed).budget);
      const visits = (budget: Measured): number => budget.counts.get("partVisits") ?? 0;
      assert.ok(visits(large!) >= 128, `${family.name}: each link's parts composed`);
      const scale =
        (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
      const doubling = (2 * (visits(large!) / Math.max(1, visits(small!)))) / scale;
      if (doubling > DOUBLING)
        steep.push(`${family.name}${reversed ? " reversed" : ""}: ${doubling.toFixed(3)}`);
    }
  assert.deepEqual(steep, []);
});

/**
 * #1194: a written type's levels are read once per type, and each walk of it steps on from the prefix before, so k
 * copies of a value of a type k levels deep walk the type about k² steps (each decided path still asks it from its
 * root: the per-path questions, a design round), never k³ (each copy and each label reading every level from the root,
 * 7.45 per doubling before). The walk is uncharged work (`writtenTypeSteps` counts it), gated at its measured doubling.
 */
/**
 * Measured per pass (steps ÷ passes), as `c1Visits`'s bound divides by `rejectPasses`: at 64 levels `out`'s decision
 * crosses its allowance (its cost is depth × copies, G6 in #1319's design-round list), and the pass that restarts it
 * (TABLE r4.180, r4.183) walks the type again.
 */
test("copies of a deep written type walk the type once, not once per copy (#1194)", () => {
  const measured = (k: number): { steps: number; nodes: number } => {
    const source = [
      `let typed: integer${"[]".repeat(k)} = []`,
      "let out = typed",
      ...Array.from({ length: k }, () => "out = typed"),
      "exit",
    ].join("\n");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${k} levels: its file parses and resolves`);
    const before = writtenTypeSteps();
    const answers = analyseCore(request);
    const { counts } = answers.budget;
    const passes = 1 + (counts.get("rejectPasses") ?? 0) + (counts.get("stopPasses") ?? 0);
    return { steps: (writtenTypeSteps() - before) / passes, nodes: counts.get("syntaxNodes") ?? 0 };
  };
  const [small, large] = [measured(32), measured(64)];
  const doubling = (2 * (large.steps / small.steps)) / (large.nodes / small.nodes);
  assert.ok(doubling <= 4.15, `${doubling.toFixed(3)} per doubling of the source`);
});

/**
 * Admission (TABLE §5, §10.3; the port plan's §3.3): its decisions, rejections, candidates and boundary checks, gated as
 * W34 is; A6's chain of dependent rejections, which takes a pass per link (§8's passes × stores, each pass charged), is
 * a gated known limit by the owner's decision (TABLE r4.49, option A): a regression check on the 64 → 128 step only,
 * at its measured doubling, not a bound at larger sizes; a change to admission's passes re-measures and proposes the
 * gate with its counts, never retunes it. Copies interleaved with conditional stores below their path (S6-CARRIERS
 * §4.7, condition (b)) are gated in the same form, a known limit by the owner's decision too (TABLE r4.69 (1)), and so
 * are copies separated by calls storing their source (r4.71).
 */
test("every admission family's work and each of its counters grow with the program in either order", () => {
  assert.deepEqual(steepCounters(ADMISSION_FAMILIES), []);
  const steep: string[] = [];
  for (const family of ADMISSION_KNOWN_PRODUCTS) {
    const [at64, at128] = [sized(family, 64), sized(family, 128)];
    for (const reversed of [false, true]) {
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
 * #1188: admission's hot-candidate discovery by touch tries lists no contribution once per context that reaches it (a
 * configuration prefix, a group's place, a read, a literal, a merge place or a cycle), so each family's total and each
 * of its counters grow with the program in either order. The series to k = 1,024, both orders and the sharing off, is
 * the step's evidence, outside CI.
 */
test("every hot-candidate family's work and each of its counters grow with the program in either order (#1188)", () => {
  assert.deepEqual(steepCounters(HOT_CANDIDATE_FAMILIES), []);
});

/**
 * G5 (5a, #1339): a cycle of whole copies is cut at its stops at once, so no member's entry walks the cycle again; each
 * family's total and each of its counters grow with the program in either order, with the sharing on and off. The
 * chord cycle reached the allowance at k = 64 on `main`. The series, the four modes and the conflicting chord cycle (whose
 * per-property components remain, G5's 5b), are the step's evidence, outside CI.
 */
test("a cycle of whole copies read at every member grows with the program in either order, shared or not (#1339)", () => {
  assert.deepEqual(
    [...steepCounters(COPY_RING_FAMILIES), ...steepCounters(COPY_RING_FAMILIES, true)],
    [],
  );
});

/**
 * A4 through copies (the owner's reviewer's F1 on #1049, TABLE r4.80): the inherited-field families, gated above with
 * the admission families, are gated with the sharing off too, so what a copy costs never hangs on equivalent answers
 * being shared; and his budget witness, a chain of 1,024 whole copies of a root of 1,024 written-typed fields (a source
 * of 6,153 syntax nodes that reached the allowance), completes within the default allowance.
 */
test("the inherited-field families grow with the program with the sharing off, and the 1,024 chain completes", () => {
  assert.deepEqual(steepCounters(INHERITED_FIELD_FAMILIES, true), []);
  const chain = INHERITED_FIELD_FAMILIES.find((family) => family.name === "A4-inherited-chain")!;
  assert.equal(analysed(sized(chain, 1_024)).outcome, "valid");
});

/**
 * S6c (TABLE r4.61, r4.69 (2), r4.85): the value side's inherited products, gated as W34 is: same-source adds, choices
 * and a literal's `get`s (S6-CARRIERS §4.5, §4.7: `ADMISSION_SAME_SOURCES`), product (c) of W34's class, k literals of
 * typed ingresses of one default (`ADMISSION_INGRESS_PRESETS`), and each discovery site's class (`VALUE_CLASS_SITES`),
 * their totals and each counter of at least 200 units in either order (they were gated at their measured doublings,
 * 2.04 to 3.65, while the value side read each copy at each field).
 */
test("the value side's work on same sources and typed presets grows with the program in either order", () => {
  assert.deepEqual(
    steepCounters([...ADMISSION_SAME_SOURCES, ...ADMISSION_INGRESS_PRESETS, ...VALUE_CLASS_SITES]),
    [],
  );
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
 * S6c: an element selection reads its owner at its step and whole, so a chain of k `.first` read each link twice per
 * link below it, 2^k reads in all (`main` reached the allowance from k = 20); its whole answer is read once per value
 * now, so a list nested 32 deep read through 32 `.first` is answered within the allowance, in either order.
 */
test("a list nested 32 deep read through 32 `.first` is answered within the allowance", () => {
  const source = `let value = ${"[".repeat(32)}1${"]".repeat(32)}\nlet n: integer = value${".first".repeat(32)}\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const named = { name: "the 32-deep `.first` chain", request };
  assert.deepEqual([analysed(named).outcome, analysed(named, true).outcome], ["valid", "valid"]);
});

/**
 * A value's identity names its inputs by their own identities (TABLE §8, round 12 B4): a chain of 32 `otherwise`s, each
 * of the one before twice, is a source of 32 lines, never an identity of 2^32 characters.
 */
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

test("a chain of records over shared inputs is identified in linear space (round 13 B3)", () => {
  const levels = Array.from(
    { length: 32 },
    (_, index) => `let a${index + 1} = {left: a${index}, right: a${index}}`,
  );
  const source = `let a0 = {n: 1}\n${levels.join("\n")}\nlet xs = [a32, a32]\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  assert.equal(analyseCore(request).outcome, "valid");
});

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

/**
 * W34's two known products, gated known limits by the owner's decision (TABLE r4.45, PLAN §6b): a regression check on
 * the 64 → 128 growth step only, each held to its measured doubling in either order (3.37 and 2.53); not a bound at
 * larger sizes (128 → 256 grows 3.62 and 2.82), and no linearity is asserted for them.
 */
test("W34's two known products grow no faster than measured", () => {
  const steep: string[] = [];
  for (const family of W34_KNOWN_PRODUCTS) {
    const [at64, at128] = [sized(family, 64), sized(family, 128)];
    for (const reversed of [false, true]) {
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
 * S6-CARRIERS §4.4: a class's members are visited only where its side's quiet proof is not quiet, and each such visit
 * emits, so the visits are bounded by the output: per pass, at most the diagnostics, the checks and the decided paths.
 */
test("every family's member visits are bounded by its output and its decided paths (§4.4)", () => {
  const over: string[] = [];
  for (const family of [
    ...WORK_FAMILIES,
    ...W34_VARIANTS,
    ...W44_VARIANTS,
    ...W45_VARIANTS,
    ...ADMISSION_FAMILIES,
  ]) {
    const answers = analysed(sized(family, 32));
    const counts = answers.budget.counts;
    const visits = counts.get("c1Visits") ?? 0;
    const bound =
      (1 + (counts.get("rejectPasses") ?? 0)) *
      (answers.diagnostics.length + answers.checks.length + answers.budget.facts.decidedPaths);
    if (visits > bound) over.push(`${family.name}: ${visits} visits, ${bound} the bound`);
  }
  assert.deepEqual(over, []);
});

/**
 * TABLE r4.192 (#1403): what a decision's stop forgets by, each demand's reader and each key a demand asked whether it
 * stopped, is counted apart from the allowance (`countApart`), never in `total`, so no stop point moves. On nested
 * selections that count doubles at one doubling of the source; on a chain of wrappers read through every link the
 * charged reads themselves grow faster (G6's deep shapes), and the records stay below one per charged read (`yields`).
 * Both orders, the sharing on and off.
 */
test("what a stop forgets by is counted apart: linear on nested selections, below the charged reads on wrappers (#1403)", () => {
  const nest = (k: number, leaf: string): string =>
    Array.from({ length: k }).reduce<string>((inner) => `[${inner}, "other"][0]`, leaf);
  const program = (source: string): SourceFile[] => [{ path: "main.tease", source }];
  // (each shape: its name, its program, whether its records grow linearly, whether it reads a variable's stop)
  const shapes: readonly (readonly [string, (k: number) => SourceFile[], boolean, boolean])[] = [
    [
      "nested selections of a variable",
      (k) => program(`let seed = "origin"\nlet out = ${nest(k, "seed")}\nsay out\nexit\n`),
      true,
      true,
    ],
    [
      "nested selections of a literal",
      (k) => program(`let out = ${nest(k, '"origin"')}\nsay out\nexit\n`),
      true,
      false,
    ],
    [
      "a chain of wrappers read through every link",
      (k) =>
        program(
          [
            "let typed: integer = 1",
            "let root = {f: typed, q: null}",
            ...Array.from(
              { length: k },
              (_, i) => `let a${i} = {q: ${i === 0 ? "root" : `a${i - 1}`}}`,
            ),
            `let out = a${k - 1}.${Array.from({ length: k }, () => "q").join(".")}.f`,
            "exit",
          ].join("\n") + "\n",
        ),
      false,
      true,
    ],
  ];
  const apart: readonly WorkCounter[] = ["readerRecords", "stopAsks"];
  const over: string[] = [];
  for (const [shape, make, linear, asks] of shapes) {
    const sizes = linear ? [32, 64] : [8, 16];
    const family: WorkFamily = { name: shape, measures: shape, program: make };
    const at = sizes.map((k) => sized(family, k));
    for (const reversed of [false, true])
      for (const unshared of [false, true]) {
        const where = `${shape}${reversed ? " reversed" : ""}${unshared ? " unshared" : ""}`;
        const [small, large] = at.map((one) => analysed(one, reversed, unshared).budget);
        for (const budget of [small!, large!]) {
          // (counted apart, never in the charged work, so never what stops the analysis)
          assert.ok(
            apart.every((counter) => !budget.counts.has(counter)),
            where,
          );
          assert.equal(
            [...budget.counts.values()].reduce((sum, units) => sum + units, 0),
            budget.total,
            where,
          );
          const records = apart.map((counter) => budget.apart.get(counter) ?? 0);
          assert.ok(records[0]! > 0, `${where}: its readers are recorded`);
          if (asks) assert.ok(records[1]! > 0, `${where}: its asks are recorded`);
          if (records[0]! + records[1]! > (budget.counts.get("yields") ?? 0))
            over.push(
              `${where}: ${records.join(" + ")} records, ${budget.counts.get("yields")} reads`,
            );
        }
        if (!linear) continue;
        const scale =
          (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
        for (const counter of apart) {
          const before = small!.apart.get(counter) ?? 0;
          const doubling = (2 * ((large!.apart.get(counter) ?? 0) / Math.max(1, before))) / scale;
          if (before > 0 && doubling > DOUBLING)
            over.push(`${where} ${counter}: ${doubling.toFixed(3)}`);
        }
      }
  }
  assert.deepEqual(over, []);
});
