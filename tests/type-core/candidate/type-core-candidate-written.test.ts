// Written types on the candidate route: a literal's projections, an object's own first, last and random, deep literals,
// written copies (A4).

import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import { run } from "../../../src/runtime/engine.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  candidate,
  sited,
  inBothOrders,
  inBothOrdersAs,
  runWith,
  assertRuns,
  checksOf,
} from "../../helpers/type-core/type-core-candidate-setup.js";

test("a projection of a literal carries its elements' types and host data on the candidate route (round 11)", () => {
  // A8 through the projection, direct and named; A2 across a change of the named list; C1 and C9 at the store, before
  // any later effect
  for (const [source, diagnostics] of [
    ['let xs = [[[1]][0], [["bad"]][0]]\nsay "AFTER"\nexit\n', ["error TSV044@20"]],
    [
      'let v1 = [1]\nlet v2 = ["bad"]\nlet xs = [[v1][0], [v2][0]]\nsay "AFTER"\nexit\n',
      ["error TSV044@49"],
    ],
    [
      'let a = [1]\nlet xs = []\nxs = [[a][0], [[1]][0]]\na = ["bad"]\nxs = [[a][0], [[1]][0]]\nexit\n',
      ["error TSV041@53"],
    ],
  ] as const)
    assert.deepEqual(
      inBothOrders(() => sited(candidate(source))),
      diagnostics,
      source,
    );
  const host = 'let a = [hostValue]\nlet xs = [[[1]][0], [a][0]]\nsay "AFTER"\nexit\n';
  const [{ plan }, compiled] = inBothOrdersAs(
    () => candidate(host),
    (result) => ({
      diagnostics: sited(result),
      checked: result.plan === null ? null : checksOf(result.plan),
    }),
  );
  assert.deepEqual(compiled, {
    diagnostics: ["warning TSV041@29"],
    checked: ["20:47 list<list<integer>>"],
  });
  assert.ok(plan !== null);
  assert.deepEqual(runWith(plan, 2), { status: "halted", says: ["AFTER"], failure: null });
  assert.deepEqual(runWith(plan, "bad"), { status: "failed", says: [], failure: "TSR058@29:47" });
});

