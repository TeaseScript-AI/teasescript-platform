import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { PlaceId } from "../src/type-inference/graph.js";
import { Admission } from "../src/type-inference/core/admission.js";
import { spanRef } from "../src/type-inference/core/contract/key-ids.js";
import type { Definition } from "../src/type-inference/core/definitions.js";
import { MODES } from "./helpers/type-core-oracles.js";
import {
  atElements,
  ownDisagreements,
  routed,
  scanned,
  shown,
  valued,
  type Answer,
  type Asked,
} from "./helpers/type-core-written-decider.js";

// #1444(b,c): outside every decision, a written decider is answered from its groups' summaries (`writtenDecider`), a
// decision's own scan staying the stops'. The obligations: the summary answers as the scan does on the same admission;
// no decision reads it; and after a stop it answers from what is current, as a scan with no memo of its own does.

/** The scan with no memo of its own: each of the decider's derived maps empty for it, the admission's restored after. */
const COLD = [
  "deciders",
  "linkTests",
  "linkKinds",
  "chosenLinks",
  "snapshotLists",
  "joinedLists",
  "viaClassNames",
  "viaClassParts",
  "viaSignatures",
  "viaNames",
  "stops",
  "everyStop",
] as const;
const cold = (admission: Admission, d: Definition, path: Asked): Answer => {
  const saved = COLD.map((name) => ({ name, kept: admission[name] }));
  // (the stops' depths are A4's receiving domain's, the pass's: empty for it too, restored after)
  const domain = admission.pass.receivingDomain;
  const depths = domain.stopDepths;
  domain.stopDepths = new WeakMap();
  for (const { name, kept } of saved)
    Object.defineProperty(admission, name, {
      value: Array.isArray(kept)
        ? kept.map(() => new WeakMap())
        : kept instanceof Map
          ? new Map()
          : new WeakMap(),
    });
  // (the transfers read their maps through the bundle: it takes the empty ones too, Codex r1's F1 on #1685)
  const bundle = admission.deciderCaches;
  Object.defineProperty(admission, "deciderCaches", {
    value: {
      deciders: admission.deciders,
      linkTests: admission.linkTests,
      linkKinds: admission.linkKinds,
      summaries: new WeakMap(),
    },
  });
  try {
    return scanned(admission, d, path);
  } finally {
    for (const { name, kept } of saved) Object.defineProperty(admission, name, { value: kept });
    domain.stopDepths = depths;
    Object.defineProperty(admission, "deciderCaches", { value: bundle });
  }
};

const PATHS: readonly (readonly string[])[] = [
  [],
  ["p"],
  ["q"],
  ["element"],
  ["element", "p"],
  ["p", "q"],
];

/**
 * The nest of #1444 and its siblings, as their k levels stand between the written copy and the read: selections with
 * the level inside first or last, a written union, a written option of another type, a copy of a written binding, a
 * typed default, a call with a written result, a copy, a default and a method between levels; and joins and the stop
 * witnesses' shapes beside them.
 */
