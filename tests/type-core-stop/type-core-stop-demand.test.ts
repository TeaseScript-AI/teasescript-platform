// The demand allowance: a read's or an admission decision's demand past it stops, alone or beside a program stop (S3).

import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend, type CompilationResult } from "../../src/compiler.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { withConsumerOrder, withoutRecords } from "../../src/type-inference/core/consumers.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { completedCore, coreRequest } from "../helpers/type-core-analysis.js";
import { heldRun, HELD_MODES, type HeldCase } from "../helpers/type-core-held-host.js";
import { decisionOf, inMode, MODES } from "../helpers/type-core-oracles.js";
import { runGlobals } from "../helpers/type-core-route.js";
import {
  stopDeclineProblem,
  stopProblems,
  unsettledStop,
  type Globals,
  type StopRun,
} from "../helpers/type-core-stop-oracle.js";
import {
  OPTIONS,
  inBothOrders,
  ran,
  LOST_CHECK,
  host,
  stopRun,
  gatedProblems,
  settledEnds,
  lastUnsettled,
} from "../helpers/type-core/type-core-stop-setup.js";

/** `stopRun` made inside `mode` (orders, allowances), its omissions run again inside it (`stopProblems` asks them). */
function stopRunIn(
  mode: <T>(make: () => T) => T,
  source: string,
  allowance?: number,
): ReturnType<typeof stopRun> {
  const run = mode(() => stopRun(source, allowance));
  return { ...run, without: (omit, key) => mode(() => run.without(omit, key)) };
}

/**
 * S3 with #1275 (Codex r10's B1 on #1310): a store at a key whose decision stopped is an obligation the stop stands
 * for (`Consumers.#stoppedStores`), whichever pass stopped it: a pass that both stops a decision and gives new store
 * targets starts again with the key stopped, and the store keeps a mark there, through demand-only completion and a
 * settled program stop alike. Each own selection's invalid store beside a property's and a variable's, in both
 * orders with the sharing on and off, at half of each decision's demand: the completed analysis keeps each error as an
 * error or as a warning or a stop's mark with a check at its site, and adds none (against the unbounded analysis); and
 * where a pass started again, a program stop halfway through the analysis and at its end changes nothing the stop oracle
 * does not excuse (against the completed analysis at that demand allowance, as above). The generated family (every
 * decision's demand at several fractions, an add, a k = 64 joined list, work stops across the restarted pass) runs
 * outside CI.
 */
test("a store at a stopped decision's key keeps an obligation, whichever pass stopped it (S3, #1275)", () => {
  const options = { globals: ["hostValue", "hostOther"] };
  const sources = [
    ...["first", "last", "random"].map((own) => `let box = {${own}: {n: 1}}\nbox.${own}.n = "bad"`),
    'let box = {inner: {n: 1}}\nbox.inner.n = "bad"',
    'let n = 1\nn = "bad"',
  ].map((body) => `${body}\nsay "DONE"\nexit\n`);
  const modes: readonly (readonly [string, <T>(make: () => T) => T])[] = [
    ["forward", (make) => make()],
    [
      "reversed",
      (make) =>
        withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder((list) => [...list].reverse(), make),
        ),
    ],
    ["forward, unshared", (make) => withoutSharing(make)],
    [
      "reversed, unshared",
      (make) =>
        withoutSharing(() =>
          withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), make),
          ),
        ),
    ],
  ];
  let combined = 0;
  for (const source of sources) {
    const request = coreRequest([{ path: "main.tease", source }], options.globals);
    assert.ok(request !== null);
    for (const [name, inMode] of modes) {
      const runAt = (demand: number | null, work: number | null): StopRun => {
        const allowed = <T>(make: () => T): T =>
          inMode(() => {
            const demanded = () =>
              demand === null ? make() : withTestDemandAllowance(demand, make);
            return work === null ? demanded() : withTestAllowance(work, demanded);
          });
        // (#2080: a stop whose stopped mark's completion result was lost declines, no plan; its obligations stand. A
        // decline stands only with a limit's reason at the phase it belongs to, `stopDeclineProblem`)
        const both = () => {
          let result: Pick<CompilationResult, "diagnostics" | "plan">;
          let what: string | null = null;
          try {
            result = compileSourceWithBackend(source, options, CORE_BACKEND);
          } catch (error) {
            if (!(error instanceof CandidateOutsideSlice)) throw error;
            result = { diagnostics: [], plan: null };
            what = error.what;
          }
          const answers = analyseCore(request);
          const problem =
            what === null
              ? null
              : stopDeclineProblem(what, unsettledStop(answers.budget), null, []);
          if (problem !== null) throw new Error(`${source}: ${problem}`);
          return { result, answers };
        };
        return { ...allowed(both), without: (omit) => allowed(() => withoutRecords(omit, both)) };
      };
      const unbounded = runAt(null, null);
      const errors = unbounded.answers.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => d.site.start);
      assert.ok(errors.length > 0, source);
      const demands = new Set(
        unbounded.answers.budget.decisions
          .filter((d) => d.units >= 2)
          .map((d) => Math.floor(d.units / 2)),
      );
      for (const demand of demands) {
        const where = `${name} @${demand}: ${source}`;
        const capped = runAt(demand, null);
        const { budget } = capped.answers;
        const kept = capped.answers.diagnostics
          .filter((d) => d.class === "compile-error")
          .map((d) => d.site.start);
        const marked = [
          ...capped.answers.diagnostics.filter((d) => d.class === "warning-runtime-check"),
          ...budget.deferred,
        ].map((d) => d.site.start);
        const checked = capped.answers.checks.map((check) => check.site.start);
        assert.deepEqual(
          errors.filter(
            (at) => !kept.includes(at) && !(marked.includes(at) && checked.includes(at)),
          ),
          [],
          `${where}: an error neither kept nor checked`,
        );
        assert.deepEqual(
          kept.filter((at) => !errors.includes(at)),
          [],
          `${where}: an error the unbounded analysis lacks`,
        );
        const stopPasses = budget.counts.get("stopPasses") ?? 0;
        if (stopPasses === 0 || budget.exhausted !== null) continue;
        if ((budget.counts.get("rejectPasses") ?? 0) > 0) combined += 1;
        // (a program stop halfway through the analysis and at its end)
        const total = budget.total;
        for (const work of [Math.floor(total / 2), total - 1])
          assert.deepEqual(
            stopProblems({
              unstopped: capped,
              stopped: runAt(demand, work),
              fitting: [],
              violating: [],
            }),
            [],
            `${where} #${work}`,
          );
      }
    }
  }
  // (a decision stop and new store targets in one pass: Codex r10's B1 shape)
  assert.ok(combined > 0);
});

