import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import { compactAnalysis, coreRequest } from "../helpers/type-core-analysis.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";

// #2289, decision B's B1: a literal's type is the one all its elements fit, in any order (ADR 0021 1.3, V30 §12); the
// place is strict where an element is declared with exactly that type (rule 5).

const DECLARED =
  "let lives: integer = 3\nlet price: number = 1.5\nlet u: integer | string = 1\nlet v: number | string = 1.5\n" +
  "let w: boolean | string = true\nlet o: integer? = 1\nlet un: integer | string | null = 1\n";

/** A binding's place by its name. */
function bindingOf(source: string, name: string): number {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  return new CoreProgram(request).places.find(
    (place) => place.kind.kind === "binding" && place.kind.name === name,
  )!.id;
}

/** In four modes: the place's admitted type at a path (`kinds`, sorted, and whether it is strict) and the errors' sites. */
function answered(source: string, name: string, path: readonly string[]): string[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const place = bindingOf(source, name);
  return MODES.map((mode) =>
    inMode(mode, () => {
      const admitted = analyseCore(request).place(place, path).admitted;
      const errors = compactAnalysis(request)
        .diagnostics.filter((d) => d.class === "compile-error")
        .map((d) => `error @${d.site.offset}`);
      const type =
        admitted.by === "decided"
          ? `${admitted.inherited ? "strict" : "inferred"} ${[...admitted.kinds].sort().join("|")}`
          : admitted.by;
      return [type, ...errors].join(", ");
    }),
  ).filter((each, index, all) => all.indexOf(each) === index);
}

test("a literal's type is the one all its elements fit, in either order (#2289 B1, decision B's rows)", () => {
  // (each row's two elements, and the list's element type, `null` where no type fits them: an error at the later one)
  const rows: readonly (readonly [string, string, string | null])[] = [
    ["lives", "2.5", "inferred number"],
    ["lives", "price", "strict number"],
    ["o", "2.5", "inferred null|number"],
    ["u", '"s"', "strict integer|string"],
    ["lives", "v", "strict number|string"],
    ["u", "v", "strict number|string"],
    ["u", "2.5", null],
    ["w", "u", null],
    ["u", "un", "strict integer|null|string"],
    ["lives", "2", "strict integer"],
    ["lives", "lives", "strict integer"],
    ["null", "lives", "strict integer|null"],
    ["1", "2", "inferred integer"],
  ];
  for (const [a, b, type] of rows)
    for (const [first, later] of [
      [a, b],
      [b, a],
    ] as const) {
      const source = `${DECLARED}let xs = [${first}, ${later}]\nexit\n`;
      const at = source.lastIndexOf(later);
      const got = answered(source, "xs", ["element"]);
      if (type !== null) assert.deepEqual(got, [type], source);
      else {
        assert.equal(got.length, 1, `${source}: one answer in every mode`);
        assert.match(got[0]!, new RegExp(`, error @${at}$`, "u"), source);
      }
    }
  // (a dict's values by the same rule, R7)
  assert.deepEqual(answered(`${DECLARED}let d = dict{p: 2, q: lives}\nexit\n`, "d", ["element"]), [
    "strict integer",
  ]);
});

test("a store into a literal's place meets the type its elements fit, not its earliest's (#2289 B1)", () => {
  // (`[lives, 2.5]` holds numbers in either order, so a fraction fits and text does not; `[lives, 2]` is the declared
  // integer in either order, so a fraction does not fit)
  const cases: readonly (readonly [string, string, boolean])[] = [
    ["[lives, 2.5]", "xs.add(1.5)", true],
    ["[2.5, lives]", "xs[0] = 1.5", true],
    ["[lives, 2.5]", 'xs.add("s")', false],
    ["[2, lives]", "xs.add(1.5)", false],
    ["[lives, 2]", "xs[0] = 1.5", false],
  ];
  for (const [literal, store, valid] of cases) {
    const source = `${DECLARED}let xs = ${literal}\n${store}\nexit\n`;
    const errors = answered(source, "xs", ["element"]).map((each) => each.includes("error"));
    assert.deepEqual(errors, [!valid], source);
  }
});

