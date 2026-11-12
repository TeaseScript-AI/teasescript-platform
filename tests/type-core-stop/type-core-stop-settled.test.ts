// A stop after admission settled (in the walk or the publication): what it keeps of the finished analysis, and what a
// read after it answers.

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { compileSourceWithBackend } from "../../src/compiler.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../src/type-inference/core/budget.js";
import { withConsumerOrder, withoutRecords } from "../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import {
  heldFamily,
  heldProblems,
  heldStops,
  heldUnstopped,
  HELD_MODES,
  phaseEnds,
  testedAllowances,
  testedStops,
  searchedStops,
  type HeldCase,
} from "../helpers/type-core-held-host.js";
import { stopProblems, type Globals, type StopRun } from "../helpers/type-core-stop-oracle.js";
import {
  OPTIONS,
  LOST_CHECK,
  DEFAULT_LOST,
  object,
  host,
  stopRun,
  walkEnds,
} from "../helpers/type-core/type-core-stop-setup.js";

/**
 * what a phase settled is never discarded by a later one, and a stop changes nothing of the
 * unstopped compile but the records its deferred marks name (the stop oracle, `helpers/type-core-stop-oracle.ts`). A
 * stop in a settled pass's walk or publication keeps admission's contracts (an inferred scalar's, a record's), the
 * findings (an error a copy brings, not a literal's), the quiet proofs and the whole plan (a default's check against a
 * written or written element type, Astra's B1 of round 2; an `otherwise`'s). Each mode's phases found in that mode; the
 * stop at the first unit of each settled phase and at its last, its phase asserted (the every-unit sweep runs outside
 * CI). `marked`: the code of an obligation a stop may leave undecided and the source text of its site, the first after
 * `after`: the stop marks it at one stop at least. A case's fourth element, `true`, says some of its settled stops owe a
 * fallback's obligation against `unknown` and decline at the default (#2183, `owesLostDefault`), every other stop as
 * above; without it no stop declines.
 */
function settledPhases(
  cases: readonly (
    | readonly [string, readonly Globals[], readonly Globals[]]
    | readonly [string, readonly Globals[], readonly Globals[], true]
  )[],
  marked?: { readonly code: string; readonly after: string; readonly text: string },
): void {
  const options = { globals: ["hostValue", "hostOther"] };
  const modes = [
    { reversed: false, sharing: true },
    { reversed: true, sharing: true },
    { reversed: false, sharing: false },
    { reversed: true, sharing: false },
  ];
  for (const [source, fitting, violating, lostDefault = false] of cases)
    for (const { reversed, sharing } of modes) {
      const inMode = <T>(make: () => T): T => {
        const ordered = (): T =>
          reversed
            ? withSolverSeam({ reverseWorklist: true }, () =>
                withConsumerOrder((list) => [...list].reverse(), make),
              )
            : make();
        return sharing ? ordered() : withoutSharing(ordered);
      };
      const request = coreRequest([{ path: "main.tease", source }], options.globals);
      assert.ok(request !== null);
      const analyse = (allowance: number): Answers =>
        withTestAllowance(allowance, () => inMode(() => analyseCore(request)));
      const compile = () => inMode(() => compileSourceWithBackend(source, options, CORE_BACKEND));
      const both = () => ({ result: compile(), answers: inMode(() => analyseCore(request)) });
      const unstopped: StopRun = { ...both(), without: (omit) => withoutRecords(omit, both) };
      // this mode's settled phases: the stops below its total, down to the first that is not settled
      const stops = phaseEnds(unstopped.answers.budget.total, (allowance) => {
        const { stoppedIn, settled } = analyse(allowance).budget;
        return settled ? stoppedIn : null;
      });
      const where = `${source} reversed: ${reversed} sharing: ${sharing}`;
      // (a settled phase at least: a program without boundaries charges its publication nothing)
      assert.ok(stops.has("walk") || stops.has("publication"), where);
      // (the marked obligation's code and site)
      const start = marked && source.indexOf(marked.text, source.indexOf(marked.after));
      const site = marked && `${marked.code} ${start}:${start! + marked.text.length}`;
      let marks = 0;
      let declined = 0;
      for (const [phase, ends] of stops)
        for (const allowance of ends) {
          const answers = analyse(allowance);
          assert.equal(answers.budget.stoppedIn, phase, `${where} @${allowance}`);
          if (
            answers.budget.deferred.some((d) => `${d.code} ${d.site.start}:${d.site.end}` === site)
          )
            marks += 1;
          let result: StopRun["result"];
          try {
            result = withTestAllowance(allowance, compile);
          } catch (error) {
            if (!(error instanceof CandidateOutsideSlice) || error.what !== DEFAULT_LOST)
              throw error;
            assert.ok(owesLostDefault(answers), `${where} ${phase} @${allowance}`);
            declined += 1;
            continue;
          }
          assert.deepEqual(
            stopProblems({
              unstopped,
              stopped: {
                result,
                answers,
                without: (omit) => withTestAllowance(allowance, () => withoutRecords(omit, both)),
              },
              fitting,
              violating,
            }),
            [],
            `${where} ${phase} @${allowance}`,
          );
        }
      if (marked !== undefined) assert.ok(marks > 0, where);
      assert.equal(declined > 0, lostDefault, `${where}: declined at ${declined} stops`);
    }
}

/**
 * Whether a settled stop's analysis owes a fallback's obligation against exactly `unknown`, which declines its compile
 * at the default (#2183, `settledOwed`).
 */
