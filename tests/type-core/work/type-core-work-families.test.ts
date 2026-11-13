// The coarse core's work as a sampled regression oracle (`tests/helpers/type-core/type-core-work.ts`), one of three files that
// CI runs side by side.

import assert from "node:assert/strict";
import test from "node:test";
import { type Answers } from "../../../src/type-inference/core/answers.js";
import { type WorkCounter } from "../../../src/type-inference/core/budget.js";
import { type SourceFile } from "../../helpers/type-core-analysis.js";
import {
  MIXED_ADD_PRODUCTS,
  READ_CHAIN_PRODUCTS,
} from "../../helpers/type-core/families/admission-products.js";
import { NARROWING_FAMILIES } from "../../helpers/type-core/families/narrowing.js";
import { WORK_FAMILIES } from "../../helpers/type-core/families/work-gates.js";
import { type WorkFamily } from "../../helpers/type-core/families/builders.js";
import { askEveryRead, narrowingPassIn } from "../../helpers/type-core/type-core-narrowing.js";
import {
  DOUBLING,
  type Sized,
  sized,
  analysed,
  COUNTER_DOUBLING,
  type Measured,
  steepCounters,
  many,
} from "../../helpers/type-core/type-core-work.js";

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
 * Stage 3b's families (W27–W34 and the tested-copy variant): the narrowing index built and every read's
 * narrowing (N2 with N5) and route (N3) asked, as S10's second part's consumers will ask them, in source order and
 * reversed with the solver's worklist; its total and each counter under the standard gate. The series to k = 1,024 is
 * the step's evidence, outside CI.
 */
test("every stage 3b family's index and queries grow with the program in either order", () => {
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
 * helper's parameter's k definitions are sorted and lifted (the `n log n` structures), which measure 2.37 here,
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
 * The value side's gated known limits (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-83):
 * read chains through nested literals, each link's key one step longer (`READ_CHAIN_PRODUCTS`), and adds of several
 * sources into one list in turn (`MIXED_ADD_PRODUCTS`); a regression check on the 64 → 128 step only, each held to its
 * measured doubling in either order. On CI (GitHub Actions sets `CI`) the mixed adds run in the source order only:
 * their orders differ by at most 0.0001.
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