/**
 * The per-demand fallback (S3, ADR 0021 rule 1.10): `y` copies a number through a chain of copies, so its
 * read's exact path is a long demand, and a later store makes its key's contract a whole number or a number; `count`'s
 * read is short. With a demand allowance below the chain's (three quarters of the longest read's work, measured), the
 * read of `y` stops with its key's contract and the reason `budget`, so its check runs when the script runs, while
 * `count`'s error stays an error.
 */
const chain = (reads: number, count: boolean): string =>
  [
    "let x = 1.5",
    ...Array.from({ length: 30 }, (_, i) => `let y${i + 1} = ${i === 0 ? "x" : `y${i}`}`),
    ...Array.from({ length: reads }, () => "repeat y30 {}"),
    "y30 = 2",
    ...(count ? ["let count = 1", "count = 0.5", "repeat count {}"] : []),
    'say "AFTER"',
    "exit",
  ].join("\n") + "\n";

/** Three quarters of the longest demand a source's analysis bounds, unbounded: below the chain's, above a short read's. */
function demandAllowance(source: string): number {
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const bounded = analyseCore(request).budget.demands.filter((read) => read.bounded);
  return Math.floor(0.75 * Math.max(...bounded.map((read) => read.units)));
}

test("a demand past its allowance moves its read's check to the runtime, an independent proof staying an error (S3)", () => {
  const source = chain(1, true);
  const read = source.indexOf("y30 {}");
  const count = source.indexOf("count {}");
  const diagnostics = withTestDemandAllowance(demandAllowance(source), () =>
    inBothOrders(() =>
      compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).diagnostics.map(
        (d) => `${d.severity} ${d.code} @${d.span.start.offset}`,
      ),
    ),
  );
  assert.deepEqual(diagnostics, [`warning TSV011 @${read}`, `error TSV011 @${count}`]);
  // without the independent error: the moved check runs and stops the fraction before the next effect
  const runnable = chain(1, false);
  const plan = withTestDemandAllowance(demandAllowance(runnable), () =>
    inBothOrders(() => compileSourceWithBackend(runnable, OPTIONS, CORE_BACKEND).plan),
  );
  assert.ok(plan !== null);
  const failed = ran(plan, 0);
  assert.deepEqual(failed.said, []);
  assert.match(failed.failure ?? "", new RegExp(`^TSR043@${runnable.indexOf("y30 {}")}:`, "u"));
});

