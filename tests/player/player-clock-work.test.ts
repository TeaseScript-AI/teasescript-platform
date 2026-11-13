import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { effectScope, ref, shallowRef, type Ref, type ShallowRef } from "vue";

import type { PlayerRuntimeSession } from "../../player/runtime/runtime-adapter.js";
import { coverageGaps, product } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import { settle, mount, asShown } from "../helpers/player/clock-host.js";

/*
 * L5i.5: session work that must follow the scene clock posts what it needs into the shown session's queue first
 * (`clock.before`), so the host runs it before the work. The family drives each kind of work through its real entry
 * point, in each state of the clock, and checks the host's request log against what this file states independently of
 * the clock's table (`CLOCK_WORK`): a removed `before`, or a wrong row, fails here.
 */

// The family's axes, declared once.
/** Each kind of session work that follows the clock, by its real entry point. */
const WORK = ["debugMode", "randomControl", "keepCapture", "pageHide", "audioEnded"] as const;
/** The clock's state when the work comes. */
const STATES = [
  "idle",
  "catch-up begun",
  "catch-up stepped",
  "observation in flight",
  "held",
] as const;
type Work = (typeof WORK)[number];
type State = (typeof STATES)[number];

/**
 * The oracle, stated here and not read from the clock: what each kind of work needs before it, `settle` (a catch-up
 * under way finishes first, as one observation) or `observe` (an observation now, also when idle).
 */
const NEEDS: Readonly<Record<Work, "settle" | "observe">> = {
  debugMode: "settle",
  randomControl: "settle",
  keepCapture: "observe",
  pageHide: "observe",
  audioEnded: "observe",
};
/** The work's own op, which comes after what it needs; `null` for an opportunity that only observes. */
const OWN_OP: Readonly<Record<Work, string | null>> = {
  debugMode: "setDebugMode",
  randomControl: "randomControl",
  keepCapture: "captureKeep",
  pageHide: null,
  audioEnded: null,
};

/**
 * The clock's ops (`dropCatchUp`, `observeTime`) and the work's own op the host receives from the work's trigger on,
 * exactly, in order, as the oracle derives them. The oracle checks nothing else the trigger causes: turning Debug mode
 * on in the normal room also keeps the session for its debug-room copy (`captureKeep`), which is the debug room's work,
 * not the clock's.
 */
function expected(work: Work, state: State): string[] {
  const own = OWN_OP[work] === null ? [] : [OWN_OP[work]];
  // Held (a waiting draw), nothing is observed; and Debug mode reaches a session only while it runs or waits for
  // input, as today, so it goes to the host once the draw is decided.
  if (state === "held") return work === "debugMode" ? [] : own;
  const catchingUp = state === "catch-up begun" || state === "catch-up stepped";
  const observes = NEEDS[work] === "observe" || catchingUp;
  // An observation drops the catch-up under way first.
  return [
    ...(observes && catchingUp ? ["dropCatchUp"] : []),
    ...(observes ? ["observeTime"] : []),
    ...own,
  ];
}

const CASES = WORK.flatMap((work) =>
  STATES.map((state) => ({ work, state, name: `${work}; ${state}` })),
);

/** The kinds of work the clock's own type declares (`ClockWork` in `useRuntimeSceneClock.ts`). */
function declaredWork(): string[] {
  const path = new URL("../../../player/vue/src/session/useRuntimeSceneClock.ts", import.meta.url);
  const file = ts.createSourceFile(
    "clock.ts",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "ClockWork",
  );
  assert.ok(declaration && ts.isUnionTypeNode(declaration.type), "ClockWork is a union of names");
  return declaration.type.types.map((member) => {
    assert.ok(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal));
    return member.literal.text;
  });
}

type Mounted = Awaited<ReturnType<typeof mount>>;

/** Puts the clock in `state`. */
async function enter(player: Mounted, state: State) {
  if (state === "idle" || state === "held") return;
  if (state === "observation in flight") {
    player.gate.hold("observeTime");
    void player.host.observe();
    await settle();
    return;
  }
  // A late observation begins a catch-up; it stays begun while its first reply waits, or stepped while its second does.
  if (state === "catch-up begun") player.gate.hold("beginCatchUp");
  else player.gate.hold("stepCatchUp", 2);
  player.late(1_000);
  await settle();
}

