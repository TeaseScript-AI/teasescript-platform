// A stop before admission settled: the stores it marks, the written stores it checks at their own sites, and what a
// read after it answers.

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { withConsumerOrder, withoutRecords } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { sampled } from "../../helpers/sweep.js";
import { keptErrors, stopIdentity } from "../../helpers/type-core-oracles.js";
import { stopProblems, type StopRun } from "../../helpers/type-core-stop-oracle.js";
import {
  ALLOWANCE,
  UNDECIDED,
  object,
  host,
  stopRun,
  gatedProblems,
  walkEnds,
  lastUnsettled,
} from "../../helpers/type-core/stop/type-core-stop-setup.js";

/**
 * Before admission settled nothing it decided stands, so the receiver's shape is undecided: the record stands as the
 * mark of the store that owes it, the one move of a record's site the oracle accepts, and only there.
 */
test("a stop before admission settled marks a property store whose receiver's shape it leaves undecided", () => {
  const source =
    "let original = {kept:1}\nlet mirror = original\nmirror.absent = hostValue\nexit\n";
  const unstopped = stopRun(source);
  const literal = source.indexOf("{kept:1}");
  const store = source.indexOf("mirror.absent");
  assert.deepEqual(
    unstopped.answers.diagnostics.map((d) => `${d.class} ${d.code} ${d.site.start}`),
    [`compile-error TSV043 ${literal}`],
  );
  // a stop in the setup, and the last before admission settled
  for (const allowance of [ALLOWANCE, walkEnds(source)[0] - 1]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (d) => d.code === "TSV043" && d.site.start === store && d.site.end === store + 13,
      ),
      `@${allowance}`,
    );
    assert.deepEqual(
      stopProblems({ unstopped, stopped, fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
    // (claimed settled, the moved record is not accepted)
    const budget = { ...stopped.answers.budget, settled: true };
    assert.notDeepEqual(
      stopProblems({
        unstopped,
        stopped: { ...stopped, answers: { ...stopped.answers, budget } },
        fitting: [],
        violating: [],
      }),
      [],
      `@${allowance}`,
    );
  }
});

/**
 * Source 4 decides only what every store's syntax tells: objects with other properties leave a read of one
 * undecided, which may find it missing (its check and warning, marked); a copy of a written place is checked by
 * admission's A4 against the type the copy inherits, from the copied value, so its store is marked, standing for that
 * record. At a stop in the setup and at the last before admission settled, the oracle finds nothing else; each program
 * stores into an inferred place, so the plain gate declines it there (#2080 part 2), with no plan to run.
 */
test("a stop before admission settled leaves to the analysis what a store's syntax does not tell", () => {
  for (const [source, fitting, violating] of [
    [
      'let flag: boolean = hostValue\nlet room = {n: 1}\nroom = {n: 1}\nif flag { room = {other: 0} }\nsay room.n\nsay "DONE"\nexit\n',
      host(false),
      host(true),
    ],
    [
      'let base: integer[]? = hostValue\nlet copy = base\nsay copy.length\nsay "AFTER"\nexit\n',
      host({ kind: "list", items: [1, 2] }),
      host(null),
    ],
  ] as const) {
    const unstopped = stopRun(source);
    for (const allowance of [ALLOWANCE, lastUnsettled(source)])
      assert.deepEqual(
        gatedProblems(
          {
            unstopped,
            stopped: stopRun(source, allowance),
            fitting: [fitting],
            violating: [violating],
          },
          true,
        ),
        [],
        `${source} @${allowance}`,
      );
  }
});

/**
 * Before admission settled nothing it decided is read (A6: a later pass may admit a store this one
 * rejected): a store into an inferred place is marked at its site, its type undecided, and one into a written type
 * keeps its check and its boundary; at a stop in the setup and at the last before admission settled, the oracle finds
 * nothing else. The inferred store's mark leaves its check undecided, so the plain gate declines the program (#2080
 * part 2); with every store written, the program publishes and runs as unstopped.
 */
test("a stop before admission settled marks the stores into inferred places and keeps the written ones", () => {
  const source = 'let count = 1\ncount = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n';
  const unstopped = stopRun(source);
  const store = source.indexOf("hostValue");
  const written = source.replace("let count = 1", "let count: integer = 1");
  const writtenUnstopped = stopRun(written);
  for (const allowance of [ALLOWANCE, lastUnsettled(written)]) {
    const stopped = stopRun(written, allowance);
    assert.equal(stopped.answers.budget.settled, false, `written @${allowance}`);
    const runs = { fitting: [host(2, 3)], violating: [host(1.5, 3), host(2, 1.5)] };
    assert.deepEqual(
      gatedProblems({ unstopped: writtenUnstopped, stopped, ...runs }, false),
      [],
      `written @${allowance}`,
    );
  }
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (d) =>
          d.code === "TSV041" &&
          d.site.start === store &&
          d.obligation.against.length === 1 &&
          d.obligation.against[0] === "unknown",
      ),
      `@${allowance}`,
    );
    assert.deepEqual(
      gatedProblems(
        { unstopped, stopped, fitting: [host(2, 3)], violating: [host(1.5, 3), host(2, 1.5)] },
        true,
      ),
      [],
      `@${allowance}`,
    );
  }
});

