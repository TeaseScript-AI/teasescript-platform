// The stop oracle's own tests: what it reports, and the reruns it refuses.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../src/compiler.js";
import { type Answers } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import {
  combinedStopRule,
  declineOf,
  heldRun,
  heldUnstopped,
  HELD_MODES,
  type HeldCase,
} from "../helpers/type-core-held-host.js";
import { runGlobals } from "../helpers/type-core-route.js";
import { stopProblems, type Globals, type StopRun } from "../helpers/type-core-stop-oracle.js";
import {
  UNDECIDED,
  LOST_CHECK,
  object,
  host,
  stopRun,
  walkEnds,
} from "../helpers/type-core/type-core-stop-setup.js";

/**
 * The stop oracle itself: the whole plan, a mark excusing only its own record. Changes to a compile
 * stand in for a stop that made them: a store check's place, type or presence (Codex r8's T1), a property store's
 * guard (Astra r3's T1), alone and beside the mark of a default the stop left undecided, the diagnostics' order and a
 * coordinate of one (Codex r12's T1).
 */
test("the stop oracle sees every change no mark of the stop names", () => {
  // `edit` applied to every node of the plan, changing one at least
  const edited = (each: StopRun, edit: (node: unknown) => boolean): StopRun => {
    const plan = structuredClone(each.result.plan);
    let changed = 0;
    const pending: unknown[] = [plan];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || typeof node !== "object") continue;
      if (edit(node)) changed += 1;
      pending.push(...Object.values(node));
    }
    assert.ok(changed > 0);
    return { ...each, result: { ...each.result, plan } };
  };
  // (the store's check is `{type: {kind: "integer"}, place: "'n'"}`; `undefined` removes it)
  const typeCheck =
    (check: unknown) =>
    (node: unknown): boolean => {
      if (node === null || typeof node !== "object" || !("typeCheck" in node)) return false;
      node.typeCheck = check;
      return true;
    };
  const withoutGuard = (node: unknown): boolean => {
    if (node === null || typeof node !== "object" || !("requireExisting" in node)) return false;
    delete node.requireExisting;
    return true;
  };
  const problems = (unstopped: StopRun, stopped: StopRun, violating: readonly Globals[] = []) =>
    stopProblems({ unstopped, stopped, fitting: [], violating });
  const store = stopRun("let n: integer = hostValue\nexit\n");
  assert.deepEqual(problems(store, store), []);
  for (const edit of [
    typeCheck({ type: { kind: "integer" }, place: "wrong target" }),
    typeCheck({ type: { kind: "text" }, place: "'n'" }),
    typeCheck(undefined),
  ])
    assert.notDeepEqual(problems(store, edited(store, edit)), []);
  const vessel = stopRun('let vessel = hostValue\nvessel.amount = 4\nsay "AFTER"\nexit\n');
  assert.deepEqual(problems(vessel, vessel), []);
  assert.notDeepEqual(problems(vessel, edited(vessel, withoutGuard)), []);
  // a walk stop marks the default, which excuses its own check and not the guard; where `vessel` holds a host
  // value, its lowest walk stop loses the vessel's check, which `{amount: "x"}` passes, and the candidate declines it
  // (#1526 decision 2), so the oracle is judged on its variant, `vessel` a typed load's, which its reader carries (the
  // list's elements admit no `null`, so the mark keeps their family: one against `unknown` declines, #2183)
  const original =
    'let nums: number[] = [1.25]\nlet pack={nums:nums}\nlet twin=pack\nsay twin.nums.get(4, default:hostValue)\nlet vessel=hostOther\nvessel.amount=4\nsay "AFTER"\nexit\n';
  assert.throws(
    () => stopRun(original, walkEnds(original)[0]),
    (error: unknown) =>
      error instanceof CandidateOutsideSlice &&
      error.what === "a store whose check was lost at the budget",
  );
  const source = original.replace(
    "let vessel=hostOther",
    'let vessel=load("v", default: {other: 1})',
  );
  const unstopped = stopRun(source);
  const stopped = stopRun(source, walkEnds(source)[0]);
  const fallback = source.indexOf("hostValue");
  assert.ok(
    stopped.answers.budget.deferred.some((d) => d.code === "TSV041" && d.site.start === fallback),
  );
  const violating = [host(2.5, object({ other: 2 }))];
  assert.deepEqual(problems(unstopped, stopped, violating), []);
  const unguarded = problems(unstopped, edited(stopped, withoutGuard), violating);
  assert.ok(
    unguarded.some((problem) => problem.includes("requireExisting")),
    unguarded.join(" | "),
  );
  assert.ok(
    unguarded.some((problem) => problem.startsWith("violating ")),
    unguarded.join(" | "),
  );
  // the diagnostics whole, in their published order: the order, and a coordinate of a span (Codex r12's T1)
  assert.ok(unstopped.result.diagnostics.length > 1);
  const diagnostics = (list: typeof unstopped.result.diagnostics): StopRun => ({
    ...unstopped,
    result: { ...unstopped.result, diagnostics: list },
  });
  assert.notDeepEqual(
    problems(unstopped, diagnostics([...unstopped.result.diagnostics].reverse())),
    [],
  );
  const [first, ...others] = unstopped.result.diagnostics;
  assert.ok(first !== undefined);
  for (const span of [
    { ...first.span, start: { ...first.span.start, line: first.span.start.line + 1 } },
    { ...first.span, end: { ...first.span.end, column: first.span.end.column + 1 } },
  ])
    assert.notDeepEqual(problems(unstopped, diagnostics([{ ...first, span }, ...others])), []);
});