function sources(k: number): string[] {
  const out: string[] = [];
  for (const first of [true, false]) {
    const sel = (x: string, y: string): string => (first ? `[${x}, ${y}][0]` : `[${y}, ${x}][1]`);
    for (const variant of [
      "property",
      "option",
      "copy",
      "default",
      "call",
      "between",
      "fallback",
      "get",
    ]) {
      let setup = "let typed: integer | string = 1\n";
      let leaf = "{p: typed}";
      let other = "{p: typed}";
      if (variant === "option") leaf = '{p: "origin"}';
      if (variant === "copy")
        [setup, leaf, other] = [`${setup}let copied = typed\n`, "{p: copied}", "{p: copied}"];
      if (variant === "default") leaf = other = '{p: load("key", default: typed)}';
      if (variant === "call")
        [setup, leaf, other] = [
          `${setup}function make: integer | string { return 1 }\n`,
          "{p: make()}",
          "{p: make()}",
        ];
      let x = leaf;
      if (variant === "between") {
        setup += `let c0 = ${leaf}\n`;
        for (let i = 1; i <= k; i += 1) setup += `let c${i} = ${sel(`c${i - 1}`, other)}\n`;
        x = `c${k}`;
      } else
        for (let i = 0; i < k; i += 1)
          x =
            variant === "get"
              ? `[${x}, ${other}].get(${first ? 0 : 1}, default: ${other})`
              : sel(variant === "fallback" ? `((${x}) otherwise ${other})` : x, other);
      out.push(`${setup}let out = ${x}\nsay "\${out.p}"\nexit\n`);
    }
  }
  // (a written copy below an operation at the path's end, which decides only where the operation surely gives it, and
  // copies the operations do not select, before the value that decides)
  const maybe = "let typed: integer | string | null = hostValue\n";
  out.push(
    `${maybe}let out = ${"(".repeat(k)}typed${" otherwise 2)".repeat(k)}\nsay "\${out}"\nexit\n`,
    `${maybe}let other: integer | string = 1\nlet out = [${"(".repeat(k)}typed${" otherwise 2)".repeat(k)}, other]\nsay out.length\nexit\n`,
    `let typed: integer | string = 1\nlet out = [typed, 2].get(${k + 3}, default: 3)\nsay "\${out}"\nexit\n`,
    `let typed: integer | string = 1\nlet out = [{p: typed}, {p: 1}].get(${k + 3}, default: {p: 2})\nsay "\${out.p}"\nexit\n`,
    `let typed: integer | string = 1\nlet flag = {p: 1}\nlet out = [${"(".repeat(k)}flag${" otherwise {p: typed})".repeat(k)}, {p: typed}][0]\nsay "\${out.p}"\nexit\n`,
    `let typed: (integer | string)[] = [1]\nlet xs = [2]\nlet out = ${"xs + ".repeat(k)}typed\nsay out.length\nexit\n`,
    `function make: integer[] | string[] { return [9] }\nlet flag = [1]\nlet out = make() + (flag otherwise [2])\nsay "\${out[0]}"\nexit\n`,
  );
  return out;
}

/**
 * Codex r1's dimensions on #1685, one witness each: a join whose written operand leaves the path open, the rows of a
 * choice's options interleaved by rank, two snapshots of one binding, a written copy two steps down (asked as a cursor's
 * span too, as every question below), a copy cycle whose decision waits on itself.
 */
const WITNESSES: readonly string[] = [
  "let typed: list = [1]\nlet other: integer[] = [2]\nlet out = other + typed\nsay out.length\nexit\n",
  'let typed: integer | string = 1\nlet other: boolean | null = true\nlet out = askChoice [{text: "A", value: {p: typed, q: other}}, {text: "B", value: {p: 2, q: true}}]\nsay "${out.p}"\nexit\n',
  'let typed: integer | string = 1\nlet a = {p: typed}\nlet before = a.p\na.p = "s"\nlet out = [[{p: before}, {p: a.p}][0], {p: typed}][0]\nsay "${out.p}"\nexit\n',
  'let typed: integer | string = 1\nlet out = [{p: {q: typed}}, {p: {q: 2}}][0]\nsay "${out.p.q}"\nexit\n',
  'let typed: integer | string = 1\nlet a = {p: typed}\nlet b = a\na = b\nlet out = [a, b][0]\nsay "${out.p}"\nexit\n',
];

test("outside a decision the written decider's summary answers each question as the scan of the stops does (#1444)", () => {
  const differ: string[] = [];
  let asked = 0;
  for (const k of [1, 2, 3])
    for (const source of k === 1 ? [...sources(k), ...WITNESSES] : sources(k))
      for (const mode of MODES)
        atElements(source, mode, (admission) => {
          for (const d of valued(admission))
            for (const steps of PATHS)
              for (const path of [
                steps,
                spanRef(admission.pass.contract, admission.pass.contract.pathIdOf(steps)),
              ]) {
                const [summary, scan] = [routed(admission, d, path), scanned(admission, d, path)];
                asked += 1;
                if (shown(summary) !== shown(scan))
                  differ.push(
                    `k ${k} ${JSON.stringify(mode)} ${d.uid} ${steps.join(".")}${path === steps ? "" : " (span)"}: ${shown(summary)} ≠ ${shown(scan)}\n${source}`,
                  );
              }
        });
  assert.ok(asked > 1_000);
  assert.deepEqual(differ.slice(0, 5), []);
});