test("after `[lives, 2.5]` no allowance makes a store into its place a check against a whole number (#2289 invariant)", () => {
  // (`x` copies a number down a chain long enough for its decision to stop at small demand allowances; a stop leaves an
  // element's value unknown, which decides nothing beside `lives` and makes the literal's cell undecided, R26, never
  // the declared integer)
  const chain = Array.from({ length: 24 }, (_, i) => `let x${i + 1} = x${i}`).join("\n");
  const source = `let lives: integer = 3\nlet x0 = 2.5\n${chain}\nlet xs = [lives, x24]\nxs.add(1.5)\nxs[0] = 1.5\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const sites = [source.indexOf("1.5)"), source.lastIndexOf("1.5")];
  const natural = analyseCore(request).budget;
  const demand = Math.max(...natural.demands.map((read) => read.units));
  const wrong: string[] = [];
  let marked = 0;
  const probe = (label: string, run: () => ReturnType<typeof compactAnalysis>): void => {
    const record = run();
    for (const d of record.diagnostics)
      if (sites.includes(d.site.offset) && d.class === "compile-error")
        wrong.push(`${label}: error @${d.site.offset}`);
      else if (sites.includes(d.site.offset) && d.class === "warning-runtime-check") marked += 1;
    for (const check of record.checks)
      if (sites.includes(check.site.offset) && check.against.join("|") === "integer")
        wrong.push(`${label}: check against integer @${check.site.offset}`);
  };
  for (const mode of MODES)
    inMode(mode, () => {
      for (let allowance = 1; allowance <= demand + 1; allowance += 1)
        probe(`${JSON.stringify(mode)} demand ${allowance}`, () =>
          withTestDemandAllowance(allowance, () => compactAnalysis(request)),
        );
      for (let step = 1; step <= 32; step += 1) {
        const allowance = Math.ceil((natural.total * step) / 32);
        probe(`${JSON.stringify(mode)} work ${allowance}`, () =>
          withTestAllowance(allowance, () => compactAnalysis(request)),
        );
      }
    });
  assert.deepEqual(wrong, []);
  assert.ok(marked > 0, "some allowance leaves the stores marked");
});

test("a nested literal's cell reads a projection's elements, its read counted to the decision that asks (#2289 R67's witness)", () => {
  const source =
    'let w: integer = 1\nlet q = dict{a: w}\nlet xs = [q.values, [w]]\nlet n = xs[0][0]\nsay "${n}"\nexit\n';
  assert.deepEqual(answered(source, "n", []), ["strict integer"]);
});

test("a choice's selected value is decided by its declared option, and nothing an author sees changes (#2289 R55, R61)", () => {
  // (`r55.host-at-selection`: `p0` is declared, so the options' selected values are its type, strict, by rule 5; no
  // message or check reads the decider, R61's outcome (c))
  const source =
    'let p0: object = {f0: 1}\nlet p1 = {f1: 1}\nlet p2 = {f2: 1}\np0 = hostValue\nlet options = [{text: "0", value: p0}, {text: "1", value: p1}, {text: "2", value: p2}]\nlet picked = askChoice options\nrepeat picked.f0 {}\nrepeat picked.f1 {}\nrepeat picked.f2 {}\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const options = bindingOf(source, "options");
  const decider = source.indexOf("p0}");
  for (const mode of MODES)
    inMode(mode, () => {
      const admitted = analyseCore(request).place(options, ["element", "#value"]).admitted;
      assert.ok(admitted.by === "decided", JSON.stringify(mode));
      assert.deepEqual(
        [admitted.kinds, admitted.decider?.start],
        [["object"], decider],
        JSON.stringify(mode),
      );
    });
});
