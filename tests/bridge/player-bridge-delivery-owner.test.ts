import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  advanceDelivery,
  type DeliveryEvent,
  deliveryOwner,
  type Delivery,
  DeliveryRefusedError,
  OwnedCell,
  OwnedMap,
} from "../../player/engine-bridge/delivery.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";

/*
 * Who owns what the host allocates (#2006, `delivery.ts`): its capability allocations and their ancillary state, not
 * the diagnostic state `releaseConnection` deliberately keeps (the recorder, the value trace, the random control).
 * One invariant: every such allocation the host retains belongs to a live delivery or a live owner, and an ended
 * delivery or owner leaves none behind. A delivery is live from just before its op runs until its success reply is
 * posted; after that, what it allocated is the connection's, until it is released or the connection closes.
 *
 * This file: the owner's one deciding function, and the owned registries it backs.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The owner's one deciding function, as a declared table.

/**
 * Where a delivery stands when an event reaches it: the open one, ended (posted or aborted), or another owner's; and
 * whether its owner was closed meanwhile. The host runs one op at a time, so at most one delivery is open.
 */
const OWNER_AXES = {
  delivery: ["open", "ended", "foreign"],
  owner: ["open", "closed"],
  event: ["own", "posted", "abort", "begin", "close"],
} as const;
type OwnerCase = { readonly [Axis in keyof typeof OWNER_AXES]: (typeof OWNER_AXES)[Axis][number] };

/** Closing aborts the open delivery, so a closed owner has none open. */
const ownerInfeasible = ({ delivery, owner }: Coordinates) =>
  owner === "closed" && delivery === "open";

/** What the event does: refused, or done, with the undos it runs and whether a new delivery opened. */
function ownerOutcome({ delivery, owner, event }: OwnerCase): "refused" | "done" | "nothing" {
  const open = delivery === "open";
  switch (event) {
    case "begin":
      // A closed owner, or one with a delivery open, admits no other.
      return owner === "closed" || open ? "refused" : "done";
    case "close":
      return owner === "closed" ? "nothing" : "done";
    case "own":
    case "posted":
      return owner === "open" && open ? "done" : "refused";
    case "abort":
      return open ? "done" : "nothing";
  }
}

function ownerCases(): OwnerCase[] {
  const feasible = product(OWNER_AXES).filter((each) => !ownerInfeasible(each));
  // EVIDENCE: fixture: `product` gives each axis one value of its declared domain.
  return feasible as OwnerCase[];
}

for (const each of ownerCases())
  test(`a delivery owner: ${Object.values(each).join(", ")}`, () => {
    const owner = deliveryOwner();
    const undone: string[] = [];
    const ended = owner.begin();
    owner.own(ended, () => undone.push("ended"));
    owner.commit(ended);
    const foreign = deliveryOwner().begin();
    const open = each.delivery === "open" ? owner.begin() : null;
    if (open !== null) owner.own(open, () => undone.push("open"));
    const target: Delivery = { open, ended, foreign }[each.delivery]!;
    if (each.owner === "closed") owner.close();
    const event: DeliveryEvent =
      each.event === "own"
        ? { kind: "own", undo: () => undone.push("new") }
        : { kind: each.event === "posted" ? "posted" : each.event };
    const want = ownerOutcome(each);
    const run = () =>
      advanceDelivery(
        owner,
        each.event === "begin" || each.event === "close" ? null : target,
        event,
      );
    if (want === "refused") {
      assert.throws(run, DeliveryRefusedError);
      assert.deepEqual(undone, [], "a refusal undoes nothing");
      return;
    }
    run();
    if ((each.event === "abort" || each.event === "close") && want === "done" && open !== null)
      assert.deepEqual(undone, ["open"], "the open delivery's undos, once");
    else assert.deepEqual(undone, [], "nothing undone");
    if ((each.event === "abort" || each.event === "posted") && want === "done") {
      // The delivery ended: it admits nothing more, and the owner admits the next one.
      assert.throws(() => owner.own(target, () => {}), DeliveryRefusedError);
      owner.rollback(owner.begin());
    }
  });

test("the delivery owner's cases are every feasible coordinate of its declaration", () => {
  const all = product(OWNER_AXES).filter((each) => !ownerInfeasible(each));
  assert.deepEqual(coverageGaps(all, ownerCases(), { tuples: true }), []);
});