test("a stopped demand's proof is not reused by a later demand of its key, in either order (S3)", () => {
  // two reads of `y30`: the one asked first stops; the other, an independent demand, keeps its allowance and proves
  const source = chain(2, false);
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const first = source.indexOf("repeat y30") + "repeat ".length;
  const second = source.indexOf("repeat y30", first) + "repeat ".length;
  const allowance = demandAllowance(source);
  for (const reversed of [false, true]) {
    const analyse = (): Answers => withTestDemandAllowance(allowance, () => analyseCore(request));
    const answers: Answers = reversed
      ? withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder((list) => [...list].reverse(), analyse),
        )
      : analyse();
    const at = (start: number): string[] =>
      answers.diagnostics
        .filter((d) => d.site.start === start)
        .map((d) => `${d.class} ${"provenance" in d ? d.provenance.context : "-"}`);
    const [stopped, proved] = reversed ? [second, first] : [first, second];
    assert.deepEqual(at(stopped), ["warning-runtime-check budget"], `reversed: ${reversed}`);
    assert.deepEqual(at(proved), ["compile-error -"], `reversed: ${reversed}`);
  }
});

/**
 * S3's allowance by where a read sits (Astra r1 B3 on #1165): a top-level read reads globals every file stores, so in
 * any file it takes 256 × the program's nodes, not its file's; a function's read takes its function's. `g136` copies a
 * number through 136 globals of a second file, and main's read of it stays the error it is: with its file's 11 nodes it
 * stopped with a moved check instead.
 */
test("a top-level read takes the program's allowance in every file, a function's read its function's (S3)", () => {
  const files = [
    { path: "main.tease", source: 'repeat g136 {}\ng136 = 2\ncheck()\nsay "DONE"\nexit\n' },
    {
      path: "data.tease",
      source:
        [
          "global g0 = 1.5",
          ...Array.from({ length: 136 }, (_, i) => `global g${i + 1} = g${i}`),
          "global h: integer = g136",
          "global function check {",
          "  repeat g136 {}",
          "}",
          "end",
        ].join("\n") + "\n",
    },
  ];
  const request = coreRequest(files);
  assert.ok(request !== null);
  for (const reversed of [false, true]) {
    const answers: Answers = reversed
      ? withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder(
            (list) => [...list].reverse(),
            () => analyseCore(request),
          ),
        )
      : analyseCore(request);
    const { graph, budget } = answers;
    const functionNodes = new Map<unknown, number>();
    for (const node of graph.nodes) {
      const owner = graph.callableOf(node.region);
      if (owner?.kind === "function") functionNodes.set(owner, (functionNodes.get(owner) ?? 0) + 1);
    }
    const reads = budget.demands.filter((read) => read.bounded);
    const where = (file: string, inFunction: boolean) =>
      reads.filter((read) => {
        const node = graph.nodes[read.node]!;
        return (
          request.files[node.file]!.path === file &&
          (graph.callableOf(node.region)?.kind === "function") === inFunction
        );
      });
    for (const [file, inFunction] of [
      ["main.tease", false],
      ["data.tease", false],
      ["data.tease", true],
    ] as const)
      assert.ok(where(file, inFunction).length > 0, `${file}, function: ${inFunction}`);
    for (const read of reads) {
      const owner = graph.callableOf(graph.nodes[read.node]!.region);
      const nodes = owner?.kind === "function" ? functionNodes.get(owner)! : graph.nodes.length;
      assert.equal(read.allowance, 256 * nodes, `reversed: ${reversed}`);
    }
    // (the top-level reads prove their errors; the function's 7 nodes may stop its own read, its check moved)
    assert.ok(
      !reads.some(
        (read) =>
          read.stopped && graph.callableOf(graph.nodes[read.node]!.region)?.kind !== "function",
      ),
      `reversed: ${reversed}`,
    );
    const at = (file: string, start: number): string[] =>
      answers.diagnostics
        .filter((d) => request.files[d.site.file]!.path === file && d.site.start === start)
        .map((d) => d.class);
    assert.deepEqual(at("main.tease", 7), ["compile-error"], `reversed: ${reversed}`);
    assert.deepEqual(
      at("data.tease", files[1]!.source.indexOf("g136\nglobal function")),
      ["compile-error"],
      `reversed: ${reversed}`,
    );
  }
});