test("a projected written integer list stays strict on the candidate route (A4, round 15 B3)", () => {
  const source = 'let typed: integer[] = [1]\nlet xs = [typed][0]\nxs = [2.5]\nsay "AFTER"\nexit\n';
  const [compiled, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
  assert.deepEqual(diagnostics, [`error TSV041@${source.indexOf("2.5")}`]);
  assert.equal(compiled.plan, null);
});

test("a projection of a written nested list stays strict on the candidate route (A4, F12, Astra r2 B2)", () => {
  const source =
    'let source: integer[][] = [[4]]\nlet result = source[0]\nresult = [3.5]\nsay "AFTER"\nexit\n';
  const [compiled, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
  assert.deepEqual(diagnostics, [`error TSV041@${source.indexOf("3.5")}`]);
  assert.equal(compiled.plan, null);
});

test("a written scalar a singleton literal gives stays strict on the candidate route (A4, Codex r16 B1)", () => {
  const source = 'let typed: integer = 1\nlet xs = [typed][0]\nxs = 2.5\nsay "AFTER"\nexit\n';
  const [compiled, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
  assert.deepEqual(diagnostics, [`error TSV041@${source.lastIndexOf("2.5")}`]);
  assert.equal(compiled.plan, null);
});

/**
 * #1240 (V30 §15, ADR 0021 §1.4): a store into an object's own `first`, `last` or `random` sets that property, as any
 * property's store does, its value checked against the property's type; the runtime assigns it so. Its read stays F11's
 * warning, never an error. Each name, a copy, a nested object and a list's element compile and run with the stored
 * value, quiet as the current checker where nothing reads the property back; inside `if`, a function and a compound
 * store (outside the slice) the core finds nothing; a value of another type gets the current checker's error and fix,
 * and a list, which has no property to assign, its error.
 */
test("a store into an object's own first, last or random sets that property and checks its type (#1240)", () => {
  for (const [source, says, quiet] of [
    ['let record = {first: 1}\nrecord.first = 2\nsay "DONE"\nexit\n', ["DONE"], true],
    ["let a = {last: 1}\na.last = 2\nexit\n", [], true],
    ['let box = {entry: {random: 1}}\nbox.entry.random = 2\nsay "DONE"\nexit\n', ["DONE"], true],
    ["let a = {last: 1}\na.last = 2\nsay a.last\nexit\n", ["2"], false],
    [
      "let source = {first: 1}\nlet copied = source\ncopied.first = 2\nsay copied.first\nexit\n",
      ["2"],
      false,
    ],
    ["let xs = [{random: 1}]\nxs[0].random = 2\nsay xs[0].random\nexit\n", ["2"], false],
  ] as const) {
    const [{ plan }, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
    assert.ok(
      quiet
        ? diagnostics.length === 0
        : diagnostics.every((diagnostic) => diagnostic.startsWith("warning")),
      `${source}: ${diagnostics.join(", ")}`,
    );
    assert.ok(plan !== null, source);
    assert.deepEqual(runWith(plan, 0).says, says, source);
  }
  for (const source of [
    "let a = {first: 1, n: 2}\nif a.n > 1 {\n  a.first = 3\n}\nexit\n",
    "let a = {last: 1}\nfunction f {\n  a.last = 4\n}\nf()\nexit\n",
  ]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    assert.deepEqual(analyseCore(request).diagnostics, [], source);
  }
  // a compound store reads the own property first, as its binary form does (F11's own selection, opaque: Astra's G2)
  const operands = (source: string): string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    return compactAnalysis(request)
      .checks.filter((check) => check.kind === "operand")
      .map((check) => `${check.target} [${check.against.join(", ")}] @${check.site.offset}`);
  };
  assert.deepEqual(operands("let a = {random: 1}\na.random += 2\nexit\n"), [
    "a.random [integer, number] @20",
  ]);
  assert.deepEqual(
    operands("let a = {random: 1}\na.random += 2\nexit\n"),
    operands("let a = {random: 1}\na.random = a.random + 2\nexit\n").map((check) =>
      check.replace("@31", "@20"),
    ),
  );
  const wrong = candidate('let a = {first: 1}\na.first = "bad"\nexit\n');
  assert.deepEqual(sited(wrong), ["error TSV041@29"]);
  assert.match(
    wrong.diagnostics[0]!.message,
    / Use a separate property for a value of another type\.$/,
  );
  assert.deepEqual(sited(candidate("let xs = [1, 2]\nxs.first = 5\nexit\n")), ["error TSV043@16"]);
});

/**
 * #1275 (ADR 0021 §1.1, §1.4, §1.10): a store below an object's own `first`, `last` or `random` stores into the
 * property below it, so its value is checked against that property's type as below any other property, while F11 still
 * reads such a property opaquely. The owner's reviewer's matrix: each name × a direct, a copied, a projected and an
 * indexed receiver × a literal of another type (the current checker's TSV041, no plan) and a host value (its store
 * checked: text stops the run there, a whole number is stored), in both orders and with the sharing on and off. A final
 * store keeps #1260's check, an object's own `random` draws nothing, and a list's selection stays its element.
 */
test("a store below an object's own first, last or random checks the property it stores into (#1275)", () => {
  const receivers = [
    ["let box = {NAME: {n: 1}}\n", "box"],
    ["let seed = {NAME: {n: 1}}\nlet box = seed\n", "box"],
    ["let outer = {box: {NAME: {n: 1}}}\n", "outer.box"],
    ["let boxes = [{NAME: {n: 1}}]\n", "boxes[0]"],
  ] as const;
  for (const name of ["first", "last", "random"])
    for (const [declaration, receiver] of receivers)
      for (const value of ['"bad"', "hostValue"]) {
        const store = `${receiver}.${name}.n = ${value}\n`;
        const source =
          `${declaration.replace("NAME", name)}say "BEFORE"\n${store}` +
          `say ${receiver}.${name}.n\nsay "AFTER"\nexit\n`;
        const at = source.indexOf(store) + store.indexOf(value);
        for (const shared of [true, false]) {
          const [{ plan }, diagnostics] = (shared ? <T>(run: () => T) => run() : withoutSharing)(
            () => inBothOrdersAs(() => candidate(source), sited),
          );
          const errors = diagnostics.filter((diagnostic) => diagnostic.startsWith("error"));
          if (value !== "hostValue") {
            assert.deepEqual(errors, [`error TSV041@${at}`], source);
            assert.equal(plan, null, source);
            continue;
          }
          assert.deepEqual(errors, [], source);
          assert.ok(diagnostics.includes(`warning TSV041@${at}`), `${source}: ${diagnostics}`);
          assert.ok(plan !== null, source);
          assert.deepEqual(
            runWith(plan, "bad"),
            { status: "failed", failure: `TSR058@${at}:${at + value.length}`, says: ["BEFORE"] },
            source,
          );
          assert.deepEqual(runWith(plan, 2).says, ["BEFORE", "2", "AFTER"], source);
        }
      }
  // a receiver admission decided keeps its object proof beside a later host value or a rejected store (Codex r1 on
  // #1310)
  for (const [parent, expected] of [
    ["hostValue", ["error TSV041@91"]],
    ["[]", ["error TSV041@57", "error TSV041@84"]],
  ] as const) {
    const source = `let a = {first: {last: {random: {n: 1}}}}\na.first.last = ${parent}\na.first.last.random.n = "bad"\nexit\n`;
    const compiled = inBothOrders(() => candidate(source));
    assert.deepEqual(
      sited(compiled).filter((diagnostic) => diagnostic.startsWith("error")),
      expected,
      source,
    );
    assert.equal(compiled.plan, null, source);
  }
  // #1260's final store keeps its check
  const final = candidate("let box = {first: 1}\nbox.first = hostValue\nsay box.first\nexit\n");
  assert.ok(sited(final).includes("warning TSV041@33"), sited(final).join(", "));
  assert.equal(runWith(final.plan!, "bad").failure, "TSR058@33:42");
  // an object's own `random` is its property: storing below it draws nothing
  const own = candidate(
    "let box = {random: {n: 1}}\nbox.random.n = hostValue\nsay box.random.n\nexit\n",
  );
  const start = createImmediatePacingRuntimeSnapshot(own.plan!, { globals: { hostValue: 2 } });
  assert.deepEqual(run(own.plan!, start).snapshot.rng, start.rng);
  // a list's selection stays its element, its element's property checked
  for (const [source, expected] of [
    ['let xs = [{n: 1}]\nxs.first.n = "bad"\nexit\n', ["compile-error store"]],
    ['let xs = [{n: 1}]\nxs.random.n = "bad"\nexit\n', ["compile-error store"]],
    ["let xs = [{n: 1}]\nxs.first.n = 2\nexit\n", []],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    assert.deepEqual(
      analyseCore(request).diagnostics.map((diagnostic) =>
        diagnostic.kind === "written-type" || diagnostic.kind === "budget"
          ? diagnostic.kind
          : `${diagnostic.class} ${diagnostic.rule.rule}`,
      ),
      expected,
      source,
    );
  }
});

/**
 * Deep and broad list literals on the candidate route: their indexes share one text per path and order
 * their identities by path id, and the core charges what they keep. A read 64 levels into a literal, through two
 * aliases, of external data 32 levels in and of the last of 512 elements or 300 rows; and two literals 40 deep stored
 * into one place, alike, differing at their leaf's kind, or one holding an empty list at its depth: each compiles to
 * its diagnostics, and its plan runs to the says and the failure its leaves give, in both orders. (Records, dicts and
 * sets are outside the slice until it is complete, S9b; the core's deep reads of them are `deep-literal-scale.test.ts`'s.)
 */
test("deep and broad list literals compile and run as their leaves give, in both orders", () => {
  const nested = (depth: number, leaf: string): string =>
    `${"[".repeat(depth)}${leaf}${"]".repeat(depth)}`;
  const reads = (name: string, depth: number): string => `${name}${"[0]".repeat(depth)}`;
  const counted = (read: string, word: string): string =>
    `let n: integer = ${read}\nrepeat n {\n  say "${word}"\n}\nexit\n`;
  const compiled = (source: string) =>
    inBothOrders(() => {
      const result = candidate(source);
      return { sited: sited(result), plan: result.plan };
    });
  const says = (word: string, count: number): string[] => Array<string>(count).fill(word);

  // a read 64 levels in, quiet, and the same read of text, C1's error at the read
  const deep = `let value = ${nested(64, "3")}\n${counted(reads("value", 64), "deep")}`;
  const quiet = compiled(deep);
  assert.deepEqual(quiet.sited, []);
  assert.ok(quiet.plan !== null);
  assert.deepEqual(checksOf(quiet.plan), []);
  assertRuns(quiet.plan, "deep", says("deep", 3), [[0, null]]);
  const text = `let value = ${nested(64, '"x"')}\n${counted(reads("value", 64), "deep")}`;
  assert.deepEqual(compiled(text), {
    sited: [`error TSV041@${text.indexOf("value[0]")}`],
    plan: null,
  });

  // external data 32 levels in: the store warns and checks it, where the read stands
  const host = `let value = ${nested(32, "hostValue")}\n${counted(reads("value", 32), "host")}`;
  const read = host.indexOf("value[0]");
  const external = compiled(host);
  assert.deepEqual(external.sited, [`warning TSV041@${read}`]);
  assert.ok(external.plan !== null);
  assertRuns(external.plan, "host", says("host", 2), [
    [2, null],
    ["x", `TSR058@${read}:${read + reads("value", 32).length}`],
  ]);

  // two aliases of a literal 48 deep; the last of 512 elements; the last of 300 rows
  for (const [name, source, count] of [
    [
      "aliases",
      `let a = ${nested(48, "2")}\nlet b = a\nlet c = b\n${counted(reads("c", 48), "aliases")}`,
      2,
    ],
    ["breadth", `let row = [${"0, ".repeat(511)}2]\n${counted("row[511]", "breadth")}`, 2],
    [
      "rows",
      `let grid = [${Array.from({ length: 300 }, (_, i) => `[${i % 3}]`).join(", ")}]\n${counted("grid[299][0]", "rows")}`,
      299 % 3,
    ],
  ] as const) {
    const result = compiled(source);
    assert.deepEqual(result.sited, [], name);
    assert.ok(result.plan !== null, name);
    assertRuns(result.plan, name, says(name, count), [[0, null]]);
  }

  // two literals 40 deep stored into one place: alike they are one integer; a text leaf is A6's error at it; an empty
  // list at their depth fails the read where it is taken
  const twice = (other: string, word: string): string =>
    `let pick = ${nested(40, "1")}\nlet flag: boolean = hostValue\nif flag {\n  pick = ${other}\n}\n${counted(reads("pick", 40), word)}`;
  const flag = (source: string): string => {
    const at = source.indexOf("hostValue");
    return `TSR058@${at}:${at + "hostValue".length}`;
  };
  const alike = twice(nested(40, "2"), "alike");
  const both = compiled(alike);
  assert.deepEqual(both.sited, [`warning TSV041@${alike.indexOf("hostValue")}`]);
  assert.ok(both.plan !== null);
  assertRuns(both.plan, "alike", says("alike", 1), [
    [false, null],
    [2, flag(alike)],
  ]);
  assertRuns(both.plan, "alike", says("alike", 2), [[true, null]]);
  const textual = twice(nested(40, '"x"'), "textual");
  assert.deepEqual(compiled(textual), {
    sited: [
      `warning TSV041@${textual.indexOf("hostValue")}`,
      `error TSV041@${textual.indexOf('"x"')}`,
    ],
    plan: null,
  });
  const emptied = twice(nested(39, "[]"), "emptied");
  const empty = compiled(emptied);
  assert.deepEqual(empty.sited, [`warning TSV041@${emptied.indexOf("hostValue")}`]);
  assert.ok(empty.plan !== null);
  assertRuns(empty.plan, "emptied", says("emptied", 1), [[false, null]]);
  const last = emptied.lastIndexOf("[0]") + 1;
  assert.deepEqual(runWith(empty.plan, true), {
    status: "failed",
    says: [],
    failure: `TSR025@${last}:${last + 1}`,
  });
});

/**
 * A copy of a written binding keeps its type beside an unwritten copy of the same source (A4, Astra r5
 * B1): `let a = raw`, `let b: integer[] = raw`, then `out` takes both, and a later store brings other host data. The
 * written copy decides `out`'s element by `integer[]`, whichever copy comes first, at depths one and two: each of the
 * three stores owes its C1 against the whole written type, the host data its boundary; the plan checks every store; the
 * fitting host value says AFTER and each bad one fails at the third store's value, nothing said.
 */
test("a copy of a written binding keeps its type beside a copy of the same source, in both orders (A4)", () => {
  for (const nested of [false, true])
    for (const [first, second] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const wrap = (text: string): string => (nested ? `[${text}]` : text);
      const source =
        `let raw = [${wrap("hostValue")}]\nlet a = raw\nlet b: integer[]${nested ? "[]" : ""} = raw\n` +
        `let out = ${first}\nout = ${second}\nout = [${wrap("otherHost")}]\nsay "AFTER"\nexit\n`;
      const name = `${nested ? "depth two" : "depth one"}, ${first} then ${second}`;
      const target = nested ? "out.element.element" : "out.element";
      const at = (text: string, from = 0): string => {
        const start = source.indexOf(text, from);
        return `${start}:${start + text.length}`;
      };
      const host = at("otherHost");
      const tail = source.indexOf("out = [");
      const checks = inBothOrders(() => {
        const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "otherHost"]);
        assert.ok(request !== null, name);
        return compactAnalysis(request)
          .checks.filter((check) => check.target === target && check.kind === "copy-type")
          .map(
            (check) =>
              `${check.boundary ? "B" : "C"} [${check.against.join("|")}] ${check.site.offset}:${check.site.end}`,
          )
          .sort();
      });
      assert.deepEqual(
        checks,
        [
          `C [integer] ${at(first, source.indexOf("let out = "))}`,
          `C [integer] ${at(second, source.indexOf("\nout = "))}`,
          `C [integer] ${host}`,
          `B [integer] ${host}`,
        ].sort(),
        name,
      );
      const options = { globals: ["hostValue", "otherHost"] };
      const plan = inBothOrders(() => compileSourceWithBackend(source, options, CORE_BACKEND).plan);
      assert.ok(plan !== null, name);
      const type = nested ? "list<list<integer>>" : "list<integer>";
      // (each statement's span: `b`'s declaration, which holds host data under its written type, and out's three stores)
      const line = (text: string): string => {
        const start = source.indexOf(text);
        return `${start}:${source.indexOf("\n", start)} ${type}`;
      };
      assert.deepEqual(
        checksOf(plan),
        [line("let b"), line("let out"), line(`out = ${second}`), line("out = [")],
        `${name}: b's store and every store of out checked`,
      );
      const end = source.indexOf("\n", tail);
      for (const otherHost of [1, 2.5, "bad"]) {
        const result = run(
          plan,
          createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue: 1, otherHost } }),
        );
        const failure = result.events.find((event) => event.kind === "runtimeFailure");
        assert.deepEqual(
          {
            status: result.snapshot.status,
            says: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
            failure:
              failure?.kind === "runtimeFailure"
                ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
                : null,
          },
          otherHost === 1
            ? { status: "halted", says: ["AFTER"], failure: null }
            : { status: "failed", says: [], failure: `TSR058@${tail + 6}:${end}` },
          `${name} with ${JSON.stringify(otherHost)}`,
        );
      }
    }
});

/**
 * A2 with F17b and A8: of a literal's elements, one read the literal's `get` never gives and a direct read of the same
 * snapshot beside it, the direct read decides; a walk's stop shares another's only through the same operations, selected
 * alike (Astra r5 D1): the decider is the direct `raw` at 68:71, never the later `"tail"`.
 */
test("a decider beside an unselected read of its source is the selected read itself (A2, F17b, Astra r5 D1)", () => {
  const source =
    'let raw = hostValue\nraw = 1\nlet out = [[raw].get(9, default: null), raw, "tail"]\nrepeat out[0] {}\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const place = new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === "out",
  )!;
  assert.deepEqual(
    inBothOrders(() => analyseCore(request).place(place.id, ["element"]).admitted),
    {
      by: "decided",
      kinds: ["integer", "null"],
      decider: { file: 0, start: 68, end: 71 },
      inherited: false,
    },
  );
});