test("an undo that throws is reported and keeps neither the others nor the caller from going on; a second abort or close undoes nothing", () => {
  const reported: unknown[] = [];
  const owner = deliveryOwner((error) => reported.push(error));
  const undone: string[] = [];
  const delivery = owner.begin();
  owner.own(delivery, () => undone.push("first"));
  owner.own(delivery, () => {
    throw new Error("injected");
  });
  owner.own(delivery, () => undone.push("third"));
  owner.rollback(delivery);
  assert.deepEqual(undone, ["third", "first"]);
  assert.deepEqual(
    reported.map((error) => (error instanceof Error ? error.message : error)),
    ["injected"],
  );
  owner.rollback(delivery);
  owner.close();
  owner.close();
  assert.deepEqual(undone, ["third", "first"]);
  assert.equal(reported.length, 1);
  // An unknown event is refused, and leaves an open delivery as it was.
  const open = deliveryOwner();
  const kept = open.begin();
  open.own(kept, () => undone.push("kept"));
  const unknown: unknown = JSON.parse('{ "kind": "unknown" }');
  // EVIDENCE: fixture: an event outside the closed set, as an untyped caller could send it.
  const event = unknown as DeliveryEvent;
  assert.throws(() => advanceDelivery(open, kept, event), DeliveryRefusedError);
  open.rollback(kept);
  assert.deepEqual(undone, ["third", "first", "kept"]);
  // An unknown owner admits nothing.
  assert.throws(() => advanceDelivery({ ...owner }, null, { kind: "begin" }), DeliveryRefusedError);
});

test("an owned registry adds only inside a delivery, only a new key, and its undo removes without restoring", () => {
  const owner = deliveryOwner();
  const retired: string[] = [];
  const map = new OwnedMap<string, string>(owner, (value, key) => retired.push(`${key}=${value}`));
  assert.throws(() => map.set("k", "outside"), DeliveryRefusedError);
  assert.equal(map.size, 0, "a refused add installs nothing");
  const first = owner.begin();
  map.set("k", "one");
  owner.commit(first);
  const second = owner.begin();
  assert.throws(() => map.set("k", "two"), DeliveryRefusedError, "an entry is never replaced");
  map.set("new", "three");
  owner.rollback(second);
  assert.deepEqual([...map], [["k", "one"]], "the committed entry stays, the new one is gone");
  assert.deepEqual(retired, ["new=three"], "what left was retired once");
  map.delete("k");
  map.delete("k");
  map.clear();
  assert.deepEqual(retired, ["new=three", "k=one"]);
  // A caller may name the open delivery itself.
  const named = owner.begin();
  map.set("named", "four", named);
  owner.rollback(named);
  assert.equal(map.has("named"), false);
});

test("a retire that throws is reported, and every other entry that leaves is still retired", () => {
  const reported: unknown[] = [];
  const owner = deliveryOwner((error) => reported.push(error));
  const retired: string[] = [];
  const map = new OwnedMap<string, string>(owner, (value) => {
    retired.push(value);
    if (value === "one") throw new Error("injected: retiring fails");
  });
  const delivery = owner.begin();
  map.set("a", "one");
  map.set("b", "two");
  owner.commit(delivery);
  map.clear();
  assert.deepEqual(retired, ["one", "two"]);
  assert.equal(map.size, 0);
  assert.deepEqual(
    reported.map((error) => (error instanceof Error ? error.message : error)),
    ["injected: retiring fails"],
  );
});

test("an owned cell holds a value only inside a delivery, and an abort empties it without restoring the last", () => {
  const owner = deliveryOwner();
  const cell = new OwnedCell<string>(owner);
  assert.throws(() => cell.set("outside"), DeliveryRefusedError);
  const first = owner.begin();
  cell.set("one");
  owner.commit(first);
  const second = owner.begin();
  cell.set("two");
  owner.rollback(second);
  assert.equal(cell.value, null, "an abort empties it; a cache is recomputed when empty");
  cell.clear();
  assert.equal(cell.value, null);
});

test("a reporter that throws, or an error whose inspection throws, never stops the undos or the close", (context) => {
  context.mock.method(console, "error", (...args: unknown[]) => {
    // As Node's console does: it inspects what it logs.
    for (const arg of args) inspect(arg);
  });
  const hostile = {
    [inspect.custom]() {
      throw new Error("injected: inspecting the error fails");
    },
  };
  for (const report of [
    undefined,
    () => {
      throw new Error("injected: the reporter fails");
    },
  ]) {
    const owner = report === undefined ? deliveryOwner() : deliveryOwner(report);
    const undone: string[] = [];
    const delivery = owner.begin();
    owner.own(delivery, () => undone.push("first"));
    owner.own(delivery, () => {
      throw hostile;
    });
    owner.own(delivery, () => undone.push("last"));
    owner.close();
    assert.deepEqual(undone, ["last", "first"], "every undo ran");
    assert.ok(owner.closed);
  }
});
