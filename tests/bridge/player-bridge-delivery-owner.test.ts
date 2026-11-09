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
 * Where a delivery stands when an event reaches it: open and innermost, open under a nested one, ended (posted or
 * aborted), or another owner's; and whether its owner was closed meanwhile.
 */
const OWNER_AXES = {
  delivery: ["innermost", "outer", "ended", "foreign"],
  owner: ["open", "closed"],
  event: ["own", "posted", "abort", "begin", "close"],
} as const;
type OwnerCase = { readonly [Axis in keyof typeof OWNER_AXES]: (typeof OWNER_AXES)[Axis][number] };

/** Closing aborts every open delivery, so a closed owner has none open. */
const ownerInfeasible = ({ delivery, owner }: Coordinates) =>
  owner === "closed" && (delivery === "innermost" || delivery === "outer");

/** What the event does: refused, or done, with the undos it runs and whether a new delivery opened. */
function ownerOutcome({ delivery, owner, event }: OwnerCase): "refused" | "done" | "nothing" {
  const open = delivery === "innermost" || delivery === "outer";
  switch (event) {
    case "begin":
      return owner === "closed" ? "refused" : "done";
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
    const outer = owner.begin();
    owner.own(outer, () => undone.push("outer"));
    const inner = owner.begin();
    owner.own(inner, () => undone.push("inner"));
    const ended = owner.begin();
    owner.commit(ended);
    const foreign = deliveryOwner().begin();
    const target: Delivery = { innermost: inner, outer, ended, foreign }[each.delivery];
    if (each.owner === "closed") {
      owner.close();
      assert.deepEqual(
        undone,
        ["inner", "outer"],
        "closing aborts every open delivery, latest first",
      );
      undone.length = 0;
    }
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
    if (each.event === "abort" && want === "done")
      assert.deepEqual(
        undone,
        [each.delivery === "innermost" ? "inner" : "outer"],
        "its undos, once",
      );
    else if (each.event === "close" && want === "done")
      assert.deepEqual(undone, ["inner", "outer"]);
    else assert.deepEqual(undone, [], "nothing undone");
    if (each.event === "abort" || each.event === "posted") {
      // The delivery ended: it admits nothing more, and the other open one is untouched.
      assert.throws(() => owner.own(target, () => {}), DeliveryRefusedError);
      if (owner.closed === false) {
        const other = target === inner ? outer : inner;
        owner.rollback(other);
        assert.ok(
          undone.includes(other === inner ? "inner" : "outer"),
          "the other delivery kept its undos",
        );
      }
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
  // A facade names its own delivery, whatever is innermost.
  const facade = owner.begin();
  const inner = owner.begin();
  map.set("facade", "four", facade);
  owner.rollback(inner);
  assert.equal(map.get("facade"), "four", "the inner delivery did not own it");
  owner.rollback(facade);
  assert.equal(map.has("facade"), false);
});

test("an undo names its insertion: a key released and set again, even with the same value, is not undone by the old one", () => {
  const owner = deliveryOwner();
  const map = new OwnedMap<string, object>(owner);
  const value = {};
  const first = owner.begin();
  map.set("k", value);
  const second = owner.begin();
  map.delete("k");
  map.set("k", value);
  owner.commit(second);
  owner.rollback(first);
  assert.equal(map.get("k"), value, "the committed insertion stays");
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

/** Two deliveries nested, each setting the same key or cell, ended in either order. */
const REPLACE_AXES = { registry: ["map", "cell"], aborted: ["outerFirst", "innerFirst"] } as const;

for (const each of product(REPLACE_AXES))
  test(`an owned ${each.registry}, set by nested deliveries that both abort (${each.aborted}), keeps nothing`, () => {
    const owner = deliveryOwner();
    const map = new OwnedMap<string, string>(owner);
    const cell = new OwnedCell<string>(owner);
    const outer = owner.begin();
    const inner = owner.begin();
    if (each.registry === "map") {
      map.set("k", "a", outer);
      // The inner delivery cannot take the key over; it adds its own.
      assert.throws(() => map.set("k", "b", inner), DeliveryRefusedError);
      map.set("k2", "b", inner);
    } else {
      cell.set("a", outer);
      cell.set("b", inner);
    }
    const [one, other] = each.aborted === "outerFirst" ? [outer, inner] : [inner, outer];
    owner.rollback(one);
    owner.rollback(other);
    assert.deepEqual([...map], [], "nothing aborted comes back");
    assert.equal(cell.value, null);
  });

test("the replacement cases are every coordinate of their declaration", () => {
  const owed = [
    { registry: "map", aborted: "outerFirst" },
    { registry: "map", aborted: "innerFirst" },
    { registry: "cell", aborted: "outerFirst" },
    { registry: "cell", aborted: "innerFirst" },
  ];
  assert.deepEqual(coverageGaps(owed, product(REPLACE_AXES), { tuples: true }), []);
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