/**
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-135): before admission settled no
 * syntax decision is made, so every store into an inferred place is marked at its site whatever its literals give, a
 * store the unstopped analysis rejects among them (its error stands for the mark's content); at a settled stop, as
 * unstopped, the error stands. Disagreements of a scalar, a list, an object and an object's nested field, an integer
 * then a decimal (no error), and a later copy (`let m = n`), in both orders, at a stop in the setup, the last stop
 * before admission settled, the first after it and the last. Every stop of every one in both orders, outside CI: 0
 * differing (13,542 analyses).
 */
test("before admission settled every store into an inferred place is marked, after it a rejection's error stands", () => {
  const tail = '\nsay n\nrepeat 2 { say "AFTER" }\nexit\n';
  const at = (source: string, text: string, skip = 0): number => source.indexOf(text) + skip;
  for (const [source, values] of [
    [
      'let n = 1\nn = "wrong"' + tail,
      [
        ["= 1", 2],
        ['"wrong"', 0],
      ],
    ],
    [
      'let n = [1]\nn = ["wrong"]' + tail,
      [
        ["[1]", 0],
        ['["wrong"]', 0],
      ],
    ],
    [
      'let n = {x: 1}\nn = {x: "wrong"}' + tail,
      [
        ["{x: 1}", 0],
        ['{x: "wrong"}', 0],
      ],
    ],
    [
      'let n = {x: {y: 1}}\nn = {x: {y: "wrong"}}' + tail,
      [
        ["{x: {y: 1}}", 0],
        ['{x: {y: "wrong"}}', 0],
      ],
    ],
    [
      "let n = 1\nn = 2.5" + tail,
      [
        ["= 1", 2],
        ["2.5", 0],
      ],
    ],
    [
      'let n = 1\nn = "wrong"\nlet m = n' + tail,
      [
        ["= 1", 2],
        ['"wrong"', 0],
        ["= n\n", 2],
      ],
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const sites = values.map(([text, skip]) => at(source, text, skip));
    const wrong = source.indexOf('"wrong"');
    for (const reversed of [false, true]) {
      const analyse = (allowance?: number): Answers => {
        const go = (): Answers =>
          allowance === undefined
            ? analyseCore(request)
            : withTestAllowance(allowance, () => analyseCore(request));
        return reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), go),
            )
          : go();
      };
      const errors = (answers: Answers): string[] =>
        answers.diagnostics
          .filter((d) => d.class === "compile-error")
          .map((d) => `${d.code} ${d.site.start}`);
      const unstopped = analyse();
      assert.deepEqual(errors(unstopped), wrong < 0 ? [] : [`TSV041 ${wrong}`], source);
      // (settledness is monotone in the allowance: the first settled stop by bisection)
      let [low, high] = [1, unstopped.budget.total - 1];
      while (low < high) {
        const mid = (low + high) >> 1;
        if (analyse(mid).budget.settled) high = mid;
        else low = mid + 1;
      }
      for (const allowance of [1, low - 1, low, unstopped.budget.total - 1]) {
        const stopped = analyse(allowance);
        const where = `${source} @${allowance}${reversed ? " reversed" : ""}`;
        assert.equal(stopped.budget.exhausted, "work", where);
        if (stopped.budget.settled) assert.deepEqual(errors(stopped), errors(unstopped), where);
        else {
          assert.deepEqual(errors(stopped), [], where);
          for (const site of sites)
            assert.ok(
              stopped.budget.deferred.some(
                (d) =>
                  d.code === "TSV041" &&
                  d.site.start === site &&
                  d.obligation.against.length === 1 &&
                  d.obligation.against[0] === "unknown",
              ),
              `${where}: a mark at ${site}`,
            );
        }
      }
    }
  }
});

