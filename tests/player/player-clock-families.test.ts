/*
 * The scene clock's generated families: the first completion of every outcome, chains of two completions, and the
 * basis fence against a shown publication. Each covers its rows (`coverageGaps`); the single-case witnesses are in
 * `player-clock-observations.test.ts`, and the clock-work tables in `player-clock-work.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { coverageGaps, product } from "../helpers/family-coverage.js";
import type { ClockTicket } from "../../player/runtime/clock-ticket.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import { untypedClient } from "../helpers/bridge/untyped.js";
import { observeOnHost, settle, asShown, mountClock } from "../helpers/player/clock-host.js";

const FIRST_COMPLETION_AXES = {
  outcome: [
    "success",
    "recovery",
    "explicit rejection",
    "basis refused twice",
    "retirement",
    "hold",
    "disposal",
    "loss",
  ],
  skipped: ["periodic", "joined"],
  deadline: ["yes", "no"],
  media: ["on", "off"],
} as const;
// Both admission classes can wait behind a real bridge section, for every completion and media/deadline state.
function firstCompletionInfeasible(_row: Readonly<Record<string, string>>): string | null {
  return null;
}
const firstCompletionRows = product(FIRST_COMPLETION_AXES).filter(
  (row) => firstCompletionInfeasible(row) === null,
);
const firstCompletionRegistered: Readonly<Record<string, string>>[] = [];
for (const row of firstCompletionRows) {
  firstCompletionRegistered.push(row);
  test(`a first completion of every outcome ends as written: a due deadline observed, a future one pending, a hold held, an end ended: ${Object.values(row).join("; ")}`, async (context) => {
    const player = await mountClock(context, row.media === "on");
    let open!: () => void;
    const waiting = new Promise<void>((resolve) => (open = resolve));
    const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => waiting);
    let observed: Promise<unknown>;
    if (row.outcome === "recovery") {
      player.clock.before("pageHide");
      observed = Promise.resolve();
    } else observed = player.clock.observe().catch(() => null);
    if (row.skipped === "joined") player.clock.before("pageHide");
    else player.clock.catchUp();
    if (row.deadline === "yes") await player.advance(20);
    if (["recovery", "explicit rejection", "retirement"].includes(row.outcome!))
      player.gate.refuse("observeTime", row.outcome === "retirement" ? 2 : 1, "shape");
    if (row.outcome === "basis refused twice") player.gate.refuse("observeTime", 2, "basis");
    if (row.outcome === "retirement")
      observed = Promise.all([observed, player.clock.observe().catch(() => null)]);
    if (row.outcome === "hold") player.paused.value = true;
    if (row.outcome === "disposal") {
      player.clockScope.stop();
      player.stopSampling();
    }
    if (row.outcome === "loss") {
      untypedClient(player.bridge.client).terminate();
      player.stopSampling();
    }
    const from = player.attempts.length;
    open();
    await earlier;
    await observed;
    await settle(30);
    if (row.deadline === "no") {
      // No newly due work: the release may re-arm the existing future deadline, but must not send now.
      const expectedInitialAttempts =
        row.outcome === "basis refused twice" || row.outcome === "retirement"
          ? 2
          : ["hold", "disposal"].includes(row.outcome!)
            ? 0
            : 1;
      assert.equal(player.attempts.length - from, expectedInitialAttempts);
      assert.equal(player.shown.value?.state.foregroundAction?.kind, "delay");
    }
    if (row.outcome === "hold") {
      const armed = player.timeouts.armed;
      await player.advance(50);
      assert.equal(player.timeouts.armed, armed, "held release does not re-arm repeatedly");
      assert.equal(player.shown.value?.state.foregroundAction?.kind, "delay");
      player.paused.value = false;
      await settle();
    }
    if (row.deadline === "yes") {
      await player.advance(30);
      if (["disposal", "loss"].includes(row.outcome!)) {
        assert.equal(
          player.shown.value?.state.foregroundAction?.kind,
          "delay",
          "no observation after disposal/loss",
        );
        const attempts = player.attempts.length;
        const armed = player.timeouts.armed;
        await player.advance(100);
        assert.equal(player.attempts.length, attempts, "no loss or disposal loop");
        assert.equal(player.timeouts.armed, armed, "no re-arm loop");
      } else {
        const action = player.shown.value?.state.foregroundAction;
        assert.equal(action?.kind, "interaction", "source work after the deadline is reached");
        assert.equal(
          action?.kind === "interaction"
            ? action.ui?.kind === "button"
              ? action.ui.buttonLabel
              : null
            : null,
          "Done",
        );
      }
    }
  });
}
test("the first-completion family covers every declared row", () => {
  assert.equal(firstCompletionRows.length, 64);
  assert.deepEqual(
    coverageGaps(firstCompletionRows, firstCompletionRegistered, { tuples: true }),
    [],
  );
});

// The completion chains: the first completion and its successor's both vary; later completions succeed.
const CHAIN_AXES = {
  first: [
    "publish",
    "recovery",
    "explicit rejection",
    "basis",
    "retirement",
    "hold",
    "disposal",
    "loss",
    "replacement",
  ],
  second: [
    "publish",
    "recovery",
    "basis",
    "retirement",
    "hold",
    "disposal",
    "loss",
    "replacement",
    "none",
  ],
  consumed: ["periodic", "joined"],
  deadline: ["due", "pending"],
  media: ["on", "off"],
} as const;
const chainTerminal = (outcome: string) => ["disposal", "loss", "replacement"].includes(outcome);
/** Whether the chain's second observation is the clock's own and the host refuses its basis twice, unchanged. */
const chainParks = (row: Readonly<Record<string, string>>) =>
  !chainTerminal(row.first!) && row.first !== "retirement" && row.second === "basis";