function owesLostDefault(answers: Answers): boolean {
  return [...answers.diagnostics, ...answers.budget.deferred].some(
    (d) =>
      d.class === "warning-runtime-check" &&
      d.kind !== "budget" &&
      d.rule.rule === "fallback" &&
      d.obligation.against.length === 1 &&
      d.obligation.against[0] === "unknown",
  );
}

test("a stop after admission settled keeps its contracts, findings, quiet proofs and checks", () => {
  settledPhases([
    [
      'let count = 1\ncount = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n',
      [host(2)],
      [host(1.5)],
    ],
    [
      'let parcel = {count: 1}\nparcel = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n',
      [host(object({ count: 2 }))],
      [host(object({ count: 1.5 }))],
    ],
    [
      'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n',
      [],
      [],
    ],
    [
      'let count = 2\nrepeat count {}\nlet n: integer = hostValue\nsay "DONE"\nexit\n',
      [host(2)],
      [host(1.5)],
    ],
    [
      'let items: integer[] = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [host(2, 3)],
      [host("bad", 3)],
    ],
    [
      'let anchor = 4\nlet value = anchor otherwise hostValue\nsay value\nsay "AFTER"\nexit\n',
      [host(2, 3)],
      [host("bad", 3)],
    ],
    // a domain is not the value's kinds: `integer?` copied where the value is only `null` imposes no
    // family on the fallback, so a text fallback still runs (Codex r9's B1); where a stop leaves `c`'s kinds the stop's,
    // the fallback owes its check against `unknown` and the program declines at it, a false decline (#2183)
    [
      'let v: integer? = null\nlet a = {v:v}\nlet b = a\nlet c = b.v\nsay c otherwise hostValue\nsay "AFTER"\nexit\n',
      [host("bad", 3)],
      [],
      true,
    ],
  ]);
});

/**
 * C5's record where the retained state decides its receiver's shape (Astra r3's N1): a store of a
 * property no source of its receiver has is an error at the literal the receiver copies, and a stop after admission
 * settled publishes it there, not a mark at the store.
 */
test("a stop after admission settled keeps the error at the literal a property store's receiver copies", () => {
  settledPhases([
    ["let original = {kept:1}\nlet mirror = original\nmirror.absent = hostValue\nexit\n", [], []],
  ]);
});

/**
 * the finishing path derives a unit's findings as the analysis does. A parameter whose `null` default
 * reaches a member read is an error (#1172's `defaultOf`); a walk stop before that read keeps the error, in both orders.
 * Functions are outside the candidate route: through the analysis.
 */
test("a stop in a settled walk keeps the error of a member read of a null default", () => {
  const source =
    'function show(item = null) {\n  say item.name\n}\nshow({name: "n0"})\nlet n: integer = hostValue\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const errors = (answers: Answers): string[] =>
    answers.diagnostics
      .filter((d) => d.class === "compile-error")
      .map((d) => `${d.code} ${d.site.start}:${d.site.end}`);
  const at = source.indexOf("item.name");
  for (const reversed of [false, true]) {
    const analyse = (allowance?: number): Answers => {
      const run = (): Answers => analyseCore(request);
      const ordered = (): Answers =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), run),
            )
          : run();
      return allowance === undefined ? ordered() : withTestAllowance(allowance, ordered);
    };
    assert.deepEqual(errors(analyse()), [`TSV043 ${at}:${at + "item.name".length}`]);
    // the settled walk's first and last stops
    const walk = phaseEnds(analyse().budget.total, (allowance) => {
      const { stoppedIn, settled } = analyse(allowance).budget;
      return settled ? stoppedIn : null;
    }).get("walk");
    assert.ok(walk !== undefined, `reversed: ${reversed}`);
    for (const allowance of walk)
      assert.deepEqual(errors(analyse(allowance)), errors(analyse()), `${reversed} @${allowance}`);
  }
});

/**
 * After a stop a read is answered from admission's retained state through the copy forest (S3 revision 14), walked
 * finitely: round a cycle of copies whose member copies another's part (`b = a.next`, `a = b`) a path grows no step,
 * so a read below it finishes at every settled phase's ends instead of overflowing the native stack (Codex r9's B2).
 */
test("after a stop a read through a cycle of copies that would grow its path finishes", () => {
  const source =
    'let items: integer[] = [2,3]\nlet a = {xs: items, next: {xs: items}}\nlet b = a.next\na = b\nsay b.next.xs.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const analyse = (allowance: number): Answers =>
    withTestAllowance(allowance, () => analyseCore(request));
  const ends = phaseEnds(analyseCore(request).budget.total, (allowance) => {
    const { stoppedIn, settled } = analyse(allowance).budget;
    return settled ? stoppedIn : null;
  });
  assert.ok(ends.has("walk"));
  for (const pair of ends.values())
    for (const allowance of pair)
      assert.equal(analyse(allowance).outcome, "warning-runtime-check", `@${allowance}`);
});

/**
 * Read as the value for a fixed need, a domain says nothing of emptiness: a copied written list that may
 * be empty keeps its selection's empty check at the settled walk's ends, in both orders. A call statement is outside
 * the candidate route: through the analysis.
 */
