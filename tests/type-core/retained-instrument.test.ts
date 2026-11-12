import assert from "node:assert/strict";
import test from "node:test";

import type { Item } from "../../src/type-inference/core/items.js";
import {
  amend,
  Retained,
  withRetainedRecorder,
} from "../../src/type-inference/core/retained/retained.js";
import { Solver, type Demand, type Work } from "../../src/type-inference/core/solver.js";
import { itemScope } from "../helpers/type-core-items.js";
import { InstrumentProbe, REFUSED, RetainedInstrument } from "../helpers/retained-instrument.js";

// #1072 step 1b: the instrument's controls. Each shape stores into retained state in one solver run and writes in a
// later one; a step's outcome is `ok`, `refused` (the instrument's refusal at the store or the switch) or `frozen` (a
// write to sealed plain data, which throws at its line).

type Outcome = "ok" | "refused" | "frozen" | `threw ${string}`;

function outcomeOf(error: unknown): Outcome {
  if (!(error instanceof TypeError)) return `threw ${String(error)}`;
  return error.message.startsWith(REFUSED) ? "refused" : "frozen";
}

/** Runs each step as its own solver run under a fresh instrument: each step's outcome, and the run's own (a switch's). */
function stepped(shape: () => readonly (() => void)[]): {
  readonly steps: Outcome[];
  readonly run: Outcome;
} {
  const steps: Outcome[] = [];
  let run: Outcome = "ok";
  withRetainedRecorder(new RetainedInstrument(), () => {
    const made = shape();
    const demands = made.map((step, index): Demand => ({
      key: `run${index}`,
      kind: "value",
      file: 0,
      offset: index,
      *make(): Work<readonly Item[]> {
        try {
          step();
          steps.push("ok");
        } catch (error) {
          steps.push(outcomeOf(error));
        }
        return [];
      },
    }));
    try {
      new Solver(itemScope()).run(
        (function* (): Work<readonly Item[]> {
          for (const demand of demands) yield demand;
          return [];
        })(),
      );
    } catch (error) {
      run = outcomeOf(error);
    }
  });
  return { steps, run };
}

test("plain data stored in one run is frozen at the switch: the run that stored it may finish it, a later one may not", () => {
  let map: Map<string, { n: number; list: number[] }> | undefined;
  const { steps, run } = stepped(() => [
    () => {
      map = Retained.map("T.plain");
      const list: number[] = [];
      const value = { n: 0, list };
      map.set("a", value);
      value.n = 1;
      value.list.push(1);
    },
    () => (map!.get("a")!.n = 2),
    () => map!.get("a")!.list.push(2),
  ]);
  assert.deepEqual(steps, ["ok", "frozen", "frozen"]);
  assert.equal(run, "ok");
});

test("a map's object key, a weak map's key and a set's member are sealed as a value is", () => {
  const key = { n: 0 };
  const weakKey = { n: 0 };
  const member = { n: 0 };
  const { steps } = stepped(() => [
    () => {
      Retained.map<{ n: number }, number>("T.keys").set(key, 1);
      Retained.weakMap<{ n: number }, number>("T.weakKeys").set(weakKey, 1);
      Retained.set<{ n: number }>("T.members").add(member);
    },
    () => (key.n = 1),
    () => (weakKey.n = 1),
    () => (member.n = 1),
  ]);
  assert.deepEqual(steps, ["ok", "frozen", "frozen", "frozen"]);
});

test("a native collection, a function or a class instance is refused where it is stored, frozen or bound first", () => {
  const frozenMap = Object.freeze(new Map([["n", 0]]));
  const native = new Map<string, number>();
  const borrowed = native.set.bind(native);
  void borrowed;
  const { steps } = stepped(() => [
    () => Retained.map<string, unknown>("T.native").set("m", frozenMap),
    () => Retained.map<string, unknown>("T.native2").set("m", { inner: native }),
    () => Retained.map<string, unknown>("T.fn").set("f", () => native),
    () => Retained.map<string, unknown>("T.fn2").set("f", { call: () => 1 }),
    () => Retained.map<string, unknown>("T.instance").set("i", new (class Unlisted {})()),
    () =>
      Retained.map<string, unknown>("T.subclass").set(
        "i",
        new (class extends InstrumentProbe {})(),
      ),
    () => Retained.map<string, unknown>("T.typed").set("t", new Int32Array(2)),
    () => Retained.map<string, unknown>("T.probe").set("p", new InstrumentProbe()),
  ]);
  assert.deepEqual(steps, [
    "refused",
    "refused",
    "refused",
    "refused",
    "refused",
    "refused",
    "refused",
    "ok",
  ]);
});

