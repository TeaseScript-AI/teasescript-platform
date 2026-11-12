// What reads the narrowing index: a stored value's read (S10 part 2b), a stored selection, a read below a selection, a
// consumer as a store, and their cost.

import assert from "node:assert/strict";
import test from "node:test";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import type { Obligation } from "../../../src/type-inference/core/result.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { narrowingAt } from "../../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES, stopSet } from "../../helpers/type-core-oracles.js";
import type { CompactRecord } from "../../helpers/type-core-records.js";
import { FLAG, pass, read } from "../../helpers/type-core/type-core-narrowing-setup.js";

/** A program's analysis, alike with the sharing of answers off and with the consumers' and solver's orders reversed. */
function record(...lines: readonly string[]): CompactRecord {
  const request = coreRequest([{ path: "main.tease", source: `${lines.join("\n")}\nexit\n` }]);
  assert.ok(request !== null, lines.join("\n"));
  const modes = [
    compactAnalysis(request),
    withoutSharing(() => compactAnalysis(request)),
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    ),
  ];
  for (const other of modes.slice(1)) assert.deepEqual(other, modes[0], lines.join("\n"));
  return modes[0]!;
}

test("a read in a stored value takes its narrowing where it holds, and its mark where it fails (S10 part 2b)", () => {
  const outcome = (...lines: readonly string[]): string => record(...lines).outcome;
  const real = "let n = 2.0";
  // a whole number passes `is integer`: the stored value is the tested kind
  assert.equal(outcome(real, "if n is integer { let whole: integer = n }"), "valid");
  assert.equal(outcome(real, "if n is not integer { let whole: integer = n }"), "compile-error");
  // through a copy and an operation of the stored value
  assert.equal(
    outcome(real, "if n is integer { let copy = n\n let whole: integer = copy }"),
    "valid",
  );
  assert.equal(outcome(real, "if n is integer { let whole: integer = n + 1 }"), "valid");
  // a call storing the location between the test and the read drops G: the read keeps its mark
  assert.equal(
    outcome(
      real,
      "function halve { n = n / 2 }",
      "if n is integer { halve()\n let whole: integer = n }",
    ),
    "warning-runtime-check",
  );
  // a definition after the test answers the read itself (the nearest candidate)
  assert.equal(
    outcome(
      FLAG,
      "let v: number? = 2.5",
      "if flagHost { v = null }",
      "if v != null { v = 2\n let whole: integer = v }",
    ),
    "valid",
  );
  // a test whose input is a definition in a loop around it reads the contract, never that definition's value, which
  // would wait on the test's own component (Sol's U3 build review r2): the inner loop's stores preserve both facts
  assert.equal(
    outcome(
      FLAG,
      "let a: integer? = 1",
      "if flagHost { a = null }",
      "if a != null { repeat 2 { let n = a",
      "if n != null { repeat 2 { a = n",
      "n = n + 1",
      "let m: integer = n",
      "a = m } } } }",
    ),
    "valid",
  );
  // an element test's input is the element key's read at the test, never the collection's narrowing
  assert.equal(
    outcome(
      FLAG,
      "let xs = [1]",
      "if flagHost { xs = [null] }",
      "if flagHost { xs = null }",
      "if xs != null { if xs is integer[] { let first: integer = xs[0] } }",
    ),
    "valid",
  );
  // a key text spelling another path never lends it that path's test: the stored read is the outer test's `null`
  // (#1244), as with a key that spells nothing
  const spelling = [
    'let d: integer? dict dict = dict {"a": dict {"b].[string:c": null}, "a].[string:b": dict {"c": 1}}',
    'if d["a"]["b].[string:c"] == null { if d["a].[string:b"]["c"] != null {',
    'let saved: integer = d["a"]["b].[string:c"]',
    "say saved } }",
  ];
  for (const lines of [spelling, spelling.map((line) => line.replaceAll("a].[string:b", "z"))]) {
    const offset = lines.join("\n").lastIndexOf('d["a"]');
    const end = offset + 'd["a"]["b].[string:c"]'.length;
    assert.deepEqual(record(...lines), {
      outcome: "compile-error",
      diagnostics: [
        {
          kind: "written-target",
          class: "compile-error",
          site: { file: "main.tease", offset, end },
          context: null,
        },
      ],
      checks: [],
    });
  }
  // a computed row under a fixed column reads the root test's element fact, as under a computed column (#1245): the
  // storage ingress check alone remains
  const rows = [
    'let rows: integer?[][] = load("rows", default: [[1], [2]])',
    "let row = 0",
    "if rows is integer[][] { let saved: integer = rows[row + 1][0]\n say saved }",
  ];
  const computed = rows.map((line) => line.replace("[0]", "[0 + 0]"));
  for (const lines of [rows, computed]) {
    const analysed = pass(...lines);
    const found = narrowingAt(analysed.pass, read(analysed, "rows[row", 0));
    // (the form's test, its type as written, `integer`, beside its kinds: #1398)
    const form = found?.g.form;
    assert.deepEqual(
      [
        form?.kind,
        form?.kind === "is" ? [form.kinds, form.test?.kind] : null,
        found?.g.elements,
        found?.fails,
      ],
      ["is", [["integer"], "namedType"], 2, null],
    );
  }
  const stored = record(...rows);
  assert.deepEqual([stored.outcome, stored.diagnostics, stored.checks.length], ["valid", [], 1]);
  assert.deepEqual(record(...computed), stored);
});