test("a stop keeps the empty check of a selection read through a copied written list", () => {
  const source =
    'let grow: boolean = hostValue\nlet a: integer[] = []\nif grow { a.add(2) }\nlet b = a\nsay b.first\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const at = source.indexOf("b.first");
  const owed = (answers: Answers): boolean =>
    [...answers.diagnostics, ...answers.budget.deferred].some(
      (d) => d.code === "TSV043" && d.site.start === at && d.site.end === at + "b.first".length,
    );
  for (const reversed of [false, true]) {
    const analyse = (allowance?: number): Answers => {
      const run = (): Answers => analyseCore(request);
      const ordered = (): Answers =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), run),
            )
          : run();
      return allowance === undefined ? ordered() : withTestAllowance(allowance, ordered);
    };
    assert.ok(owed(analyse()), `unstopped, reversed: ${reversed}`);
    const walk = phaseEnds(analyse().budget.total, (allowance) => {
      const { stoppedIn, settled } = analyse(allowance).budget;
      return settled ? stoppedIn : null;
    }).get("walk");
    assert.ok(walk !== undefined, `reversed: ${reversed}`);
    for (const allowance of walk) assert.ok(owed(analyse(allowance)), `${reversed} @${allowance}`);
  }
});

/**
 * The key's finished contract is a domain too: `b.v` is only `null` at the read though `v` may hold an
 * integer later, so no stop gives the fallback the integer family (Codex r10's B1, a band inside the walk): at every
 * settled walk stop, in the source order, the text fallback still runs, or, where the stop leaves `b.v`'s kinds the
 * stop's, the fallback owes its check against `unknown` and the program declines at it, a false decline (#2183).
 */
test("no stop in a settled walk gives a fallback the family of its key's contract", () => {
  const source =
    'let v: integer? = null\nlet a = {v:v}\nlet b = a\nsay b.v otherwise hostValue\nv = 2\nsay "AFTER"\nexit\n';
  const unstopped = stopRun(source);
  const [low, high] = walkEnds(source);
  let declined = 0;
  for (let allowance = low; allowance <= high; allowance += 1) {
    const stopped = stopRun(source, allowance);
    if (stopped.lostDefault) {
      assert.ok(owesLostDefault(stopped.answers), `@${allowance}`);
      declined += 1;
      continue;
    }
    assert.deepEqual(
      stopProblems({ unstopped, stopped, fitting: [host("good", 3)], violating: [] }),
      [],
      `@${allowance}`,
    );
  }
  assert.ok(declined > 0);
});

/**
 * The same of an inferred list's default (`get`'s C10): its element type is first found by its own unit's read, so a walk
 * stop before that unit leaves the element's contract unfinished; the stores' syntax decides it (`[2, 3]`: integers),
 * so the default keeps its check.
 */
test("a stop after admission settled checks an inferred list's default by its stores' syntax", () => {
  settledPhases([
    [
      'let items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [host(2, 3)],
      [host("bad", 3)],
    ],
    [
      "let anchor = 4\nlet value = anchor otherwise hostValue\nlet items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay value\nexit\n",
      [host(2, 3)],
      [host("bad", 3)],
    ],
  ]);
});

/**
 * A copied element type that admits `null` leaves the default's family undecided: the stop marks the default against
 * `unknown`, and the program declines at it (#2183).
 */
test("a stop after admission settled marks a default whose element domain admits null", () => {
  settledPhases(
    [
      [
        'let items: integer?[] = [2,null]\nlet a = {xs: items}\nlet b = a\nsay b.xs.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
        [host(2, 3)],
        [host("bad", 3)],
        true,
      ],
    ],
    { code: "TSV041", after: "default:", text: "hostValue" },
  );
});

/**
 * After a settled stop a read's answer takes the type admission gives its place as `place` does, a path admission decides
 * lazily among them (S3): at every settled walk stop, `src.first`'s `at` and `valueAt` hold the kinds
 * `place(src, ["element"])` admits, never `budget` (the matrix's 116).
 */
test("after a settled stop a read answers its place's lazily decided type, as place does", () => {
  const source =
    'let count: integer = 2\nlet base: integer[] = [1]\nlet src = [1, 2]\nsay src.first\nsay "DONE"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const at = source.indexOf("src.first");
  const [low, high] = walkEnds(source);
  for (let allowance = low; allowance <= high; allowance += 1) {
    const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
    const read = answers.graph.nodes.find(
      (node) =>
        node.expression?.kind === "propertyAccessExpression" && node.span?.start.offset === at,
    );
    assert.ok(read !== undefined);
    const answer = answers.at(read);
    assert.ok(answer !== null && answer.place !== null, `@${allowance}`);
    const admitted = answers.place(answer.place.id, answer.place.path).admitted;
    assert.equal(admitted.by, "decided", `@${allowance}`);
    const kinds = (items: readonly { readonly tag: string }[]) =>
      [...new Set(items.map((item) => item.tag).filter((tag) => tag !== "empty"))].sort();
    const expected = [...admitted.kinds].sort();
    assert.deepEqual(kinds(answer.items), expected, `@${allowance}`);
    assert.deepEqual(kinds(answers.valueAt(read, []).items), expected, `@${allowance}`);
  }
});

/**
 * A literal's composed questions read a child through the same sources as the child's own question: at
 * every settled walk stop of Astra r7's three, a list, two objects deep and a copy's selection in a set, the literal's
 * element or property answers the selection's lazily decided `integer`, as the selection's own read does, never `budget`.
 */