test("an accessor or an own iterator in stored data is refused by its descriptor and never run", () => {
  let gets = 0;
  let iterations = 0;
  const withGetter = Object.defineProperty({}, "n", { get: () => (gets += 1), enumerable: true });
  const indexed = Object.defineProperty<number[]>([], "0", {
    get: () => (gets += 1),
    enumerable: true,
  });
  const iterating = [1, 2];
  Object.defineProperty(iterating, Symbol.iterator, {
    value: function* () {
      iterations += 1;
      yield 1;
    },
  });
  const { steps } = stepped(() => [
    () => Retained.map<string, unknown>("T.getter").set("g", withGetter),
    () => Retained.map<string, unknown>("T.indexed").set("g", indexed),
    () => Retained.map<string, unknown>("T.iterator").set("i", iterating),
  ]);
  assert.deepEqual(steps, ["refused", "refused", "refused"]);
  assert.equal(gets, 0);
  assert.equal(iterations, 0);
});

test("plain data stored, then given a native map in the same run, is refused at the switch", () => {
  const { steps, run } = stepped(() => [
    () => {
      const value: { child?: Map<string, number> } = {};
      Retained.map<string, unknown>("T.late").set("v", value);
      value.child = new Map();
    },
    () => {},
  ]);
  assert.deepEqual(steps, ["ok"]);
  assert.equal(run, "refused");
});

test("a new own property on a collection or a write outside a maker's kind throws at its line ", () => {
  const { steps } = stepped(() => [
    () => {
      const shell = Retained.map<string, number>("T.shell");
      Object.assign(shell, { extra: { n: 0 } });
    },
    () => {
      const record = Retained.record("T.record", { n: 0 });
      Object.assign(record, { [Symbol("s")]: 1 });
    },
    () => Object.assign(Retained.arena<number>("T.arena"), { extra: 1 }),
    () => Object.assign(Retained.array<number>("T.array"), { extra: 1 }),
  ]);
  assert.deepEqual(steps, ["frozen", "refused", "refused", "refused"]);
});

test("a record's fields change in any run; what it is given is sealed, and its literal's accessor is refused unrun", () => {
  let record: { n: number; child: { m: number } | null; later?: number } | undefined;
  let gets = 0;
  const { steps } = stepped(() => [
    () =>
      (record = Retained.record<{ n: number; child: { m: number } | null; later?: number }>(
        "T.fields",
        { n: 0, child: null },
      )),
    () => {
      record!.n = 1;
      record!.child = { m: 0 };
      record!.later = 1;
      delete record!.later;
    },
    () => (record!.child!.m = 1),
    () =>
      Retained.record(
        "T.getter",
        Object.defineProperty({}, "n", { get: () => (gets += 1), enumerable: true }),
      ),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "frozen", "refused"]);
  assert.equal(gets, 0);
});

test("an arena only grows: a slot is written once, a hole filled once, and its length never falls", () => {
  let arena: number[] | undefined;
  const { steps } = stepped(() => [
    () => (arena = Retained.arena("T.arena", [0])),
    () => arena!.push(1),
    () => (arena![0] = 5),
    () => (arena![3] = 3),
    () => (arena![2] = 2),
    () => (arena![2] = 4),
    () => arena!.pop(),
    () => (arena!.length = 1),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "refused", "ok", "ok", "refused", "refused", "refused"]);
  assert.deepEqual([...arena!], [0, 1, 2, 3]);
});

test("an array changes anyhow in any run, and what it is given is sealed", () => {
  let array: { n: number }[] | undefined;
  const { steps } = stepped(() => [
    () => (array = Retained.array<{ n: number }>("T.stack")),
    () => array!.push({ n: 0 }),
    () => array!.pop(),
    () => array!.push({ n: 1 }),
    () => (array![0]!.n = 2),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "ok", "ok", "frozen"]);
});

class Owner {
  field = 0;
  plain = { n: 0 };
  readonly #state = Retained.record("Owner.state", { n: 0 });
  public constructor() {
    Retained.owner(this, "Owner");
  }
  public fill(): void {
    this.#state.n += 1;
  }
}

test("an owner is locked at the switch after it is made: a field written in a later run throws unless the run marks it first", () => {
  for (const mark of [false, true]) {
    let owner: Owner | undefined;
    const { steps, run } = stepped(() => [
      () => (owner = new Owner()),
      () => {
        if (mark) amend(owner!);
        owner!.field = 1;
      },
      () => owner!.fill(),
      () => (owner!.plain.n = 1),
      () => Object.assign(owner!, { added: 1 }),
    ]);
    assert.deepEqual(steps, ["ok", mark ? "ok" : "frozen", "ok", "frozen", "frozen"]);
    assert.equal(run, "ok");
  }
});