test("an admission decision past its allowance stops: its key undecided, its reads checked when the script runs (S3)", () => {
  // `b`'s decision scans its 41 stores, while each read is short, `count`'s decision too
  const source = (count: boolean): string =>
    [
      "let b = 1",
      ...Array.from({ length: 40 }, (_, i) => `b = ${i + 2}`),
      "b = hostValue",
      "let n: integer = b",
      ...(count ? ["let count = 1", "count = 0.5", "repeat count {}"] : []),
      'say "AFTER"',
      "exit",
    ].join("\n") + "\n";
  for (const reversed of [false, true]) {
    const inOrder = <T>(make: () => T): T =>
      reversed
        ? withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), make),
          )
        : make();
    for (const count of [true, false]) {
      const text = source(count);
      const request = coreRequest([{ path: "main.tease", source: text }], OPTIONS.globals);
      assert.ok(request !== null);
      const b = new CoreProgram(request).places.find(
        ({ kind }) => kind.kind === "binding" && kind.name === "b",
      )!.id;
      // half of `b`'s decision in the unbounded analysis in this order, still far above `count`'s (the solver's steps
      // decide where it stops: since A2, #1293, three quarters is crossed only after the last of them)
      const { decisions } = inOrder(() => analyseCore(request)).budget;
      const allowance = Math.floor(0.5 * decisionOf(decisions, { place: b, path: [] }).units);
      const where = `reversed: ${reversed}, count: ${count}`;
      const answers: Answers = withTestDemandAllowance(allowance, () =>
        inOrder(() => completedCore(request)),
      );
      assert.deepEqual(
        answers.budget.decisions.filter((d) => d.stopped).map((d) => [d.place, d.path]),
        [[b, []]],
        where,
      );
      // (a read as long as the decision may stop too: its own key's contract with `budget`)
      assert.deepEqual(answers.place(b).admitted, { by: "undecided" }, where);
      const at = (start: number): string[] =>
        answers.diagnostics
          .filter((d) => d.site.start === start)
          .map((d) => `${d.class} ${"provenance" in d ? d.provenance.context : "-"}`);
      const read = text.indexOf(count ? "b\nlet count" : "b\nsay");
      // (`budget` in either order: the pass in which `b`'s decision stopped is not settled, and the next starts with `b`
      // stopped, so `n`'s check, which reads `b` before `b` is decided in the reversed order, reads it stopped)
      assert.deepEqual(at(read), ["warning-runtime-check budget"], where);
      if (count) assert.deepEqual(at(text.indexOf("count {}")), ["compile-error -"], where);
      else {
        // the read's moved check stops a fraction before the next effect; where the receiving completion completed `b`'s
        // contract (#1526 phase C step 5), the store of host data checks it first, as unstopped
        const plan = withTestDemandAllowance(allowance, () =>
          inOrder(() => compileSourceWithBackend(text, OPTIONS, CORE_BACKEND).plan),
        );
        assert.ok(plan !== null, where);
        assert.deepEqual(ran(plan, 5), { said: ["AFTER"], failure: null }, where);
        const checked = answers.budget.closure === null ? read : text.indexOf("hostValue\nlet n");
        assert.match(ran(plan, 1.5).failure ?? "", new RegExp(`^TSR\\d+@${checked}:`, "u"), where);
      }
    }
  }
});

/**
 * Astra r1 B1 and Codex c-r7 B1 on #1165: a decision stopped at its allowance leaves its key's contract `budget` for
 * every read from then on (`Contract.stop`), a read composed in a literal or its projection included, also after a
 * program stop where admission had settled, when the finishing path asks retained, lazily decided and syntax sources
 * (source 4 tells a stopped decision from a path admission decides lazily). `tally`'s decision scans its 14 stores; its
 * place stays undecided and its read, an object literal's property holding it and that property's read answer `budget`
 * before the program stop and at its first settled and its last stop, and the stop changes nothing the oracle does not
 * excuse, no boundary among it. The generated family (shapes, readers, caps and allowances around the stop) runs outside
 * CI.
 */