test("after a settled stop a literal's composed questions answer a child's lazily decided type, as its own read does", () => {
  for (const [source, child, literal, kind, path] of [
    [
      "let basket = [2, 4]\nsay [basket.first]\nexit\n",
      "basket.first",
      "[",
      "listLiteral",
      ["element"],
    ],
    [
      "let basket = [2, 4]\nsay {outer: {inner: basket.first}}\nexit\n",
      "basket.first",
      "{outer",
      "objectLiteral",
      ["outer", "inner"],
    ],
    [
      "let basket = [2, 4]\nlet mirror = basket\nsay set[mirror.first]\nexit\n",
      "mirror.first",
      "set[",
      "setLiteral",
      ["element"],
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const nodeAt = (answers: Answers, offset: number, expression: string) => {
      const node = answers.graph.nodes.find(
        (each) =>
          each.kind === "expression" &&
          each.expression?.kind === expression &&
          each.span?.start.offset === offset,
      );
      assert.ok(node !== undefined, `${source} @${offset}`);
      return node;
    };
    const kinds = (items: readonly { readonly tag: string }[]) => {
      assert.ok(items.length > 0 && items.every((item) => item.tag !== "unknown"), source);
      return [...new Set(items.map((item) => item.tag).filter((tag) => tag !== "empty"))].sort();
    };
    const [low, high] = walkEnds(source);
    for (let allowance = low; allowance <= high; allowance += 1) {
      const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
      const own = answers.at(nodeAt(answers, source.indexOf(child), "propertyAccessExpression"));
      assert.ok(own !== null, `${source} @${allowance}`);
      assert.deepEqual(kinds(own.items), ["integer"], `${source} @${allowance}`);
      const outer = nodeAt(answers, source.indexOf(literal), kind);
      const composed = [answers.valueAt(outer, path).items];
      if (path.length === 1) composed.push(answers.project(outer, "element"));
      else {
        const inner = nodeAt(answers, source.indexOf("{inner"), "objectLiteral");
        composed.push(answers.project(inner, { property: "inner" }));
        composed.push(answers.properties(inner).get("inner") ?? []);
      }
      for (const items of composed)
        assert.deepEqual(kinds(items), ["integer"], `${source} @${allowance}`);
    }
  }
});

/**
 * After a settled stop a boundary's type is a read like any other (Astra r4's B2): where admission retained
 * no decision for `total`, its boundary takes its stored value's finished contract, `integer | number`, as the finishing
 * read answers it. At every settled stop it equals the unstopped boundary, in four modes; the quiet controls (a
 * subtraction, a multiplication, a comparison, a written `number` destination) keep theirs, in the core's order.
 */
test("a settled stop keeps a boundary's type from its stored value's finished contract", () => {
  const reversed = <T>(make: () => T): T =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), make),
    );
  const modes: readonly (<T>(make: () => T) => T)[] = [
    (make) => make(),
    reversed,
    (make) => withoutSharing(make),
    (make) => withoutSharing(() => reversed(make)),
  ];
  for (const [source, inModes] of [
    ["let total = hostValue + 8\nrepeat hostOther { say total }\nexit\n", modes],
    ["let total = hostValue - 8\nrepeat hostOther { say total }\nexit\n", modes.slice(0, 1)],
    ["let total = hostValue * 8\nrepeat hostOther { say total }\nexit\n", modes.slice(0, 1)],
    ["let total = hostValue < 8\nrepeat hostOther { say total }\nexit\n", modes.slice(0, 1)],
    [
      "let total: number = hostValue + 8\nrepeat hostOther { say total }\nexit\n",
      modes.slice(0, 1),
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const site = source.indexOf("hostValue");
    const boundary = (answers: Answers) =>
      answers.checks.filter((check) => check.boundary && check.site.start === site);
    for (const inMode of inModes) {
      const at = (allowance?: number): Answers =>
        inMode(() =>
          allowance === undefined
            ? analyseCore(request)
            : withTestAllowance(allowance, () => analyseCore(request)),
        );
      const unstopped = at();
      assert.equal(boundary(unstopped).length, 1, source);
      const phaseOf = (allowance: number): string | null => {
        const { stoppedIn, settled } = at(allowance).budget;
        return settled ? stoppedIn : null;
      };
      for (const [phase, [low, high]] of phaseEnds(unstopped.budget.total, phaseOf))
        for (const allowance of testedAllowances(phase, low, high))
          assert.deepEqual(boundary(at(allowance)), boundary(unstopped), `${source} @${allowance}`);
    }
  }
});

/**
 * A stop takes back its running unit's read checks with all that made them (Codex r12's final check): the dedupe keys
 * and the ingress resolutions, so finishing makes a projected fallback's own-read boundary again. At every settled walk
 * stop, in the source order (an interior stop: a phase's ends miss it), the compile keeps every record.
 */
test("every settled walk stop keeps a projected fallback's own-read boundary", () => {
  const source = "hostValue.n = 2\nsay 1 otherwise hostValue.n\nexit\n";
  const unstopped = stopRun(source);
  const [low, high] = walkEnds(source);
  for (let allowance = low; allowance <= high; allowance += 1)
    assert.deepEqual(
      stopProblems({ unstopped, stopped: stopRun(source, allowance), fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
});

/**
 * #1216: a settled walk stop adds a redundant read check of `state.ticks`, read by its key's contract
 * whose external item lost the ingress the value read keeps, so the count's consumer checks it as host data no ingress
 * store brought. The stop oracle takes it as the count's mark content (#1448); the check is pinned by its
 * publication, counted at every stop of the settled phases in the analysis's own order: the test fails where the count
 * moves (it goes when #1216 lands).
 */
test("#1216's redundant check stands at its counted stops", () => {
  const source =
    'let seed = {ticks: 2, title: "ok"}\nlet state = seed\nstate = hostValue\nrepeat state.ticks {}\nsay state.title\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const analyse = (allowance: number): Answers =>
    withTestAllowance(allowance, () => analyseCore(request));
  const check =
    '{"kind":"copy-type","target":"state.ticks","against":["unknown"],"on":"validate external data state.ticks","site":{"file":0,"start":77,"end":88},"boundary":true}';
  const has = (answers: Answers): boolean =>
    answers.checks.some((each) => JSON.stringify(each) === check);
  const unstopped = analyseCore(request);
  assert.equal(has(unstopped), false);
  let count = 0;
  for (const [phase, [low, high]] of phaseEnds(unstopped.budget.total, (allowance) => {
    const { stoppedIn, settled } = analyse(allowance).budget;
    return settled ? stoppedIn : null;
  }))
    for (const allowance of testedAllowances(phase, low, high))
      if (has(analyse(allowance))) count += 1;
  assert.equal(count, 96);
});

/**
 * #1432, #1415 (S3; S8's mark-ownership rule): after a settled program stop, a read the finishing walk
 * answers by a domain holds the host data its key's stores hold, as the unstopped read does, so its consumer owes its
 * check (a mark carrying the unstopped obligation) and the store's boundary forms: through a dictionary's values
 * list (#1452), and where an unrestricted written type stands, whose store owes no other boundary (#1450). The anchors
 * (`heldFamily`: each holder at depth 1, read by a repeat count and by an interpolation) at the sample of every twelfth
 * stop of each settled phase and its last (`testedStops`), forward with the sharing and reversed without it; the whole
 * family runs outside CI.
 */
test("a settled stop keeps the checks of the host data a place's stores hold (#1432, #1415)", () => {
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!])
    for (const c of heldFamily(true)) {
      const { run: unstopped, problems } = heldUnstopped(c, mode);
      assert.deepEqual(problems, [], `${c.name}, ${mode.name}`);
      const stops = testedStops(heldStops(c, mode, 12));
      assert.ok(
        stops.some((stop) => stop.phase === "walk"),
        `${c.name}, ${mode.name}`,
      );
      for (const { allowance, phase } of stops)
        assert.deepEqual(
          heldProblems(c, mode, allowance, unstopped),
          [],
          `${c.name}, ${mode.name}, ${phase} @${allowance}`,
        );
    }
});

/**
 * #1501 (the owner's reviewer's control on #1536): host data stored into an unrestricted written element keeps its
 * boundary (`copy-type xs.element`, against `unknown`, at `hostValue`) at the walk's settled stops in source order, owned or
 * kept, its domain's `unknown` being opaque; before the finishing read took that reason the walk's stops lost it (895; 783 since #1251 makes no narrowing index for this program).
 */
test("a settled stop keeps the boundary of host data an unrestricted written element holds, at the walk's stops (#1501)", () => {
  const c = heldFamily(true).find((each) => each.name === "writtenList-1-repeat-plain")!;
  assert.equal(
    c.source,
    'let xs: list = [hostValue, 4]\nsay "BEFORE"\nrepeat xs[0] {say "ok"}\nsay "AFTER"\nexit\n',
  );
  const mode = HELD_MODES[0]!;
  const { run: unstopped } = heldUnstopped(c, mode);
  // the reviewer's own stop: forward order, program allowance 783, a settled walk stop, where the boundary of
  // `hostValue` (16:25) was lost
  const boundary = unstopped.answers.checks.find(
    (check) =>
      check.target === "xs.element" &&
      check.boundary &&
      check.site.start === 16 &&
      check.site.end === 25,
  );
  assert.deepEqual(boundary?.against, ["unknown"]);
  const request = coreRequest(
    [{ path: "main.tease", source: c.source }],
    ["hostValue", "hostOther"],
  )!;
  const { stoppedIn, settled } = mode.run(() =>
    withTestAllowance(783, () => analyseCore(request)),
  ).budget;
  assert.deepEqual({ stoppedIn, settled }, { stoppedIn: "walk", settled: true });
  assert.deepEqual(heldProblems(c, mode, 783, unstopped), [], "walk @783");
  // (and every eighth of the walk's stops, where the finishing read answers the repeat count's domain)
  const stops = heldStops(c, mode, 8).filter((stop) => stop.phase === "walk");
  assert.ok(stops.length > 0);
  for (const { allowance } of stops)
    assert.deepEqual(heldProblems(c, mode, allowance, unstopped), [], `walk @${allowance}`);
});

/**
 * #1501: after a settled stop the finishing read follows a domain's host data where its contract's `unknown` carries no
 * reason but the opaque one, as a written open domain's does (the held family's `writtenList` and its siblings above).
 * The same reason marks a reference's member, a speaker's property and a handle: a stop of a read of one changes nothing
 * of its unstopped analysis (judged at the analysis, as the candidate route declines speakers).
 */
test("a settled stop changes nothing of a read of a reference's member, a speaker's property or a handle (#1501)", () => {
  const cases: HeldCase[] = (
    [
      [
        "reference member",
        "speaker vera { mood: 1 }\nvera.mood = hostValue\nlet alias = vera",
        "alias.mood",
      ],
      ["speaker property", "speaker vera { mood: hostValue }", "vera.mood"],
      [
        "reference union",
        'speaker vera { length: 2 }\nlet pool: dict = dict{a: [hostValue], b: vera}\nlet alias = pool.get("a", default: vera)',
        "alias.length",
      ],
      ["handle", "let alias = timer async hidden 1 s {}", "alias.length"],
    ] as const
  ).map(([name, setup, read]) => ({
    name,
    source: `${setup}\nsay "BEFORE"\nrepeat ${read} {say "ok"}\nsay "AFTER"\nexit\n`,
    slice: false,
    values: [],
  }));
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!])
    for (const c of cases) {
      const { run: unstopped } = heldUnstopped(c, mode);
      const stops = testedStops(heldStops(c, mode, 12));
      assert.ok(stops.length > 0, `${c.name}, ${mode.name}`);
      for (const { allowance, phase } of stops)
        assert.deepEqual(
          heldProblems(c, mode, allowance, unstopped),
          [],
          `${c.name}, ${mode.name}, ${phase} @${allowance}`,
        );
    }
});

