import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../../src/type-inference/core/budget.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";

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
  // (a dict's values by the same rule)
  assert.deepEqual(answered(`${DECLARED}let d = dict{p: 2, q: lives}\nexit\n`, "d", ["element"]), [
    "strict integer",
  ]);
});

test("a literal of constants answers as the same elements named do, in every order (#2289, the short route)", () => {
  // (a literal of no named element is compared by its elements' definite kinds through `fitOf`, asked only where one
  // does not fit the earliest's; the same constants bound to names take the cell query; both give the same admitted
  // type and each diagnostic at the same element with the same sentence. The site is the innermost offending expression
  // in the literal (A6): a constant's own, a named element's reference)
  const constants = [
    "1",
    "2.5",
    '"s"',
    "true",
    "null",
    "{a: 1}",
    '{a: "s"}',
    "{a: 2.5}",
    "[1]",
    '["s"]',
  ];
  const rows: string[][] = [];
  for (const a of constants) for (const b of constants) rows.push([a, b]);
  for (const a of constants.slice(0, 5))
    for (const b of constants.slice(0, 5))
      for (const c of constants.slice(0, 5)) rows.push([a, b, c]);
  rows.push(
    ["{a: 1}", "{a: 2.5}", '{a: "s"}'],
    ['{a: "s"}', "{a: 1}", "{a: 2.5}"],
    ["[1]", '["s"]', "[2.5]"],
  );
  /** The list's admitted element type, and each diagnostic by the element it is in, with its sentence. */
  const outcome = (elements: readonly string[], named: boolean): string[] => {
    const lets = named ? elements.map((each, i) => `let e${i} = ${each}\n`).join("") : "";
    const texts = named ? elements.map((_, i) => `e${i}`) : elements;
    const written = `[${texts.join(", ")}]`;
    const source = `${lets}let xs = ${written}\nexit\n`;
    // (each element's span in the literal)
    const spans: (readonly [number, number])[] = [];
    let at = source.indexOf(written) + 1;
    for (const text of texts) {
      spans.push([at, at + text.length]);
      at += text.length + 2;
    }
    const reference = (offset: number): string => {
      const i = spans.findIndex(([start, end]) => offset >= start && offset < end);
      return i >= 0 ? `element ${i}` : `@${offset}`;
    };
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const xs = bindingOf(source, "xs");
    return MODES.flatMap((mode) =>
      inMode(mode, () => {
        const answers = analyseCore(request);
        const shown = messageSource([source], answers.diagnostics);
        const admitted = answers.place(xs, ["element"]).admitted;
        return [
          admitted.by === "decided"
            ? `${admitted.inherited ? "strict" : "inferred"} ${[...admitted.kinds].sort().join("|")}`
            : admitted.by,
          ...answers.diagnostics.map(
            // (a fix quotes the literal as written, its names or its constants)
            (d) =>
              `${d.code} ${reference(d.site.start)}: ${coreMessage(d, shown).replaceAll(written, "[…]")}`,
          ),
        ];
      }),
    );
  };
  for (const row of rows)
    assert.deepEqual(outcome(row, false), outcome(row, true), `[${row.join(", ")}]`);
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
  // element's value unknown, which decides nothing beside `lives` and makes the literal's cell undecided, never
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

test("a nested literal's cell reads a projection's elements, its read counted to the decision that asks (#2289)", () => {
  const source =
    'let w: integer = 1\nlet q = dict{a: w}\nlet xs = [q.values, [w]]\nlet n = xs[0][0]\nsay "${n}"\nexit\n';
  assert.deepEqual(answered(source, "n", []), ["strict integer"]);
});

test("a choice's selected value is decided by its declared option, and nothing an author sees changes (#2289)", () => {
  // (`p0` is declared, so the options' selected values are its type, strict, by rule 5; no message or check reads the
  // decider)
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

test("a declared element that does not fit is named by its written type, at today's site (#2289 rule 3)", () => {
  // (`n` holds a whole number, but it is compared as the number it is declared: the sentence names that; the error
  // sits where main puts a misfit, the element, as `n` holds no kind that misfits)
  const declared = "let a: integer = 1\nlet n: number = 1\nlet u: integer | string = 1\n";
  const cases: readonly (readonly [string, string, string])[] = [
    [
      '[a, n, "s"]',
      "n",
      "This list mixes a whole number (integer) and a number. A list holds one type. To allow both, declare it with the type 'number[]'.",
    ],
    [
      '[{p: a}, {p: n}, {p: "s"}]',
      "{p: n}",
      "This list mixes objects whose property 'p' holds a whole number (integer) in one and a number in another. A list holds one type. Give 'p' one type in every element.",
    ],
    // (`u` holds a whole number, compared as its written union, which a number does not fit: the fix holds both)
    [
      "[2.5, u]",
      "u",
      "This list mixes a number and a whole number (integer) or text (string). A list holds one type. To allow both, declare it as 'let xs: (number | string)[] = [2.5, u]'.",
    ],
  ];
  for (const [literal, at, sentence] of cases) {
    const source = `${declared}let xs = ${literal}\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    for (const mode of MODES)
      inMode(mode, () => {
        const { diagnostics } = analyseCore(request);
        const shown = messageSource([source], diagnostics);
        const site = source.indexOf(at, source.indexOf("let xs"));
        assert.deepEqual(
          diagnostics
            .filter((d) => d.site.start === site)
            .map((d) => [d.code, d.site.end, coreMessage(d, shown)]),
          [["TSV044", site + at.length, sentence]],
          `${JSON.stringify(mode)}: ${source}`,
        );
      });
  }
});

test("equal unions spelled with and without the whole number give one type in either order (#2289 rule 2)", () => {
  const source =
    "let a: number | string = 1.5\nlet b: integer | number | string = 1\nlet xs = [a, b]\nlet ys = [b, a]\nexit\n";
  assert.deepEqual(answered(source, "xs", ["element"]), ["strict number|string"]);
  assert.deepEqual(answered(source, "ys", ["element"]), ["strict number|string"]);
});

test("a program stop that leaves a literal's cell undecided keeps its decision undecided and the read of its host element marked (#2289)", () => {
  // (at the smallest demand allowances `x0`'s chain stops the program; the decision of `r`'s element meets `x24`, a
  // stopped element, so it is left undecided and recorded as such: the program reports its stop, and `out`, the read of
  // the host element, is checked when the script runs; unrecorded, the stop went unreported and `out` unchecked)
  const chain = Array.from({ length: 24 }, (_, i) => `let x${i + 1} = x${i}`).join("\n");
  const source = `let lives: integer = 3\nlet x0 = 2.5\n${chain}\nlet r = [lives, hostValue, x24]\nlet out = r[1]\nr.add(1.5)\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const out = source.indexOf("r[1]");
  for (const mode of MODES)
    for (const demand of [1, 2, 3, 4])
      inMode(mode, () => {
        const record = withTestDemandAllowance(demand, () => compactAnalysis(request));
        const where = `${JSON.stringify(mode)} demand ${demand}`;
        assert.ok(
          record.diagnostics.some((d) => d.class === "not-checked-budget"),
          `${where}: the stop is reported`,
        );
        assert.ok(
          record.checks.some((check) => check.kind === "copy-type" && check.site.offset === out),
          `${where}: \`out\` is checked`,
        );
      });
});

test("each copy of a misfitting element errs, the later ones its literal's body leaves out included (#2289 rule 3)", () => {
  // (the second `s` copies the first at one snapshot, so the literal's body describes the first only; the cell's
  // misfits carry it to the second, which errs as the first does, not checked when the script runs)
  const source =
    'let s: string = "x"\nlet n: integer = 1\nlet xs = [n, s, s]\nlet ys = [s, n, n]\nexit\n';
  const xs = source.indexOf("[n, s, s]");
  const ys = source.indexOf("[s, n, n]");
  const sites = [xs + 4, xs + 7, ys + 4, ys + 7];
  for (const got of answered(source, "xs", ["element"]))
    assert.equal(got, `strict integer, ${sites.map((at) => `error @${at}`).join(", ")}`, source);
});