test("a stopped decision stays undecided at every reader, also after a settled program stop (S3)", () => {
  const source =
    [
      "let tally = 1",
      ...Array.from({ length: 12 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let picked: integer = tally",
      "let other = tally",
      "repeat {kept: tally}.kept {}",
      "repeat tally {}",
      "repeat other {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const tally = new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === "tally",
  )!.id;
  const read = source.indexOf("tally {}");
  const kept = source.indexOf("{kept: tally}");
  for (const reversed of [false, true]) {
    const inOrder = <T>(make: () => T): T =>
      reversed
        ? withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), make),
          )
        : make();
    const { decisions } = inOrder(() => analyseCore(request)).budget;
    const own = decisionOf(decisions, { place: tally, path: [] });
    const capped = <T>(make: () => T): T =>
      withTestDemandAllowance(Math.floor(own.units / 2), () => inOrder(make));
    const unstopped = capped(() => stopRun(source));
    const total = unstopped.answers.budget.total;
    const [first] = capped(() => [...settledEnds(source).values()]).reduce(
      (lowest, ends) => (ends[0] < lowest[0] ? ends : lowest),
      [total, total] as const,
    );
    for (const allowance of [undefined, first, total - 1]) {
      const where = `reversed: ${reversed}, allowance: ${allowance}`;
      // (at a settled program stop the candidate may decline the compile, #1526 decision 2: an accepted over-decline,
      // #1832, the store check of `tally`'s host value partial and no completion to tell it from the natural plan's; a
      // published plan runs as the unstopped one; its analysis is judged either way)
      if (allowance !== undefined)
        try {
          const run = capped(() => stopRun(source, allowance));
          // (a published plan runs as the unstopped one)
          assert.ok(run.result.plan !== null, where);
          for (const value of [2, 2.5, "x"])
            assert.deepEqual(
              runGlobals(run.result.plan, host(value)),
              runGlobals(unstopped.result.plan!, host(value)),
              where,
            );
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error;
          assert.ok(error instanceof CandidateOutsideSlice && error.what === LOST_CHECK, where);
        }
      const answers: Answers =
        allowance === undefined
          ? unstopped.answers
          : capped(() => withTestAllowance(allowance, () => analyseCore(request)));
      assert.equal(answers.budget.settled, true, where);
      assert.ok(
        answers.budget.decisions.some((d) => d.place === tally && d.stopped),
        where,
      );
      assert.deepEqual(answers.place(tally).admitted, { by: "undecided" }, where);
      const node = (start: number, kind: string) =>
        answers.graph.nodes.find(
          (each) => each.expression?.kind === kind && each.span?.start.offset === start,
        )!;
      const budget = (items: readonly { tag: string; reasons: number }[]) =>
        items.map((item) => `${item.tag}/${item.reasons}`);
      assert.deepEqual(budget(answers.at(node(read, "identifier"))!.items), ["unknown/16"], where);
      assert.deepEqual(
        budget(answers.valueAt(node(kept, "objectLiteral"), ["kept"]).items),
        ["unknown/16"],
        where,
      );
      assert.deepEqual(
        budget(answers.at(node(kept, "propertyAccessExpression"))!.items),
        ["unknown/16"],
        where,
      );
    }
  }
});

/**
 * Astra r1's B2 on #1437: a stop changes nothing no mark of it names. Below a decision stopped at its demand allowance
 * the unstopped publication owes no boundary, so the stopped one reads no further there (`againstOf`); and
 * after a stop `toJson` owes the check of a value the stop left unread, its mark owning the one the unstopped walk made
 * for the regex below each argument. Each mode's settled phase ends and its last stop before admission settled (whose
 * fresh pass reads no property names: a literal argument, which it reads as an object), without a demand allowance and
 * with the witness's
 * 257, which stops a decision below `root`; where it stops the analysis itself (the reversed orders) there
 * is no unstopped analysis to compare. A host value fits where the unstopped plan runs it: without sharing, 257 decides
 * the element `regex`, which C9 checks the host value against. Both programs store into inferred places, so at the stop
 * before admission settled the plain gate declines (#2080 part 2): there the records and the check ledger are compared.
 */
test("a stop adds no boundary below a stopped decision and keeps toJson's checks, or the program is declined (#1437, #1526)", () => {
  const sources = [
    "let root={value:{a:[hostValue otherwise /r/],b:1}}\nlet first=root\nlet second=first\n" +
      "say toJson(first)\nsay toJson(second)\nsay toJson(root)\nexit\n",
    "let n = 1\nsay toJson({a: [hostValue otherwise /r/], b: n})\nexit\n",
  ];
  // (#1526 decision 2, condition 1: a settled stop whose plan lost the element's check, which the unstopped
  // plan makes against a host value, is declined; where the reference run at demand 257 is such a stop, a decision's,
  // each of its stops is declined too, and an unsettled one, which has no registry, by the plain gate, #2080 part 2)
  const declines = (error: unknown): boolean =>
    error instanceof CandidateOutsideSlice &&
    error.what === "a store whose check was lost at the budget";
  let compared = 0;
  let declined = 0;
  let unsettled = 0;
  let undecided = 0;
  for (const source of sources)
    for (const demand of [null, 257])
      for (const mode of MODES) {
        const inDemand = <T>(make: () => T): T =>
          inMode(mode, () => (demand === null ? make() : withTestDemandAllowance(demand, make)));
        // (each settled phase's ends, and the last stop before admission settled, whose fresh pass asks nothing)
        const stopsOf = (): (readonly [string, number])[] => [
          ...[...inDemand(() => settledEnds(source))].flatMap(([phase, ends]) =>
            ends.map((allowance) => [phase, allowance] as const),
          ),
          ["unsettled", inDemand(() => lastUnsettled(source))],
        ];
        let unstopped: StopRun;
        try {
          unstopped = stopRunIn(inDemand, source);
        } catch (error) {
          assert.ok(declines(error), `${source} demand: ${demand}, ${JSON.stringify(mode)}`);
          for (const [phase, allowance] of stopsOf()) {
            const where = `${source} demand: ${demand}, ${JSON.stringify(mode)}, ${phase} @${allowance}`;
            try {
              const stopped = stopRunIn(inDemand, source, allowance);
              assert.equal(stopped.answers.budget.settled, false, where);
              assert.ok(stopped.undecided, where);
              unsettled += 1;
            } catch (stop) {
              assert.ok(declines(stop), where);
              declined += 1;
            }
          }
          continue;
        }
        if (unstopped.answers.budget.exhausted !== null) continue;
        const inputs = [host(1), host(null)];
        const fits = (globals: Globals): boolean =>
          runGlobals(unstopped.result.plan!, globals).failure === null;
        for (const [phase, allowance] of stopsOf()) {
          compared += 1;
          const where = `${source} demand: ${demand}, ${JSON.stringify(mode)}, ${phase} @${allowance}`;
          let stopped: ReturnType<typeof stopRun>;
          try {
            stopped = stopRunIn(inDemand, source, allowance);
          } catch (error) {
            assert.ok(declines(error), where);
            assert.ok(
              inputs.some((globals) => !fits(globals)),
              where,
            );
            declined += 1;
            continue;
          }
          if (phase === "unsettled") undecided += 1;
          assert.deepEqual(
            gatedProblems(
              {
                unstopped,
                stopped,
                fitting: inputs.filter(fits),
                violating: inputs.filter((globals) => !fits(globals)),
              },
              phase === "unsettled",
            ),
            [],
            where,
          );
        }
      }
  // (54 stops: in source order at demand 257, with and without sharing, the first source's reference run stops `root`'s
  // decisions and loses the `value.a` element's check; of its five stops each, its two walk ends and two publication ends
  // are declined, and the last unsettled one by the plain gate; each of the 12 compared runs' last unsettled stop is the
  // plain gate's)
  assert.deepEqual(
    { compared, declined, unsettled, undecided },
    { compared: 44, declined: 8, unsettled: 2, undecided: 12 },
  );
});

