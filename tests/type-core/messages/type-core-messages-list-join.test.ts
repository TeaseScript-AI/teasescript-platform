// A list join's mixed-element sentence, inline and kept in a variable, and its fix (#1272).

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { reportedDiagnostics } from "../../../src/type-inference/core/check-result/check-result.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { main } from "../../helpers/type-core/type-core-messages-setup.js";

/**
 * #1272 (V30 §4 and §16, ADR 0021 1.3): a list's `+` and `+=` hold both lists' elements, so elements of another type
 * mix as in a literal: the current checker's error and sentence at the join (a `+=`'s at its right operand), its fix on
 * the first operand's variable or parameter, `values` for any other. Later uses see the left list's elements (A6): a
 * read of the joined list and a store of it into a decided place add nothing. A nested join's fix writes the union
 * inside the lists, which V30 §13 permits (the current checker's `(integer[] | string[])[]` it forbids). Numbers beside
 * whole numbers, `null` and empty lists mix nothing, and a written union admits both, as the variable's (A4) or as the
 * place the join lands in (A1, where the current checker errs).
 */
test("a list's '+' mixes element types as a literal does, with the current checker's sentence at the join (#1272)", () => {
  const sited = (source: string): string[] => {
    const request = coreRequest(main(source));
    assert.ok(request !== null, source);
    const answers = analyseCore(request);
    const text = messageSource([source], answers.diagnostics);
    return [...reportedDiagnostics(answers)].map(
      (diagnostic) =>
        `${diagnostic.code} [${diagnostic.site.start},${diagnostic.site.end}) ${coreMessage(diagnostic, text)}`,
    );
  };
  const mix = (operator: string, kinds: string, fix: string): string =>
    `'${operator}' would mix ${kinds}. A list holds one type. To allow both, ${fix}.`;
  const integerString = "a whole number (integer) and text (string)";
  // (the declaration whose start value the joined list is, with its own start value; else the type in words: #1268)
  const declared = (code: string): string => `declare the list as '${code}'`;
  const typed = (type = "(integer | string)[]"): string =>
    `declare the list with the type '${type}'`;
  for (const [source, expected] of [
    [
      'let xs = [1]\nlet more = xs + ["x"]\nsay more.length\nexit',
      `TSV044 [24,34) ${mix("+", integerString, declared('let more: (integer | string)[] = xs + ["x"]'))}`,
    ],
    ['say ([1] + ["x"]).length\nexit', `TSV044 [5,16) ${mix("+", integerString, typed())}`],
    [
      'let xs = [1]\nlet ys = ["x"]\nlet both = xs + ys\nsay both.length\nexit',
      `TSV044 [39,46) ${mix("+", integerString, declared("let both: (integer | string)[] = xs + ys"))}`,
    ],
    ['let xs = [1]\nxs += ["x"]\nexit', `TSV044 [19,24) ${mix("+=", integerString, typed())}`],
    [
      'let box = {items: [1]}\nbox.items = box.items + ["x"]\nexit',
      `TSV044 [35,52) ${mix("+", integerString, typed())}`,
    ],
    [
      'let xs = [1]\nlet both = xs + ["x"]\nsay both[1] + 1\nexit',
      `TSV044 [24,34) ${mix("+", integerString, declared('let both: (integer | string)[] = xs + ["x"]'))}`,
    ],
    [
      'let left = {items: [true]}\nlet right = {items: ["x"]}\nlet both = left.items + right.items\nsay both.length\nexit',
      `TSV044 [65,89) ${mix("+", "true or false (boolean) and text (string)", declared("let both: (boolean | string)[] = left.items + right.items"))}`,
    ],
    [
      'function f(xs = [1]) {\n  return xs + ["x"]\n}\nsay f().length\nexit',
      `TSV044 [32,42) ${mix("+", integerString, typed())}`,
    ],
    [
      'function f(xs = [1] + ["x"]) {\n  say xs.length\n}\nf()\nexit',
      `TSV044 [16,27) ${mix("+", integerString, "declare the parameter as 'xs: (integer | string)[] = [1] + [\"x\"]'")}`,
    ],
    [
      'global gs = [1] + ["x"]\nexit',
      `TSV044 [12,23) ${mix("+", integerString, declared('global gs: (integer | string)[] = [1] + ["x"]'))}`,
    ],
    [
      'let xs = [[1]]\nlet more = xs + [["x"]]\nsay more.length\nexit',
      `TSV044 [26,38) ${mix("+", "a list (integer[]) and a list (string[])", declared('let more: (integer | string)[][] = xs + [["x"]]'))}`,
    ],
    [
      'let c = [{n: 1}] + [{n: "x"}]\nsay c.length\nexit',
      "TSV044 [8,29) '+' would mix objects whose property 'n' holds a whole number (integer) in one and text " +
        "(string) in another. A list holds one type. Give 'n' one type in every element.",
    ],
    // host data beside a known element decides nothing, as in a literal; a join's right operand that holds joins is
    // read with its left neighbours in source order (Codex r1 on #1310)
    [
      'let both = [1, hostValue] + ["x"] + [2]\nexit',
      `TSV044 [11,33) ${mix("+", integerString, declared('let both: (integer | string)[] = [1, hostValue] + ["x"] + [2]'))}`,
    ],
    [
      'let xs = [1] + ([2] + ["x"])\nexit',
      `TSV044 [16,27) ${mix("+", integerString, declared('let xs: (integer | string)[] = [1] + ([2] + ["x"])'))}`,
    ],
    // whole numbers beside numbers in one operand are numbers (Codex r2 on #1310); a join in a right operand is decided
    // on its own
    [
      'let both = [1, 1.5] + ["x"]\nexit',
      `TSV044 [11,27) ${mix("+", "a number and text (string)", declared('let both: (number | string)[] = [1, 1.5] + ["x"]'))}`,
    ],
    [
      'let ys = [1]\nlet both = [1] + (ys + ["x"])\nexit',
      `TSV044 [31,41) ${mix("+", integerString, declared('let both: (integer | string)[] = [1] + (ys + ["x"])'))}`,
    ],
    // null elements decide nothing, but each side's sentence and the union the fix writes hold them (Codex r3 on #1310)
    [
      'let xs = [1, null]\nlet both = xs + ["x"]\nexit',
      `TSV044 [30,40) ${mix("+", "a whole number (integer) or null and text (string)", declared('let both: (integer | string | null)[] = xs + ["x"]'))}`,
    ],
    [
      'let xs = [1]\nlet both = xs + ["x", null]\nexit',
      `TSV044 [24,40) ${mix("+", "a whole number (integer) and text (string) or null", declared('let both: (integer | string | null)[] = xs + ["x", null]'))}`,
    ],
    // a function's written result decides as a variable's written type does (Codex r5 on #1310)
    [
      'function make: (integer | boolean)[] {\n  return [1]\n}\nlet both = make() + ["x"]\nexit',
      `TSV044 [65,79) ${mix("+", "a whole number (integer) or true or false (boolean) and text (string)", declared('let both: (integer | boolean | string)[] = make() + ["x"]'))}`,
    ],
    // a run of joins has one element type, whole numbers beside numbers numbers
    [
      'say ([1] + [1.5] + ["x"]).length\nexit',
      `TSV044 [5,24) ${mix("+", "a number and text (string)", typed("(number | string)[]"))}`,
    ],
    // an operand reaching an earlier join takes its composed type: beside a part holding only `null`, which decides
    // nothing but keeps its `null` (Codex r15's N1 on #1310)
    [
      "let s = [[null], ([1] + [2])][0] + [true]\nexit",
      `TSV044 [8,41) ${mix("+", "a whole number (integer) or null and true or false (boolean)", declared("let s: (integer | boolean | null)[] = [[null], ([1] + [2])][0] + [true]"))}`,
    ],
    ["let xs = [1]\nlet b = [1.5]\nsay (xs + b).length\nexit", null],
    ['let xs = []\nlet more = xs + ["x"]\nsay more.length\nexit', null],
    ["let xs = [1]\nlet more = xs + []\nsay more.length\nexit", null],
    ["let xs = [1]\nlet more = xs + [null]\nsay more.length\nexit", null],
    ['let xs: (integer | string)[] = [1]\nlet both = xs + ["x"]\nsay both.length\nexit', null],
    [
      'let xs: (integer | string)[][] = [[1]]\nlet more = xs + [["x"]]\nsay more.length\nexit',
      null,
    ],
    ['let ys: (integer | string)[] = ["x"]\nlet both = [1] + ys\nsay both.length\nexit', null],
    ['let xs = [1]\nlet both: (integer | string)[] = xs + ["x"]\nsay both.length\nexit', null],
  ] as const)
    assert.deepEqual(sited(source), expected === null ? [] : [expected], source);
});