/** An owner whose one field is an own accessor its `hidden` shows: a getter, with a setter when `settable`. */
function accessorOwner(settable: boolean): { field: number } {
  let value = 0;
  const owner: { field: number } = settable
    ? {
        get field(): number {
          return value;
        },
        set field(next: number) {
          value = next;
        },
      }
    : {
        get field(): number {
          return value;
        },
      };
  Retained.owner(owner, "AccessorOwner", (shown) => ({ field: shown.field }));
  return owner;
}

test("an owner's own accessor stands only as a getter its `hidden` shows, which nothing replaces later; a setter is refused", () => {
  let owner: { field: number } | undefined;
  const fixed = stepped(() => [
    () => (owner = accessorOwner(false)),
    () => Object.defineProperty(owner!, "field", { value: 1 }),
  ]);
  assert.deepEqual(fixed, { steps: ["ok", "frozen"], run: "ok" });
  const settable = stepped(() => [() => (owner = accessorOwner(true)), () => (owner!.field = 1)]);
  assert.equal(settable.steps[0], "ok");
  assert.equal(settable.run, "refused");
});

test("a run's mark stands in each of its intervals: a write after the run resumes is open, another run's is not", () => {
  let wrote: Outcome = "ok";
  let other: Outcome = "ok";
  withRetainedRecorder(new RetainedInstrument(), () => {
    const owner = new Owner();
    const child: Demand = {
      key: "child",
      kind: "value",
      file: 0,
      offset: 1,
      *make(): Work<readonly Item[]> {
        try {
          owner.field += 10;
        } catch (error) {
          other = outcomeOf(error);
        }
        return [];
      },
    };
    const parent: Demand = {
      key: "parent",
      kind: "value",
      file: 0,
      offset: 0,
      *make(): Work<readonly Item[]> {
        amend(owner);
        yield child;
        try {
          owner.field += 1;
        } catch (error) {
          wrote = outcomeOf(error);
        }
        return [];
      },
    };
    new Solver(itemScope()).run(
      (function* (): Work<readonly Item[]> {
        yield parent;
        return [];
      })(),
    );
  });
  assert.equal(wrote, "ok");
  assert.equal(other, "frozen");
});

test("a demand's factory runs as its own run: its caller's mark does not open the owner to the write it makes", () => {
  for (const eager of [true, false]) {
    let refused: Outcome = "ok";
    withRetainedRecorder(new RetainedInstrument(), () => {
      const owner = new Owner();
      const change = (): void => {
        owner.field += 1;
      };
      const child: Demand = {
        key: "child",
        kind: "value",
        file: 0,
        offset: 1,
        make: eager
          ? (): Work<readonly Item[]> => {
              change();
              return (function* (): Work<readonly Item[]> {
                return [];
              })();
            }
          : function* (): Work<readonly Item[]> {
              change();
              return [];
            },
      };
      const parent: Demand = {
        key: "parent",
        kind: "value",
        file: 0,
        offset: 0,
        *make(): Work<readonly Item[]> {
          amend(owner);
          yield child;
          return [];
        },
      };
      try {
        new Solver(itemScope()).run(
          (function* (): Work<readonly Item[]> {
            yield parent;
            return [];
          })(),
        );
      } catch (error) {
        refused = outcomeOf(error);
      }
    });
    assert.equal(refused, "frozen", eager ? "eager factory" : "generator factory");
  }
});

test("a function registered where it is made is admitted; any other stays refused at the store", () => {
  const { steps } = stepped(() => [
    () =>
      Retained.map<string, unknown>("T.registered").set(
        "f",
        Retained.closure("T.f", () => 1),
      ),
    () =>
      Retained.map<string, unknown>("T.inside").set("f", {
        call: Retained.closure("T.g", () => 1),
      }),
    () => Retained.map<string, unknown>("T.unregistered").set("f", () => 1),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "refused"]);
});

test("what the indexed program reaches is held as it is, its plain data frozen; a listed class's instance stays its own", () => {
  const listed = Object.assign(new InstrumentProbe(), { inner: { n: 0 } });
  const program = { plain: { n: 0 }, natives: new Map([["k", { m: 0 }]]), listed };
  const { steps } = stepped(() => [
    () => Retained.program(program),
    () => Retained.map<string, unknown>("T.program").set("p", program.natives),
    () => (program.plain.n = 1),
    () => (program.natives.get("k")!.m = 1),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "frozen", "frozen"]);
  listed.inner.n = 1;
  assert.equal(listed.inner.n, 1);
});