function chainInfeasible(row: Readonly<Record<string, string>>): string | null {
  if (chainTerminal(row.first!))
    return row.second === "none"
      ? null
      : "the first completion ends ownership; this chain has no second token";
  return row.second === "none"
    ? "the live two-wait source retains a due or future deadline, so the chain must continue"
    : null;
}
const chainRows = product(CHAIN_AXES).filter((row) => chainInfeasible(row) === null);
const chainRegistered: Readonly<Record<string, string>>[] = [];
for (const row of chainRows) {
  chainRegistered.push(row);
  test(`a chain of two completions leaves the deadline observed, parked or ended as written: ${Object.values(row).join("; ")}`, async (context) => {
    const player = await mountClock(
      context,
      row.media === "on",
      'wait 10 ms\nwait 30 ms\nshowButton "Done"\nexit',
    );
    player.stopSampling(); // Samples remain available; no interval can rescue a lost deadline.
    let next =
      row.first === "replacement" || row.second === "replacement"
        ? await player.bridge.start(player.shown.value!.planToken, {}, false)
        : null;
    if (next !== null && row.media === "on") {
      await player.bridge.request(next, "reportMediaLoad", {
        mediaId: 1,
        report: { kind: "loaded", durationMs: 10000 },
      });
      next = player.bridge.latest(next)!;
    }
    let open!: () => void;
    const held = new Promise<void>((resolve) => (open = resolve));
    const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => held);
    const client = untypedClient(player.bridge.client);
    const section = client.section.bind(client);
    let entered = 0,
      refusals = 0;
    let ended: string | null = null;
    const explicit: Promise<unknown>[] = [];
    context.mock.method(
      client,
      "section",
      (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
        section(id, ticket, async (send) => {
          if (id !== player.bridge.latest(asShown(player.initial))!.id) return body(send);
          const index = ++entered;
          const outcome = index === 1 ? row.first : index === 2 ? row.second : "publish";
          if (outcome === "retirement") explicit.push(player.clock.observe().catch(() => null));
          if (outcome === "hold") {
            player.paused.value = true;
            setTimeout(() => {
              player.paused.value = false;
            }, 1);
          }
          if (outcome === "disposal") {
            ended = outcome;
            player.clockScope.stop();
          }
          if (outcome === "loss") {
            ended = outcome;
            client.terminate();
          }
          if (outcome === "replacement") {
            ended = outcome;
            assert.ok(next);
            player.shown.value = next;
          }
          return body(async (op, args, basis, onReply) => {
            const refuseBasis = op === "observeTime" && outcome === "basis";
            const refuseArgs =
              op === "observeTime" && ["recovery", "explicit rejection"].includes(outcome!);
            try {
              return await send(
                op,
                refuseArgs ? { atMs: -1, media: [] } : args,
                refuseBasis ? (basis ?? 0) + 1000 : basis,
                onReply,
              );
            } catch (error) {
              if (refuseBasis || refuseArgs) refusals++;
              throw error;
            }
          });
        }),
    );
    const observed =
      row.first === "recovery"
        ? (player.clock.before("pageHide"), Promise.resolve(null))
        : player.clock.observe().catch(() => null);
    if (row.consumed === "joined") player.clock.before("pageHide");
    else player.clock.catchUp();
    if (row.deadline === "due") await player.advance(20);
    open();
    await earlier;
    await observed;
    await settle();
    await player.advance(80);
    await Promise.all(explicit);
    const expectedRefusals = (outcome: string) =>
      outcome === "basis" ? 2 : ["recovery", "explicit rejection"].includes(outcome) ? 1 : 0;
    assert.equal(
      refusals,
      expectedRefusals(row.first!) + expectedRefusals(row.second!),
      "the declared failures reached the real host",
    );
    const kind = player.shown.value?.state.foregroundAction?.kind;
    if (ended === "disposal" || ended === "loss") {
      assert.notEqual(kind, "interaction", "terminal completion leaves no further observation");
      const attempts = player.attempts.length,
        armed = player.timeouts.armed;
      await player.advance(100);
      assert.equal(player.attempts.length, attempts, "terminal chain sends nothing more");
      assert.equal(player.timeouts.armed, armed, "terminal chain arms nothing more");
    } else if (chainParks(row)) {
      // Written expectation: the second completion is the clock's own observation (unless a retirement queued an
      // explicit one), and the host refused its basis twice with no publication since, so the clock waits for one.
      // Any other failure of it (`recovery`) is recovered and the deadline observed, as below.
      assert.notEqual(kind, "interaction", "parked on the unchanged basis");
      const sent = player.attempts.length;
      await player.advance(100);
      assert.equal(
        player.attempts.length,
        sent,
        "nothing more is sent while the basis is unchanged",
      );
      await player.clock.observe().catch(() => null);
      await player.advance(100);
      assert.equal(
        player.shown.value?.state.foregroundAction?.kind,
        "interaction",
        "a publication lifts it",
      );
    } else {
      assert.equal(kind, "interaction", "the live owned session reaches both waits' successor");
      if (ended === "replacement") assert.equal(player.shown.value?.id, next!.id);
    }
    if (chainTerminal(row.first!)) assert.equal(entered, 1, "no second token of the old session");
    else assert.ok(entered >= 2, "the successor's completion was actually exercised");
  });
}
test("the completion-chain family covers every feasible row and states why each other is excluded", () => {
  assert.equal(product(CHAIN_AXES).length, 648);
  assert.equal(chainRows.length, 408);
  assert.deepEqual(coverageGaps(chainRows, chainRegistered, { tuples: true }), []);
  const excluded = product(CHAIN_AXES).filter((row) => chainInfeasible(row) !== null);
  assert.equal(excluded.length, 240);
  for (const row of excluded) assert.ok(chainInfeasible(row));
});