/**
 * #1272 (Astra's B1, Codex r7's B1 on #1310, ADR 0021 1.3, 1.10): a join answers the same written inline as kept in a
 * variable first, its elements' type the one a variable holding them is decided by. Unions declared on the left
 * operand, on the right, on both, alike or overlapping (`(integer | string)[]` beside `(integer | boolean)[]`), or
 * none; the join inline in a store (as either operand of another join), a join nested a level deeper, an interpolation,
 * beside text or a truth value; both orders, the sharing on and off. Each inline form errs as its kept form does, with
 * the same kinds; inline in an argument the join lands in the parameter's written union, which holds both (A1).
 */
/**
 * A source's compile errors, a list join's with its decided and offending kinds, the same in both orders with the
 * sharing on and off.
 */
function joinAnswers(source: string): string[] {
  const request = coreRequest(main(source));
  assert.ok(request !== null, source);
  const runs: string[][] = [];
  for (const shared of [true, false])
    for (const reversed of [false, true]) {
      const go = () => analyseCore(request);
      const ordered = reversed
        ? () =>
            withConsumerOrder(
              (list) => [...list].reverse(),
              () => withSolverSeam({ reverseWorklist: true }, go),
            )
        : go;
      const answers = shared ? ordered() : withoutSharing(ordered);
      runs.push(
        [...reportedDiagnostics(answers)]
          .filter((diagnostic) => diagnostic.class === "compile-error")
          .map((diagnostic) =>
            "rule" in diagnostic && diagnostic.rule.rule === "mixed"
              ? `${diagnostic.code} ${JSON.stringify([diagnostic.rule.type, diagnostic.kinds])}`
              : diagnostic.code,
          ),
      );
    }
  for (const run of runs) assert.deepEqual(run, runs[0], source);
  return runs[0]!;
}