/** Triggers `work` through its real entry point. */
function trigger(player: Mounted, work: Work) {
  switch (work) {
    case "debugMode":
      return player.host.setDebugMode(true);
    case "randomControl":
      return player.host.setRandomControl({ sites: [] });
    case "keepCapture":
      return player.hide();
    case "pageHide":
      return void window.dispatchEvent(new Event("pagehide"));
    case "audioEnded": {
      const element = player.elements.at(-1);
      assert.ok(element, "the cue has an element");
      return void element.dispatchEvent(new Event("ended"));
    }
  }
}

/** The `(work, state)` coordinates registered as clock-work cases below. */
const registeredCases: { work: string; state: string }[] = [];
for (const { work, state, name } of CASES) {
  registeredCases.push({ work, state });
  test(`the clock comes before session work: ${name}`, async (context) => {
    const player = await mount(context, state === "held");
    if (state === "held")
      assert.notEqual(player.host.session.value?.state.randomDraw, null, "a draw waits");
    await enter(player, state);
    const from = player.posts.length;
    const atTrigger = player.observedMs();
    trigger(player, work);
    await settle();
    player.gate.release();
    await settle(40);
    const own = OWN_OP[work];
    // What `expected` counts, and only that (see there).
    const counted = new Set(["dropCatchUp", "observeTime", ...(own === null ? [] : [own])]);
    const after = player.posts
      .slice(from)
      .map((post) => post.op)
      .filter((op) => counted.has(op));
    assert.deepEqual(after, expected(work, state), name);
    const want = expected(work, state);
    // The work sees the observed time: with an observation before it, its op goes out after the observation applied.
    if (own !== null && want.includes("observeTime")) {
      const post = player.posts.slice(from).find((each) => each.op === own)!;
      assert.ok((post.atMs ?? 0) > (atTrigger ?? 0), `${name}: the work follows the observation`);
    }
  });
}

test("the clock-work family covers every kind of work in every state of the clock", () => {
  // The axis is the clock's own domain: a kind of work the clock gains needs its row here.
  assert.deepEqual([...WORK].sort(), declaredWork().sort());
  const feasible = product({ work: [...WORK], state: [...STATES] });
  // The coordinates the loop above registered as cases, not the list it reads.
  const observed = registeredCases;
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  const lacking = observed.filter(
    (each) => !(each.work === "keepCapture" && each.state === "held"),
  );
  assert.ok(coverageGaps(feasible, lacking, { tuples: true }).length > 0);
});

test("a kind of work the clock's table does not hold throws, whatever the clock's state", async (context) => {
  const player = await mount(context, false);
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/useRuntimeSceneClock.ts",
  );
  assert.equal(typeof module.useRuntimeSceneClock, "function");
  // EVIDENCE: validation: the bundle's clock, checked callable above; `before` is its policy entry.
  const useClock = module.useRuntimeSceneClock as (
    session: ShallowRef<PlayerRuntimeSession | null>,
    reports: () => readonly [],
    paused: Ref<boolean>,
  ) => { before(work: string): void };
  for (const paused of [false, true])
    for (const shown of [null, player.host.session.value]) {
      const scope = effectScope();
      const clock = scope.run(() => useClock(shallowRef(shown), () => [], ref(paused)))!;
      try {
        // An inherited name is no member either.
        for (const work of ["nope", "toString"])
          assert.throws(() => clock.before(work), /No clock work/u, `${work}, paused ${paused}`);
      } finally {
        scope.stop();
      }
    }
});

// #1983: `clock.section` opens its section under a `SECTION_WORK` row and observes what that row needs at the turn,
// before its body. Exclusions, decided where named: which row a sender names is visible at its call site and reviewed;
// that `runInput`'s target check, intent and tab run after the observation's reply is `player-runtime-input.test.ts`
// ("a blocked tab posts no answer…"); that a service's delivery settles its answer on a `null` observation is
// `player-session-camera.test.ts` ("a capture whose section finds its session retired…").