/**
 * #1901's regressions, each a copy whose own level the summary once guessed by the asked path's geometry: an inferred
 * binding of a join (its element below the joined copy's own level), and a property holding a scalar copy (its own
 * level); each in both orders and as a join, beside a copy of a copy and a written copy read below its own level.
 */
const OWN: readonly string[] = [
  'let d: integer?[] = [1]\nlet held = d + [2]\nlet xs = held + ["tail"]\nexit\n',
  'let d: integer?[] = [1]\nlet held = d + [2]\nlet xs = ["tail"] + held\nexit\n',
  'let d: integer[]?[] = [[1]]\nlet held = d + [[2]]\nlet xs = [held, [["x"]]]\nexit\n',
  'let atom: string? = "x"\nlet h = {v: atom}\nlet xs = [{v: 1}, h]\nexit\n',
  'let atom: string? = "x"\nlet h = {v: atom}\nlet xs = [h, {v: 1}]\nexit\n',
  'let atom: string? = "x"\nlet h = {v: atom}\nlet xs = [[1]] + [h]\nexit\n',
  'let atom: string? = "x"\nlet h = {v: atom}\nlet g = h\nlet xs = [{v: 1}, g]\nexit\n',
  'let b: string?[] = ["x"]\nlet xs = [[1], b]\nexit\n',
];

/**
 * #1901: the summary and the scan agree on whether a copy reads its type at its own level, on the regressions in four
 * modes and on the mixed family's copies (a written binding `c` its side reads) sampled one case per value of each of
 * its axes. The whole product of its copies is a queue job (`ownDisagreements` over every case, the owner's test-cost
 * rule).
 */
test("the summary and the scan agree on a copy's own level across the regressions and the sampled family (#1901)", async () => {
  // EVIDENCE: the family modules export `cases` (name and source) and `axes`, the families' module contract.
  const { cases, axes } = (await import(
    pathToFileURL(
      resolve(
        process.cwd(),
        "tests/families/messages/nested-carriers-and-diagnostic-work/nested-mixed-list-null-and-position-product.mjs",
      ),
    ).href
  )) as {
    cases: readonly (readonly [string, string])[];
    axes: readonly (readonly [string, unknown])[];
  };
  const copies = cases.filter(([, source]) => source.includes("let c:"));
  const value = (name: string, axis: string): string =>
    name.split("/").find((part) => part.startsWith(`${axis}:`))!;
  const sample = new Map<string, readonly [string, string]>();
  for (const [axis] of axes)
    for (const each of copies) {
      const key = value(each[0], axis);
      if (![...sample.values()].some(([name]) => value(name, axis) === key))
        sample.set(each[0], each);
    }
  const differ: string[] = [];
  let regressions = 0;
  let family = 0;
  for (const source of OWN)
    for (const mode of MODES) {
      const found = ownDisagreements(source, 2, mode);
      regressions += found.copies;
      differ.push(...found.differ);
    }
  for (const [name, source] of sample.values()) {
    const found = ownDisagreements(
      source,
      Number(value(name, "depth").slice("depth:".length)),
      MODES[0]!,
    );
    family += found.copies;
    differ.push(...found.differ);
  }
  assert.deepEqual(differ.slice(0, 5), []);
  assert.ok(regressions > 0 && family > 0, `${regressions} ${family}`);
});

test("a decision never reads the written decider's summary, so it charges what its scan charges (#1444)", () => {
  const read: string[] = [];
  const decide = Admission.prototype.decide;
  Admission.prototype.decide = function (this: Admission, ...args) {
    const before = this.summaryStates;
    const decision = decide.apply(this, args);
    if (this.summaryStates !== before) read.push(JSON.stringify(args[0].path));
    return decision;
  };
  try {
    for (const source of sources(3))
      for (const mode of MODES)
        atElements(source, mode, (admission) => {
          for (const d of valued(admission)) for (const path of PATHS) routed(admission, d, path);
        });
  } finally {
    Admission.prototype.decide = decide;
  }
  assert.deepEqual(read, []);
});