const reversed = <T>(make: () => T): T =>
  withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), make),
  );
const modes: readonly (readonly [string, <T>(make: () => T) => T])[] = [
  ["forward", (make) => make()],
  ["reversed", reversed],
  ["forward, unshared", (make) => withoutSharing(make)],
  ["reversed, unshared", (make) => withoutSharing(() => reversed(make))],
];
const globals = ["hostValue", "hostOther"];
const place = (source: string, name: string) => {
  const request = coreRequest([{ path: "main.tease", source }], globals);
  assert.ok(request !== null);
  return {
    request,
    id: new CoreProgram(request).places.find(
      ({ kind }) => kind.kind === "binding" && kind.name === name,
    )!.id,
  };
};
const passes = (answers: Answers): number => answers.budget.counts.get("stopPasses") ?? 0;
const items = (list: readonly { tag: string; reasons: number }[]) =>
  list.map((item) => `${item.tag}/${item.reasons}`);

/**
 * a pass in which a decision stops is not settled; the next, from the same rejections, starts with that key stopped
 * (`Contract.stop`), so no result read the key before its stop, in any order. `pair`'s stored literal holds a read of
 * `tally`; in the reversed order `pair` is decided before `tally`, and without the next pass `pair.first` kept the host
 * value `tally` held then; `count`'s error is independent of `tally` and stays. One extra pass where a decision first
 * stops, none without one, and at most one per rejected set
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183): in the reversed order `box`'s
 * root, which reads the values `box.n`'s stopped decision had finished, stops once `box.n` is stopped from its pass's
 * start, and that second stop stops the analysis as the work allowance does. A program stop in the pass where a
 * decision first stopped is not settled: finishing marks the stores, and the stop oracle holds, no boundary among it,
 * as in #1194's witness below of a second stop; the plain gate declines it (#2080 part 2).
 */