/** Each kind of section work, as the clock's table names it. */
const SECTION_ROWS = [
  "inputAnswer",
  "inputDraft",
  "storageEdit",
  "storageWriteDone",
  "service",
  "mediaLoadObserved",
  "mediaLoad",
] as const;
type SectionRow = (typeof SECTION_ROWS)[number];
/** The oracle, stated here and not read from the clock: the op each row observes with, or none. */
const ROW_OBSERVES: Readonly<Record<SectionRow, "observeInput" | "observeTime" | null>> = {
  inputAnswer: "observeInput",
  inputDraft: null,
  storageEdit: null,
  storageWriteDone: null,
  service: "observeTime",
  mediaLoadObserved: "observeTime",
  mediaLoad: null,
};
/**
 * What holds at the section's turn: its session owned and shown; the clock held (an inspected state, a waiting draw);
 * its ownership retired; or its observation refused for its basis, which only the media rows' delivery recovers from
 * (it keeps the reports for the next publication), so only they have it.
 */
const SECTION_STATES = ["owned", "held", "retired", "basis refused"] as const;
type SectionState = (typeof SECTION_STATES)[number];
const SECTION_CASES = SECTION_ROWS.flatMap((row) =>
  SECTION_STATES.filter((state) => state !== "basis refused" || row.startsWith("mediaLoad")).map(
    (state) => ({ row, state, name: `${row}; ${state}` }),
  ),
);

/** What the oracle derives for a row and state: the clock's posts, and the observation the body receives. */
function sectionExpected(row: SectionRow, state: SectionState) {
  const op = ROW_OBSERVES[row];
  const observes = op !== null && (state === "owned" || state === "basis refused");
  return {
    // A refused observation is attempted, but never reaches the host.
    posts: observes && state === "owned" ? [op] : [],
    samples: observes ? 1 : 0,
    // The refusal rejects the section before its body.
    body: !(observes && state === "basis refused"),
    observed: op !== null && state === "retired" ? ("none" as const) : ("section's" as const),
  };
}

/** The keys of the clock's `SECTION_WORK` table, read from its source. */
function declaredSectionWork(): string[] {
  const path = new URL("../../../player/vue/src/session/useRuntimeSceneClock.ts", import.meta.url);
  const file = ts.createSourceFile(
    "clock.ts",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let keys: string[] | undefined;
  file.forEachChild(function visit(node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "SECTION_WORK")
      node.forEachChild(function find(inner): void {
        if (ts.isObjectLiteralExpression(inner))
          keys ??= inner.properties.map((property) => property.name?.getText(file) ?? "");
        else inner.forEachChild(find);
      });
    else node.forEachChild(visit);
  });
  assert.ok(keys, "the clock has its section table");
  return keys;
}

interface SectionClock {
  section<T>(
    work: string,
    current: PlayerRuntimeSession,
    owned: () => boolean,
    body: (
      section: { readonly session: PlayerRuntimeSession },
      observed: PlayerRuntimeSession | null,
    ) => Promise<T>,
  ): Promise<T>;
}
/** A clock of the bundle over `shown`, with its media samples counted and its hold in the test's hand. */
async function sectionClock(context: TestContext, shown: PlayerRuntimeSession) {
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/useRuntimeSceneClock.ts",
  );
  assert.equal(typeof module.useRuntimeSceneClock, "function");
  // EVIDENCE: validation: the bundle's clock, checked callable above; `section` is its section entry.
  const useClock = module.useRuntimeSceneClock as (
    session: ShallowRef<PlayerRuntimeSession | null>,
    reports: () => readonly [],
    paused: Ref<boolean>,
  ) => SectionClock;
  const paused = ref(false);
  const sampled = { count: 0 };
  const scope = effectScope();
  const clock = scope.run(() =>
    useClock(
      shallowRef(shown),
      () => {
        sampled.count += 1;
        return [];
      },
      paused,
    ),
  )!;
  context.after(() => scope.stop());
  return { clock, paused, sampled };
}