/**
 * #1594: a stopped run's `without` reruns its compile and analysis at the run's own allowance (`StopRun.without`).
 * At a settled walk stop whose plan differs from the natural one by what the stop's marks excuse, the oracle excuses
 * that content only where `without` measures it: the held host's own stopped run (`heldRun`) gives no problem, and one
 * made outside its allowance (`withTestAllowance` around `heldUnstopped`, whose `without` then runs unstopped) is
 * refused. #1631's witness at program allowance 1,766, its lowest such stop in held mode 0. (The issue's witness, a
 * literal-zero `get` with a named default, stores into inferred places, so before admission settles the plain gate
 * declines it, #2080 part 2; a default whose element domain admits `null` leaves its mark against `unknown`, which
 * declines after it, #2183.)
 */
test("the stop oracle refuses a stopped run whose without leaves the run's allowance (#1594)", () => {
  const source =
    'let root = {inside: {f0: hostValue}}\nlet first = root\nroot = {inside: {f0: hostOther}}\nsay "BEFORE"\nrepeat first.inside.f0 {say "ok"}\nsay "AFTER"\nexit\n';
  const values = [0, 2, "bad", true, null].map((value) => ({
    globals: { hostValue: value, hostOther: value },
    says: typeof value === "number" ? ["AFTER"] : null,
  }));
  const c: HeldCase = { name: "domain-nested", source, slice: true, values };
  const mode = HELD_MODES[0]!;
  const allowance = 1766;
  const { run: unstopped } = heldUnstopped(c, mode);
  const judge = (stopped: StopRun): string[] =>
    stopProblems({
      unstopped,
      stopped,
      fitting: values.filter((each) => each.says !== null).map((each) => each.globals),
      violating: values.filter((each) => each.says === null).map((each) => each.globals),
    });
  const kept = heldRun(c, mode, allowance);
  assert.deepEqual([kept.answers.budget.stoppedIn, kept.answers.budget.settled], ["walk", true]);
  assert.ok(kept.result.plan !== null);
  // (the oracle measures the content: it reruns `without`)
  let reruns = 0;
  assert.deepEqual(
    judge({ ...kept, without: (omit, key) => ((reruns += 1), kept.without(omit, key)) }),
    [],
  );
  assert.ok(reruns > 0);
  const outside = withTestAllowance(allowance, () => heldUnstopped(c, mode)).run;
  assert.throws(() => judge(outside), /another stop/);
});