/** A `get` whose result nothing consumes, its default `hostOther`: a fitting value and `null` run on, `bad` is rejected. */
function unusedGet(name: string, setup: readonly string[], receiver: string): HeldCase {
  return {
    name,
    source: [
      ...setup,
      'say "BEFORE"',
      `${receiver}.get(4, default: hostOther)`,
      'say "AFTER"',
      "exit",
      "",
    ].join("\n"),
    slice: true,
    values: [
      ...[2, null].map((value) => ({
        globals: { hostValue: 2, hostOther: value },
        says: ["BEFORE", "AFTER"],
      })),
      { globals: { hostValue: 2, hostOther: "bad" }, says: null },
    ],
  };
}

/**
 * #1563 (S8's mark-ownership rule; C10): a `get` whose result nothing consumes reads its receiver's element first in the
 * walk, so a walk stop may leave that read unfinished, and the finishing read decides the default's family by structure
 * alone: a projection of a literal no place holds by the literal's cells (`[[hostValue, 4][0]]`, the issue's; a
 * dictionary literal's `values` list by the dictionary's), a store of one by the stores' syntax through the same cells,
 * and a requirement one domain leaves to several families or to every kind by the next domain that gives one (a written
 * `list` or union receiver: the stores' syntax). At the sample of every eighth settled stop of each phase and its last
 * (`testedStops`), forward with the sharing and reversed without it, all five preserve the unstopped check against the
 * integer family. The
 * projection, stored projection and written-list cases also reject `bad` before `AFTER`; dictionary values and the
 * written union are analysis-only (the candidate route declines them).
 */