test("a stored selection takes its element's narrowing as an index does, never its emptiness (U4a, N1)", () => {
  // (a record without its sites: an index and a selection of one owner differ in their spans)
  const answer = (...lines: readonly string[]): string => {
    const { outcome, diagnostics, checks } = record(...lines);
    return [
      outcome,
      ...diagnostics.map((d) => `${d.kind} ${d.context ?? "-"}`),
      ...checks.map((c) => c.kind),
    ].join(", ");
  };
  const choice = 'let choice = askBoolean "change?"';
  const xs = [choice, "let xs: integer?[] = [1]", "if choice { xs = [null] }"];
  const rows = [choice, "let rows: integer?[][] = [[1]]", "if choice { rows = [[null]] }"];
  // each program read at `@` by an index and by selections: a selection answers as the index does (Astra's N1 on
  // #1228), where G holds and where it fails
  const scenarios: readonly (readonly [string, readonly string[]])[] = [
    ["a collection test", [...xs, "if xs is integer[] { let sink: integer = xs@ }"]],
    [
      "a root test, which proves no element's kind",
      [
        choice,
        "let xs: integer?[]? = [1]",
        "if choice { xs = [null] }",
        "if choice { xs = null }",
        "if xs != null { let sink: integer = xs@ }",
      ],
    ],
    [
      "a mutation after the test",
      [...xs, "if xs is integer[] { xs.reverse()\nlet sink: integer = xs@ }"],
    ],
    [
      "a call storing the list after the test",
      [
        ...xs,
        "function spoil { xs = [null] }",
        "if xs is integer[] { spoil()\nlet sink: integer = xs@ }",
      ],
    ],
    ["a nearer store", [...xs, "if xs is integer[] { xs = [null]\nlet sink: integer = xs@ }"]],
    [
      "one literal's reads before and after a call (one class per environment)",
      [
        ...xs,
        "function spoil { xs = [null]\nreturn 1 }",
        "if xs is integer[] { let both: integer[] = [xs@, spoil(), xs@] }",
      ],
    ],
    [
      "a computed row under a test of every row",
      [...rows, "let row = 0", "if rows is integer[][] { let sink: integer = rows[row + 1]@ }"],
    ],
    ["another row's test", [...rows, "if rows[0] is integer[] { let sink: integer = rows[1]@ }"]],
    [
      "a parameter given a list and an object with its own `first`",
      [
        "function pick(v) {",
        'if v is integer[] { let sink: integer = v@\nsay "${sink}" }',
        "}",
        "pick([1])",
        'pick({first: "a"})',
      ],
    ],
  ];
  const indexes = scenarios.map(([name, lines]) => {
    const index = answer(...lines.map((line) => line.replaceAll("@", "[0]")));
    for (const selection of [".first", ".last", ".random"])
      assert.equal(
        answer(...lines.map((line) => line.replaceAll("@", selection))),
        index,
        `${name}: ${selection}`,
      );
    return index;
  });
  assert.equal(indexes[0], "valid");
  // a selected path's own test narrows it as an index's does; `.random` selects anew, so it is no path, and a test of
  // one path says nothing of another
  const tested = (test: string, read: string): string =>
    answer(...xs, `if ${test} != null { let sink: integer = ${read} }`);
  const untested = (read: string): string => answer(...xs, `let sink: integer = ${read}`);
  assert.equal(tested("xs.first", "xs.first"), tested("xs[0]", "xs[0]"));
  // (`.random`'s test is a check the compiler cannot keep, the warning; with none, its `null` is the route rule's error,
  // AD-1)
  assert.match(tested("xs.random", "xs.random"), /^warning-runtime-check/);
  assert.match(untested("xs.random"), /^compile-error/);
  // (a test of `.first` is one of the element key `.last` reads too: the warning, the proof limit of a corridor that
  // follows keys, not locations, #1938; with no test, `.last`'s `null` is the route rule's error)
  assert.match(tested("xs.first", "xs.last"), /^warning-runtime-check/);
  assert.match(untested("xs.last"), /^compile-error/);
  // an empty list passes every element test: C6 still asks the selection's element of its owner
  const empty = record(
    choice,
    "let xs: integer?[] = []",
    "if choice { xs = [null] }",
    "if xs is integer[] { let sink: integer = xs.first }",
  );
  assert.deepEqual(
    empty.checks.map((c) => c.kind),
    ["empty-check"],
  );
  // an owner that may be an object keeps its own `first` opaque beside the narrowed element (F11)
  const own = record(
    "function pick(v) {",
    'if v.first != null { let sink: integer = v.first\nsay "${sink}" }',
    "}",
    "pick([1, null])",
    "pick({first: null})",
  );
  assert.deepEqual(
    own.diagnostics.filter((d) => d.kind === "written-target").map((d) => d.context),
    ["unmodelled"],
  );
});