test("a pass in which a decision stops is not settled: the next starts with its key stopped", () => {
  const dependent =
    [
      "let tally = 1",
      ...Array.from({ length: 60 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let pair = [tally]",
      "let count = 1",
      "count = 0.5",
      "repeat count {}",
      "repeat pair.first {}",
      "repeat tally {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const tally = place(dependent, "tally");
  for (const [mode, inMode] of modes) {
    const unbounded = inMode(() => analyseCore(tally.request));
    assert.equal(passes(unbounded), 0, mode);
    const own = decisionOf(unbounded.budget.decisions, { place: tally.id, path: [] });
    const capped = <T>(make: () => T): T =>
      withTestDemandAllowance(Math.floor(own.units / 2), () => inMode(make));
    const answers = capped(() => analyseCore(tally.request));
    const node = (text: string, kind: string) =>
      answers.graph.nodes.find(
        (each) =>
          each.expression?.kind === kind && each.span?.start.offset === dependent.indexOf(text),
      )!;
    assert.deepEqual(
      items(answers.at(node("pair.first", "propertyAccessExpression"))!.items),
      ["unknown/16"],
      mode,
    );
    assert.deepEqual(
      items(answers.at(node("tally {}", "identifier"))!.items),
      ["unknown/16"],
      mode,
    );
    // (the independent error stays; in the reversed unshared mode `pair`'s element decision, longer there than
    // `tally`'s, stops too and then again in the restarted pass, which stops the analysis
    // (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183): its check is marked)
    assert.equal(passes(answers), 1, mode);
    const count = dependent.indexOf("count {}");
    if (mode === "reversed, unshared") {
      assert.equal(answers.budget.exhausted, "work", mode);
      assert.ok(
        answers.budget.deferred.some((mark) => mark.site.start === count),
        mode,
      );
    } else
      assert.deepEqual(
        answers.diagnostics.filter((d) => d.site.start === count).map((d) => d.class),
        ["compile-error"],
        mode,
      );
  }
  // one decision stopping: one extra pass in either order; a program stop at the last unit of the pass where it stopped
  const single =
    [
      "let tally = 1",
      ...Array.from({ length: 12 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let picked: integer = tally",
      "repeat tally {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const scalar = place(single, "tally");
  for (const [mode, inMode] of modes.slice(0, 2)) {
    const own = decisionOf(inMode(() => analyseCore(scalar.request)).budget.decisions, {
      place: scalar.id,
      path: [],
    });
    const capped = <T>(make: () => T): T =>
      withTestDemandAllowance(Math.floor(own.units / 2), () => inMode(make));
    const unstopped = capped(() => stopRun(single));
    assert.equal(passes(unstopped.answers), 1, mode);
    // (the lowest program allowance whose stop comes after the first pass: one below it, the first pass's last unit)
    let [low, high] = [1, unstopped.answers.budget.total];
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (passes(capped(() => withTestAllowance(middle, () => analyseCore(scalar.request)))) >= 1)
        high = middle;
      else low = middle;
    }
    const stopped = capped(() => stopRun(single, low));
    const { budget } = stopped.answers;
    assert.equal(budget.exhausted, "work", mode);
    assert.equal(budget.settled, false, mode);
    assert.ok(
      budget.deferred.some((mark) => mark.rule.rule === "store"),
      mode,
    );
    // (the inferred stores' checks are left undecided there: the plain gate declines, #2080 part 2)
    assert.deepEqual(
      capped(() =>
        gatedProblems({ unstopped, stopped, fitting: [host(2)], violating: [host(2.5)] }, true),
      ),
      [],
      mode,
    );
  }
  // a decision stopping only in the restarted pass: the analysis stops there
  // (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183)
  const property =
    [
      "let box = {n: 1}",
      ...Array.from({ length: 12 }, (_, i) => `box.n = ${i + 2} + ${i + 3}`),
      "box = {n: 4}",
      "repeat box.n {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const box = place(property, "box");
  const root = decisionOf(reversed(() => analyseCore(box.request)).budget.decisions, {
    place: box.id,
    path: [],
  });
  // (outside the candidate route's slice, `2 + 3`: its analysis alone; #1194's witness below runs the stop oracle)
  const twice: Answers = withTestDemandAllowance(root.units + 3, () =>
    reversed(() => analyseCore(box.request)),
  );
  assert.equal(passes(twice), 1);
  assert.equal(twice.budget.exhausted, "work");
  assert.equal(twice.budget.settled, false);
  assert.ok(twice.budget.deferred.some((mark) => mark.rule.rule === "store"));
});

/**
 * Codex c-r8 B1 on #1165: a narrowed read of a key whose decision stopped reads it as every read does,
 * through the one key read (`Values.#keyRead`), as unknown data with the reason `budget`, and the test narrows it as it
 * narrows host data: under `is integer` the read is the integer the test itself proves, so its reason is the test's, not
 * `budget`; under `is not integer`, and unguarded, it stays `unknown` with `budget`. Both orders.
 */
test("a narrowed read of a stopped decision's key is what its test proves, unguarded reads budget", () => {
  for (const [form, expected] of [
    ["is integer", ["integer/0"]],
    ["is not integer", ["unknown/16"]],
  ] as const) {
    const source =
      [
        "let tally = 1",
        ...Array.from({ length: 12 }, (_, i) => `tally = ${i + 2}`),
        "tally = hostValue",
        `if tally ${form} {`,
        "  let picked: integer = tally",
        "}",
        "repeat tally {}",
        "exit",
      ].join("\n") + "\n";
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const tally = new CoreProgram(request).places.find(
      ({ kind }) => kind.kind === "binding" && kind.name === "tally",
    )!.id;
    for (const reversed of [false, true]) {
      const inOrder = <T>(make: () => T): T =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), make),
            )
          : make();
      const own = decisionOf(inOrder(() => analyseCore(request)).budget.decisions, {
        place: tally,
        path: [],
      });
      const answers: Answers = withTestDemandAllowance(Math.floor(own.units / 2), () =>
        inOrder(() => analyseCore(request)),
      );
      const where = `${form}, reversed: ${reversed}`;
      assert.deepEqual(answers.place(tally).admitted, { by: "undecided" }, where);
      const read = (start: number) =>
        answers
          .at(
            answers.graph.nodes.find(
              (each) => each.expression?.kind === "identifier" && each.span?.start.offset === start,
            )!,
          )!
          .items.map((item) => `${item.tag}/${item.reasons}`);
      assert.deepEqual(read(source.indexOf("tally\n}")), expected, where);
      assert.deepEqual(read(source.indexOf("tally {}")), ["unknown/16"], where);
    }
  }
});

/**
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183): a decision that stops in the
 * restarted pass stops the analysis there, its stores marked, the stop oracle holding, and the plain gate declining
 * (#2080 part 2). #1194's copies of a deep
 * written type (64 levels and copies) are the witness: at the natural allowance they are `valid` in the four modes with
 * no restart (the recorded cost was the alias class's eligibility index, charged to the first decision that asked for
 * it, the sharing on only, #1703); at the demand allowance 1,024 the reversed order's deepest decision stops, and the
 * next path's in the restarted pass, with the sharing on and off.
 */
test("a decision stopping in the restarted pass stops the analysis: #1194's copies reversed", () => {
  const source = [
    `let typed: integer${"[]".repeat(64)} = []`,
    "let out = typed",
    ...Array.from({ length: 64 }, () => "out = typed"),
    "exit",
  ].join("\n");
  const reversed = <T>(make: () => T): T =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), make),
    );
  const sharings = [
    ["shared", <T>(make: () => T): T => make()],
    ["unshared", withoutSharing],
  ] as const;
  for (const [name, sharing] of sharings)
    for (const order of [<T>(make: () => T): T => make(), reversed]) {
      const natural = stopRunIn((make) => sharing(() => order(make)), source);
      const where = `${name}, reversed: ${order === reversed}`;
      assert.equal(natural.answers.budget.exhausted, null, where);
      assert.equal(natural.answers.budget.counts.get("stopPasses"), undefined, where);
      assert.equal(natural.result.diagnostics.length, 0, where);
    }
  for (const [name, sharing] of sharings) {
    const ordered = <T>(make: () => T): T => sharing(() => reversed(make));
    // (the reference: no decision stops under a demand allowance the analysis never reaches)
    const unstopped = stopRunIn(
      (make) => withTestDemandAllowance(30_000_000, () => ordered(make)),
      source,
    );
    assert.equal(unstopped.answers.budget.exhausted, null, name);
    assert.equal(unstopped.result.diagnostics.length, 0, name);
    const stopped = stopRunIn(
      (make) => withTestDemandAllowance(1_024, () => ordered(make)),
      source,
    );
    const { budget } = stopped.answers;
    assert.equal(budget.counts.get("stopPasses"), 1, name);
    assert.equal(budget.exhausted, "work", name);
    assert.equal(budget.settled, false, name);
    assert.ok(
      budget.deferred.some((mark) => mark.rule.rule === "store"),
      name,
    );
    // (the copy `out`'s check is left undecided: the plain gate declines, #2080 part 2)
    assert.deepEqual(
      gatedProblems({ unstopped, stopped, fitting: [], violating: [] }, true),
      [],
      name,
    );
  }
});

/**
 * #1323 (Codex r6): a folded group's provenance reads are shared work, and a demand stop that leaves one
 * suspended closes it (`closeShared`): with the sharing on, the stops at these demands lose no check main keeps.
 */
test("a stop that abandons a group's provenance read loses no check, with the sharing on (#1323)", () => {
  const cases = [
    [
      "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({p:[{extra:1,noise:read({p:[{extra:1,noise:0},{f0:1.5}]})},{f0:1.5}]})\nexit\n",
      64,
    ],
    [
      "function read(x:object) { let alias=x.p\nalias.extra=1\nx.p.extra=hostValue\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      32,
    ],
  ] as const;
  for (const [source, demand] of cases)
    for (const mode of HELD_MODES.slice(0, 2)) {
      const held: HeldCase = { name: "abandoned-provenance", source, slice: false, values: [] };
      const problems = stopProblems({
        unstopped: heldRun(held, mode),
        stopped: heldRun(held, mode, undefined, demand),
        fitting: [],
        violating: [],
      });
      assert.deepEqual(
        problems.filter((problem) => problem.startsWith("lost")),
        [],
        `${mode.name} at ${demand}`,
      );
    }
});