/**
 * The same-admission stop witnesses (#1444's prototype rounds r8–r12, Astra's review): a question asked, an input of
 * its answer stopped on the same admission (`Contract.stop`, as a stopped decision does; every record kept, so a stop
 * may still forget there, as where a pass's targets decide receivers), the question asked again.
 * The answer after the stop is the scan's with no memo of its own; the stop's forget is counted, the summary's maps are
 * replaced, and its groups' answers are made again. The inputs stopped: an `otherwise` operand (each link's answer and
 * the region it selects), the operand a `get` receives (an operation's own kinds, the mask), the earliest deciding
 * value, a written copy's own read, and an input the answer does not use (it stays).
 */
const STOPS: readonly {
  readonly name: string;
  readonly source: string;
  readonly stop: string;
  readonly path: string;
}[] = [
  {
    name: "an otherwise operand",
    source:
      'let typed: integer | string = 7\nlet flag = {p: 1}\nlet out = (flag otherwise {p: typed})\nsay "${out.p}"\nexit\n',
    stop: "flag",
    path: "p",
  },
  {
    name: "the operand two gets receive",
    source:
      'let typed: integer | string = 7\nlet flag = {p: 1}\nlet out = [[(flag otherwise {p: typed})].get(0, default: {p: typed})].get(0, default: {p: typed})\nsay "${out.p}"\nexit\n',
    stop: "flag",
    path: "p",
  },
  {
    name: "a join's operand beside a written call",
    source:
      'function make: integer[] | string[] { return [9] }\nlet flag = [1]\nlet out = make() + (flag otherwise [2])\nsay "${out[0]}"\nexit\n',
    stop: "flag",
    path: "element",
  },
  {
    name: "the earliest deciding value",
    source:
      'let typed: integer | string = 7\nlet flag = {p: 1}\nlet out = [[flag, {p: typed}][0], {p: typed}][0]\nsay "${out.p}"\nexit\n',
    stop: "flag",
    path: "p",
  },
  {
    name: "a written copy's own read",
    source:
      'let typed: integer | string = 7\nlet copied = typed\nlet flag = {p: 1}\nlet out = [[{p: copied}, flag][0], {p: typed}][0]\nsay "${out.p}"\nexit\n',
    stop: "copied",
    path: "p",
  },
  {
    name: "an input the answer does not use",
    source:
      'let typed: integer | string = 7\nlet flag = {p: 1}\nlet other = {p: 2}\nlet out = [[{p: typed}, flag][0], other][0]\nsay "${out.p}"\nexit\n',
    stop: "other",
    path: "p",
  },
];

test("after a stop on the same admission the written decider answers from what is current (#1444)", () => {
  const wrong: string[] = [];
  for (const shape of STOPS)
    for (const mode of MODES) {
      let done = false;
      atElements(
        shape.source,
        mode,
        (admission) => {
          if (done) return;
          const { program } = admission.pass;
          const text = (value: PlaceId): string => {
            const site = program.places[value]?.site;
            return site === undefined || site === null
              ? ""
              : shape.source.slice(site.start, site.end);
          };
          const out = valued(admission).find(
            (d) => d.how === "initializer" && program.places[d.place]?.label === "out",
          );
          const stopped = [...program.occurrenceOf.entries()].find(
            ([value]) => text(value) === shape.stop,
          );
          if (out === undefined || stopped === undefined) return;
          done = true;
          const path = [shape.path];
          const before = shown(routed(admission, out, path));
          const [forgets, epochs, states] = [
            admission.pass.solver.forgets,
            admission.summaryEpochs,
            admission.summaryStates,
          ];
          admission.pass.contract.stop(stopped[1], []);
          const after = shown(routed(admission, out, path));
          const reference = shown(cold(admission, out, path));
          const trace = [
            admission.pass.solver.forgets > forgets,
            admission.summaryEpochs > epochs,
            admission.summaryStates > states,
          ];
          if (after !== reference || trace.includes(false))
            wrong.push(
              `${shape.name} ${JSON.stringify(mode)}: before ${before}, after ${after}, reference ${reference}, trace ${trace}`,
            );
        },
        true,
      );
      if (!done) wrong.push(`${shape.name} ${JSON.stringify(mode)}: no question reached`);
    }
  assert.deepEqual(wrong, []);
});