test("a read below a selection takes its narrowing, each selected owner's own selection beside it (#1073, F11)", () => {
  const answer = (...lines: readonly string[]): string => {
    const { outcome, diagnostics, checks } = record(...lines);
    return [
      outcome,
      ...diagnostics.map((d) => `${d.kind} ${d.context ?? "-"}`),
      ...checks.map((c) => c.kind),
    ].join(", ");
  };
  const choice = 'let choice = askBoolean "change?"';
  const rows = [choice, "let rows: integer?[][] = [[1]]", "if choice { rows = [[null]] }"];
  const cube = [choice, "let cube: integer?[][][] = [[[1]]]", "if choice { cube = [[[null]]] }"];
  // each program read at `@` two element steps down, by indexes and by selections at either step (`.random` in the
  // middle included): a selection answers as the index does where G holds, where it fails and where a nearer
  // definition answers
  const scenarios: readonly (readonly [string, readonly string[]])[] = [
    ["a collection test", [...rows, "if rows is integer[][] { let sink: integer = rows@ }"]],
    [
      "a root test, which proves no element's kind",
      [
        choice,
        "let rows: integer?[][]? = [[1]]",
        "if choice { rows = [[null]] }",
        "if choice { rows = null }",
        "if rows != null { let sink: integer = rows@ }",
      ],
    ],
    [
      "an inner mutation after the test",
      [...rows, "if rows is integer[][] { rows[0].add(null)\nlet sink: integer = rows@ }"],
    ],
    [
      "a call storing the list after the test",
      [
        ...rows,
        "function spoil { rows = [[null]] }",
        "if rows is integer[][] { spoil()\nlet sink: integer = rows@ }",
      ],
    ],
    [
      "a nearer store of the prefix",
      [...rows, "if rows is integer[][] { rows[0] = [null]\nlet sink: integer = rows@ }"],
    ],
    [
      "one literal's reads before and after a call (one class per environment)",
      [
        ...rows,
        "function spoil { rows = [[null]]\nreturn 1 }",
        "if rows is integer[][] { let both: integer[] = [rows@, spoil(), rows@] }",
      ],
    ],
    [
      "a store to the row's index between two reads (one class per environment)",
      [
        choice,
        "let cube: integer?[][][] = [[[1]], [[null]]]",
        "if choice { cube = [[[null]]] }",
        "let row = 0",
        "function bump { row = 1\nreturn 1 }",
        "if cube[row] is integer[][] { let both: integer[] = [cube[row]@, bump(), cube[row]@] }",
      ],
    ],
    ["a test of one row", [...cube, "if cube[0] is integer[][] { let sink: integer = cube[0]@ }"]],
    ["another row's test", [...cube, "if cube[0] is integer[][] { let sink: integer = cube[1]@ }"]],
    [
      "a parameter given lists and an object with its own selections",
      [
        "function pick(v) {",
        'if v is integer[][] { let sink: integer = v@\nsay "${sink}" }',
        "}",
        "pick([[1]])",
        'pick({first: {last: "a"}})',
      ],
    ],
  ];
  const indexes = scenarios.map(([name, lines]) => {
    const index = answer(...lines.map((line) => line.replaceAll("@", "[0][0]")));
    for (const selection of [".first.last", ".random.first", ".first[0]", ".last.random"])
      assert.equal(
        answer(...lines.map((line) => line.replaceAll("@", selection))),
        index,
        `${name}: ${selection}`,
      );
    return index;
  });
  assert.deepEqual([indexes[0], indexes[7], indexes[9]], ["valid", "valid", "valid"]);
  // a descendant path's own test narrows it as an index path's does; `.random` selects anew, so a path through it is no
  // path, and a test of one path says nothing of another
  const rs = [choice, "let rs = [{f: 1}]", "if choice { rs = [{f: null}] }"];
  const tested = (base: readonly string[], test: string, read: string): string =>
    answer(...base, `if ${test} != null { let sink: integer = ${read} }`);
  const untested = (base: readonly string[], read: string): string =>
    answer(...base, `let sink: integer = ${read}`);
  assert.equal(tested(rs, "rs.first.f", "rs.first.f"), "valid");
  assert.equal(tested(rs, "rs.last.f", "rs.last.f"), tested(rs, "rs[0].f", "rs[0].f"));
  assert.equal(tested(rows, "rows.first.last", "rows.first.last"), "valid");
  assert.equal(tested(rs, "rs.first.f", "rs.last.f"), untested(rs, "rs.last.f"));
  assert.equal(tested(rs, "rs.random.f", "rs.random.f"), untested(rs, "rs.random.f"));
  // (a selection through `.random` is read anew: its test is a check the compiler cannot keep, the warning; with none,
  // its `null` is the route rule's error, AD-1)
  for (const read of ["rows.random.first", "rows.first.random"]) {
    assert.match(tested(rows, read, read), /^warning-runtime-check/, read);
    assert.match(untested(rows, read), /^compile-error/, read);
  }
  // an empty list passes every element test: C6 still asks each selection's element of its owner; a property an
  // element lacks stays a member read
  const checks = (...lines: readonly string[]): string[] =>
    record(...lines).checks.map((c) => c.kind);
  assert.deepEqual(
    checks(
      choice,
      "let rows: integer?[][] = []",
      "if choice { rows = [[null]] }",
      "if rows is integer[][] { let sink: integer = rows.first.last }",
    ),
    ["empty-check", "empty-check"],
  );
  assert.ok(
    record(
      choice,
      "let rs = [{g: 1}]",
      "if choice { rs = [{f: null}] }",
      "if rs.first.f != null { let sink: integer = rs.first.f }",
    ).diagnostics.some((d) => d.kind === "member-read" && d.context === "missing"),
  );
  // each owner that may be an object keeps its own selection opaque beside the narrowed element (F11), at the inner
  // link and at the outer one, where G holds and where it fails; lists alone are narrowed
  const pick = (body: string, ...calls: readonly string[]): readonly string[] =>
    record(
      "function pick(v) {",
      `if v.first.last != null { ${body}let sink: integer = v.first.last\nsay "\${sink}" }`,
      "}",
      "pick([[1], [null]])",
      ...calls.map((call) => `pick(${call})`),
    )
      .diagnostics.filter((d) => d.kind === "written-target")
      .map((d) => d.context ?? "-");
  assert.deepEqual(pick(""), []);
  for (const object of ["{first: [null]}", "[{last: null}]"]) {
    assert.deepEqual(pick("", object), ["unmodelled"], object);
    assert.ok(pick("v.first.add(null)\n", object).includes("unmodelled"), object);
  }
});