/**
 * #1275 (Codex r7's B2 on #1310): a pass keys the stores below an own selection by the targets the pass before it gave,
 * and where its admission gives others the passes start again, so a stop before they do settles nothing:
 * its finishing path marks such a store as it marks every store into an inferred place, and the store's error
 * stands as that mark. Each own selection, both orders, each end of the first pass's walk.
 */
test("a stop before a store below an own selection takes its target settles nothing and marks the store", () => {
  const options = { globals: ["hostValue", "hostOther"] };
  const phases = ["setup", "admission", "walk", "publication"];
  for (const own of ["first", "last", "random"])
    for (const reversed of [false, true]) {
      const source = `let box = {${own}: {n: 1}}\nbox.${own}.n = "bad"\nsay "AFTER"\nexit\n`;
      const where = `${own} reversed: ${reversed}`;
      const inOrder = <T>(make: () => T): T =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), make),
            )
          : make();
      const request = coreRequest([{ path: "main.tease", source }], options.globals);
      assert.ok(request !== null);
      // (the plain gate's decline, #2080 part 2, is no plan and no diagnostics, as in `stopRun`)
      let undecided = false;
      const compile = (): StopRun["result"] => {
        try {
          return compileSourceWithBackend(source, options, CORE_BACKEND);
        } catch (error) {
          if (!(error instanceof CandidateOutsideSlice) || error.what !== UNDECIDED) throw error;
          undecided = true;
          return { diagnostics: [], plan: null };
        }
      };
      const both = () => inOrder(() => ({ result: compile(), answers: analyseCore(request) }));
      const runAt = (allowance?: number): ReturnType<typeof stopRun> => {
        const allowed = <T>(make: () => T): T =>
          allowance === undefined ? make() : withTestAllowance(allowance, make);
        undecided = false;
        const made = allowed(both);
        return {
          ...made,
          undecided,
          lostDefault: false,
          without: (omit) => allowed(() => withoutRecords(omit, both)),
        };
      };
      const unstopped = runAt();
      const value = source.indexOf('"bad"');
      assert.deepEqual(
        unstopped.answers.diagnostics
          .filter((d) => d.class === "compile-error")
          .map((d) => `${d.code} ${d.site.start}`),
        [`TSV041 ${value}`],
        where,
      );
      // (how far a stop at the allowance came: the passes started again, its phase in its pass)
      const reached = (allowance: number): number => {
        const { counts, stoppedIn } = withTestAllowance(allowance, () =>
          inOrder(() => analyseCore(request)),
        ).budget;
        return (counts.get("rejectPasses") ?? 0) * phases.length + phases.indexOf(stoppedIn ?? "");
      };
      const lowest = (at: number): number => {
        let [low, high] = [1, unstopped.answers.budget.total];
        while (low < high) {
          const middle = (low + high) >> 1;
          if (reached(middle) >= at) high = middle;
          else low = middle + 1;
        }
        return low;
      };
      const walk = phases.indexOf("walk");
      for (const allowance of [lowest(walk), lowest(walk + 1) - 1]) {
        assert.equal(reached(allowance), walk, `${where} @${allowance}`);
        const stopped = runAt(allowance);
        assert.equal(stopped.answers.budget.settled, false, `${where} @${allowance}`);
        assert.ok(
          stopped.answers.budget.deferred.some(
            (d) =>
              d.code === "TSV041" &&
              d.site.start === value &&
              d.obligation.against.length === 1 &&
              d.obligation.against[0] === "unknown",
          ),
          `${where} @${allowance}`,
        );
        // (the store into the inferred place is left undecided: the plain gate declines, #2080 part 2)
        assert.deepEqual(
          gatedProblems({ unstopped, stopped, fitting: [], violating: [] }, true),
          [],
          `${where} @${allowance}`,
        );
      }
    }
});

