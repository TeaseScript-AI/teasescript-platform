import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PLAN_JSON_LEASE,
  settle,
  type PlanJson,
  type PlanJsonEvent,
  type PlanJsonLease,
} from "../player/plan-json-lease.js";

/*
 * Who holds a plan's JSON (`player/plan-json-lease.ts`), over a generated family of event orders: `settle` against a
 * model of the host, which writes a plan's JSON when asked, lets a capture take it, and lets go of it when released.
 * After every event of every case: the host holds a plan's JSON only while the page is live and the plan is current; a
 * write happens only where no copy exists, in the host, in a capture's reply or on the page; nothing is posted once
 * the page closed.
 */

/** The axes, declared once; a case is built from its values alone and named by them. */
const AXES = {
  // Where the capture's plan stands when the case ends: still the page's, replaced by another, or the page closed.
  preparation: ["current", "replaced", "disposed"],
  // What the keep's capture does: none at all, a saved state, an unkeepable state, a session the host no longer
  // holds, or a request the Worker's loss ended.
  capture: ["none", "captured", "unkeepable", "gone", "lost"],
  // Whether a Start of the same plan is prepared while the capture is out.
  startDuringCapture: ["no", "yes"],
  // Whether the replacement or closing comes before the capture's reply or after it.
  retire: ["beforeReply", "afterReply"],
} as const;
type Axis = keyof typeof AXES;
type Case = { readonly [A in Axis]: (typeof AXES)[A][number] };

/** Whether a combination is a case: a capture's axes need a capture, and a retirement order needs a retirement. */
function valid(c: Case): boolean {
  if (c.capture === "none" && c.startDuringCapture === "yes") return false;
  if ((c.capture === "none" || c.preparation === "current") && c.retire === "afterReply")
    return false;
  return true;
}

function* product(): Generator<Case> {
  for (const preparation of AXES.preparation)
    for (const capture of AXES.capture)
      for (const startDuringCapture of AXES.startDuringCapture)
        for (const retire of AXES.retire) {
          const c: Case = { preparation, capture, startDuringCapture, retire };
          if (valid(c)) yield c;
        }
}
const nameOf = (c: Case) =>
  `${c.preparation} ${c.capture} start:${c.startDuringCapture} retire:${c.retire}`;

/** The host as the lease sees it: which plans' JSON it holds, and how often it wrote one. */
class HostModel {
  readonly slots = new Set<string>();
  writes = 0;
  /** Whether the host is gone, with the Worker. */
  lost = false;
  apply(message: { readonly kind: "write" | "release"; readonly plan: string }) {
    if (this.lost) return;
    if (message.kind === "release") this.slots.delete(message.plan);
    else if (!this.slots.has(message.plan)) {
      this.writes += 1;
      this.slots.add(message.plan);
    }
  }
  /** A capture taking `plan`'s JSON: written now if not held, except for a session the host no longer holds. */
  take(plan: string, gone: boolean): string | null {
    const held = this.slots.delete(plan);
    if (held) return `json of ${plan}`;
    if (gone) return null;
    this.writes += 1;
    return `json of ${plan}`;
  }
}