test("a list join answers the same inline as kept in a variable (#1272)", () => {
  const answers = joinAnswers;
  const joins = { left: "typed + [1]", right: "[1] + typed", both: "typed + other" };
  const contexts = [
    (join: string, beside: string) => `let result = ${beside} + ${join}\nsay result.length`,
    (join: string, beside: string) => `let result = ${join} + ${beside}\nsay result.length`,
    (join: string, beside: string) => `show(${beside} + ${join})`,
    (join: string, beside: string) => `let result = [2] + (${beside} + ${join})\nsay result.length`,
    (join: string, beside: string) => `say "\${(${join} + ${beside}).length}"`,
  ];
  const show = "function show(xs: (integer | string)[]) {\n  say xs.length\n}\n";
  const declarations = {
    none: ["", ""],
    alike: [": (integer | string)[]", ": (integer | string)[]"],
    overlapping: [": (integer | string)[]", ": (integer | boolean)[]"],
  };
  for (const [declared, [typed, other]] of Object.entries(declarations))
    for (const beside of ['["b"]', "[true]"])
      for (const [position, join] of Object.entries(joins))
        for (const context of contexts) {
          const start = `${show}let typed${typed} = ["a"]\nlet other${other} = [2]\n`;
          const inline = answers(`${start}${context(`(${join})`, beside)}\nexit\n`);
          const name = `${declared} ${position}: ${context("J", beside)}`;
          if (context("J", beside).startsWith("show(")) {
            if (beside === '["b"]' && declared === "alike") assert.deepEqual(inline, [], name);
            continue;
          }
          const kept = answers(`${start}let inner = ${join}\n${context("inner", beside)}\nexit\n`);
          // (kept, the inner join's error comes on its own line first)
          assert.deepEqual(inline.toSorted(), kept.toSorted(), name);
          // (a union holds the text beside it, never a truth value beside it that neither declaration holds)
          if (declared === "alike" && beside === '["b"]') assert.deepEqual(inline, [], name);
          if (declared !== "none" && beside === "[true]" && position === "both")
            assert.ok(
              inline.some((answer) => answer.startsWith("TSV044")),
              name,
            );
        }
});