test("a consumer reads the narrowing as a store does, in the same order (#1073 PR 2, #1320)", () => {
  // (a record's outcome, its diagnostics' kinds and classes and its checks' kinds, in the three modes `record` asks)
  const answer = (...lines: readonly string[]): string => {
    const { outcome, diagnostics, checks } = record(...lines);
    return [
      outcome,
      ...diagnostics.map((d) => `${d.kind} ${d.class}`),
      ...checks.map((c) => `${c.kind}${c.boundary === true ? " boundary" : ""}`),
    ].join(", ");
  };
  const flag = 'let flag = askBoolean "?"';
  // G holds at a consumer: a fitting kind is quiet, as at a store
  for (const [test, use] of [
    ["n != null", "repeat n {}"],
    ["n is integer", "repeat n {}"],
    ["n != null", 'say "${n}"'],
  ] as const)
    assert.equal(
      answer(flag, "let n = 1", "if flag { n = null }", `if ${test} { ${use} }`),
      "valid",
      `${test}: ${use}`,
    );
  // a nearer store after the test answers the consumer exactly: an invalid value stays invalid (V30 §13)
  assert.equal(
    answer(flag, "let n = 1", "if flag { n = null }", "if n != null { n = null\n repeat n {} }"),
    "compile-error, integer-use compile-error",
  );
  // a test of the read's own key keeps its guard
  assert.equal(
    answer("let box = {n: 1.5}", "if box.n < 2 { repeat box.n {} }"),
    "warning-runtime-check, integer-use warning-runtime-check, integer-check",
  );
  // the test proves a kind, never an ingress (C9, the lead's ruling (a)): external data keeps exactly one boundary
  // check, at its ingress store or, where no store brought it, at the consumer, through every transfer that
  // keeps the value; a computed result brings no data in (Codex r1–r3 on #1770: the typed store, the operator, the
  // selection without an ingress are rows)
  const transfers: readonly (readonly [string, string, string, string, string])[] = [
    ["a read", "", "integer", "repeat X {}", "valid, copy-type boundary"],
    ["a copy", "", "integer", "let c = X\n repeat c {}", "valid, copy-type boundary"],
    [
      "a merge of one kind",
      "",
      "integer",
      "let xs = [X, 1]\n repeat xs[0] {}",
      "valid, copy-type boundary",
    ],
    [
      "a literal's element",
      "",
      "integer",
      "let xs = [X]\n repeat xs[0] {}",
      "valid, copy-type boundary",
    ],
    ["a selection", "", "integer[]", "repeat X[0] {}", "valid, copy-type boundary"],
    [
      "an operator",
      "",
      "integer",
      "let out: integer = X + 1\n repeat out {}",
      "valid, copy-type boundary",
    ],
    [
      "a typed store",
      "",
      "integer",
      "let out: integer = X\n repeat out {}",
      "valid, copy-type boundary",
    ],
    [
      "an argument",
      "function f(p: integer) {\n repeat p {}\n}\n",
      "integer",
      "f(X)",
      "valid, copy-type boundary",
    ],
    [
      "a result",
      "function g(p): integer {\n return p\n}\n",
      "integer",
      "let out = g(X)\n repeat out {}",
      "valid, copy-type boundary",
    ],
    [
      "a default",
      "",
      "integer",
      "let out: integer = X otherwise 0\n repeat out {}",
      "warning, static warning, copy-type boundary",
    ],
  ];
  for (const [name, prelude, type, body, expected] of transfers)
    for (const [where, before, read] of [
      ["an ingress store", "let raw = hostValue\n", "raw"],
      ["no ingress store", "", "hostValue"],
    ] as const)
      assert.equal(
        answer(`${prelude}${before}if ${read} is ${type} {\n${body.replaceAll("X", read)}\n}`),
        expected,
        `${name}, ${where}`,
      );
  // a stopped read keeps its C9 check: the stop leaves the kinds unknown, never the ingress (Codex r4), at the read's
  // root occurrence or at the store that brought the data in, with its target, site and domain
  for (const [source, expected] of [
    ["if hostValue is integer {repeat hostValue {}}", "hostValue [unknown] 32-41"],
    ['if hostValue is string[] {say "${hostValue}"}', "hostValue [unknown] 33-42"],
    // (a projection's own read, data or computed, is the occurrence's check alone, Codex r5)
    ["if hostValue is integer[] {repeat hostValue[0] {}}", "hostValue [unknown] 34-43"],
    ["if hostValue is integer[] {repeat hostValue.length {}}", "hostValue [unknown] 34-43"],
    ["if hostValue is integer {let out:integer=hostValue\nrepeat out {}}", "out [integer] 41-50"],
    [
      "if hostValue is integer[] {let out:integer=hostValue[0]\nrepeat out {}}",
      "out [integer] 43-52",
    ],
  ] as const)
    for (const mode of MODES) {
      const stopped = stopSet(
        [{ path: "main.tease", source: `${source}\nexit\n` }],
        mode,
        ["hostValue"],
        1,
      )!;
      // EVIDENCE: `stoppedRecord` serializes the answers' `checks`, a list of `Obligation`s.
      const { checks } = JSON.parse(stopped.record) as { checks: readonly Obligation[] };
      assert.ok(stopped.record.includes('"context":"budget"'), `${source}: a read stops`);
      assert.equal(
        checks
          .filter((c) => c.boundary === true)
          .map((c) => `${c.target} [${c.against.join("|")}] ${c.site.start}-${c.site.end}`)
          .join("; "),
        expected,
        `${source} ${JSON.stringify(mode)}`,
      );
    }
  // #1320: a scalar under its test needs no operand check; a list under an element test keeps C6's emptiness, read
  // directly and at a row (a consumer's descendant demand takes its path's G)
  assert.equal(
    answer("let v = hostValue", 'if v is string { say "${v}" }'),
    "valid, copy-type boundary",
  );
  for (const [test, use] of [
    ["xs is string[]", 'say "${xs}"'],
    ["xs is string[][]", 'say "${xs[0]}"'],
  ] as const)
    assert.equal(
      answer("let xs = hostValue", `if ${test} { ${use} }`),
      "warning-runtime-check, member-read warning-runtime-check, copy-type boundary, empty-check",
      `${test}: ${use}`,
    );
  // without the test, the operand check stays
  assert.equal(
    answer("let xs = hostValue", 'say "${xs}"'),
    "warning-runtime-check, operator warning-runtime-check, copy-type boundary, operand",
  );
});