/** Runs `c` against `settle` and the host model, checking the invariants after every event. */
function run(c: Case) {
  const host = new HostModel();
  let lease: PlanJsonLease = EMPTY_PLAN_JSON_LEASE;
  let closed = false;
  /** Every copy of `plan`'s JSON, at the time of a write: none may exist. */
  let inFlight: string | null = null;
  const copies = (plan: string) =>
    [
      host.slots.has(plan),
      lease.unsaved?.plan === plan,
      lease.prepared?.plan === plan,
      inFlight === plan,
    ].filter(Boolean).length;
  const step = (event: PlanJsonEvent) => {
    const settled = settle(lease, event);
    lease = settled.lease;
    if (closed) assert.deepEqual(settled.messages, [], `${nameOf(c)}: posted after closing`);
    for (const message of settled.messages) {
      if (message.kind === "write")
        assert.equal(copies(message.plan), 0, `${nameOf(c)}: wrote ${message.plan} with a copy`);
      host.apply(message);
    }
    if (event.kind === "dispose") closed = true;
    for (const plan of host.slots)
      assert.ok(
        lease.live && plan === lease.current,
        `${nameOf(c)}: the host holds ${plan} after ${event.kind}`,
      );
    return settled;
  };
  const retire = () => {
    if (c.preparation === "replaced") {
      step({ kind: "replace", plan: "B" });
      step({ kind: "prepare", plan: "B" });
    } else if (c.preparation === "disposed") step({ kind: "dispose" });
  };
  step({ kind: "replace", plan: "A" });
  step({ kind: "prepare", plan: "A" });
  if (c.capture === "none") {
    retire();
    return { host, lease };
  }
  const { source } = step({ kind: "captureStart", plan: "A" });
  assert.equal(source?.kind, "host", `${nameOf(c)}: the first save takes the host's JSON`);
  // The capture reaches the host: it takes the JSON, except where the Worker is lost first.
  let json: string | null = null;
  if (c.capture === "lost") {
    host.lost = true;
    host.slots.clear();
  } else {
    const before = host.writes;
    json = host.take("A", c.capture === "gone");
    if (host.writes > before)
      assert.equal(copies("A"), 0, `${nameOf(c)}: the capture wrote A with a copy`);
    inFlight = json === null ? null : "A";
  }
  if (c.startDuringCapture === "yes") step({ kind: "prepare", plan: "A" });
  if (c.retire === "beforeReply") retire();
  if (c.capture === "lost") step({ kind: "captureLost", plan: "A" });
  else {
    inFlight = null;
    const { saving } = step({
      kind: "captureReply",
      plan: "A",
      json,
      saved: c.capture === "captured",
    });
    if (saving != null) step({ kind: "stored", entry: saving });
  }
  if (c.retire === "afterReply") retire();
  // A later Start of A, while A is still the page's plan, needs a write only if no copy is held.
  if (lease.live && lease.current === "A") step({ kind: "prepare", plan: "A" });
  return { host, lease };
}

const CASES = [...product()];

test("the generated family covers every value of every axis and every pair of values", () => {
  const names = new Set(CASES.map(nameOf));
  assert.equal(names.size, CASES.length, "each case has its own name");
  // EVIDENCE: invariant: the keys of the axes object, declared literally above.
  const axes = Object.keys(AXES) as Axis[];
  for (const axis of axes)
    for (const value of AXES[axis])
      assert.ok(
        CASES.some((c) => c[axis] === value),
        `no case for ${axis} = ${value}`,
      );
  // Every pair of values that a case can hold together is in some case.
  for (const [i, left] of axes.entries())
    for (const right of axes.slice(i + 1))
      for (const a of AXES[left])
        for (const b of AXES[right]) {
          const possible = [...product()].some((c) => c[left] === a && c[right] === b);
          const present = CASES.some((c) => c[left] === a && c[right] === b);
          assert.equal(present, possible, `${left} = ${a} with ${right} = ${b}`);
        }
});

for (const c of CASES)
  test(`plan JSON lifetime: ${nameOf(c)}`, () => {
    const { host, lease } = run(c);
    // At the end: a closed page holds nothing and leaves nothing in the host; a replaced plan leaves nothing either.
    if (c.preparation === "disposed") {
      assert.deepEqual([...host.slots], []);
      assert.deepEqual([lease.unsaved, lease.prepared], [null, null]);
    }
    if (c.preparation === "replaced") assert.ok(!host.slots.has("A"));
    // A's JSON is written at most once in the case, unless the Worker was lost and the page wrote it again after.
    assert.ok(host.writes <= 2, `${nameOf(c)}: ${host.writes} writes`);
  });

test("a retry stores the same bytes, and a Start prepared while a save holds the JSON takes them", () => {
  let lease: PlanJsonLease = EMPTY_PLAN_JSON_LEASE;
  const apply = (event: PlanJsonEvent) => {
    const settled = settle(lease, event);
    lease = settled.lease;
    return settled;
  };
  apply({ kind: "replace", plan: "A" });
  assert.deepEqual(apply({ kind: "prepare", plan: "A" }).messages, [{ kind: "write", plan: "A" }]);
  apply({ kind: "captureStart", plan: "A" });
  const saving: PlanJson | null | undefined = apply({
    kind: "captureReply",
    plan: "A",
    json: "bytes",
    saved: true,
  }).saving;
  assert.deepEqual(saving, { plan: "A", json: "bytes" });
  // The store refused the save: the retry takes the page's copy.
  const retry = apply({ kind: "captureStart", plan: "A" }).source;
  assert.deepEqual(retry, { kind: "page", entry: saving });
  // A Start prepared while that save still holds it takes the same JSON, and asks the host for nothing.
  assert.deepEqual(apply({ kind: "prepare", plan: "A" }).messages, []);
  apply({ kind: "stored", entry: saving! });
  assert.deepEqual(apply({ kind: "captureStart", plan: "A" }).source, {
    kind: "page",
    entry: saving,
  });
});