/**
 * #1631: a rerun without the run's demand allowance can stop in the same phase, settled, at the same program allowance,
 * yet under another demand allowance none of its decisions stops, so its compile differs. The issue's witness at program
 * allowance 1,886 (2,039 before #1251 made no narrowing index for it) and demand allowance 27, whose stopped compile the
 * candidate now declines (#1832): on its analysis with the reference's plan one text changed, the run's own `without` is
 * judged, the uncapped run's refused.
 */
test("the stop oracle refuses a stopped run whose without leaves the run's demand allowance (#1631)", () => {
  const c: HeldCase = {
    name: "domain-nested",
    slice: true,
    values: [],
    source:
      'let root = {inside: {f0: hostValue}}\nlet first = root\nroot = {inside: {f0: hostOther}}\nsay "BEFORE"\nrepeat first.inside.f0 {say "ok"}\nsay "AFTER"\nexit\n',
  };
  const mode = HELD_MODES[0]!;
  const unstopped = heldRun(c, mode, undefined, 27);
  const stopped = heldRun(c, mode, 1886, 27);
  const uncapped = heldRun(c, mode, 1886);
  for (const { budget } of [stopped.answers, uncapped.answers])
    assert.deepEqual([budget.allowance, budget.stoppedIn, budget.settled], [1886, "walk", true]);
  assert.ok(stopped.answers.budget.decisions.some((d) => d.stopped));
  assert.ok(!uncapped.answers.budget.decisions.some((d) => d.stopped));
  // (there the candidate may decline the stopped compile, #1526 decision 2, an accepted over-decline, #1832: no completion
  // tells `root`'s partial check from the natural one; a published plan runs as the natural one)
  try {
    const plan = mode.run(() =>
      withTestDemandAllowance(27, () =>
        withTestAllowance(1886, () =>
          compileSourceWithBackend(c.source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND),
        ),
      ),
    ).plan;
    const natural = heldRun(c, mode).result.plan!;
    assert.ok(plan !== null);
    for (const value of [2, "x", null])
      assert.deepEqual(
        runGlobals(plan, { hostValue: value, hostOther: value }),
        runGlobals(natural, { hostValue: value, hostOther: value }),
      );
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.ok(error instanceof CandidateOutsideSlice && error.what === LOST_CHECK, String(error));
  }
  // (the oracle's scope check, on the stopped analysis with the reference's plan and its `say "BEFORE"` text changed, so
  // the oracle reruns the stopped run: its own rerun is judged, the uncapped run's refused)
  // (the reference under demand allowance 27 is declined too, at its decision stop; the natural plan stands for it)
  const base: StopRun = {
    ...unstopped,
    result: { ...unstopped.result, plan: unstopped.result.plan ?? heldRun(c, mode).result.plan },
  };
  assert.ok(base.result.plan !== null);
  const plan = structuredClone(base.result.plan);
  const pending: unknown[] = [plan];
  let changed = 0;
  while (pending.length > 0 && changed === 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    for (const [key, value] of Object.entries(node))
      if (value === "BEFORE" && changed === 0) {
        Reflect.set(node, key, "OTHER");
        changed += 1;
      }
    pending.push(...Object.values(node));
  }
  assert.equal(changed, 1);
  const edited: StopRun = { ...stopped, result: { ...stopped.result, plan } };
  // (a combined stop, judged under its rule: its finishing read answers `first` from its stores' syntax through the copy
  // of `root`, as the natural analysis does, where the demand-only run's read stopped, #1604)
  const rule = combinedStopRule(c, mode, base, stopped.answers);
  const excused = {
    records: new Set([...rule.records.keys(), ...rule.relabelled.records, ...rule.coarse.records]),
    checks: new Set([
      ...rule.checks.keys(),
      ...rule.owing,
      ...rule.relabelled.checks,
      ...rule.coarse.checks.keys(),
    ]),
  };
  const judge = (run: StopRun): string[] =>
    stopProblems({ unstopped: base, stopped: run, fitting: [], violating: [], excused });
  assert.notDeepEqual(judge(edited), []);
  assert.throws(
    () => judge({ ...edited, without: uncapped.without }),
    /the demand allowance \d+ at its decision \[\d+,\[[^\]]*\]\], not the run's 27/,
  );
  // (and the reference's rerun without its completion, Codex r1's F1 on #1662: a decision of the reference stopped, its
  // uncapped rerun refused. The issue's `tally` witness stopped before admission settled, where the plain gate declines
  // it, #2080 part 2, so nothing reruns its reference; the reference here at demand 27 stands for it)
  assert.ok(unstopped.answers.budget.decisions.some((d) => d.stopped));
  assert.throws(
    () =>
      stopProblems({
        unstopped: { ...base, without: heldRun(c, mode).without },
        stopped: edited,
        fitting: [],
        violating: [],
        excused,
      }),
    /the demand allowance \d+ at its decision \[\d+,\[[^\]]*\]\], not the run's 27/,
  );
});