test("a settled stop keeps the family of an unused get's default that structure decides (#1563)", () => {
  const cases = [
    unusedGet("projection", [], "[[hostValue, 4][0]]"),
    unusedGet("dictionary values", [], "[(dict {a: hostValue, b: 4}).values[0]]"),
    unusedGet("stored projection", ["let xs = [({f: 4, g: hostValue}).f]"], "xs"),
    unusedGet("written list", ["let xs: list = [4]"], "xs"),
    unusedGet("written union", ["let xs: (integer|string)[] = [4]"], "xs"),
  ];
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!])
    for (const c of cases) {
      const { run: unstopped, problems } = heldUnstopped(c, mode);
      assert.deepEqual(problems, [], `${c.name}, ${mode.name}`);
      assert.ok(
        unstopped.answers.checks.some(
          (check) =>
            check.target === "hostOther" &&
            !check.boundary &&
            isDeepStrictEqual(check.against, ["integer", "number"]),
        ),
        `${c.name}, ${mode.name}`,
      );
      const stops = testedStops(heldStops(c, mode, 8));
      assert.ok(
        stops.some((stop) => stop.phase === "walk"),
        `${c.name}, ${mode.name}`,
      );
      for (const { allowance, phase } of stops)
        assert.deepEqual(
          heldProblems(c, mode, allowance, unstopped),
          [],
          `${c.name}, ${mode.name}, ${phase} @${allowance}`,
        );
    }
});

/**
 * #1563, Codex r1's B1 on #1581: structure decides a projection only where every literal it may read has a part at the
 * step, so a selection of two objects of which one lacks `f` leaves `.f` undecided, and the read's obligations stay:
 * the natural analysis's null-checks of the selection and of its `f` (its property and its index read) are kept or
 * owned at each phase's sample of its settled stops (`testedStops`) in four modes. The unused default's family, which no
 * structure decides there, is reported lost as #1580's forms are, and nothing else: at the sample of every eighth stop,
 * forward with the sharing and reversed without it.
 */