/**
 * #1272 (Astra r2's B1 and Codex r9's B1 on #1310, ADR 0021 1.3, V30 §13 and §16, `joinedDomain`): an operand's element
 * domain decides a join as it decides a variable holding the join. An open one (`list`, `list[]` with or without an
 * element yet) leaves the join open there and below, whatever decided before or after it, a written type included, so
 * nothing beside it errs and a variable holding the join takes any element; one that holds only `null` (`null[]`,
 * `null[][]`) decides nothing and makes the joined list optional, so a join errs only where its other operands
 * conflict, and a variable holding it takes `null`; a strict written destination stays strict. Each domain (beside a
 * concrete, a nullable written, a written union and a two-level one) as either operand of a join, alone or nested in
 * either operand of another, beside whole numbers, text, `null` or a written `integer[]` before or after it; a binding,
 * a copy, a call with a written result, and a call returning it inferred (inline only, #1393); inline as kept, both
 * orders, the sharing on and off.
 */
test("an open or null-only operand proves no conflict in a list join, inline as kept (#1272)", () => {
  const domains = [
    ["concrete", 1, "let d = [1]"],
    ["nullable", 1, "let d: integer?[] = [1]"],
    ["union", 1, "let d: (integer | string)[] = [1]"],
    ["open", 1, "let d: list = [1]"],
    ["null", 1, "let d: null[] = [null]"],
    ["two-concrete", 2, "let d = [[1]]"],
    ["two-open", 2, "let d: list[] = [[1]]"],
    ["two-open-empty", 2, "let d: list[] = []"],
    ["two-null", 2, "let d: null[][] = [[null]]"],
  ] as const;
  // (whole numbers, text, `null`, and `w`, a written `integer[]`: before, after or beside the domain's operand)
  const neighbours = { I: "2", S: '"tail"', N: "null", W: "w" } as const;
  const positions = [
    ["left", "X", (j: string) => j],
    ["right", "X", (j: string) => j],
    ["left of left", "XY", (j: string) => `${j} + Y`],
    ["right of left", "XY", (j: string) => `${j} + Y`],
    ["left of right", "XY", (j: string) => `Y + ${j}`],
    ["right of right", "XY", (j: string) => `Y + ${j}`],
  ] as const;
  const pairs = [
    ["I", "S"],
    ["N", "S"],
    ["S", "I"],
    ["W", "S"],
    ["S", "W"],
  ] as const;
  let checked = 0;
  for (const [domain, depth, declaration] of domains) {
    const wrap = (element: string) =>
      element === "w" ? element : "[".repeat(depth) + element + "]".repeat(depth);
    const forms: (readonly [string, string, string])[] = [["binding", "", "d"]];
    if (domain === "open" || domain === "null")
      forms.push(
        ["copy", "let c = d\n", "c"],
        [
          "written call",
          `function make: ${domain === "open" ? "list" : "null[]"} {\n  return d\n}\n`,
          "make()",
        ],
      );
    if (domain === "open" || domain === "union")
      forms.push(["inferred call", "function make {\n  return d\n}\n", "make()"]);
    const open = domain.includes("open");
    const nulls = domain === "null" || domain === "two-null";
    for (const [form, extra, d] of forms)
      for (const [position, uses, outer] of positions)
        for (const [x, y] of uses === "X"
          ? (["I", "S", "N", "W"] as const).map((x) => [x, "I"] as const)
          : pairs) {
          // (the other forms, the controls and a join in a right operand at fewer neighbours: `w` before or after it,
          // whole numbers, text beside them)
          if (form !== "binding" && !(position === "left" || position === "right of left"))
            continue;
          if ((form !== "binding" || position.endsWith("of right")) && x === "N") continue;
          if (depth === 2 && position.endsWith("of right") && x !== "W") continue;
          if (form !== "binding" && x === "S") continue;
          if (!open && !nulls && !(uses === "X" ? x === "S" : x === "I" || x === "W")) continue;
          const [X, Y] = [wrap(neighbours[x]), wrap(neighbours[y])];
          const inner = position.startsWith("left") ? `${d} + ${X}` : `${X} + ${d}`;
          const result = (join: string) => outer(join).replace("Y", Y);
          const start = `let w: integer${"[]".repeat(depth)} = ${wrap("7")}\n${declaration}\n${extra}`;
          const nested = uses === "XY";
          const name = `${domain} ${form} ${position}: ${result(`(${inner})`)}`;
          const inline = joinAnswers(
            `${start}let result = ${nested ? result(`(${inner})`) : inner}\nsay result.length\nexit\n`,
          );
          checked += 1;
          // (inline as kept; a variable holding an inferred call's result loses its written type: #1393)
          if (nested && form !== "inferred call")
            assert.deepEqual(
              inline.toSorted(),
              joinAnswers(
                `${start}let held = ${inner}\nlet result = ${result("held")}\nsay result.length\nexit\n`,
              ).toSorted(),
              name,
            );
          // (open: nothing errs, and a variable holding the join takes text; only `null`: an error only where whole
          // numbers meet text beside it, and a variable holding the join takes `null`)
          if (open) assert.deepEqual(inline, [], name);
          if (nulls) {
            const kinds = new Set(
              [x, y].flatMap((kind) => (kind === "N" ? [] : [kind === "W" ? "I" : kind])),
            );
            assert.equal(
              inline.some((answer) => answer.startsWith("TSV044")),
              nested && kinds.size === 2,
              name,
            );
          }
          if (!nested && form !== "inferred call" && (open || nulls) && (x === "I" || x === "W"))
            assert.deepEqual(
              joinAnswers(
                `${start}let held = ${inner}\nheld.add(${"[".repeat(depth - 1)}${open ? '"tail"' : "null"}${"]".repeat(depth - 1)})\nsay held.length\nexit\n`,
              ),
              [],
              `${name}, then a store`,
            );
        }
  }
  assert.ok(checked > 150, `${checked} joins`);
  // a strict written destination stays strict: a `+=` or a store back into a written `null[]` errs
  for (const store of ["d += [1]", "d = d + [1]"])
    assert.deepEqual(
      joinAnswers(`let d: null[] = [null]\n${store}\nsay d.length\nexit\n`),
      [`TSV044 ${JSON.stringify([["null"], ["integer"]])}`],
      store,
    );
  // a call's written result a join carries deeper than any written copy (in a literal's property or element, below
  // two): the decider reads it at every depth a stop stands at, the values' too (#1410's `stopDepths`), so an open one
  // takes text and a union keeps out what it does not hold, warnings included, as V1 has them
  const reported = (source: string): string[] => {
    const request = coreRequest(main(source));
    assert.ok(request !== null, source);
    const runs = [true, false].flatMap((shared) =>
      [false, true].map((reversed) => {
        const go = () => analyseCore(request);
        const ordered = reversed
          ? () =>
              withConsumerOrder(
                (list) => [...list].reverse(),
                () => withSolverSeam({ reverseWorklist: true }, go),
              )
          : go;
        return reportedDiagnostics(shared ? ordered() : withoutSharing(ordered)).map(
          (diagnostic) => `${diagnostic.class === "compile-error" ? "E" : "W"} ${diagnostic.code}`,
        );
      }),
    );
    for (const run of runs) assert.deepEqual(run, runs[0], source);
    return runs[0]!;
  };
  for (const [contain, read] of [
    [(j: string) => `{n: ${j}}`, ".n"],
    [(j: string) => `[${j}]`, "[0]"],
    [(j: string) => `{m: {n: ${j}}}`, ".m.n"],
    [(j: string) => `[{n: ${j}}]`, "[0].n"],
  ] as const)
    for (const join of ["make() + [2]", "[2] + make()"])
      for (const [result, element, expected] of [
        ["list", '"tail"', []],
        ["(integer | string)[]", '"tail"', []],
        ["(integer | string)[]", "true", ["E TSV041"]],
        ["(integer | string)[]", "null", ["E TSV041"]],
      ] as const) {
        const source = `function make: ${result} {\n  return [1]\n}\nlet o = ${contain(join)}\no${read}.add(${element})\nsay o${read}.length\nexit\n`;
        assert.deepEqual(reported(source), expected, source);
      }
});

