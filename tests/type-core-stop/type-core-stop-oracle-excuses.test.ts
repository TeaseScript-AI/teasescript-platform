// The stop oracle's own tests: what it excuses (a mark's records within its value, a fix in words, a standing check, a
// repeated decision).

import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend, type ProjectDiagnostic } from "../../src/compiler.js";
import type { Diagnostic } from "../../src/diagnostics.js";
import { type SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../src/type-inference/core/budget.js";
import { withoutRecords } from "../../src/type-inference/core/consumers.js";
import type { Obligation } from "../../src/type-inference/core/result.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import { heldRun, HELD_MODES, phaseEnds, type HeldCase } from "../helpers/type-core-held-host.js";
import {
  repeatedDecisions,
  standsForNullCheck,
  stopProblems,
  type Globals,
  type StopRun,
} from "../helpers/type-core-stop-oracle.js";
import {
  ALLOWANCE,
  object,
  host,
  stopRun,
  gatedProblems,
  lastUnsettled,
} from "../helpers/type-core/type-core-stop-setup.js";

/**
 * A fix a stop gives in words (#1449): at a settled walk stop whose unchecked region holds a store, its
 * warning gives the fix in words where the unstopped compile shows code, and the oracle takes it for the same diagnostic:
 * the unstopped one with every fix in words. The sources cover a check, a project's second file, and a kept value whose
 * text holds the author's own: a full stop, an apostrophe, quotes and listed words in a text literal or a comment (Codex
 * r1's F3, r2's F1, r3's F1; the comment's fix is words unstopped too). Generated over the stopped warning's sentences
 * (its first, its consequence, its cause and its fix) and the changes a stop could make, every one is reported: other
 * wording, a quoted name lost (Codex r1's F1), code kept from the unstopped fix (its F2), other code, code or other words
 * where the unstopped compile gives words (r2's F1, r3's F1), one more sentence, another severity, code, site or file, and
 * the warning published twice.
 */
const IN_WORDS: readonly (readonly SourceFile[])[] = [
  'let root = {f0: 1}\nroot.f0 = hostValue\nsay "BEFORE"\nrepeat root.f0 {say "ok"}\nsay "AFTER"\nexit\n',
  ...[
    "2.5",
    ...["a. B", "a' as in 'b", "it's", "'b'", "use it as in Write"].map((text) =>
      JSON.stringify(text),
    ),
  ]
    .map((text) => JSON.stringify(text))
    .concat(["/* a' as in 'b */ \"2.5\""])
    .map(
      (value) =>
        `let state = {amount: 2.5}\nstate.amount = 17\nstate.amount = fromJson(${value}, default: null)\nsay state.amount\nexit\n`,
    ),
].map((source) => [{ path: "main.tease", source }]);

test("the stop oracle takes a fix in words for the unstopped one's code, and nothing else", () => {
  const globals = ["hostValue", "hostOther"];
  const projects = [
    ...IN_WORDS,
    [
      { path: "main.tease", source: 'say "main"\nexit\n' },
      { ...IN_WORDS[0]![0]!, path: "part.tease" },
    ],
  ];
  for (const files of projects) {
    const request = coreRequest(files, globals);
    assert.ok(request !== null);
    const allowed = <T>(allowance: number | undefined, make: () => T): T =>
      allowance === undefined ? make() : withTestAllowance(allowance, make);
    const compile = () => compileProjectWithBackend(files, { globals }, CORE_BACKEND);
    // (a run's omissions, its compile in words among them, made once each)
    const runAt = (allowance?: number): StopRun => {
      const both = () => ({ result: compile(), answers: analyseCore(request) });
      const made = new Map<string, ReturnType<typeof both>>();
      return {
        ...allowed(allowance, both),
        without: (omit, key) => {
          if (!made.has(key))
            made.set(
              key,
              allowed(allowance, () => withoutRecords(omit, both)),
            );
          return made.get(key)!;
        },
      };
    };
    // (the project's warning, in its last file)
    const path = files.at(-1)!.path;
    const warning = (each: StopRun): Diagnostic => {
      const found = each.result.diagnostics.filter((d) => d.code === "TSV041");
      assert.equal(found.length, 1);
      assert.equal("path" in found[0]! ? found[0].path : null, path);
      return found[0]!;
    };
    // a settled walk stop whose warning gives the fix in words
    const unstopped = runAt();
    const code = warning(unstopped).message;
    const walk = phaseEnds(analyseCore(request).budget.total, (allowance) => {
      const { stoppedIn, settled } = allowed(allowance, () => analyseCore(request)).budget;
      return settled ? stoppedIn : null;
    }).get("walk");
    assert.ok(walk !== undefined);
    const inWords = (allowance: number) =>
      allowed(allowance, compile).diagnostics.find((d) => d.code === "TSV041")?.message !== code;
    // (the walk's stops every twelfth allowance from its first, as the anchors take them; the first where the unstopped
    // fix is words already)
    let at = walk[0];
    while (at <= walk[1] && !inWords(at)) at += 12;
    if (at > walk[1]) at = walk[0];
    const stopped = runAt(at);
    const words = warning(stopped).message;
    const where = `${path} @${at}`;
    const problems = (want: StopRun, got: StopRun) =>
      stopProblems({ unstopped: want, stopped: got, fitting: [], violating: [] });
    assert.deepEqual(problems(unstopped, stopped), [], where);
    // each message's sentences: its first, its consequence, its fix and its cause, whose subject is quoted
    const parts = (message: string) => {
      const consequence = "If it is, the Tease stops with an error at this line.";
      const [first = "", rest = "", ...more] = message.split(` ${consequence} `);
      assert.equal(more.length, 0, message);
      // (the fix ends where the cause's quoted subject starts)
      const cause = rest.indexOf(". '") + 1;
      return { first, consequence, fix: rest.slice(0, cause), cause: rest.slice(cause + 1) };
    };
    const [was, is] = [parts(code), parts(words)];
    assert.ok(!is.fix.includes(", as in '"), where);
    assert.equal(
      [is.first, is.consequence, is.fix, is.cause].join(" "),
      words,
      `${where}: the stopped warning's four sentences`,
    );
    const said = (change: Partial<typeof is>) => {
      const { first, consequence, fix, cause } = { ...is, ...change };
      return `${first} ${consequence} ${fix} ${cause}`;
    };
    // `each` with its warning changed
    const changed = (each: StopRun, change: Partial<ProjectDiagnostic>): StopRun => ({
      ...each,
      result: {
        ...each.result,
        diagnostics: each.result.diagnostics.map((d) =>
          d.code === "TSV041" ? { ...d, ...change } : d,
        ),
      },
    });
    // (each code example of the unstopped fix, its quoted text ending before a comma or a full stop)
    const examples = [...was.fix.matchAll(/, as in '.*?'(?=[,.](?:\s|$))/g)].map(
      (match) => match[0],
    );
    const { span } = warning(stopped);
    const shifted = (position: typeof span.start) => ({
      ...position,
      offset: position.offset + 1,
      column: position.column + 1,
    });
    const messages = [
      said({ first: is.first.replace(" holds ", " keeps ") }),
      said({ first: is.first.replace(/^'[^']*'/, "It") }),
      said({ consequence: "If not, the Tease stops with an error at this line." }),
      said({ cause: is.cause.replace("comes from outside", "is set outside") }),
      said({ cause: "Its type is known before the script runs." }),
      // (other words, with or without the names)
      said({ fix: is.fix.replace(/ first\.$/, " at once.") }),
      said({ fix: `${is.fix.split(" ")[0]!} the value first.` }),
      // (code added to the words, one code example of two kept, other code)
      ...(examples.length > 0
        ? [
            said({ fix: is.fix.replace(/\.$/, `${examples.at(-1)!}.`) }),
            said({ fix: `${was.fix.slice(0, was.fix.lastIndexOf(", as in '"))}, as in 'say 0'.` }),
          ]
        : []),
      ...(examples.length > 1 ? [said({ fix: was.fix.replace(examples[0]!, "") })] : []),
      `${words} Check it again.`,
    ];
    const cases = [
      ...messages.map((message) => [unstopped, changed(stopped, { message })] as const),
      // (code where the unstopped compile gives words)
      ...(code === words
        ? []
        : [[changed(unstopped, { message: words }), changed(stopped, { message: code })] as const]),
      [unstopped, changed(stopped, { severity: "error" })],
      [unstopped, changed(stopped, { code: "TSV042" })],
      [
        unstopped,
        changed(stopped, { span: { ...span, start: shifted(span.start), end: shifted(span.end) } }),
      ],
      [unstopped, changed(stopped, { path: path === "main.tease" ? "part.tease" : "main.tease" })],
      [
        unstopped,
        {
          ...stopped,
          result: {
            ...stopped.result,
            diagnostics: [...stopped.result.diagnostics, warning(stopped)],
          },
        },
      ],
    ] as const;
    cases.forEach(([want, got], index) =>
      assert.notDeepEqual(problems(want, got), [], `${where}: change ${index}`),
    );
  }
});

/**
 * Before admission settled a written store's mark stands for its records within its value: a
 * literal holding an element admission left undecided (`v = [kept]`) is marked at the literal, while unstopped its
 * TSV041 stands at the element; the oracle excuses that record, and the same record planted outside the value is still
 * reported.
 */
test("a written store's mark stands for its records within its value, and for none outside it", () => {
  const source = "let kept = 8.0\nlet v: integer[] = [1]\nv = [kept]\nexit\n";
  const unstopped = stopRun(source);
  const start = source.indexOf("[kept]");
  const error = unstopped.result.diagnostics.find((d) => d.code === "TSV041");
  assert.ok(error !== undefined && error.span.start.offset === start + 1);
  // the same record at the declaration's `[1]`, outside the store's value
  const outside = source.indexOf("[1]");
  const planted: StopRun = {
    ...unstopped,
    result: {
      ...unstopped.result,
      diagnostics: [
        {
          ...error,
          span: {
            ...error.span,
            start: { ...error.span.start, offset: outside },
            end: { ...error.span.end, offset: outside + 3 },
          },
        },
        ...unstopped.result.diagnostics,
      ],
    },
  };
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (mark) =>
          mark.rule.rule === "store" &&
          mark.rule.written &&
          mark.site.start === start &&
          mark.site.end === start + "[kept]".length,
      ),
      `@${allowance}`,
    );
    assert.deepEqual(
      stopProblems({ unstopped, stopped, fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
    assert.notDeepEqual(
      stopProblems({ unstopped: planted, stopped, fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
  }
});

/**
 * Before admission settled, a store marked with its type undecided stands for its records within its value and for the
 * errors it brought: an object stored with host data inside it (Codex r8's copy of fields), a typed parse
 * inside a typed default, a copy whose conflict A2 finds where it meets the place (the error inside the store's value),
 * and a copy whose conflict is reached only through a cycle of copies that adds steps, its
 * error reported where it is read and naming the copy. Each rule only so far: the mark narrowed off the record, or the
 * error's store moved elsewhere, and the oracle reports the record. A2's checks run before the stop, so its records at
 * a literal of copies, a store, a relay inside a cycle of whole copies and a fed ring, and at a literal and a store of
 * copies of written bindings (Astra r1 N1), stand at an early and the latest unsettled stop as the unstopped analysis
 * publishes them, or as the marks' content.
 */
test("a store a stop before admission settled marks stands for its records within its value and the errors it brought", () => {
  const inner =
    'let a = {inner: {n: 1, title: "ok"}}\nlet b = a\nb = {inner: hostValue}\nsay b.inner.n\nsay b.inner.title\nexit\n';
  const copied =
    'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n';
  const read =
    'let a = {inner: {n: 1}}\na = a.inner\nlet bad = {n: "x"}\nlet copy = a\ncopy = bad\nsay copy.n\n' +
    "let n: integer = hostValue\nexit\n";
  const typed =
    'let value = fromJson(hostValue, default: {list: [{n: fromJson("3", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay "DONE"\nexit\n';
  // (every program stores into an inferred place, so the plain gate declines each stop, #2080 part 2)
  const problems = (
    unstopped: StopRun,
    stopped: ReturnType<typeof stopRun>,
    fitting: readonly Globals[] = [],
    violating: readonly Globals[] = [],
  ) => gatedProblems({ unstopped, stopped, fitting, violating }, true);
  const fields = (n: SerializableRuntimeValue) => host(object({ n, title: "yes" }), 3);
  for (const [source, fitting, violating] of [
    [inner, [fields(2)], [fields(1.5)]],
    [copied, [], []],
    [read, [], []],
    [typed, [], []],
  ] as const) {
    const stopped = stopRun(source, ALLOWANCE);
    assert.equal(stopped.answers.budget.settled, false, source);
    assert.deepEqual(problems(stopRun(source), stopped, fitting, violating), [], source);
  }
  // the store's mark narrowed to its first character: the C1 warning inside its value is no longer its record
  const literal = inner.indexOf("{inner: hostValue}");
  const stopped = stopRun(inner, ALLOWANCE);
  const narrowed: ReturnType<typeof stopRun> = {
    ...stopped,
    answers: {
      ...stopped.answers,
      budget: {
        ...stopped.answers.budget,
        deferred: stopped.answers.budget.deferred.map((d) =>
          d.site.start === literal ? { ...d, site: { ...d.site, end: literal + 1 } } : d,
        ),
      },
    },
  };
  assert.notDeepEqual(problems(stopRun(inner), narrowed), []);
  // A2's witnesses (#1293), stopped early and at the latest unsettled unit
  for (const source of [
    'let a = {n: 1}\nlet b = {n: "x"}\nlet xs = [a, b]\nlet n: integer = hostValue\nexit\n',
    'let good = {n: 1}\nlet bad = {n: "x"}\nlet a = {inner: {inner: bad}}\nlet b = {inner: {inner: good}}\n' +
      'let c = b\nc = a\nsay "AFTER"\nb = c\na = b\nexit\n',
    'let good = {p0: 1, p1: 1}\nlet bad = {p0: "x", p1: "x"}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\na0 = a2\n' +
      "a2 = bad\nexit\n",
    'let w: integer = 1\nlet a = {n: w}\nlet b = {n: "x"}\nlet xs = [a, b]\nsay xs[0].n\nlet n: integer = hostValue\nexit\n',
    'let s: string = "x"\nlet a = {n: 1}\nlet b = {n: s}\nlet copy = a\ncopy = b\nsay copy.n\n' +
      "let n: integer = hostValue\nexit\n",
  ])
    for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
      const stopped = stopRun(source, allowance);
      assert.equal(stopped.answers.budget.settled, false, `${source} @${allowance}`);
      assert.deepEqual(problems(stopRun(source), stopped), [], `${source} @${allowance}`);
    }
  // the copy's error brought by another store than the marked one
  const unstopped = stopRun(read);
  const elsewhere: StopRun = {
    ...unstopped,
    answers: {
      ...unstopped.answers,
      diagnostics: unstopped.answers.diagnostics.map((d) =>
        d.class === "compile-error" && "rule" in d && d.rule.rule === "store"
          ? { ...d, rule: { ...d.rule, brought: { file: 0, start: 0, end: 3 } } }
          : d,
      ),
    },
  };
  assert.ok(
    unstopped.answers.diagnostics.some(
      (d) =>
        d.class === "compile-error" &&
        "rule" in d &&
        d.rule.rule === "store" &&
        d.rule.brought !== null,
    ),
  );
  assert.notDeepEqual(problems(elsewhere, stopRun(read, ALLOWANCE)), []);
});

/**
 * A store marked with its type undecided stands for its records within its value on both sides alike (Codex r14):
 * a check there that the stopped analysis keeps as the unstopped one has it is that record, so a host
 * index read below the store is no extra check, at a stop in the setup and at the last before admission settled; a
 * check there that the unstopped analysis lacks, with or without the marks, is still reported. The stores are into
 * inferred places, so the plain gate declines each stop (#2080 part 2): the records and the check ledger are compared.
 */
test("a marked store's records within its value are compared alike on both sides", () => {
  const source = "let items = [[1]]\nlet v = items[hostOther]\nsay v[0]\nexit\n";
  const unstopped = stopRun(source);
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.deepEqual(
      gatedProblems({ unstopped, stopped, fitting: [host(2, 0)], violating: [host(2, 1.5)] }, true),
      [],
      `@${allowance}`,
    );
  }
  const stopped = stopRun(source, ALLOWANCE);
  const index = source.indexOf("hostOther");
  const boundary = stopped.answers.checks.find(
    (check) => check.boundary && check.site.start === index,
  );
  assert.ok(boundary !== undefined);
  const extra = { ...boundary, against: ["integer" as const] };
  const added = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: { ...each.answers, checks: [...each.answers.checks, extra] },
  });
  const problems = gatedProblems(
    {
      unstopped,
      stopped: { ...added(stopped), without: (omit, key) => added(stopped.without(omit, key)) },
      fitting: [],
      violating: [],
    },
    true,
  );
  assert.deepEqual(problems, [`extra check ${JSON.stringify(extra)}`]);
});

const nullCheck: Obligation = {
  kind: "null-check",
  target: "xs.element",
  against: ["integer", "number"],
  on: "check that xs.element is not null before /",
  site: { file: 0, start: 27, end: 32 },
  boundary: false,
};
const operand: Obligation = {
  kind: "operand",
  target: "xs[1]",
  against: ["integer", "number"],
  on: "check the operand of / when it runs",
  site: nullCheck.site,
  boundary: false,
};

/**
 * A stopped operand check stands for a lost null check only as the lead's ruling (A) on #1688 allows
 * (`standsForNullCheck`). `null-divisors@4`
 * (`tests/families/messages/nested-carriers-and-diagnostic-work/selection-store-and-object-index-diagnostic-work.mjs`,
 * k = 4) under demand allowance 32, both reversed modes, at the settled decision stop of `xs`'s element: the natural
 * analysis owes at each divisor "check that xs.element is not null before /" against `integer` and `number`; the
 * stopped run owes an operand check there instead, against the same two kinds at the first three divisors, and also
 * against `duration`, `calendarDuration` and `angle` at the last, where the chain on its left is unknown too. The first
 * three stand for their null checks, reported apart (`standing check`); the last is a weaker check and stays lost;
 * every operand check is still its own content, so the extras are unchanged. The predicate's clauses each refuse alone.
 */
test("a stopped operand check stands for a lost null check only at its site, excluding null, within its kinds (#1688)", () => {
  const source = `let xs = [4, null]\nsay 1${" / xs[1]".repeat(4)}\nexit\n`;
  const c: HeldCase = { name: "null-divisors@4", source, slice: true, values: [] };
  for (const mode of HELD_MODES.filter((each) => each.name.startsWith("reversed"))) {
    const stopped = heldRun(c, mode, undefined, 32);
    assert.ok(stopped.answers.budget.settled, mode.name);
    const problems = stopProblems({
      unstopped: heldRun(c, mode),
      stopped,
      fitting: [],
      violating: [],
    });
    const of = (prefix: string) =>
      problems.filter((problem) => problem.startsWith(`${prefix} check `));
    // (the check a problem names first: a lost check's, or the null check a standing one stands for)
    const site = (problem: string) => {
      const text = problem.replace(/^(lost|standing) check /, "").split(" by ")[0]!;
      const check: Obligation = JSON.parse(text);
      return `${check.kind} ${check.site.start}-${check.site.end}`;
    };
    assert.deepEqual(
      of("standing").map(site),
      ["null-check 27-32", "null-check 35-40", "null-check 43-48"],
      mode.name,
    );
    assert.deepEqual(of("lost").map(site), ["null-check 51-56"], mode.name);
    // (each standing copy names its operand check, which stays an extra)
    for (const problem of of("standing")) {
      const operand = problem.slice(problem.indexOf(" by ") + 4);
      assert.ok(problems.includes(`extra check ${operand}`), problem);
    }
  }
  assert.equal(standsForNullCheck(operand, nullCheck), true);
  assert.equal(standsForNullCheck({ ...operand, against: ["integer"] }, nullCheck), true);
  const others: Obligation[] = [
    { ...operand, against: ["integer", "number", "null"] },
    { ...operand, against: ["integer", "number", "duration"] },
    { ...operand, site: { file: 0, start: 35, end: 40 } },
    { ...operand, site: { file: 1, start: 27, end: 32 } },
    { ...operand, boundary: true },
    { ...operand, kind: "null-check" },
  ];
  for (const other of others)
    assert.equal(standsForNullCheck(other, nullCheck), false, JSON.stringify(other));
  assert.equal(standsForNullCheck(operand, { ...nullCheck, kind: "integer-check" }), false);
  // (the ledger: a standing pair is accounted for, the other checks still compared in order; each operand check stands
  // for one lost copy: a divisor whose null check and operand check both publish, the null check left out of the
  // stopped side, its other checks reversed, or its null check published twice on the unstopped side)
  {
    const source = "let xs = [4, null, hostValue]\nsay 1 / xs[1]\nrepeat hostOther {}\nexit\n";
    const run = heldRun({ name: "divisor", source, slice: true, values: [] }, HELD_MODES[0]!);
    const checks = run.answers.checks;
    const lost = checks.find(
      (check) => check.kind === "null-check" && check.on.endsWith(" before /"),
    )!;
    assert.ok(checks.some((check) => standsForNullCheck(check, lost)));
    const publishing = (each: StopRun, list: readonly Obligation[]): StopRun => ({
      ...each,
      answers: Object.defineProperty(Object.create(each.answers), "checks", { value: list }),
    });
    const others = checks.filter((check) => check !== lost);
    assert.ok(others.length >= 2);
    const judged = (unstopped: StopRun, stopped: StopRun) =>
      stopProblems({ unstopped, stopped, fitting: [], violating: [] }).map((problem) =>
        problem.replace(/ \{.*$/, ""),
      );
    assert.deepEqual(judged(run, publishing(run, others)), ["standing check"]);
    assert.deepEqual(judged(run, publishing(run, [...others].reverse())), [
      "standing check",
      "checks order",
    ]);
    assert.deepEqual(judged(publishing(run, [...checks, lost]), publishing(run, others)), [
      "standing check",
      "lost check",
    ]);
  }
  // (the same on a divisor whose own text spans two lines: Codex r2 on #1725)
  {
    const source = "say 1 / [4,\n null, hostValue][1]\nexit\n";
    const run = heldRun({ name: "multiline", source, slice: true, values: [] }, HELD_MODES[0]!);
    const checks = run.answers.checks;
    const lost = checks.find(
      (check) => check.kind === "null-check" && check.on.endsWith(" before /"),
    )!;
    assert.ok(lost.target.includes("\n"), lost.target);
    const others = checks.filter((check) => check !== lost);
    const stopped: StopRun = {
      ...run,
      answers: Object.defineProperty(Object.create(run.answers), "checks", { value: others }),
    };
    assert.deepEqual(
      stopProblems({ unstopped: run, stopped, fitting: [], violating: [] }).map((problem) =>
        problem.replace(/ \{[\s\S]*$/, ""),
      ),
      ["standing check"],
    );
  }
  // (its whole site: another end; the operator consumer's own two checks for one operator, never a receiver's check at
  // the operand's span, another operator's, or a null check whose words name another value; a domain admitting null,
  // `unknown` too, or one a name cannot compare: Codex r1 on #1725)
  const unmatched: (readonly [Obligation, Obligation])[] = [
    [{ ...operand, site: { file: 0, start: 27, end: 33 } }, nullCheck],
    [
      operand,
      { ...nullCheck, on: "check that xs is a list or a dict with .index before the read" },
    ],
    [{ ...operand, on: "check the operand of * when it runs" }, nullCheck],
    [operand, { ...nullCheck, target: "xs" }],
    [operand, { ...nullCheck, on: "check that xs.element is not null before *" }],
    [
      { ...operand, against: ["unknown"] },
      { ...nullCheck, against: ["unknown"] },
    ],
    [operand, { ...nullCheck, against: ["non-null"] }],
  ];
  for (const [other, check] of unmatched)
    assert.equal(standsForNullCheck(other, check), false, JSON.stringify([other, check]));
  // (a target that is a value's own text over several lines, its words whole)
  const multiline = "[4,\n null][1]";
  assert.equal(
    standsForNullCheck(
      { ...operand, target: multiline },
      { ...nullCheck, target: multiline, on: `check that ${multiline} is not null before /` },
    ),
    true,
  );
  // (a domain holding null stands for nothing, even where the null check's own kinds would hold it: the clause alone)
  assert.equal(
    standsForNullCheck(
      { ...operand, against: ["integer", "null"] },
      { ...nullCheck, against: ["integer", "number", "null"] },
    ),
    false,
  );
});

/**
 * #1741: a for loop's iterable and a repeat count, the other two consumers whose stopped run owes, for the null the
 * natural analysis proved, the check of the kinds its use needs (`standsForNullCheck`, pairs 2 and 3). Under demand
 * allowance 8 in every held mode, each witness's lost null check is a standing check by that consumer's replacement, at
 * its whole site on the same target with the same domain: the iterable's operand check against list, set, dict and
 * range, the count's integer check; Sol's allowance sweep found them as 13 contents in 379 copies (20 iterables, 359
 * counts, two of them `f1-astra-b1-cases` `astra::duplicates/integer?/8` and `/"bad"`). Each clause refuses alone, a
 * domain wider than the null check's by one kind included, by the predicate and through the ledger.
 */
test("a stopped iterable or repeat-count check stands for a lost null check only on its target, site and kinds (#1741)", () => {
  const duplicates = (value: string) =>
    `let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:${value},nest:{n:${value},keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n`;
  const witnesses: readonly (readonly [string, string, string])[] = [
    // (a `null` a handler may store: its null-check a warning, never the route rule's error, AD-1 and X7)
    [
      "iterable",
      "let l = [1]\ntimer async 1 s { l = null }\nfor x in l { say x }\nexit\n",
      "operand l 50-51",
    ],
    [
      "count",
      "let n = 2\ntimer async 1 s { n = null }\nrepeat n {}\nexit\n",
      "integer-check n 46-47",
    ],
    ["duplicates/8", duplicates("8"), "integer-check out.element.element.n 182-193"],
    ['duplicates/"bad"', duplicates('"bad"'), "integer-check out.element.element.n 190-201"],
  ];
  const named = (text: string) => {
    const check: Obligation = JSON.parse(text);
    return `${check.kind} ${check.target} ${check.site.start}-${check.site.end}`;
  };
  for (const [name, source, replacement] of witnesses)
    for (const mode of HELD_MODES) {
      const c: HeldCase = { name, source, slice: true, values: [] };
      const problems = stopProblems({
        unstopped: heldRun(c, mode),
        stopped: heldRun(c, mode, undefined, 8),
        fitting: [],
        violating: [],
      });
      const at = `${name} ${mode.name}`;
      assert.deepEqual(
        problems.filter((p) => p.startsWith("lost check ")).map((p) => p.slice(11)),
        [],
        at,
      );
      const standing = problems.filter((p) => p.startsWith("standing check "));
      assert.equal(standing.length, 1, at);
      assert.equal(named(standing[0]!.slice(standing[0]!.indexOf(" by ") + 4)), replacement, at);
      // (the replacing check is still its own content)
      assert.ok(
        problems.includes(`extra check ${standing[0]!.slice(standing[0]!.indexOf(" by ") + 4)}`),
        at,
      );
    }
  const iterableNull: Obligation = {
    kind: "null-check",
    target: "l",
    against: ["list", "set", "dict", "range"],
    on: "check that l is not null at the iterable of for",
    site: { file: 0, start: 44, end: 45 },
    boundary: false,
  };
  const iterable: Obligation = {
    ...iterableNull,
    kind: "operand",
    on: "check the operand l at the iterable of for when it runs",
  };
  const countNull: Obligation = {
    kind: "null-check",
    target: "n",
    against: ["integer"],
    on: "check that the repeat count is not null when it runs",
    site: { file: 0, start: 40, end: 41 },
    boundary: false,
  };
  const count: Obligation = {
    ...countNull,
    kind: "integer-check",
    on: "check that the repeat count is a whole number when it runs",
  };
  assert.equal(standsForNullCheck(iterable, iterableNull), true);
  assert.equal(standsForNullCheck({ ...iterable, against: ["list"] }, iterableNull), true);
  assert.equal(standsForNullCheck(count, countNull), true);
  const refused: (readonly [Obligation, Obligation])[] = [
    // (another target, spelled in the check's words as well: the same words on another value)
    [
      { ...iterable, target: "m", on: "check the operand m at the iterable of for when it runs" },
      iterableNull,
    ],
    [{ ...count, target: "m" }, countNull],
    // (another site, file or boundary)
    [{ ...iterable, site: { file: 0, start: 44, end: 46 } }, iterableNull],
    [{ ...count, site: { file: 1, start: 40, end: 41 } }, countNull],
    [{ ...count, boundary: true }, countNull],
    // (another consumer's words on either side, or the pair's checks crossed)
    [{ ...iterable, on: "check the operand l at the index of for when it runs" }, iterableNull],
    [iterable, { ...iterableNull, on: "check that l is not null before the read" }],
    [{ ...count, on: "check that the index is a whole number when it runs" }, countNull],
    [count, { ...countNull, on: "check that the index is not null when it runs" }],
    [{ ...count, kind: "operand" }, countNull],
    [{ ...iterable, kind: "integer-check" }, iterableNull],
    // (a domain admitting null, or unknown)
    [{ ...iterable, against: ["list", "null"] }, iterableNull],
    [
      { ...count, against: ["unknown"] },
      { ...countNull, against: ["unknown"] },
    ],
    // (a domain wider than the null check's by one kind: a weaker check, never one in other words)
    [iterable, { ...iterableNull, against: ["list", "set", "dict"] }],
    [{ ...count, against: ["integer", "number"] }, countNull],
  ];
  for (const [check, nullCheck] of refused)
    assert.equal(standsForNullCheck(check, nullCheck), false, JSON.stringify([check, nullCheck]));
  // (through the ledger: the count's replacement one kind wider stays a lost check, its null check unaccounted for)
  const c: HeldCase = { name: "count", source: witnesses[1]![1], slice: true, values: [] };
  const mode = HELD_MODES[0]!;
  const stopped = heldRun(c, mode, undefined, 8);
  const wider = stopped.answers.checks.map((check) =>
    check.kind === "integer-check" && check.target === "n"
      ? { ...check, against: ["integer", "number"] }
      : check,
  );
  const problems = stopProblems({
    unstopped: heldRun(c, mode),
    stopped: {
      ...stopped,
      answers: Object.defineProperty(Object.create(stopped.answers), "checks", { value: wider }),
    },
    fitting: [],
    violating: [],
  });
  assert.deepEqual(
    problems
      .filter((p) => /^(lost|standing) check /.test(p))
      .map((p) => `${p.split(" ")[0]} ${named(p.slice(p.indexOf("{")).split(" by ")[0]!)}`),
    ["lost null-check n 46-47"],
  );
});

/**
 * #1757 (the lead's ruling on #1741's sweep): a pass can decide one place's path twice (`1310-astra-probe-stops.mjs`
 * `chain/hostValue`: the root of `box`, 38 units and then 1 in the natural pass). The stop oracle compares such records
 * by their occurrence, refusing a comparison only where the two runs decide the key a different number of times, and
 * lists each repetition as a problem line (`repeated decision at …`), never a failure; why the core repeats is #1757's.
 */
test("a decision a pass makes twice is compared by its occurrence and listed apart, never a failure (#1757)", () => {
  const c: HeldCase = {
    name: "chain/hostValue",
    source: `let box = {last: null}\nbox.last = {first: null}\nbox.last.first = {n: 1}\nsay "BEFORE"\nbox.last.first.n = hostValue\nsay "AFTER"\nexit\n`,
    slice: true,
    values: [],
  };
  const mode = HELD_MODES[0]!;
  const unstopped = heldRun(c, mode);
  for (const demand of [8, 16, 256]) {
    const run = { unstopped, stopped: heldRun(c, mode, undefined, demand) };
    // (judged, the repetition compared by occurrence: no refusal, no line of it among the problems)
    const problems = stopProblems({ ...run, fitting: [], violating: [] });
    assert.ok(!problems.some((p) => p.startsWith("repeated decision")), `${demand}`);
    // (listed apart: the natural pass's repetitions, then the stopped one's where its units differ)
    const lines = repeatedDecisions(run);
    assert.deepEqual(
      lines.slice(0, 2),
      [
        "repeated decision at [5,[]]: units 38, 1, 1",
        'repeated decision at [5,["last"]]: units 305, 2',
      ],
      `${demand}`,
    );
    for (const line of lines)
      assert.match(
        line,
        /^repeated decision at \[\d+,\[[^\]]*\]\]: units \d+(, \d+)+$/,
        `${demand}`,
      );
  }
});