/*
 * The shown-publication family (P): automatic work parks only if both sends of an automatic observation were refused on
 * their basis and the latest stored basis still equals the retry's submitted basis; a newer publication shown resumes
 * it. The page's store is left stale first by an injected failed delivery (one success reply that cannot cross), so the
 * host refuses the page's basis genuinely. A publication, applied to the store and shown, then arrives at one moment of
 * the automatic attempt, or never; the attempt's sends fail as the failure kind says, with a send that cannot cross as
 * the failure that is no refusal.
 *
 * P's provenance, one case each:
 * - a healthy retired publication, stored and not shown, whose successor shows: "a retired observation's reply
 *   publishes nothing, while the next one's waits";
 * - an injected orphaned reply: this family's precondition;
 * - a publication stored only, after the parked release: P promises no recovery from it; one existing opportunity
 *   reaches the deadline (the stored-only-publication witness in `player-clock-observations.test.ts`);
 * - a missing event segment against no gap: the store refuses a publication whose events do not continue its cursor
 *   (`player-bridge-session.test.ts`, "a store applies publications by revision and requires their events to continue
 *   its cursor"). No recovery is claimed;
 * - terminal or replaced ownership: "a session the host halted gets no more of the clock's own observations" and "an
 *   observation of a replaced session schedules nothing for the session that replaced it".
 */