test("a test that holds removes kinds, not the read's cause: its read's warning names the word the read without it names (#2024)", () => {
  // (a program's outcome, its diagnostics' kinds, sites and context words, and its checks, alike in four modes)
  const answer = (source: string): string => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const answers = MODES.map((mode) => {
      const { outcome, diagnostics, checks } = inMode(mode, () => compactAnalysis(request));
      return [
        outcome,
        ...diagnostics.map((d) => `${d.kind} ${d.site.offset} ${d.context}`),
        ...checks.map((c) => `${c.kind} ${c.target} ${c.site.offset}`),
      ].join(", ");
    });
    for (const [index, other] of answers.entries())
      assert.equal(other, answers[0], `${source} ${JSON.stringify(MODES[index])}`);
    return answers[0]!;
  };
  // (a read's one warning and its check at the read)
  const warned = (source: string, read: string, word: string, check = "empty-check"): string => {
    const at = source.indexOf(read);
    return `warning-runtime-check, member-read ${at} ${word}, ${check} xs ${at}`;
  };
  // the fixture record cp9-cells/3b/review-early/astra-r2-fence-6 and the issue's three controls
  const loop = (head: string, store = "xs = []"): string =>
    `let xs = [1]\n${head} {\n    repeat 2 {\n        say xs.first\n        ${store}\n    }\n}\nexit\n`;
  const untested = "let xs = [1]\nrepeat 2 {\n    say xs.first\n    xs = []\n}\nexit\n";
  // (a called function's null store: no entry R2.2 reaches, so the read keeps its warning and its null check)
  const drop = "let xs = [1]\nfunction drop {\n    xs = null\n}\n";
  const called = loop("if xs != null", "drop()").replace("let xs = [1]\n", drop);
  const calledUntested = `${drop}repeat 2 {\n    say xs.first\n    drop()\n}\nexit\n`;
  for (const [name, source, check] of [
    ["the record: a null test that holds", loop("if xs != null"), "empty-check"],
    ["no test", untested, "empty-check"],
    ["a test of the emptiness itself", loop("if xs.length > 0"), "empty-check"],
    ["a null test a called null store fails", called, "null-check"],
    ["a called null store, no test", calledUntested, "null-check"],
  ] as const)
    assert.equal(answer(source), warned(source, "xs.first", "loop", check), name);
  // R2.2: the loop's entry under the program default; the store's null reaches the read on the second run
  const failed = loop("if xs != null", "xs = null");
  assert.equal(
    answer(failed),
    `compile-error, member-read ${failed.indexOf("xs.first")} null`,
    "a null test a null store fails (U5)",
  );
  // the family: each test that holds, each store whose word explains the read, each selection, against the same
  // program without its test; the word equals the untested read's, or `unknown` where that read carries two words (the
  // host-data rows below)
  for (const form of ["xs != null", "xs is list"])
    for (const [event, word] of [
      ["a loop's store", "loop"],
      ["a branch's store", "branch"],
    ] as const)
      for (const selection of ["first", "last"]) {
        const read = `xs.${selection}`;
        const body =
          word === "loop"
            ? `repeat 2 {\n    say ${read}\n    xs = []\n}`
            : `if askBoolean "b" { xs = [] }\nsay ${read}`;
        const twin = `let xs = [1]\n${body}\nexit\n`;
        const tested = `let xs = [1]\nif ${form} {\n${body}\n}\nexit\n`;
        const name = `${form}, ${event}, ${read}`;
        assert.equal(answer(twin), warned(twin, read, word), `${name}: without the test`);
        assert.equal(answer(tested), warned(tested, read, word), name);
      }
  // two reads under one test whose reads without it name different words keep their own: a narrowed read's class is
  // keyed by its read's snapshot (`readSnapshot`: the exact path's signature at its node), which fixes that read's word
  const both =
    'let xs = [1]\nif xs != null {\n    if askBoolean "b" { xs = [] }\n    say xs.first\n    repeat 2 {\n        say xs.last\n        xs = []\n    }\n}\nexit\n';
  const [first, last] = [both.indexOf("xs.first"), both.indexOf("xs.last")];
  assert.equal(
    answer(both),
    `warning-runtime-check, member-read ${first} branch, member-read ${last} loop, empty-check xs ${first}, empty-check xs ${last}`,
  );
  // a read without its test whose items carry two words keeps G's items: data from outside the script, `unknown` with its
  // reasons' word, beside the loop store's list, `loop` (#2024, the lead's ruling 2: `unknown` is the true cause there)
  const host = (head: string): string =>
    `let xs = hostValue\n${head}repeat 2 {\n    say xs.first\n    xs = []\n}${head === "" ? "" : "\n}"}\nexit\n`;
  const later = "written-target 9 later";
  const copies = "copy-type xs 9, copy-type xs 9";
  for (const [name, source, nulls] of [
    ["host data without a test", host(""), true],
    ["host data under a null test", host("if xs != null {\n"), true],
    ["host data under a type test", host("if xs is integer[] {\n"), false],
  ] as const) {
    const at = source.indexOf("xs.first");
    assert.equal(
      answer(source),
      nulls
        ? `warning-runtime-check, ${later}, member-read ${at} unknown, member-read ${at} unknown, ${copies}, null-check xs ${at}, empty-check xs ${at}`
        : `warning-runtime-check, ${later}, member-read ${at} unknown, ${copies}, empty-check xs ${at}`,
      `${name}: \`unknown\`, since host data may itself be empty; the store's \`loop\` would hide that cause`,
    );
  }
});