/** The `(row, state)` coordinates registered as section cases below. */
const registeredSections: { row: string; state: string }[] = [];
for (const { row, state, name } of SECTION_CASES) {
  registeredSections.push({ row, state });
  test(`the clock opens a section under its row, observing at its turn: ${name}`, async (context) => {
    const player = await mount(context, false);
    const bridge = await player.host.bridge;
    const shown = player.host.session.value!;
    const { clock, paused, sampled } = await sectionClock(context, shown);
    // An earlier section holds the session's queue, so this one waits for its turn.
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    // EVIDENCE: fixture: the shown session is a publication of this bridge.
    const earlier = bridge.section(asShown(shown), clockTicket(), () => opened);
    let owned = true;
    if (state === "basis refused") player.gate.refuse(ROW_OBSERVES[row]!, 1, "basis");
    const from = { posts: player.posts.length, attempts: player.attempts.length };
    const clockOps = new Set(["observeTime", "observeInput", "dropCatchUp"]);
    const posted = () =>
      player.posts
        .slice(from.posts)
        .map((post) => post.op)
        .filter((op) => clockOps.has(op));
    const reached: {
      body: {
        readonly posts: number;
        readonly observed: PlayerRuntimeSession | null;
        readonly session: PlayerRuntimeSession;
      } | null;
    } = { body: null };
    const done = clock
      .section(
        row,
        shown,
        () => owned,
        async (section, observed) => {
          reached.body = { posts: posted().length, observed, session: section.session };
        },
      )
      .then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    await settle();
    assert.equal(sampled.count, 0, "nothing is sampled before the section's turn");
    assert.deepEqual(posted(), [], "nothing is posted before the section's turn");
    if (state === "held") paused.value = true;
    if (state === "retired") owned = false;
    open();
    await earlier;
    const outcome = await done;
    await settle();
    const want = sectionExpected(row, state);
    assert.deepEqual(posted(), want.posts, `${name}: posts`);
    assert.equal(sampled.count, want.samples, `${name}: media samples, taken at the turn`);
    if (!want.body) {
      assert.equal(reached.body, null, `${name}: the body does not run`);
      assert.notEqual(outcome, "resolved");
      assert.deepEqual(player.attempts.slice(from.attempts), [ROW_OBSERVES[row]]);
      return;
    }
    assert.equal(outcome, "resolved");
    const body = reached.body;
    assert.ok(body, `${name}: the body runs`);
    assert.equal(body.posts, want.posts.length, `${name}: the observation precedes the body`);
    assert.equal(
      body.observed,
      want.observed === "none" ? null : body.session,
      `${name}: the observation`,
    );
  });
}

test("the section-work family covers every row in each state its turn can have", () => {
  // The coordinates the loop above registered as cases, not the list it reads.
  assert.deepEqual([...SECTION_ROWS].sort(), declaredSectionWork().sort());
  const feasible = [
    ...product({ row: [...SECTION_ROWS], state: ["owned", "held", "retired"] }),
    ...product({ row: ["mediaLoadObserved", "mediaLoad"], state: ["basis refused"] }),
  ];
  const observed = registeredSections;
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  const lacking = observed.filter((each) => !(each.row === "service" && each.state === "held"));
  assert.ok(coverageGaps(feasible, lacking, { tuples: true }).length > 0);
});

test("a kind of section work the clock's table does not hold throws, and opens nothing", async (context) => {
  const player = await mount(context, false);
  const shown = player.host.session.value!;
  const { clock } = await sectionClock(context, shown);
  const from = player.attempts.length;
  for (const work of ["nope", "toString"])
    assert.throws(
      () =>
        clock.section(
          work,
          shown,
          () => true,
          async () => {},
        ),
      /No section work/u,
      work,
    );
  await settle();
  assert.deepEqual(player.attempts.slice(from), []);
});

for (const work of ["randomControl", "debugMode"] as const)
  test(`a setting change follows an observation of its time when a late opportunity comes behind a waiting one: ${work}`, async (context) => {
    const player = await mount(context, false);
    const bridge = await player.host.bridge;
    const shown = player.host.session.value!;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const earlier = bridge.section(asShown(shown), clockTicket(), () => opened);
    const from = player.posts.length;
    window.dispatchEvent(new Event("pagehide"));
    player.late(1000);
    trigger(player, work);
    open();
    await earlier;
    await settle(60);
    const posts = player.posts.slice(from);
    assert.equal(
      posts.some((p) => p.op === "beginCatchUp"),
      false,
      "no catch-up begins behind the waiting observation",
    );
    const changed = posts.find((p) => p.op === OWN_OP[work]);
    assert.ok(changed && (changed.atMs ?? 0) >= 1000, "work follows observation of its time");
  });