const PUBLICATION_AXES = {
  moment: [
    "before first send",
    "between sends",
    "before catch",
    "between catch and release",
    "after release",
    "never",
  ],
  media: ["on", "off"],
  failure: ["two basis refusals", "a refusal, then another failure", "another failure first"],
} as const;
type PublicationRow = Readonly<Record<string, string>>;
function publicationInfeasible(row: PublicationRow): string | null {
  if (
    row.failure === "another failure first" &&
    (row.moment === "between sends" || row.moment === "before catch")
  )
    return "a first send that fails other than by its basis is not retried: there is no second send or second catch";
  return null;
}
const publicationRows = product(PUBLICATION_AXES).filter(
  (row) => publicationInfeasible(row) === null,
);
const publicationRegistered: PublicationRow[] = [];
for (const row of publicationRows) {
  publicationRegistered.push(row);
  test(`the basis fence holds only when no shown publication came after the refused basis was sent: ${Object.values(row).join("; ")}`, async (context) => {
    const player = await mountClock(context, row.media === "on");
    player.stopSampling();
    const clone = globalThis.structuredClone;
    let failedReply = 0;
    context.mock.method(
      globalThis,
      "structuredClone",
      (value: unknown, options?: StructuredSerializeOptions) => {
        const observedReply =
          typeof value === "object" &&
          value !== null &&
          "kind" in value &&
          value.kind === "reply" &&
          "ok" in value &&
          value.ok === true &&
          "result" in value &&
          typeof value.result === "object" &&
          value.result !== null &&
          "kind" in value.result &&
          value.result.kind === "observed";
        if (observedReply && failedReply === 0) {
          failedReply += 1;
          throw new Error("The success reply could not cross.");
        }
        return clone(value, options);
      },
    );
    await assert.rejects(
      player.bridge.request(asShown(player.initial), "observeTime", { atMs: 0, media: [] }),
      /could not cross/,
    );
    let published = false;
    const publish = () => {
      if (published) return;
      published = true;
      assert.equal(observeOnHost(player.shown.value!, 0, []).outcome.kind, "observed");
      player.shown.value = player.bridge.latest(asShown(player.initial))!;
    };
    const client = untypedClient(player.bridge.client);
    const section = client.section.bind(client);
    let sends = 0;
    context.mock.method(
      client,
      "section",
      (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
        section(id, ticket, async (send) => {
          const first = sends === 0;
          if (first && row.moment === "before first send") publish();
          try {
            return await body(async (op, args, basis, onReply) => {
              if (op !== "observeTime") return send(op, args, basis, onReply);
              sends += 1;
              const attempt = first ? sends : 0;
              const fails =
                (row.failure === "another failure first" && attempt === 1) ||
                (row.failure === "a refusal, then another failure" && attempt === 2);
              try {
                if (fails) throw new Error("The request could not cross.");
                return await send(op, args, basis, onReply);
              } catch (error) {
                if (attempt === 1 && row.moment === "between sends") publish();
                if (attempt === 2 && row.moment === "before catch") publish();
                throw error;
              }
            });
          } finally {
            // After the attempt's last catch, before its release, however it ended.
            if (first && row.moment === "between catch and release") publish();
          }
        }),
    );
    await player.advance(100);
    if (row.moment === "after release") {
      // Parked: the clock's own observations stopped on the refused basis, until the shown publication.
      const parked = player.attempts.length;
      await player.advance(50);
      assert.equal(player.attempts.length, parked, "nothing is sent while the basis is unchanged");
      publish();
      await player.advance(100);
    }
    const reached = player.shown.value?.state.foregroundAction?.kind;
    if (row.moment === "never") {
      // Written expectation: with no publication, the host refuses every basis the page holds; the clock parks, its
      // work bounded.
      assert.notEqual(reached, "interaction", "parked");
      const parked = player.attempts.length;
      await player.advance(100);
      assert.equal(player.attempts.length, parked, "and sends nothing more");
    } else
      assert.equal(
        reached,
        "interaction",
        "a shown publication after the refused basis lifts or prevents the fence",
      );
  });
}
test("the shown-publication family covers every feasible row and states why each other is excluded", () => {
  assert.equal(product(PUBLICATION_AXES).length, 36);
  assert.deepEqual(coverageGaps(publicationRows, publicationRegistered, { tuples: true }), []);
  const feasible = new Set(publicationRows.map((row) => JSON.stringify(row)));
  for (const row of product(PUBLICATION_AXES))
    assert.equal(feasible.has(JSON.stringify(row)), publicationInfeasible(row) === null);
  assert.equal(publicationRows.length, 32);
});
