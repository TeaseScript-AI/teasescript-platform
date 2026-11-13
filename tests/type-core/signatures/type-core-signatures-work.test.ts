// C13's consumers' work grows with the program: their families, toJson's re-proving, record-valued nested choices, and
// join's, sort's and toJson's walks.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, inOrder, MODES } from "../../helpers/type-core-oracles.js";

/** The work families of the new consumers, each at size k (the lead's gates: total 2.15, counters 2.35 per doubling). */
const SIGNATURE_FAMILIES: readonly {
  readonly name: string;
  readonly program: (k: number) => string;
}[] = [
  {
    name: "k method arguments on one text and one list",
    program: (k) =>
      `let t = "abc"\nlet xs = [1]\n${Array.from({ length: k }, (_, i) => `say t.contains("${i}")\nlet r${i} = xs.union([${i}])`).join("\n")}\nexit\n`,
  },
  {
    name: "k lists each sorted and joined",
    program: (k) =>
      `${Array.from({ length: k }, (_, i) => `let x${i} = [${i}, 1]\nx${i}.sort()\nsay x${i}.join()`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of an object k wide",
    program: (k) =>
      `say toJson({${Array.from({ length: k }, (_, i) => `f${i}: [${i}]`).join(", ")}})\nexit\n`,
  },
  { name: "k compound assignments", program: (k) => `let x = 0\n${"x += 1\n".repeat(k)}exit\n` },
  {
    name: "k loops over one list",
    program: (k) => `let xs = [1, 2]\n${"for e in xs {}\n".repeat(k)}exit\n`,
  },
  {
    name: "toJson of one unchanged object k fields wide, at 4 calls",
    program: (k) =>
      `let root = {${Array.from({ length: k }, (_, i) => `f${i}: ${i}`).join(", ")}}\n${Array.from({ length: 4 }, (_, i) => `let j${i} = toJson(root)`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of one unchanged object 8 fields wide, at k calls",
    program: (k) =>
      `let root = {${Array.from({ length: 8 }, (_, i) => `f${i}: ${i}`).join(", ")}}\n${Array.from({ length: k }, (_, i) => `let j${i} = toJson(root)`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of k copies of one unchanged object k fields wide",
    program: (k) =>
      `let root = {${Array.from({ length: k }, (_, i) => `f${i}: ${i}`).join(", ")}}\n${Array.from({ length: k }, (_, i) => `let c${i} = root\nlet j${i} = toJson(c${i})`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of the last of a chain of k copies, at 4 calls",
    program: (k) =>
      `let c0 = {n: 0}\n${Array.from({ length: k }, (_, i) => `let c${i + 1} = c${i}`).join("\n")}\n${Array.from({ length: 4 }, (_, i) => `let j${i} = toJson(c${k})`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of the last of a chain of 4 copies, at k calls",
    program: (k) =>
      `let c0 = {n: 0}\n${Array.from({ length: 4 }, (_, i) => `let c${i + 1} = c${i}`).join("\n")}\n${Array.from({ length: k }, (_, i) => `let j${i} = toJson(c4)`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of the last of a chain of k copies, at k calls",
    program: (k) =>
      `let c0 = {n: 0}\n${Array.from({ length: k }, (_, i) => `let c${i + 1} = c${i}`).join("\n")}\n${Array.from({ length: k }, (_, i) => `let j${i} = toJson(c${k})`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of each copy along a chain of k copies",
    program: (k) =>
      `let c0 = {n: 0}\n${Array.from({ length: k }, (_, i) => `let c${i + 1} = c${i}\nlet j${i} = toJson(c${i + 1})`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of one unchanged object k fields wide, at k calls",
    program: (k) =>
      `let root = {${Array.from({ length: k }, (_, i) => `f${i}: ${i}`).join(", ")}}\n${Array.from({ length: k }, (_, i) => `let j${i} = toJson(root)`).join("\n")}\nexit\n`,
  },
  {
    name: "k content checks of written host lists",
    program: (k) =>
      `${Array.from({ length: k }, (_, i) => `let x${i}: object[] = hostValue\nsay x${i}.join()\nsay toJson(x${i})`).join("\n")}\nexit\n`,
  },
  {
    name: "k choices of written choice objects",
    program: (k) =>
      `${Array.from({ length: k }, (_, i) => `let c${i} = askChoice [{text: "a", value: ${i}}, {text: "b", value: "${i}"}]`).join("\n")}\nexit\n`,
  },
];

/**
 * The new consumers' work grows with the program: each family at k = 64 and 128, in the core's order and reversed, with
 * the sharing of answers on and off, its charged total per doubling of its syntax nodes within 2.15 and each counter of
 * at least 200 units within 2.35 (the work test's gates), and the analysis within its allowance.
 */
test("each new C13 consumer's work and counters grow with the program in all four modes", () => {
  const steep: string[] = [];
  for (const family of SIGNATURE_FAMILIES)
    for (const mode of MODES) {
      const { reversed, unshared } = mode;
      const [small, large] = [64, 128].map((k) => {
        const request = coreRequest([{ path: "main.tease", source: family.program(k) }]);
        assert.ok(request !== null, `${family.name} at ${k}`);
        const { budget } = inMode(mode, () => analyseCore(request));
        assert.equal(budget.exhausted, null, `${family.name} at ${k}: within the allowance`);
        return budget;
      });
      const scale =
        (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      const name = `${family.name}${reversed ? " reversed" : ""}${unshared ? " unshared" : ""}`;
      if (doubling(small!.total, large!.total) > 2.15)
        steep.push(`${name}: ${doubling(small!.total, large!.total).toFixed(3)}`);
      for (const [counter, after] of large!.counts)
        if (
          counter !== "syntaxNodes" &&
          after >= 200 &&
          doubling(small!.counts.get(counter) ?? 0, after) > 2.35
        )
          steep.push(
            `${name} ${counter}: ${doubling(small!.counts.get(counter) ?? 0, after).toFixed(3)}`,
          );
    }
  assert.deepEqual(steep, []);
});

/**
 * The re-proving control of `toJson`'s one proof per snapshot (the owner's review P1): a field stored before each of k
 * calls makes each call a new snapshot, proved again, so the calls' own work (the program's less the same stores
 * without the calls; k stores into one key sort their definitions, n log n, which is the stores' own) grows linearly in
 * the calls, in all four modes.
 */
test("toJson re-proves after each store, and that work grows linearly with the calls", () => {
  const stored = (k: number, calls: boolean): string =>
    `let root = {${Array.from({ length: 8 }, (_, i) => `f${i}: ${i}`).join(", ")}}\n${Array.from({ length: k }, (_, i) => `root.f0 = ${i}${calls ? `\nlet j${i} = toJson(root)` : ""}`).join("\n")}\nexit\n`;
  const steep: string[] = [];
  for (const mode of MODES) {
    const { reversed, unshared } = mode;
    const total = (source: string): number => {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, source);
      const { budget } = inMode(mode, () => analyseCore(request));
      assert.equal(budget.exhausted, null, source);
      return budget.total;
    };
    const [small, large] = [64, 128].map((k) => total(stored(k, true)) - total(stored(k, false)));
    if (large! / small! > 2.15)
      steep.push(
        `${reversed ? "reversed " : ""}${unshared ? "unshared " : ""}${(large! / small!).toFixed(3)}`,
      );
  }
  assert.deepEqual(steep, []);
});

/**
 * Astra's B6-r4 witness: k record-valued nested choices, each TSV029's error, their answer read k levels
 * below: no record a button holds is composed into the answer, so the chain takes less work than its literal analogue
 * (the same objects read through `.value`, a deep literal read chain, itself the accepted read-chain product), at both
 * sizes and in both orders, and without the read it grows as the accepted nested-choice product (`I1106-nested-choices`
 * measured 3.06).
 */
test("record-valued nested choices compose no record: below their literal analogue, and within the nested-choice product", () => {
  const chain = (k: number, read: boolean): string => {
    let value = "0";
    for (let index = k - 1; index >= 0; index -= 1)
      value = `{x: askChoice {text: "${index}", value: ${value}}}`;
    return read
      ? `let c = (askChoice {text: "top", value: ${value}})${".x".repeat(k)}\nexit\n`
      : `let c = askChoice {text: "top", value: ${value}}\nexit\n`;
  };
  const analogue = (k: number): string => {
    let value = "0";
    for (let index = k - 1; index >= 0; index -= 1)
      value = `{x: {text: "${index}", value: ${value}}.value}`;
    return `let c = ${value}${".x".repeat(k)}\nexit\n`;
  };
  for (const reversed of [false, true]) {
    const budget = (source: string) => {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null);
      const { budget: spent } = inOrder(reversed, () => analyseCore(request));
      assert.equal(spent.exhausted, null);
      return spent;
    };
    for (const k of [64, 128])
      assert.ok(
        budget(chain(k, true)).total < budget(analogue(k)).total,
        `at ${k}${reversed ? " reversed" : ""}`,
      );
    const [small, large] = [budget(chain(64, false)), budget(chain(128, false))];
    const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
    assert.ok((2 * (large.total / small.total)) / scale <= 3.06, `reversed: ${reversed}`);
  }
});

/**
 * The work of `join`'s and `sort`'s element checks does not grow with the list's width: over a list literal of k
 * elements (whose own check of one type, A8, is the literal's), the checks they add are the same at 64 and 128; and
 * `toJson`'s walk of an object k deep reads each level once, each level's path one step longer than the one above it
 * and charged as it is made: the read chain through nested literals, a gated known limit, with each
 * level's property names, whose kept paths, path index entries and pump checks the search charges since #1493 (13,877
 * / 50,131 units at k = 64, 128, 3.677 per doubling of the source; 12,437 / 41,683 and 3.412 before), the depth no real
 * script reaches.
 */
test("join's and sort's element checks take the same work at any width, and toJson's deep walk is the read chain's known product", () => {
  const spent = (source: string) => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    return analyseCore(request).budget;
  };
  const list = (k: number): string =>
    `let xs = [${Array.from({ length: k }, (_, i) => String(i)).join(", ")}]\n`;
  const added = (k: number): number =>
    (spent(`${list(k)}xs.sort()\nsay xs.join()\nexit\n`).counts.get("checks") ?? 0) -
    (spent(`${list(k)}exit\n`).counts.get("checks") ?? 0);
  assert.equal(added(128), added(64));
  const deep = (k: number) => spent(`say toJson(${"{a: ".repeat(k)}1${"}".repeat(k)})\nexit\n`);
  const [small, large] = [deep(64), deep(128)];
  assert.equal(large.exhausted, null);
  const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
  assert.ok((2 * (large.total / small.total)) / scale <= 3.71);
});