/** The work one query charges, at k = 64 and 128, per doubling of the source: about 2 for linear work. */
function queryDoubling(source: (k: number) => string, marker: string, delta: number): number {
  const [small, large] = [64, 128].map((k) => {
    const analysed = pass(source(k));
    const node = read(analysed, marker, delta);
    const work = analysed.pass.program.work;
    const before = work.total;
    narrowingAt(analysed.pass, node);
    return { units: work.total - before, nodes: work.counts().get("syntaxNodes") ?? 1 };
  });
  return (2 * (large!.units / small!.units)) / (large!.nodes / small!.nodes);
}

test("a long `otherwise` chain's preserving store and a deep element read cost what their size does (Sol r3)", () => {
  // each value's items merged by kind: a chain's intermediates never grow with it
  const chain = (k: number): string => {
    let value = "n";
    for (let index = 0; index < k; index += 1) value = `(${value} otherwise n)`;
    return `let n: integer? = load("n", default: null)\nif n is integer | null { repeat 2 { say n\n n = ${value} } }`;
  };
  assert.ok(queryDoubling(chain, "say n", 4) <= 2.15);
  // one walk of the read's steps down the tested paths' trie, never a scope text per trailing depth
  const deep = (k: number): string =>
    `let xs = load("xs", default: [])\nif xs is integer[][] { say 1 }\nsay xs${"[0 + 0]".repeat(k)}`;
  assert.ok(queryDoubling(deep, "say xs", 4) <= 2.15);
});