/**
 * A host read's ingress is structural (Codex r12's B1): whatever the script stores into the host global,
 * the read's external data meets its boundary check at any stop, settled or not; its kinds come from the read itself
 * only where the script stores at no path at or above it. At a stop in the setup each compile keeps every record but
 * the marks' own; the store into the host global is one into an inferred place, so the plain gate declines (#2080
 * part 2).
 */
test("a host read keeps its boundary check at a stop whatever the script stores into the host global", () => {
  for (const source of [
    "hostValue.n = 2\nexit\n",
    'hostValue.n = null\nsay hostValue.n otherwise "ok"\nexit\n',
    "hostValue.n = 2\nsay hostValue.n.x\nexit\n",
    "say hostValue.m\nhostValue.n = 2\nexit\n",
  ]) {
    const stopped = stopRun(source, ALLOWANCE);
    assert.equal(stopped.answers.budget.settled, false, source);
    assert.deepEqual(
      gatedProblems({ unstopped: stopRun(source), stopped, fitting: [], violating: [] }, true),
      [],
      source,
    );
  }
});

/**
 * Before admission settled, a store into a written type checks each part of a collection literal the type reaches at the
 * part's own site, as A8 does (Codex r12's final-check B2): a host read as a written list's element, a
 * host property the script stored, a nested list's element. A part that reads a place the stop left undecided, a
 * variable or a property of one, marks the store at its literal whatever host read beside it (#1611).
 * At a stop in the setup and at the last before admission settled, the oracle finds nothing; where the program also
 * stores into an inferred place, the plain gate declines it (#2080 part 2), with no plan to run.
 */
test("a stop before admission settled checks a written store's literal parts at their own sites", () => {
  for (const [source, fitting, violating, declines] of [
    ["let xs: integer[] = [hostValue]\nexit\n", [host(2)], [host("bad")], false],
    [
      "hostValue.n = 2\nlet xs: integer[] = [hostValue.n]\nexit\n",
      [host(object({ n: 1 }))],
      [],
      true,
    ],
    ["let xs: integer[][] = [[hostValue]]\nexit\n", [host(2)], [host("bad")], false],
    [
      "let p = hostValue otherwise hostOther\nlet xs: integer[] = [p, hostOther]\nexit\n",
      [host(2)],
      [host("bad")],
      true,
    ],
    [
      "let p = hostValue otherwise hostOther\nlet xs: integer[] = [hostOther, p]\nexit\n",
      [host(2)],
      [host("bad")],
      true,
    ],
    [
      "let named = {v: hostValue}\nlet xs: integer[] = [named.v, hostOther]\nexit\n",
      [host(2)],
      [host("bad")],
      true,
    ],
  ] as const) {
    const unstopped = stopRun(source);
    for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
      const stopped = stopRun(source, allowance);
      assert.equal(stopped.answers.budget.settled, false, `${source} @${allowance}`);
      assert.deepEqual(
        gatedProblems({ unstopped, stopped, fitting, violating }, declines),
        [],
        `${source} @${allowance}`,
      );
    }
  }
});

