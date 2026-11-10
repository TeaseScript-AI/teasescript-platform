import assert from "node:assert/strict";
import test from "node:test";

import { deliveryOwner, type Delivery } from "../../player/engine-bridge/delivery.js";
import type {
  CloseReason,
  HistoryCore,
  HistoryObservation,
} from "../../player/engine-bridge/history/core.js";
import { HistoryRegistry } from "../../player/engine-bridge/history/registry.js";
import type { DebugHistorySpill } from "../../player/engine-bridge/history/snapshots.js";
import type { HistoryMarks } from "../../player/debug/debug-history-marks.js";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import {
  observePlayerRuntimeTime,
  playerRuntimeSnapshotJson,
  selectPlayerRuntimeChoice,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { playerRuntimeForeground } from "../../player/runtime/runtime-view.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { INSPECTION, RULES, type Inspection } from "../helpers/player/rewind-transfer-domain.js";

/*
 * The lifetimes of a rewind history's resources (`player/engine-bridge/history/core.ts`, through its registry, which
 * owns the candidates and the deliveries' undos): each resource, made by each observation that makes one, meets each
 * end in each inspection state it can meet it in. A reference model of the history at the level of its resources says
 * what stays; public state shows what did: the points (`timeline()`), the snapshots held (`memoryChars`, `snapshot(id)`
 * refusing a released ID, the spill fake's rows), the pending step, the lineages released and followed, collection, and
 * the close. Which lineages a close, a Return and an adoption transfer comes from the declared transfer domain
 * (`helpers/player/rewind-transfer-domain.ts`).
 */

const AXES = {
  /**
   * The points and their snapshots; a committed step's restored lineage, shown; the lineage the history follows; a
   * prepared, uncommitted step with its candidate; the first Back's saved state; a snapshot written to the spill.
   */
  resource: [
    "points",
    "candidate",
    "live lineage",
    "pending step",
    "reservation",
    "spilled snapshot",
  ],
  maker: ["publication", "enrollCurrent", "back", "forward", "return", "adoption"],
  end: [
    "replace",
    "closeAll disposal",
    "close by debugOff",
    "close by replacement",
    "close by import",
    "close by clear",
    "close by disposal",
    "spill failure",
    "budget overrun",
    "delivery abort",
    "stop",
    "return",
    "adoption",
  ],
  inspection: INSPECTION,
} as const;
type Case = { readonly [Axis in keyof typeof AXES]: (typeof AXES)[Axis][number] };

const MAKERS: Readonly<Record<Case["resource"], readonly Case["maker"][]>> = {
  points: ["publication", "enrollCurrent"],
  candidate: ["back", "forward"],
  "live lineage": ["publication", "enrollCurrent", "return", "adoption"],
  "pending step": ["back", "forward"],
  reservation: ["back"],
  "spilled snapshot": ["publication", "back"],
};

/** Why a tuple is no case, or `null` for a feasible one. */
function infeasible({ resource, maker, end, inspection }: Case): string | null {
  if (!MAKERS[resource].includes(maker)) return `${maker} makes no ${resource}`;
  if (resource === "candidate" && inspection === "not inspecting")
    return "a committed candidate is the restored state shown";
  if (resource === "candidate" && maker === "back" && inspection === "inspecting without a future")
    return "a Back leaves a future";
  if (resource === "pending step" && inspection === "adopting")
    return "no step is prepared while adopting";
  if (
    resource === "pending step" &&
    maker === "forward" &&
    inspection !== "inspecting with a future"
  )
    return "Forward needs a future";
  if (end === "budget overrun" && inspection !== "not inspecting")
    return "no point is taken while a restored state is inspected";
  if (end === "delivery abort") {
    if (maker === "enrollCurrent" || maker === "return" || maker === "adoption")
      return "an enrollment, a Return and an adoption own no undo";
    if (maker === "publication" && inspection !== "not inspecting")
      return "a step changed the history after the publication: its undo's guard is the core test's";
    if (resource !== "pending step" && inspection !== "not inspecting")
      return "the step was committed, after its preparation's reply was posted";
  }
  return null;
}

function asCase(coordinates: Coordinates): Case {
  // EVIDENCE: invariant: `product` gives the declared axes' values.
  return coordinates as Case;
}
const FEASIBLE = product(AXES).filter((coordinates) => infeasible(asCase(coordinates)) === null);

// The session the history follows: four asks, each a point when it is newly presented.
const SCRIPT =
  'let a = askChoice "A1", "A2"\nwait 1 s\nlet b = askChoice "B1", "B2"\nwait 1 s\nlet c = askChoice "C1", "C2"\nwait 1 s\nlet d = askChoice "D1", "D2"\nexit';
const PLAN = compilePlayerProject(SCRIPT).plan!;
const NO_MARKS: HistoryMarks = { editedWhileDebugging: null, rewoundWhileDebugging: null };
const LIVE = "s1";

function choose(session: PlayerRuntimeSession, index = 0): PlayerRuntimeSession {
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  return selectPlayerRuntimeChoice(session, foreground.options[index]!.id)!.session;
}
/** Each publication after the first, from the one before: the answers and the waits between the asks. */
const CHAIN: readonly ((session: PlayerRuntimeSession) => PlayerRuntimeSession)[] = [
  (session) => choose(session),
  (session) => observePlayerRuntimeTime(session, 1_000).session,
  (session) => choose(session, 1),
  (session) => observePlayerRuntimeTime(session, 2_000).session,
  (session) => choose(session),
  (session) => observePlayerRuntimeTime(session, 3_000).session,
];
/** The publications that present a new ask: A, B, C, and D, which only a budget overrun publishes. */
const PRESENTS = new Set([0, 2, 4, 6]);
/** Each publication's snapshot length, which the model counts. */
const CHARS: readonly number[] = (() => {
  let session = createPlayerRuntimeSession(PLAN);
  const lengths = [playerRuntimeSnapshotJson(session).length];
  for (const next of CHAIN) {
    session = next(session);
    lengths.push(playerRuntimeSnapshotJson(session).length);
  }
  return lengths;
})();

/** What the arrangement does: publish or enroll the next session, step, Return or adopt. */
type Action =
  | { readonly do: "publish" | "enroll" | "return" | "adoptBegun" | "adoptEnded" }
  | { readonly do: "back"; readonly to: number; readonly commit: boolean }
  | { readonly do: "forward"; readonly commit: boolean };

const publish: Action = { do: "publish" };
const back = (to: number, commit = true): Action => ({ do: "back", to, commit });
const forward = (commit = true): Action => ({ do: "forward", commit });

/** The actions that make the case's resource and reach its inspection state; a step that makes it comes last. */
function arrangement({ resource, maker, inspection }: Case): Action[] {
  const made: Action[] =
    maker === "enrollCurrent"
      ? [{ do: "enroll" }, publish, publish, publish, publish]
      : [publish, publish, publish, publish, publish];
  if (maker === "return") made.push(back(1), { do: "return" });
  // The state Forward left is adopted: every point stays, and the first Back's saved state goes.
  if (maker === "adoption")
    made.push(back(1), forward(), { do: "adoptBegun" }, { do: "adoptEnded" });
  const steps: Record<Inspection, Action[]> =
    resource === "candidate" && maker === "forward"
      ? {
          "not inspecting": [],
          "inspecting with a future": [back(1), back(0), forward()],
          "inspecting without a future": [back(1), forward()],
          adopting: [back(1), forward(), { do: "adoptBegun" }],
        }
      : resource === "pending step"
        ? {
            "not inspecting": [back(1, false)],
            "inspecting with a future":
              maker === "forward" ? [back(1), forward(false)] : [back(1), back(0, false)],
            "inspecting without a future": [back(1), forward(), back(0, false)],
            adopting: [],
          }
        : {
            "not inspecting": maker === "back" ? [back(1, false)] : [],
            "inspecting with a future": [back(1)],
            "inspecting without a future": [back(1), forward()],
            adopting: [back(1), { do: "adoptBegun" }],
          };
  return [...made, ...steps[inspection]];
}

/** A spill store held in a map, whose writes succeed, or wait until `fail` rejects them. */
class FakeSpill implements DebugHistorySpill {
  readonly rows = new Map<number, string>();
  destroyed = false;
  readonly #failing: PromiseWithResolvers<void> | null;

  constructor(failing: boolean) {
    this.#failing = failing ? Promise.withResolvers<void>() : null;
  }
  get failing(): boolean {
    return this.#failing !== null;
  }
  put(id: number, json: string): Promise<void> {
    if (this.#failing !== null) return this.#failing.promise;
    this.rows.set(id, json);
    return Promise.resolve();
  }
  fail(): void {
    this.#failing!.reject(new DOMException("full", "QuotaExceededError"));
  }
  get(id: number): Promise<string | undefined> {
    return Promise.resolve(this.rows.get(id));
  }
  delete(ids: readonly number[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
    return Promise.resolve();
  }
  destroy(): Promise<void> {
    this.destroyed = true;
    this.rows.clear();
    return Promise.resolve();
  }
}

/*
 * The reference model: the history's resources as the arrangement and the end leave them. A point and the first Back's
 * saved state each take the next ID; a lineage key names its own host session.
 */
interface Held {
  readonly id: number;
  readonly chars: number;
}
interface Inspected {
  readonly parked: string;
  shown: string;
  shownId: number;
  points: number;
  readonly forward: { readonly id: number; readonly points: number }[];
  adopting: boolean;
}
interface Model {
  published: number;
  nextId: number;
  candidates: number;
  points: Held[];
  /** The first Back's saved state, while a step or an inspection needs it. */
  reserved: Held[];
  readonly ids: number[];
  bound: string | null;
  inspecting: Inspected | null;
  pending: {
    readonly move: "back" | "forward";
    readonly to: number;
    readonly candidate: string;
    readonly reservation: Held | null;
  } | null;
  complete: boolean;
  closed: boolean;
  released: string[];
}

const newModel = (): Model => ({
  published: 0,
  nextId: 1,
  candidates: 0,
  points: [],
  reserved: [],
  ids: [],
  bound: null,
  inspecting: null,
  pending: null,
  complete: true,
  closed: false,
  released: [],
});

function stateOf({ inspecting }: Model): Inspection {
  if (inspecting === null) return "not inspecting";
  if (inspecting.adopting) return "adopting";
  return inspecting.forward.length > 0 ? "inspecting with a future" : "inspecting without a future";
}

function take(model: Model, chars: number): Held {
  const held = { id: model.nextId, chars };
  model.nextId += 1;
  model.ids.push(held.id);
  return held;
}

/** The declared transfer of `transition` in `state`: its first variant's first case. */
function declared(transition: string, state: Inspection) {
  const rule = RULES.find((each) => each.transition === transition)!;
  return rule.decide(state, rule.variants[0]!)[0]!;
}

function commitModel(model: Model): void {
  const pending = model.pending!;
  model.pending = null;
  const shown = model.inspecting;
  if (pending.move === "forward") {
    const next = shown!.forward.pop()!;
    Object.assign(shown!, { shown: pending.candidate, shownId: next.id, points: next.points });
    return;
  }
  const target = model.points[pending.to]!;
  if (shown === null)
    model.inspecting = {
      parked: model.bound!,
      shown: pending.candidate,
      shownId: target.id,
      points: pending.to + 1,
      forward: [{ id: pending.reservation!.id, points: model.points.length }],
      adopting: false,
    };
  else {
    shown.forward.push({ id: shown.shownId, points: shown.points });
    Object.assign(shown, { shown: pending.candidate, shownId: target.id, points: pending.to + 1 });
  }
}

/** Return: the parked lineage is followed again, and only the points' snapshots stay. */
function reinstate(model: Model): void {
  const shown = model.inspecting!;
  model.inspecting = null;
  model.bound = shown.parked;
  model.reserved = [];
  model.released.push(shown.shown);
}

/** A successful adoption: the shown lineage is followed, and the points after the state shown go. */
function adopt(model: Model): void {
  const shown = model.inspecting!;
  model.inspecting = null;
  model.bound = shown.shown;
  model.points = model.points.slice(0, shown.points);
  model.reserved = [];
  model.released.push(shown.parked);
}

function applyModel(model: Model, action: Action): void {
  switch (action.do) {
    case "publish":
    case "enroll": {
      const at = model.published;
      model.published += 1;
      model.bound ??= LIVE;
      if (PRESENTS.has(at) && model.inspecting === null && model.complete)
        model.points.push(take(model, CHARS[at]!));
      return;
    }
    case "back":
    case "forward": {
      const reservation =
        action.do === "back" && model.inspecting === null
          ? take(model, CHARS[model.published - 1]!)
          : null;
      if (reservation !== null) model.reserved.push(reservation);
      model.candidates += 1;
      model.pending = {
        move: action.do,
        to: action.do === "back" ? action.to : -1,
        candidate: `r${model.candidates}`,
        reservation,
      };
      if (action.commit) commitModel(model);
      return;
    }
    case "return":
      reinstate(model);
      return;
    case "adoptBegun":
      model.inspecting!.adopting = true;
      return;
    case "adoptEnded":
      adopt(model);
  }
}

function closeModel(model: Model, by: CloseReason): void {
  const decided = declared(`close by ${by}`, stateOf(model));
  if (decided.expect.kind === "refused") return;
  if (model.pending !== null) model.released.push(model.pending.candidate);
  const shown = model.inspecting;
  if (decided.expect.kind === "transfer") {
    if (shown !== null) {
      if (decided.expect.parked !== "live") model.released.push(shown.parked);
      if (decided.expect.shown !== "live") model.released.push(shown.shown);
    } else if (model.bound !== null) model.released.push(model.bound);
  }
  Object.assign(model, { closed: true, points: [], reserved: [], pending: null, inspecting: null });
}

function closeReason(end: Case["end"]): CloseReason | null {
  switch (end) {
    case "replace":
    case "close by replacement":
      return "replacement";
    case "closeAll disposal":
    case "close by disposal":
      return "disposal";
    case "close by debugOff":
      return "debugOff";
    case "close by import":
      return "import";
    case "close by clear":
      return "clear";
    default:
      return null;
  }
}

/** One history in a registry, with its delivery owner and spill, and the host sessions its changes released. */
class World {
  readonly owner = deliveryOwner();
  readonly registry: HistoryRegistry;
  readonly core: HistoryCore;
  readonly released: string[] = [];
  readonly #sessions: PlayerRuntimeSession[] = [];
  /** The maker's delivery, left open for a delivery abort. */
  #kept: Delivery | null = null;

  constructor(
    readonly spill: FakeSpill | null,
    budget: number | undefined,
  ) {
    this.registry = new HistoryRegistry(this.owner, () => Promise.resolve(spill), budget);
    this.delivered(() => this.registry.open(1));
    this.core = this.registry.core(1)!;
    const advance = this.registry.advance.bind(this.registry);
    this.registry.advance = (history, observation) => {
      const done = advance(history, observation);
      this.released.push(...done.applied.released);
      return done;
    };
  }

  delivered<T>(run: () => T, keep = false): T {
    const delivery = this.owner.begin();
    const result = run();
    if (keep) this.#kept = delivery;
    else this.owner.commit(delivery);
    return result;
  }

  abort(): void {
    this.owner.rollback(this.#kept!);
  }

  #next(): PlayerRuntimeSession {
    const last = this.#sessions.at(-1);
    const next =
      last === undefined
        ? createPlayerRuntimeSession(PLAN)
        : CHAIN[this.#sessions.length - 1]!(last);
    this.#sessions.push(next);
    return next;
  }

  publish(key: string, keep = false): void {
    const session = this.#next();
    this.registry.name(1, key, key);
    this.delivered(
      () => this.registry.observePublication({ historyKey: key, marks: NO_MARKS }, session),
      keep,
    );
  }

  enroll(): void {
    const session = this.#next();
    assert.ok(this.registry.follow(1, LIVE, LIVE));
    this.observe({
      kind: "enrollCurrent",
      candidate: {
        session,
        log: LIVE,
        marks: NO_MARKS,
        snapshotJson: () => playerRuntimeSnapshotJson(session),
      },
    });
  }

  observe(observation: HistoryObservation): void {
    const { outcome } = this.delivered(() => this.registry.advance(1, observation));
    if (outcome.kind === "refused") assert.fail(outcome.reason);
  }

  /** Prepares a step, with the state the first Back leaves when `parked` names its lineage; commits it if asked. */
  step(
    move: "back" | "forward",
    point: number,
    parked: string | null,
    candidate: string,
    commit: boolean,
    keep: boolean,
  ): void {
    const latest = this.#sessions.at(-1)!;
    const left =
      parked === null
        ? {}
        : {
            parked: {
              lineage: parked,
              position: {
                log: parked,
                eventCount: latest.events.length,
                sceneTimeMs: latest.state.observedSessionTimeMs,
                marks: NO_MARKS,
              },
              json: playerRuntimeSnapshotJson(latest),
              lastSequence: latest.events.at(-1)?.sequence ?? -1,
            },
          };
    const step = this.delivered(() => {
      const { outcome } = this.registry.advance(1, {
        kind: "prepare",
        move,
        ...(move === "back" ? { point } : {}),
        ...left,
      });
      if (outcome.kind === "refused") assert.fail(outcome.reason);
      this.registry.prepared(1, outcome.step!, candidate, candidate, this.owner.scope());
      return outcome.step!;
    }, keep);
    if (!commit) return;
    const { outcome } = this.delivered(() => this.registry.commit(1, step));
    if (outcome.kind === "refused") assert.fail(outcome.reason);
  }

  async settled(): Promise<void> {
    if (this.spill === null) return;
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
}

function act(world: World, model: Model, action: Action, keep: boolean): void {
  switch (action.do) {
    case "publish":
      world.publish(model.bound ?? LIVE, keep);
      break;
    case "enroll":
      world.enroll();
      break;
    case "back":
    case "forward":
      world.step(
        action.do,
        action.do === "back" ? model.points[action.to]!.id : -1,
        action.do === "back" && model.inspecting === null ? model.bound! : null,
        `r${model.candidates + 1}`,
        action.commit,
        keep,
      );
      break;
    case "return":
      world.observe({ kind: "return" });
      break;
    case "adoptBegun":
      world.observe({ kind: "adoptBegun" });
      break;
    case "adoptEnded":
      world.observe({ kind: "adoptEnded", succeeded: true });
  }
  applyModel(model, action);
}

/** The case's end, in the world and in the model. */
function end(world: World, model: Model, c: Case): void {
  const state = stateOf(model);
  const by = closeReason(c.end);
  if (c.end === "replace") world.delivered(() => world.registry.open(2));
  else if (c.end === "closeAll disposal") world.registry.closeAll("disposal");
  else if (by !== null) {
    const decided = declared(`close by ${by}`, state);
    world.registry.advance(1, {
      kind: "close",
      by,
      ...(state === "adopting" ? { adoptionSucceeded: decided.name.includes("success") } : {}),
    });
  }
  if (by !== null) {
    closeModel(model, by);
    return;
  }
  switch (c.end) {
    case "spill failure":
      world.spill!.fail();
      model.complete = false;
      return;
    case "budget overrun":
      // The answer to C, then D's ask, whose snapshot does not fit.
      world.publish(model.bound!);
      world.publish(model.bound!);
      model.published += 2;
      model.complete = false;
      return;
    case "delivery abort": {
      world.abort();
      const pending = model.pending;
      if (pending === null) model.points.pop();
      else {
        model.released.push(pending.candidate);
        model.reserved = model.reserved.filter((each) => each !== pending.reservation);
        model.pending = null;
      }
      return;
    }
    case "stop":
      world.registry.advance(1, { kind: "stopCollection", reason: "a stop" });
      model.complete = false;
      return;
    case "return":
      world.registry.advance(1, { kind: "return" });
      if (model.pending === null && declared("return", state).expect.kind === "transfer")
        reinstate(model);
      return;
    case "adoption":
      if (state !== "adopting") world.registry.advance(1, { kind: "adoptBegun" });
      world.registry.advance(1, { kind: "adoptEnded", succeeded: true });
      if (
        model.pending === null &&
        (state === "adopting" || declared("adopt begun", state).expect.kind === "transfer")
      )
        adopt(model);
  }
}

/** The model against the history's public state. */
async function check(world: World, model: Model): Promise<void> {
  const { core, registry, spill } = world;
  const timeline = core.timeline();
  assert.equal(core.closed, model.closed, "closed");
  assert.equal(registry.core(1) === null, model.closed, "only an open history is registered");
  assert.deepEqual(
    timeline.points.map((point) => point.id),
    model.points.map((point) => point.id),
    "the points",
  );
  const held = [...model.points, ...model.reserved];
  const chars = held.reduce((sum, each) => sum + each.chars, 0);
  // A spill that takes writes holds every snapshot once written; with none, or one that failed, memory holds them.
  const written = spill !== null && !spill.failing;
  assert.equal(timeline.memoryChars, written ? 0 : chars, "the snapshots in memory");
  assert.equal(timeline.spilledCount, written ? held.length : 0, "the snapshots spilled");
  if (spill !== null) {
    const ids = held.map((each) => each.id).sort((one, other) => one - other);
    assert.deepEqual(
      [...spill.rows.keys()].sort((one, other) => one - other),
      written ? ids : [],
      "the spill's rows",
    );
    assert.equal(spill.destroyed, written && model.closed, "the spill destroyed with its history");
  }
  const keep = new Set(held.map((each) => each.id));
  for (const id of model.ids)
    if (keep.has(id)) assert.equal(typeof (await core.snapshot(id)), "string", `snapshot ${id}`);
    else await assert.rejects(core.snapshot(id), `snapshot ${id} is released`);
  assert.equal(core.pendingStep === null, model.pending === null, "the pending step");
  assert.equal(timeline.complete, model.complete, "collection");
  if (!model.closed) assert.equal(core.inspectionState, stateOf(model), "the inspection");
  assert.deepEqual([...world.released].sort(), [...model.released].sort(), "the lineages released");
  assert.equal(registry.bound(1), model.closed ? null : model.bound, "the lineage followed");
}

const completed: Coordinates[] = [];
for (const coordinates of FEASIBLE) {
  const c = asCase(coordinates);
  test(`a history resource's lifetime: ${Object.values(c).join(", ")}`, async () => {
    const actions = arrangement(c);
    const spill =
      c.end === "spill failure"
        ? new FakeSpill(true)
        : c.resource === "spilled snapshot"
          ? new FakeSpill(false)
          : null;
    let budget: number | undefined;
    if (c.end === "budget overrun") {
      // Room for what the arrangement leaves held in memory, and for all of D's snapshot but one unit.
      const dry = newModel();
      for (const action of actions) applyModel(dry, action);
      const held = [...dry.points, ...dry.reserved].reduce((sum, each) => sum + each.chars, 0);
      budget = (spill === null ? held : 0) + CHARS[6]! - 1;
    }
    const world = new World(spill, budget);
    const model = newModel();
    for (const [index, action] of actions.entries()) {
      act(world, model, action, c.end === "delivery abort" && index === actions.length - 1);
      await world.settled();
    }
    assert.equal(world.core.inspectionState, c.inspection, "the arrangement's inspection state");
    world.released.length = 0;
    model.released = [];
    end(world, model, c);
    await world.settled();
    await check(world, model);
    completed.push(coordinates);
  });
}

test("the lifetime family completed every feasible full tuple, and nothing else", () => {
  assert.deepEqual(coverageGaps(FEASIBLE, completed, { tuples: true }), []);
  assert.equal(FEASIBLE.length, 514);
});