test("a settled stop keeps a projection's read obligations where one literal lacks its step (#1563)", () => {
  const c = unusedGet("lacking step", [], "[[{f: [hostValue, 4]}, {g: 4}][0].f[0]]");
  const request = coreRequest(
    [{ path: "main.tease", source: c.source }],
    ["hostValue", "hostOther"],
  )!;
  const obligation = (check: Answers["checks"][number]) => JSON.stringify(check);
  for (const mode of HELD_MODES) {
    const { run: unstopped, problems } = heldUnstopped(c, mode);
    assert.deepEqual(problems, [], mode.name);
    const nullChecks = unstopped.answers.checks.filter((check) => check.kind === "null-check");
    assert.equal(nullChecks.length, 2, mode.name);
    for (const { allowance, phase } of testedStops(heldStops(c, mode))) {
      const stopped = mode.run(() => withTestAllowance(allowance, () => analyseCore(request)));
      const owed = new Set(
        [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)].map(
          obligation,
        ),
      );
      for (const check of nullChecks)
        assert.ok(
          owed.has(obligation(check)),
          `${mode.name}, ${phase} @${allowance}: ${check.target}`,
        );
    }
    if (mode !== HELD_MODES[0] && mode !== HELD_MODES[3]) continue;
    const lost = unstopped.answers.checks.find(
      (check) => check.target === "hostOther" && !check.boundary,
    );
    assert.ok(lost !== undefined, mode.name);
    const reported = [
      `unowned check ${obligation(lost)}`,
      'forbidden {"hostValue":2,"hostOther":"bad"} said ["BEFORE","AFTER"]',
    ];
    for (const { allowance, phase } of testedStops(heldStops(c, mode, 8)))
      assert.deepEqual(
        heldProblems(c, mode, allowance, unstopped).filter((found) => !reported.includes(found)),
        [],
        `${mode.name}, ${phase} @${allowance}`,
      );
  }
});

/**
 * #1563's forms structure does not decide: an element whose kinds the solver derives by a rule (a conversion's here; an
 * operation's, a fallback's, a `get`'s and a comparison's alike) is not decided after a stop, so where the walk stopped
 * before the receiver's element was read, the default's mark stands against `unknown`, "not checked (budget)" at the
 * default, and the oracle reports the unstopped check lost; the program declines at the default, where before it ran
 * `bad` on (#2183). Forward with the sharing, at every eighth settled stop.
 */
test("a settled stop reports an unused get's default lost where only a rule decides its family (#1563)", () => {
  const c = unusedGet("conversion", [], "[toInteger(hostValue, default: 3)]");
  const mode = HELD_MODES[0]!;
  const { run: unstopped, problems } = heldUnstopped(c, mode);
  assert.deepEqual(problems, [], c.name);
  const lost = unstopped.answers.checks.find(
    (check) =>
      check.target === "hostOther" &&
      !check.boundary &&
      isDeepStrictEqual(check.against, ["integer", "number"]),
  );
  assert.ok(lost !== undefined);
  const request = coreRequest(
    [{ path: "main.tease", source: c.source }],
    ["hostValue", "hostOther"],
  )!;
  let reported = 0;
  for (const { allowance, phase } of searchedStops(heldStops(c, mode, 8))) {
    const found = heldProblems(c, mode, allowance, unstopped);
    if (found.length === 0) continue;
    reported += 1;
    assert.deepEqual(found, [`unowned check ${JSON.stringify(lost)}`], `${phase} @${allowance}`);
    assert.throws(
      () =>
        mode.run(() =>
          withTestAllowance(allowance, () =>
            compileSourceWithBackend(
              c.source,
              { globals: ["hostValue", "hostOther"] },
              CORE_BACKEND,
            ),
          ),
        ),
      (error) => error instanceof CandidateOutsideSlice && error.what === DEFAULT_LOST,
      `${phase} @${allowance}`,
    );
    const marks = mode
      .run(() => withTestAllowance(allowance, () => analyseCore(request)))
      .budget.deferred.filter((mark) => mark.obligation.target === "hostOther");
    assert.deepEqual(
      marks.map((mark) => [mark.code, mark.obligation.against]),
      [["TSV041", ["unknown"]]],
      `${phase} @${allowance}`,
    );
  }
  assert.ok(reported > 0);
});

/**
 * #1448 (S8's mark-ownership rule): after a settled walk stop, the boundaries a domain read
 * brings for its key's stores are the content of the warning that owns that read there: leaving its owner out
 * (`withoutRecords`) removes them, an unrelated mark does not, a second owner keeps them, an operation a later statement
 * reads, a method call's receiver, a `get`'s default and the soft owner of an unknown receiver's `get` key are owners too,
 * and a read's own host ingress keeps its boundary without any mark. At the first settled walk stop, forward with the sharing and reversed without it.
 */