/**
 * Before admission settled, a written store's literal parts take their collections from the written type and their
 * parts from the literal's syntax, never from the solver (Codex r13's S1): a set's element, a dict's value,
 * a set inside a dict; and a stop changes no site, an error inside an add's literal staying at the add's argument.
 * At a stop in the setup and at the last before admission settled, each error, its site, its rule's
 * steps and its first sentence equal the unstopped ones (`keptErrors`; the analysis: a written set or dict is outside the
 * candidate route).
 */
test("a stop before admission settled keeps a written store's errors whole, their collections and sites", () => {
  for (const source of [
    'let xs: integer set = set["wrong"]\nexit\n',
    'let d: integer dict = dict{a: "wrong"}\nexit\n',
    'let d: integer set dict = dict{a: set["wrong"]}\nexit\n',
    'let xs: integer[] set = set[]\nxs.add(["wrong"])\nexit\n',
    'let xs: integer dict set = set[]\nxs.add(dict{a: "wrong"})\nexit\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const errors = (answers: Answers) => keptErrors(answers, source);
    const unstopped = errors(analyseCore(request));
    assert.equal(unstopped.length, 1, source);
    for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
      const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
      assert.equal(stopped.budget.settled, false, `${source} @${allowance}`);
      assert.deepEqual(errors(stopped), unstopped, `${source} @${allowance}`);
    }
  }
});

/** The analysis of `source` unstopped, and at a stop in the setup and at the last before admission settled. */
function unsettledAnalyses(source: string): { unstopped: Answers; stopped: Answers[] } {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const stopped = [ALLOWANCE, lastUnsettled(source)].map((allowance) => {
    const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.equal(answers.budget.settled, false, `${source} @${allowance}`);
    return answers;
  });
  return { unstopped: analyseCore(request), stopped };
}

/**
 * Every walk of a literal's children asks `literalChildren` with its path's own step, so the step that reaches a dict
 * literal's values is read in one place (Codex r14), and a written store's checks name its parts as the
 * written type does (`entry`, a dict's value). At a stop in the setup and at the last before admission settled (each
 * defect showed at every such stop; the every-stop sweep runs outside CI): a written dict's checks equal the unstopped
 * ones; a dict default's host data keeps its own boundary; a default's wrong text stays an error; a dict literal's value
 * answers its kind and properties.
 */