/**
 * #1272 (Codex r2–r5 on #1310): the declaration a join's fix offers, the variable the join starts with the
 * type (#1268), holds every value the joined lists bring, at every list level, so pasted in place of the source's own it
 * takes the error away and adds nothing. Every pair of element kinds, either order (whole numbers, numbers, text, truth
 * values, objects, `null` beside a number and beside text); nested lists, optional at one level or more; a number only
 * external data gives; a later `null` in a run; and the variable's own later stores of a kind it holds.
 */
test("a list join's fix, pasted as the declaration it offers, holds every element the join brings (#1272)", () => {
  const reported = (source: string): string[] => {
    const request = coreRequest(main(source));
    assert.ok(request !== null, source);
    const answers = analyseCore(request);
    const text = messageSource([source], answers.diagnostics);
    return [...reportedDiagnostics(answers)].map(
      (diagnostic) => `${diagnostic.code} ${coreMessage(diagnostic, text)}`,
    );
  };
  const elements = ["1", "1.5", '"x"', "true", "{n: 1}", "1, null", "null, 2.5", '"x", null'];
  const sources: string[] = [];
  for (const left of elements)
    for (const right of elements)
      sources.push(`let xs = [${left}]\nlet both = xs + [${right}]\nexit\n`);
  sources.push(
    'let xs = [[1], null]\nlet both = xs + [["x"]]\nexit\n',
    'let xs = [[[1]], [null], null]\nlet both = xs + [[["x"]]]\nexit\n',
    'let xs = [1, hostValue / 2]\nlet both = xs + ["x"]\nexit\n',
    'let xs = [1]\nlet both = xs + ["x"] + [null]\nexit\n',
    // (a number stored later is among what the variable holds, Codex r5)
    'let xs = [1]\nlet both = xs + ["x"]\nboth.add(1.5)\nexit\n',
    'let xs = [1]\nlet both = xs + ["x"]\nboth[0] = 2.5\nexit\n',
  );
  let mixed = 0;
  for (const source of sources) {
    const found = reported(source);
    const error = found.filter((line) => line.startsWith("TSV044"));
    if (error.length === 0) continue;
    mixed += 1;
    const fix = /declare the list as '(let both: [^=]+ = (.+))'\.$/.exec(error.join("\n"));
    assert.ok(error.length === 1 && fix !== null, `${source}: ${found.join(" | ")}`);
    const pasted = source.replace(`let both = ${fix[2]!}`, fix[1]!);
    assert.notEqual(pasted, source, fix[1]);
    // (external data is checked where it comes in, against the type the fix declares, ADR 0021 1.7)
    assert.deepEqual(
      reported(pasted).filter((line) => !line.startsWith("TSV041") || !line.includes("hostValue")),
      found.filter((line) => line !== error[0]),
      pasted,
    );
  }
  assert.equal(mixed, 48);
});