test("a domain read's store boundaries are its owning mark's content (#1448)", () => {
  const record = (d: { code: string; site: { start: number; end: number } }): string =>
    `${d.code} ${d.site.start}:${d.site.end}`;
  const boundaries = (
    source: string,
    mode: (typeof HELD_MODES)[number],
    left: string[] | "all",
    allowance?: number,
  ) => {
    const c = { name: "owned", source, slice: false, values: [] };
    const stop =
      allowance ?? heldStops(c, mode, 1).find((each) => each.phase === "walk")?.allowance;
    assert.ok(stop !== undefined, source);
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
    const run = (omit: ((code: string) => boolean) | null): Answers =>
      mode.run(() =>
        withTestAllowance(stop, () =>
          omit === null
            ? analyseCore(request)
            : withoutRecords({ diagnostic: (d) => omit(record(d)), check: () => false }, () =>
                analyseCore(request),
              ),
        ),
      );
    const marks = run(null).budget.deferred.map(record);
    const answers = run(
      left === "all" ? (each) => marks.includes(each) : (each) => left.includes(each),
    );
    return answers.checks
      .filter((check) => check.boundary)
      .map((check) => `${check.target}@${check.site.start}`);
  };
  const replaced =
    'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\nrepeat root.f0 {say "ok"}\n';
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!]) {
    const where = mode.name;
    // the count's mark owns both stores' boundaries its domain read brings; the receiver's mark is unrelated
    const witness = `${replaced}say "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(witness, mode, []), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(witness, mode, ["TSV043 70:77"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(witness, mode, ["TSV011 70:77"]), [], where);
    // two consumers read the domain, each its own owner
    const two = `${replaced}say "\${root.f0}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(two, mode, ["TSV011 70:77"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(two, mode, ["TSV042 96:103"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(two, mode, ["TSV011 70:77", "TSV042 96:103"]), [], where);
    // an operation a later statement reads: its operand's mark owns them, the interpolation's is unrelated
    const later =
      'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\nrepeat 2 {say "x"}\nsay "${root.f0 * 2}"\nsay "AFTER"\nexit\n';
    assert.deepEqual(boundaries(later, mode, []), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(later, mode, ["TSV042 89:100"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(later, mode, ["TSV043 89:96"]), [], where);
    // a method call's receiver and a `get`'s default: the member check's mark and the default's own warning own them
    const head = 'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\n';
    const method = `${head}say "\${root.f0.first()}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(method, mode, ["TSV042 70:85"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(method, mode, ["TSV043 70:85"]), [], where);
    // (the interpolation shows the `get`'s result, which holds its default's host data as unstopped: an owner too, #1491)
    const fallback = `${head}say "\${[1].get(4, default: root.f0)}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(fallback, mode, ["TSV042 70:98"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(fallback, mode, ["TSV041 90:97"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(fallback, mode, ["TSV041 90:97", "TSV042 70:98"]), [], where);
    // a soft owner, a `get` on an unknown receiver (its key's one warning); and beside a count, two owners (Codex r1's B1)
    const get =
      "let root = {f0: hostValue}\nroot = {f0: hostOther}\nhostValue.get(root.f0, default: 0)\nexit\n";
    assert.deepEqual(boundaries(get, mode, []), ["root@16", "root@39", "hostValue@50"], where);
    assert.deepEqual(
      boundaries(get, mode, ["TSV043 50:84"]),
      ["root@16", "root@39", "hostValue@50"],
      where,
    );
    assert.deepEqual(boundaries(get, mode, ["TSV043 64:71"]), ["hostValue@50"], where);
    const counted = `${head}repeat root.f0 {say "ok"}\nhostValue.get(root.f0, default: 0)\nsay "AFTER"\nexit\n`;
    const both = ["root@16", "root@39", "hostValue@89"];
    assert.deepEqual(boundaries(counted, mode, ["TSV043 103:110"]), both, where);
    assert.deepEqual(boundaries(counted, mode, ["TSV011 70:77"]), both, where);
    assert.deepEqual(
      boundaries(counted, mode, ["TSV011 70:77", "TSV043 103:110"]),
      ["hostValue@89"],
      where,
    );
    // a member read whose receiver's object lacks the property: its `extra` warning owns the receiver's domain items, and
    // the property's presence, read from every source, asks that store's boundary itself
    const extra = `let root = {f0: hostValue}\nroot = {f0: {h: 1}}\nsay "BEFORE"\nsay "\${root.f0.g}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(extra, mode, "all"), ["root@16"], where);
    // on an unrestricted written object nothing else asks it: at each settled stop the receiver's unknown warning or the
    // `extra` one owns it, and every mark left out leaves no boundary (Codex r2's witness on #1511)
    const written =
      'let root: object = {f0: hostValue}\nroot = {f0: {h: 1}}\nsay "${root.f0.g}"\nexit\n';
    const c = { name: "written", source: written, slice: false, values: [] };
    for (const { allowance } of testedStops(heldStops(c, mode, 1)))
      assert.deepEqual(boundaries(written, mode, "all", allowance), [], `${where} ${allowance}`);
    // a host read's own ingress beside its stores'
    const host =
      'hostValue.f0 = 2\nsay "BEFORE"\nrepeat hostValue.f0 {say "ok"}\nsay "AFTER"\nexit\n';
    assert.deepEqual(
      boundaries(host, mode, "all"),
      ["hostValue@0", "hostValue@37", "hostValue.f0@37"],
      where,
    );
  }
});

/**
 * S3 revision 21: a settled walk stop leaves a typed parse's nested paths undecided (admission decides
 * them lazily, never after a stop); source 4 decides them from its default literal's syntax, so the store's check stays
 * whole (#1165's class, a named exception of the oracle before: 984 and 1,180 stop points over four modes, the first
 * walk stop among them). At the first walk stop and one halfway through the walk.
 */
test("a settled stop decides a typed parse's nested default by its syntax, its check whole", () => {
  for (const source of [
    'let value = fromJson(hostValue, default: {list: [{n: fromJson("3", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay "DONE"\nexit\n',
    "let parsed = fromJson(hostValue, default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n",
  ]) {
    const unstopped = stopRun(source);
    const [low, high] = walkEnds(source);
    for (const allowance of [low, Math.floor((low + high) / 2)]) {
      // (or declined: the parse's store has no result at a program stop, and only a complete store check keeps it,
      // #1526 decision 2, an accepted over-decline, #1832)
      let stopped: StopRun;
      try {
        stopped = stopRun(source, allowance);
      } catch (error) {
        assert.ok(
          error instanceof CandidateOutsideSlice && error.what === LOST_CHECK,
          `@${allowance}`,
        );
        continue;
      }
      assert.deepEqual(
        stopProblems({ unstopped, stopped, fitting: [], violating: [] }),
        [],
        `@${allowance}`,
      );
    }
  }
});