test("a stop before admission settled reads a dict literal's values as its syntax and the written type give them", () => {
  for (const source of [
    "let d: integer dict = dict{a: hostValue}\nexit\n",
    "let d: integer[] dict = dict{a: [hostValue]}\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    assert.ok(unstopped.checks.some((check) => check.target.includes("entry")));
    for (const answers of stopped) assert.deepEqual(answers.checks, unstopped.checks, source);
  }
  {
    const source =
      'let items = [dict{a: 1}]\nlet v = items.get(hostOther, default: dict{a: hostValue})\nsay v["a"]\nexit\n';
    const { unstopped, stopped } = unsettledAnalyses(source);
    const site = source.indexOf("hostValue");
    const boundary = unstopped.checks.find((check) => check.boundary && check.site.start === site);
    assert.ok(boundary !== undefined);
    for (const answers of stopped)
      assert.ok(answers.checks.some((check) => isDeepStrictEqual(check, boundary)));
  }
  {
    const source = 'let v = dict{a: 1}.get(hostOther, default: "wrong")\nsay v\nexit\n';
    const errors = (answers: Answers) => keptErrors(answers, source);
    const { unstopped, stopped } = unsettledAnalyses(source);
    assert.equal(errors(unstopped).length, 1);
    for (const answers of stopped) assert.deepEqual(errors(answers), errors(unstopped));
  }
  {
    const source = "let d = dict{a: {n: 1}}\nexit\n";
    const value = (answers: Answers) => {
      const literal = answers.graph.nodes.find(
        (node) => node.kind === "expression" && node.expression?.kind === "dictLiteral",
      );
      assert.ok(literal !== undefined);
      const found = answers.valueAt(literal, ["element"]);
      return {
        tags: found.items.map((item) => item.tag),
        properties: [...found.properties].sort(),
      };
    };
    const { unstopped, stopped } = unsettledAnalyses(source);
    assert.deepEqual(value(unstopped), { tags: ["object"], properties: ["n"] });
    for (const answers of stopped) assert.deepEqual(value(answers), value(unstopped));
  }
});

/**
 * After a stop a literal's composed questions (`valueAt`, `project`, `properties`) read a child its syntax leaves open as
 * the child's own read does, beside its known siblings, never `budget` where that read keeps a type (Astra r6 B1):
 * a written child, a union's, a nullable's, at a stop before admission settled; a decided one at every settled
 * walk stop.
 */
test("after a stop a literal's composed questions read a child as its own read does, beside its siblings", () => {
  const composed = (answers: Answers, kind: string, step: string) => {
    const literal = answers.graph.nodes.find(
      (node) => node.kind === "expression" && node.expression?.kind === kind,
    );
    assert.ok(literal !== undefined);
    const tags = (items: readonly { readonly tag: string }[]) =>
      [...new Set(items.map((item) => item.tag))].sort();
    return {
      valueAt: tags(answers.valueAt(literal, [step]).items),
      project: tags(answers.project(literal, step === "element" ? "element" : { property: step })),
      properties:
        kind === "objectLiteral" ? tags(answers.properties(literal).get(step) ?? []) : null,
    };
  };
  for (const [source, kind, step, tags] of [
    ["let quantity: number = 3.5\nsay [quantity]\nexit\n", "listLiteral", "element", ["number"]],
    [
      'let quantity: number = 3.5\nsay [quantity, "x"]\nexit\n',
      "listLiteral",
      "element",
      ["number", "string"],
    ],
    [
      "let quantity: integer | boolean = 3\nsay [quantity]\nexit\n",
      "listLiteral",
      "element",
      ["boolean", "integer"],
    ],
    [
      "let quantity: integer? = 3\nsay {part: quantity}\nexit\n",
      "objectLiteral",
      "part",
      ["integer", "null"],
    ],
  ] as const)
    for (const answers of unsettledAnalyses(source).stopped)
      assert.deepEqual(
        composed(answers, kind, step),
        { valueAt: tags, project: tags, properties: kind === "objectLiteral" ? tags : null },
        source,
      );
  const source =
    "let quantity = 8.0\nif quantity is integer { quantity = 3.5\nlet observed: number = quantity\nsay [quantity] }\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const [low, high] = walkEnds(source);
  for (let allowance = low; allowance <= high; allowance += 1) {
    const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.deepEqual(
      composed(answers, "listLiteral", "element"),
      { valueAt: ["number"], project: ["number"], properties: null },
      `@${allowance}`,
    );
  }
});

/**
 * After a stop a typed call no store takes in keeps its boundary through a named default's written type, and is marked
 * where its default's type is undecided (an inferred variable, a call's result): a missing answer never declines it
 * silently (Astra r6 B2). A written type wider than the value is no type for it (an `integer?` may hold
 * null alone, which leaves the level open; a `number` an integer; a union one member): no boundary the unstopped analysis
 * lacks, the call marked (Codex r22 B1).
 */
test("after a stop a typed call keeps its boundary through a named default, or is marked", () => {
  for (const source of [
    "let fallback: integer = 3\nsay fromJson(hostValue, default: fallback)\nexit\n",
    'let fallback: boolean = false\nsay load("key", default: fallback)\nexit\n',
    "let fallback: integer[] = [3]\nsay fromJson(hostValue, default: fallback)\nexit\n",
    'let fallback: object = {amount: 3}\nsay load("key", default: fallback)\nexit\n',
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const boundary = unstopped.checks.find((check) => check.boundary);
    assert.ok(boundary !== undefined, source);
    for (const answers of stopped)
      assert.ok(
        answers.checks.some((check) => isDeepStrictEqual(check, boundary)),
        source,
      );
  }
  for (const source of [
    "let fallback = 9\nsay fromJson(hostValue, default: fallback)\nexit\n",
    "function fallback { return 9 }\nsay fromJson(hostValue, default: fallback())\nexit\n",
  ]) {
    const site = { file: 0, start: source.indexOf("fromJson"), end: source.indexOf(")\nexit") + 1 };
    for (const answers of unsettledAnalyses(source).stopped)
      assert.ok(
        answers.budget.deferred.some(
          (mark) =>
            mark.obligation.target === "fromJson.result" && isDeepStrictEqual(mark.site, site),
        ),
        source,
      );
  }
  for (const source of [
    'let fallback: integer? = null\nsay load("key", default: fallback)\nexit\n',
    "let fallback: number = 3\nsay fromJson(hostValue, default: fallback)\nexit\n",
    "let fallback: integer | string = 3\nsay fromJson(hostValue, default: fallback)\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const call = source.indexOf("say ") + 4;
    for (const answers of stopped) {
      assert.ok(
        answers.checks.every(
          (check) =>
            !check.boundary || unstopped.checks.some((kept) => isDeepStrictEqual(kept, check)),
        ),
        source,
      );
      assert.ok(
        answers.budget.deferred.some((mark) => mark.site.start === call),
        source,
      );
    }
  }
});

/**
 * An element read a stop left unsettled is no proof of an element: a selection of a typed call whose named list default
 * the finishing read leaves open at its element owes C6's empty check as unstopped, or its mark, at a stop before
 * admission settled and in the settled walk.
 */
test("after a stop a selection of a typed call with a named list default owes its empty check", () => {
  for (const source of [
    "let fallback: integer[] = [1]\nsay fromJson(hostValue, default: fallback).first\nexit\n",
    "let fallback = [1]\nsay fromJson(hostValue, default: fallback).first\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const check = unstopped.checks.find((found) => found.kind === "empty-check");
    assert.ok(check !== undefined, source);
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const settled = walkEnds(source).map((allowance): Answers =>
      withTestAllowance(allowance, () => analyseCore(request)),
    );
    for (const answers of [...stopped, ...settled])
      assert.ok(
        answers.checks.some((found) => isDeepStrictEqual(found, check)) ||
          answers.budget.deferred.some((mark) => mark.obligation.kind === "empty-check"),
        `${source} @${answers.budget.allowance}`,
      );
  }
});

/**
 * A member read a stop left unsettled is no proof of the property either (C5, Codex r24 B1): a typed call's member its
 * default lacks keeps its TSV043 or its mark, from a literal and from a named default, at a stop before admission settled
 * and in the settled walk. A literal's own element is proof of one, settled or not (Codex r24 N1): `[count].first` owes no
 * empty check at a stop, as unstopped.
 */
test("after a stop an unsettled member read owes its check; a literal's own element needs none", () => {
  for (const source of [
    "say fromJson(hostValue, default: {n: 1}).missing\nexit\n",
    "let fallback = {n: 1}\nsay fromJson(hostValue, default: fallback).missing\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const warning = unstopped.diagnostics.find((found) => found.code === "TSV043");
    assert.ok(warning !== undefined && "site" in warning, source);
    const { site } = warning;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const settled = walkEnds(source).map((allowance): Answers =>
      withTestAllowance(allowance, () => analyseCore(request)),
    );
    for (const answers of [...stopped, ...settled])
      assert.ok(
        answers.diagnostics.some((found) =>
          isDeepStrictEqual(stopIdentity(found), stopIdentity(warning)),
        ) ||
          answers.budget.deferred.some(
            (mark) => mark.code === "TSV043" && isDeepStrictEqual(mark.site, site),
          ),
        `${source} @${answers.budget.allowance}`,
      );
  }
  const source = "let count = 2\nsay [count].first\nexit\n";
  const { unstopped, stopped } = unsettledAnalyses(source);
  assert.ok(!unstopped.checks.some((found) => found.kind === "empty-check"));
  for (const answers of stopped) {
    assert.ok(!answers.checks.some((found) => found.kind === "empty-check"), source);
    assert.ok(
      !answers.budget.deferred.some((mark) => mark.obligation.kind === "empty-check"),
      source,
    );
  }
});

/**
 * Before admission settled, a store into a written type is checked by admission's own C1, the derivation the analysis
 * runs unstopped, reading what the stop retained (Astra r4's B1): two wrong elements give one
 * error, a record literal its own kind, in a list, a set, a dict and a nested list; and admission's mixed-element check
 * (ADR 0021 1.3) as it runs it, a mixed literal's grouping and an error that only it finds, written or inferred, and a
 * join of two literals' (#1272); a written
 * parameter's every call, a dead one too (Codex r16, r17). At the sample (`sampled`) of the stops before admission
 * settled the errors, their sites and sentences equal the unstopped ones.
 */
test("a stop before admission settled checks a written store by admission's own C1, error for error", () => {
  for (const source of [
    'let rows: integer[] = ["one", "two"]\nexit\n',
    'let rows: integer set = set["one", "two"]\nexit\n',
    'let rows: integer dict = dict{a: "one", b: "two"}\nexit\n',
    'let rows: integer[][] = [["one", "two"]]\nexit\n',
    "let rows: integer[] = [{n: hostValue}]\nexit\n",
    "let rows: integer set = set[{n: 4}]\nexit\n",
    'let xs: integer[] set = set[]\nxs.add(["wrong", true])\nexit\n',
    'let xs: (integer | string)[] set = set[]\nxs.add([1, "a"])\nexit\n',
    'let ys = [1, "a"]\nexit\n',
    'let ys = [1] + ["a"]\nexit\n',
    'function f(xs: integer[]) { say "x" }\nf(["wrong"])\nf(["bad"])\nexit\n',
    'function f(xs: integer[]) { say "x" }\nexit\nf(["wrong"])\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const errors = (answers: Answers) => keptErrors(answers, source);
    const unstopped = analyseCore(request);
    const want = errors(unstopped);
    assert.ok(want.length > 0, source);
    let stops = 0;
    const last = lastUnsettled(source);
    for (const allowance of sampled(Array.from({ length: last }, (_, i) => i + 1))) {
      const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
      if (stopped.budget.settled) continue;
      stops += 1;
      assert.deepEqual(errors(stopped), want, `${source} @${allowance}`);
    }
    assert.ok(stops > 0, source);
  }
});

/**
 * Before admission settled, a literal whose element needs a decision admission did not make (here a copy of an inferred
 * place) is not compared for mixed elements: the store holding it is marked at its site, its type undecided, standing for
 * its records within its value. At a stop in the setup and at the last before admission settled the
 * mark stands.
 */
test("a stop before admission settled marks the store of a literal whose element needs a decision", () => {
  const source =
    'let base = 1\nlet xs: (integer | string)[] set = set[]\nxs.add([base, "a"])\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const literal = source.indexOf("[base");
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.equal(stopped.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.budget.deferred.some(
        (d) =>
          d.code === "TSV041" &&
          d.site.start === literal &&
          d.obligation.against.length === 1 &&
          d.obligation.against[0] === "unknown",
      ),
      `@${allowance}`,
    );
  }
});

/**
 * Before admission settled, a list join with an operand read through a decision admission did not make (here an inferred
 * variable) is not compared for mixed elements (#1272): a join no definition holds is marked at its own site, its type
 * undecided, as a literal is (`#markValue`). At a stop in the setup and at the last before admission settled the mark
 * stands.
 */
test("a stop before admission settled marks a list join whose operand needs a decision", () => {
  const source = 'let xs = [1]\nsay (xs + ["a"]).length\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const join = source.indexOf("xs +");
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.equal(stopped.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.budget.deferred.some(
        (d) =>
          d.code === "TSV041" &&
          d.site.start === join &&
          d.obligation.against.length === 1 &&
          d.obligation.against[0] === "unknown",
      ),
      `@${allowance}`,
    );
  }
});