/**
 * #1642 and the stop oracle's ledger of each check's content (the lead's ruling on #1663): every check a record owns uses
 * one count of its content, so a further copy is an extra check and a missing one a lost check, on either side. The
 * issue's `dict-path` witness reversed, under demand allowance 256, stopped at program allowance 2,464: the reference's
 * TSV043 mark and the stopped run's each carry the receiver's null-check both runs publish, so neither is lost. Codex's
 * controls on #1663, each clean as compiled: r1's (a stop at program allowance 1) loses the check where the stopped run
 * keeps its mark but drops it and its guard, and changes the plan where it drops the guard alone; r2's, a copy the rule
 * accepts published twice; r3's, a further copy where a run publishes the check; r4's, a boundary that forms only with
 * the marks, doubled; r5's, a further copy of a boundary both runs owe; r6's, the reference losing its own check; and a further copy of a
 * check the stopped run alone owns. Before admission settled the stores into inferred places leave their checks
 * undecided, so the plain gate declines those stopped runs (#2080 part 2): the ledger is compared without a plan, and r1's
 * guard alone, a plan change, is made on the stopped and reference analyses carrying the natural run's plan. The
 * `dict-path` witness's written dict type is outside the slice, so its compiles decline, on main as here.
 */
test("the stop oracle counts each check's content on both sides, a further copy an extra and a missing one lost (#1642)", () => {
  const source =
    'let p = hostValue otherwise hostOther\nlet box: integer[] dict = dict{k: []}\nbox.k = [p, hostOther]\nsay "AFTER"\nexit\n';
  const c: HeldCase = { name: "dict-path", source, slice: true, values: [] };
  const receiver = (answers: Answers) =>
    answers.checks.filter(
      (check) =>
        check.kind === "null-check" &&
        check.target === "box" &&
        source.slice(check.site.start, check.site.end) === "box.k",
    );
  for (const mode of [HELD_MODES[1]!, HELD_MODES[3]!]) {
    const reference = heldRun(c, mode, undefined, 256);
    const stopped = heldRun(c, mode, 2464, 256);
    const [owed, kept] = [receiver(reference.answers), receiver(stopped.answers)];
    assert.equal(owed.length, 1, mode.name);
    assert.deepEqual(kept, owed, mode.name);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (mark) =>
          mark.code === "TSV043" && JSON.stringify(mark.obligation) === JSON.stringify(owed[0]),
      ),
      mode.name,
    );
    // (the written dict type is outside the candidate slice, so both compiles decline, on main as here: the ledger is
    // what is compared)
    assert.deepEqual(
      [declineOf(reference), declineOf(stopped)],
      ["this written type", "this written type"],
      mode.name,
    );
    assert.deepEqual(
      stopProblems({ unstopped: reference, stopped, fitting: [], violating: [] }),
      [],
      mode.name,
    );
  }
  const plain =
    'let p = hostValue otherwise hostOther\nlet box = {k: [1]}\nbox.k = [p, hostOther]\nsay "AFTER"\nexit\n';
  const o: HeldCase = { name: "object", source: plain, slice: true, values: [] };
  const mode = HELD_MODES[1]!;
  const reference = heldRun(o, mode, undefined, 256);
  const stopped = heldRun(o, mode, 1, 256);
  const [check] = reference.answers.checks.filter(
    (each) => each.kind === "null-check" && plain.slice(each.site.start, each.site.end) === "box.k",
  );
  assert.ok(check !== undefined);
  const text = JSON.stringify(check);
  assert.ok(
    stopped.answers.budget.deferred.some((mark) => JSON.stringify(mark.obligation) === text),
  );
  // (the plain gate declines the stopped run: no plan, its ledger compared)
  assert.deepEqual([stopped.result.plan, declineOf(stopped)], [null, UNDECIDED]);
  const judge = (run: StopRun): string[] =>
    stopProblems({ unstopped: reference, stopped: run, fitting: [], violating: [] }).filter(
      (problem) => problem !== "no plan",
    );
  assert.deepEqual(judge(stopped), []);
  // (the check left out of the answers, and the guard it gives the store, `requireExisting`, out of the plan)
  const unguarded = (plan: StopRun["result"]["plan"]): StopRun["result"]["plan"] => {
    const copy = structuredClone(plan);
    const pending: unknown[] = [copy];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || typeof node !== "object") continue;
      if (
        "kind" in node &&
        node.kind === "assign" &&
        "span" in node &&
        typeof node.span === "object" &&
        node.span !== null &&
        "so" in node.span &&
        node.span.so === check.site.start
      )
        Reflect.deleteProperty(node, "requireExisting");
      pending.push(...Object.values(node));
    }
    return copy;
  };
  const dropped = <T extends { readonly answers: Answers; readonly result: StopRun["result"] }>(
    each: T,
    checks = true,
  ): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.filter((x) => !checks || JSON.stringify(x) !== text),
    },
    result: { ...each.result, plan: unguarded(each.result.plan) },
  });
  assert.ok(
    judge({
      ...dropped(stopped),
      without: (omit, key) => dropped(stopped.without(omit, key)),
    }).includes(`lost check ${text}`),
  );
  // (the guard alone: a plan change at the store whose mark owes the reference's own check there is a plan problem, never
  // that mark's content. The plain gate declines the stopped compile, and the reference's too, its decision stopping in
  // the restarted pass, #2080 part 2: each side is its own analysis, the reference's owing the check, with the natural
  // run's plan, each rerun likewise; equal as built, and the store's guard, `requireExisting`, toggled in the stopped
  // plan is a plan problem)
  assert.deepEqual([reference.result.plan, declineOf(reference)], [null, UNDECIDED]);
  const naturalRun = heldRun(o, mode);
  assert.ok(naturalRun.result.plan !== null);
  const built: StopRun = {
    ...stopped,
    result: naturalRun.result,
    without: (omit, key) => ({
      ...stopped.without(omit, key),
      result: naturalRun.without(omit, `${key} naturalRun`).result,
    }),
  };
  const builtReference: StopRun = {
    ...reference,
    result: naturalRun.result,
    without: (omit, key) => ({
      ...reference.without(omit, key),
      result: naturalRun.without(omit, `${key} naturalRun`).result,
    }),
  };
  const judgeAgainstNatural = (run: StopRun): string[] =>
    stopProblems({ unstopped: builtReference, stopped: run, fitting: [], violating: [] });
  assert.deepEqual(judgeAgainstNatural(built), []);
  let toggled = 0;
  const toggle = (plan: StopRun["result"]["plan"]): StopRun["result"]["plan"] => {
    const copy = structuredClone(plan);
    const pending: unknown[] = [copy];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || typeof node !== "object") continue;
      if (
        "kind" in node &&
        node.kind === "assign" &&
        "span" in node &&
        typeof node.span === "object" &&
        node.span !== null &&
        "so" in node.span &&
        node.span.so === check.site.start
      ) {
        if ("requireExisting" in node) Reflect.deleteProperty(node, "requireExisting");
        else Reflect.set(node, "requireExisting", true);
        toggled += 1;
      }
      pending.push(...Object.values(node));
    }
    return copy;
  };
  const guardChanged = <T extends { readonly result: StopRun["result"] }>(each: T): T => ({
    ...each,
    result: { ...each.result, plan: toggle(each.result.plan) },
  });
  assert.ok(
    judgeAgainstNatural({
      ...guardChanged(built),
      without: (omit, key) => guardChanged(built.without(omit, key)),
    }).some((problem) => problem.startsWith("plan ")),
  );
  assert.ok(toggled > 0);
  // (a further copy of the owned check where a run publishes it is an extra: what forms with the marks credits no content
  // a record owns, Codex r3's control on #1663)
  const again = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some((x) => JSON.stringify(x) === text)
        ? [...each.answers.checks, structuredClone(check)]
        : each.answers.checks,
    },
  });
  assert.ok(
    judge({
      ...again(stopped),
      without: (omit, key) => again(stopped.without(omit, key)),
    }).includes(`extra check ${text}`),
  );
  // (the reference's own check is one count of its content too: a reference that loses it has a lost check, Codex r6's
  // control on #1663)
  const lacking = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.filter((x) => JSON.stringify(x) !== text),
    },
  });
  assert.ok(
    stopProblems({
      unstopped: {
        ...lacking(reference),
        without: (omit, key) => lacking(reference.without(omit, key)),
      },
      stopped,
      fitting: [],
      violating: [],
    }).includes(`lost check ${text}`),
  );
  // (a check the stopped run alone owns, which the reference neither owns nor publishes, takes no count from what forms
  // with the marks: a further copy of it is an extra; the natural reference, forward, a stop at program allowance 1)
  const natural0 = heldRun(o, HELD_MODES[0]!);
  const early0 = heldRun(o, HELD_MODES[0]!, 1);
  const [own0] = early0.answers.budget.deferred.filter(
    (mark) => mark.code === "TSV043" && plain.slice(mark.site.start, mark.site.end) === "box.k",
  );
  assert.ok(own0 !== undefined);
  const owned0 = JSON.stringify(own0.obligation);
  assert.ok(!natural0.answers.checks.some((x) => JSON.stringify(x) === owned0));
  assert.ok(early0.answers.checks.some((x) => JSON.stringify(x) === owned0));
  assert.deepEqual([early0.result.plan, declineOf(early0)], [null, UNDECIDED]);
  const once0 = (run: StopRun): string[] =>
    stopProblems({ unstopped: natural0, stopped: run, fitting: [], violating: [] }).filter(
      (problem) => problem !== "no plan",
    );
  assert.deepEqual(once0(early0), []);
  const again0 = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some((x) => JSON.stringify(x) === owned0)
        ? [...each.answers.checks, structuredClone(own0.obligation)]
        : each.answers.checks,
    },
  });
  assert.ok(
    once0({
      ...again0(early0),
      without: (omit, key) => again0(early0.without(omit, key)),
    }).includes(`extra check ${owned0}`),
  );
  // (and a further copy of a boundary that forms only with the marks, #1448's, is an extra: what forms takes one credit,
  // Codex r4's control on #1663, forward with the sharing, a settled walk stop at program allowance 1,200: the boundary
  // forms there on main and with #1323, whose natural total is lower)
  const formedCase: HeldCase = {
    name: "formed-boundary",
    source:
      'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\nrepeat root.f0 {say "ok"}\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const plainRun = heldRun(formedCase, HELD_MODES[0]!);
  const walked = heldRun(formedCase, HELD_MODES[0]!, 1200);
  const isBoundary = (x: Answers["checks"][number]): boolean =>
    x.boundary &&
    x.target === "root" &&
    formedCase.source.slice(x.site.start, x.site.end) === "hostValue";
  assert.equal(plainRun.answers.checks.filter(isBoundary).length, 0);
  const [boundary] = walked.answers.checks.filter(isBoundary);
  assert.ok(boundary !== undefined);
  const formedJudge = (run: StopRun): string[] =>
    stopProblems({ unstopped: plainRun, stopped: run, fitting: [], violating: [] });
  assert.deepEqual(formedJudge(walked), []);
  const doubled = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some(isBoundary)
        ? [...each.answers.checks, structuredClone(boundary)]
        : each.answers.checks,
    },
  });
  assert.ok(
    formedJudge({
      ...doubled(walked),
      without: (omit, key) => doubled(walked.without(omit, key)),
    }).includes(`extra check ${JSON.stringify(boundary)}`),
  );
  // (a further copy of the boundary both runs owe, at 'hostOther', is an extra too: what forms takes no credit for a
  // content the reference owes, Codex r5's control on #1663)
  const isOwed = (x: Answers["checks"][number]): boolean =>
    x.boundary &&
    x.target === "root" &&
    formedCase.source.slice(x.site.start, x.site.end) === "hostOther";
  assert.equal(plainRun.answers.checks.filter(isOwed).length, 1);
  const [owedBoundary] = walked.answers.checks.filter(isOwed);
  assert.ok(owedBoundary !== undefined);
  const owedTwice = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some(isOwed)
        ? [...each.answers.checks, structuredClone(owedBoundary)]
        : each.answers.checks,
    },
  });
  assert.ok(
    formedJudge({
      ...owedTwice(walked),
      without: (omit, key) => owedTwice(walked.without(omit, key)),
    }).includes(`extra check ${JSON.stringify(owedBoundary)}`),
  );
  // a check one record owns and the combined stop's rule accepts is one credit: a second copy of it is an extra (Codex
  // r2's control on #1663, forward with the sharing, demand 256, a stop at program allowance 1)
  const shapes: HeldCase = {
    name: "object-shapes",
    source:
      'let boxes = [{n:1},{k:2}]\nlet box = boxes[hostValue]\nbox.n = hostOther\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const forward = HELD_MODES[0]!;
  const natural = heldRun(shapes, forward, undefined, 256);
  const early = heldRun(shapes, forward, 1, 256);
  const rule = combinedStopRule(shapes, forward, natural, early.answers);
  const excused = {
    records: new Set([...rule.records.keys(), ...rule.relabelled.records, ...rule.coarse.records]),
    checks: new Set([
      ...rule.checks.keys(),
      ...rule.owing,
      ...rule.relabelled.checks,
      ...rule.coarse.checks.keys(),
    ]),
  };
  const [owner] = early.answers.budget.deferred.filter(
    (mark) =>
      mark.code === "TSV043" && shapes.source.slice(mark.site.start, mark.site.end) === "box.n",
  );
  assert.ok(owner !== undefined);
  const owned = JSON.stringify(owner.obligation);
  assert.ok(excused.checks.has(owned));
  const twice = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: [...each.answers.checks, structuredClone(owner.obligation)],
    },
  });
  // (the plain gate declines the stopped run, #2080 part 2: its ledger is compared)
  assert.deepEqual([early.result.plan, declineOf(early)], [null, UNDECIDED]);
  const shaped = (run: StopRun): string[] =>
    stopProblems({ unstopped: natural, stopped: run, fitting: [], violating: [], excused }).filter(
      (problem) => problem !== "no plan",
    );
  assert.deepEqual(shaped(early), []);
  assert.ok(
    shaped({ ...twice(early), without: (omit, key) => twice(early.without(omit, key)) }).includes(
      `extra check ${owned}`,
    ),
  );
});
