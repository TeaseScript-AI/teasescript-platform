import assert from "node:assert/strict";
import test from "node:test";

import type { Item } from "../../src/type-inference/core/items.js";
import {
  amend,
  Retained,
  retainedCopy,
  retainedModule,
  withRetainedInstrument,
} from "../../src/type-inference/core/retained/retained.js";
import { Solver, type Demand, type Work } from "../../src/type-inference/core/solver.js";
import { itemScope } from "../helpers/type-core-items.js";
import {
  COLLECTION_METHODS,
  InstrumentProbe,
  REFUSED,
  RetainedInstrument,
  watchWrites,
} from "../helpers/retained-instrument.js";

// #1072 step 1b: the instrument's controls. Each shape stores into retained state in one solver run and writes in a
// later one; a step's outcome is `ok`, `refused` (the instrument's refusal at the store or the switch) or `frozen` (a
// write to sealed plain data, which throws at its line).

type Outcome = "ok" | "refused" | "frozen" | `threw ${string}`;

function outcomeOf(error: unknown): Outcome {
  if (!(error instanceof TypeError)) return `threw ${String(error)}`;
  return error.message.startsWith(REFUSED) ? "refused" : "frozen";
}

/**
 * Runs each step as its own solver run under an instrument, a fresh one unless given: each step's outcome, and the
 * run's own (a switch's).
 */
function stepped(
  shape: () => readonly (() => void)[],
  instrument = new RetainedInstrument(),
): { readonly steps: Outcome[]; readonly run: Outcome } {
  const steps: Outcome[] = [];
  let run: Outcome = "ok";
  withRetainedInstrument(instrument, () => {
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

/** An owner with a data field `count` and an own accessor `field` its `hidden` shows: a getter, a setter if `settable`. */
function accessorOwner(settable: boolean): { field: number; count: number } {
  let value = 0;
  const owner: { field: number; count: number } = settable
    ? {
        count: 0,
        get field(): number {
          return value;
        },
        set field(next: number) {
          value = next;
        },
      }
    : {
        count: 0,
        get field(): number {
          return value;
        },
      };
  Retained.owner(owner, "AccessorOwner", (shown) => ({ field: shown.field }));
  return owner;
}

test("an owner's own accessor stands only as a getter its `hidden` shows, which nothing replaces later; a setter is refused", () => {
  let owner: { field: number; count: number } | undefined;
  const fixed = stepped(() => [
    () => (owner = accessorOwner(false)),
    () => Object.defineProperty(owner!, "field", { value: 1 }),
  ]);
  assert.deepEqual(fixed, { steps: ["ok", "frozen"], run: "ok" });
  const settable = stepped(() => [() => (owner = accessorOwner(true)), () => (owner!.field = 1)]);
  assert.equal(settable.steps[0], "ok");
  assert.equal(settable.run, "refused");
});

test("a mark opens an owner with an admitted getter: its data fields are written, the getter stays", () => {
  let owner: { field: number; count: number } | undefined;
  const { steps, run } = stepped(() => [
    () => (owner = accessorOwner(false)),
    () => {
      amend(owner!);
      owner!.count = 1;
    },
    () => (owner!.count = 2),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "frozen"]);
  assert.equal(run, "ok");
  assert.equal(owner!.count, 1);
});

test("a collection's own writers are neither removed nor replaced, so none falls back to the native one", () => {
  for (const change of [
    (map: Map<string, unknown>) => Reflect.deleteProperty(map, "set") || "unchanged",
    (map: Map<string, unknown>) => Object.defineProperty(map, "set", { value: Map.prototype.set }),
    (map: Map<string, unknown>) => Object.assign(map, { set: Map.prototype.set }),
  ]) {
    let made: Map<string, unknown> | undefined;
    const { steps } = stepped(() => [
      () => (made = Retained.map<string, unknown>("T.writers")),
      () => {
        const result = change(made!);
        if (result === "unchanged") throw new TypeError("Cannot delete property");
      },
    ]);
    assert.deepEqual(steps, ["ok", "frozen"]);
  }
});

test("a typed array holds its elements alone: an own field beside them is refused, and none is added once sealed", () => {
  let table: Int32Array | undefined;
  const store = (given: Int32Array): void => {
    Retained.map<string, { up: Int32Array }>("DefinitionLists.#sorted").set("k", { up: given });
  };
  const fielded = stepped(() => [
    () => store(Object.assign(new Int32Array([1]), { memo: { n: 0 } })),
    () => undefined,
  ]);
  assert.equal(fielded.run, "refused");
  const plain = stepped(() => [
    () => store((table = new Int32Array([1]))),
    () => Object.assign(table!, { memo: 1 }),
  ]);
  assert.deepEqual(plain, { steps: ["ok", "frozen"], run: "ok" });
});

test("a helper watches a made map's writes through its own writer, which stays in place; a native map is not watched", () => {
  const seen: string[] = [];
  withRetainedInstrument(new RetainedInstrument(), () => {
    const made = Retained.map<string, number>("T.watched");
    assert.equal(
      watchWrites(made, (key, value) => seen.push(`${key}=${value}`)),
      true,
    );
    made.set("a", 1);
    assert.equal(
      watchWrites(new Map<string, number>(), () => seen.push("native")),
      false,
    );
  });
  assert.deepEqual(seen, ["a=1"]);
});

test("a map's object key is sealed while its entry stands, under an `undefined` value too", () => {
  for (const weak of [false, true]) {
    let key: { n: number } | undefined;
    const { steps } = stepped(() => [
      () => {
        key = { n: 0 };
        (weak
          ? Retained.weakMap<object, undefined>("T.keys")
          : Retained.map<object, undefined>("T.keys")
        ).set(key, undefined);
      },
      () => (key!.n = 1),
    ]);
    assert.deepEqual(steps, ["ok", "frozen"], String(weak));
  }
});

test("a typed array sealed when its run ends and written in a later one is caught, by where it was stored", () => {
  for (const write of [true, false]) {
    const instrument = new RetainedInstrument();
    let table: Int32Array | undefined;
    const { steps } = stepped(
      () => [
        () => {
          table = new Int32Array([1, 2]);
          Retained.map<string, { up: Int32Array }>("DefinitionLists.#sorted").set("k", {
            up: table,
          });
        },
        () => {
          if (write) table![0] = 5;
        },
      ],
      instrument,
    );
    assert.deepEqual(steps, ["ok", "ok"]);
    assert.deepEqual(instrument.changedTyped(), write ? ["DefinitionLists.#sorted.up"] : []);
  }
});

test("a run's mark stands in each of its intervals: a write after the run resumes is open, another run's is not", () => {
  let wrote: Outcome = "ok";
  let other: Outcome = "ok";
  withRetainedInstrument(new RetainedInstrument(), () => {
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
    withRetainedInstrument(new RetainedInstrument(), () => {
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

test("a maker keeps a copy of the given top level in both regimes; what it reaches stays shared and is frozen at the switch", () => {
  const given = { n: 0, child: { m: 0 } };
  const items = [{ m: 0 }];
  assert.equal(retainedCopy(items)[0], items[0]);
  const copied = retainedCopy(given);
  given.n = 1;
  assert.equal(copied.n, 0);
  assert.equal(copied.child, given.child);
  let record: typeof given | undefined;
  let array: { m: number }[] | undefined;
  const { steps } = stepped(() => [
    () => {
      record = Retained.record("T.copy", given);
      array = Retained.array("T.copied", items);
    },
    () => {
      given.n = 2;
      items.push({ m: 1 });
    },
    () => (given.child.m = 1),
    () => (items[0]!.m = 1),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "frozen", "frozen"]);
  assert.equal(record!.n, 1);
  assert.equal(array!.length, 1);
});

test("a maker refuses what its copy would not keep: another prototype, a field that is not plain data, an array's other field", () => {
  const { steps } = stepped(() => [
    () => Retained.record("T.instance", new InstrumentProbe()),
    () =>
      Retained.record("T.fixed", Object.defineProperty({}, "n", { value: 0, enumerable: true })),
    () => Retained.array("T.named", Object.assign([0], { extra: 1 })),
    () => Retained.arena("T.plain", [0, 1]),
  ]);
  assert.deepEqual(steps, ["refused", "refused", "refused", "ok"]);
});

test("a registered function's own properties are frozen at its registration, the plain data they hold at the switch", () => {
  const fn = Object.assign(() => 1, { cache: 0, held: { n: 0 } });
  const { steps } = stepped(() => [
    () => {
      Retained.closure("T.cached", fn);
      fn.held.n = 1;
    },
    () => (fn.cache = 1),
    () => Object.assign(fn, { added: 1 }),
    () => (fn.held.n = 2),
    () =>
      Retained.closure(
        "T.native",
        Object.assign(() => 1, { memo: new Map() }),
      ),
    // (a function's own `prototype` is no data it holds: a generator's is admitted with its function)
    () =>
      Retained.map<string, unknown>("T.generators").set(
        "g",
        Retained.closure("T.generator", function* () {}),
      ),
  ]);
  assert.deepEqual(steps, ["ok", "frozen", "frozen", "frozen", "refused", "ok"]);
  assert.deepEqual([fn.cache, fn.held.n], [0, 1]);
});

test("a record's field named `length` is a field like any other: what it holds is sealed at the switch", () => {
  let record: { length: { n: number } } | undefined;
  const { steps } = stepped(() => [
    () => (record = Retained.record("T.length", { length: { n: 0 } })),
    () => (record!.length.n = 1),
  ]);
  assert.deepEqual(steps, ["ok", "frozen"]);
});

class ProgramPart {
  readonly #places = new Set<number>([1]);
  public constructor() {
    Retained.programPart(this, (part) => ({ places: part.#places }));
  }
  public add(place: number): void {
    this.#places.add(place);
  }
}

test("the program's native collections refuse every write, its private ones reached through `programPart`", () => {
  const program = { natives: new Map([["k", 0]]), members: new Set<object>() };
  let part: ProgramPart | undefined;
  const { steps } = stepped(() => [
    () => {
      Retained.program(program);
      part = new ProgramPart();
    },
    () => program.natives.set("j", 1),
    () => program.natives.delete("k"),
    () => program.natives.clear(),
    () => program.members.add({}),
    () => Object.assign(program.natives, { extra: 1 }),
    () => part!.add(2),
    () => Map.prototype.get.call(program.natives, "k"),
  ]);
  assert.deepEqual(steps, [
    "ok",
    "refused",
    "refused",
    "refused",
    "refused",
    "frozen",
    "refused",
    "ok",
  ]);
  assert.deepEqual([...program.natives], [["k", 0]]);
});

test("a refusal is counted where it is thrown, so one a `catch` swallows is still reported", () => {
  const instrument = new RetainedInstrument();
  const { steps } = stepped(
    () => [
      () => Retained.map<string, unknown>("T.swallowed").set("f", () => 1),
      () => Retained.record("T.instance", new InstrumentProbe()),
      () => Retained.record("T.kept", { n: 0 }),
    ],
    instrument,
  );
  assert.deepEqual(steps, ["refused", "refused", "ok"]);
  assert.equal(instrument.report().raised, 2);
  assert.equal(new RetainedInstrument().report().raised, 0);
});

test("a module's collection is made by its kind, one per instrument", () => {
  const made = retainedModule<string, number>("T.module", "map");
  // (production's, or the preload's instrument's where the file runs frozen)
  const outside = made();
  assert.equal(made(), outside);
  const instrument = new RetainedInstrument();
  withRetainedInstrument(instrument, () => {
    const recorded = made();
    assert.notEqual(recorded, outside);
    assert.equal(made(), recorded);
    assert.equal(
      watchWrites(recorded, () => undefined),
      true,
    );
  });
  assert.equal(instrument.report().made.get("map"), 1);
});

test("a function the program reaches is frozen, and the plain data its own properties hold with the program's", () => {
  const fn = Object.assign(() => 0, { cache: { n: 0 }, scalar: 0 });
  let holder: { length: typeof fn } | undefined;
  const { steps } = stepped(() => [
    () => {
      Retained.program({ fn });
      holder = Retained.record("T.programFunction", { length: fn });
    },
    () => ++holder!.length.cache.n,
    () => (fn.scalar = 1),
  ]);
  assert.deepEqual(steps, ["ok", "frozen", "frozen"]);
  assert.deepEqual([fn.cache.n, fn.scalar], [0, 0]);
});

class ProgramNode {
  public label = "a";
}

test("what the program reaches is frozen, a typed array compared at the exit, and what its walk cannot see into refused", () => {
  const weak = new WeakMap<object, { n: number }>();
  const key = {};
  weak.set(key, { n: 0 });
  const node = new ProgramNode();
  const bits = new Uint8Array(2);
  const instrument = new RetainedInstrument();
  const { steps } = stepped(
    () => [
      () => Retained.program({ node, bits }),
      () => (node.label = "b"),
      () => (bits[0] = 1),
      () => Retained.program({ weak }),
      () => Retained.program({ day: new Date(0) }),
    ],
    instrument,
  );
  assert.deepEqual(steps, ["ok", "frozen", "ok", "refused", "refused"]);
  assert.deepEqual(instrument.changedTyped(), ["the indexed program"]);
  assert.equal(weak.get(key)!.n, 0);
});

test("a collection's function key is admitted as a function value is: refused unregistered, its own data sealed registered", () => {
  type Keyed = (() => number) & { cache: { n: number } };
  const registered = Object.assign(() => 0, { cache: { n: 0 } });
  let map: Map<Keyed, number> | undefined;
  const { steps } = stepped(() => [
    () =>
      Retained.map<Keyed, number>("T.unregisteredKeys").set(
        Object.assign(() => 0, { cache: { n: 0 } }),
        0,
      ),
    () =>
      Retained.weakMap<Keyed, number>("T.unregisteredWeakKeys").set(
        Object.assign(() => 0, { cache: { n: 0 } }),
        0,
      ),
    () => {
      map = Retained.map<Keyed, number>("T.registeredKeys");
      map.set(Retained.closure("T.key", registered), 0);
    },
    () => ++map!.keys().next().value!.cache.n,
  ]);
  assert.deepEqual(steps, ["refused", "refused", "ok", "frozen"]);
});

test("every method of a native collection is classed, and each that stores goes through the instrument", () => {
  const natives = [
    ["map", Map.prototype],
    ["set", Set.prototype],
    ["weakMap", WeakMap.prototype],
    ["weakSet", WeakSet.prototype],
  ] as const;
  for (const [kind, prototype] of natives) {
    const { stores, removes, reads } = COLLECTION_METHODS[kind];
    const classed = new Set<string>([...stores, ...removes, ...reads]);
    // (a method a later runtime adds is unclassed here, and fails this test until it is classed and, if it stores,
    // given a writer)
    assert.deepEqual(
      Object.getOwnPropertyNames(prototype).filter((name) => !classed.has(name)),
      [],
      kind,
    );
    assert.deepEqual(
      Object.getOwnPropertySymbols(prototype).filter(
        (symbol) => symbol !== Symbol.iterator && symbol !== Symbol.toStringTag,
      ),
      [],
      kind,
    );
  }
});

interface Upserting {
  getOrInsert<V>(key: unknown, value: V): V;
  getOrInsertComputed<V>(key: unknown, compute: (key: unknown) => V): V;
}

/** `made` with the upserts the runtime of `.nvmrc` has, which the declared lib does not name yet. */
function upserting<T extends object>(made: T): T & Upserting {
  // EVIDENCE: invariant: Node 26 gives maps and weak maps both upserts (ES2026); the test fails at its call where not.
  return made as T & Upserting;
}

test("a map's upserts store through its own writer: checked at the store, sealed at the switch, refused in the program", () => {
  let map: (Map<string, { n: number }> & Upserting) | undefined;
  const program = upserting(new Map<string, number>());
  const { steps } = stepped(() => [
    () => {
      map = upserting(Retained.map<string, { n: number }>("T.upserts"));
      map.getOrInsert("a", { n: 0 });
      map.getOrInsertComputed("b", () => ({ n: 0 }));
      Retained.program({ program });
    },
    () => ++map!.get("a")!.n,
    () => ++map!.get("b")!.n,
    () => map!.getOrInsert("f", () => 1),
    () => upserting(Retained.weakMap<object, unknown>("T.weakUpserts")).getOrInsert({}, () => 1),
    () => program.getOrInsert("k", 1),
    () => program.getOrInsertComputed("k", () => 1),
  ]);
  assert.deepEqual(steps, ["ok", "frozen", "frozen", "refused", "refused", "refused", "refused"]);
  assert.equal(program.size, 0);
});

test("the program's walk refuses an own accessor, whose result it does not see", () => {
  const { steps } = stepped(() => [
    () =>
      Retained.program(
        Object.defineProperty({}, "lazy", { get: () => ({ n: 0 }), enumerable: true }),
      ),
  ]);
  assert.deepEqual(steps, ["refused"]);
});

test("a made collection's writers are exactly the storing methods its runtime has", () => {
  withRetainedInstrument(new RetainedInstrument(), () => {
    const made = [
      ["map", Retained.map<string, number>("T.writers"), Map.prototype],
      ["set", Retained.set<string>("T.writers"), Set.prototype],
      ["weakMap", Retained.weakMap<object, number>("T.writers"), WeakMap.prototype],
      ["weakSet", Retained.weakSet<object>("T.writers"), WeakSet.prototype],
    ] as const;
    for (const [kind, collection, prototype] of made)
      assert.deepEqual(
        Object.getOwnPropertyNames(collection).sort(),
        COLLECTION_METHODS[kind].stores.filter((name) => name in prototype).sort(),
        kind,
      );
  });
});

test("a made map's upserts answer as the native ones do: the key the runtime takes, a symbol weak key included", () => {
  const weakKey = Symbol("weak");
  const sequence = (map: Upserting, weak: Upserting) => [
    map.getOrInsertComputed(-0, (key) => (Object.is(key, -0) ? 1 : 0)),
    map.getOrInsert(0, 5),
    weak.getOrInsert(weakKey, 1),
    weak.getOrInsert(weakKey, 2),
    weak.getOrInsertComputed(weakKey, () => 3),
  ];
  const native = sequence(upserting(new Map()), upserting(new WeakMap()));
  let instrumented: number[] = [];
  withRetainedInstrument(new RetainedInstrument(), () => {
    instrumented = sequence(
      upserting(Retained.map<number, number>("T.nativeUpserts")),
      upserting(Retained.weakMap<object, number>("T.nativeWeakUpserts")),
    );
  });
  assert.deepEqual(instrumented, native);
  assert.deepEqual(native, [0, 0, 1, 1, 1]);
});

test("a program map's upsert reads an entry it holds, and refuses only an insert", () => {
  const program = upserting(new Map<string, number>([["k", 1]]));
  const { steps } = stepped(() => [
    () => Retained.program({ program }),
    () => assert.equal(program.getOrInsert("k", 2), 1),
    () =>
      assert.equal(
        program.getOrInsertComputed("k", () => 2),
        1,
      ),
    () => program.getOrInsert("j", 2),
  ]);
  assert.deepEqual(steps, ["ok", "ok", "ok", "refused"]);
});

test("a record's field `__proto__`, which would set its prototype, is refused where it is written or given", () => {
  let record: Record<string, unknown> | undefined;
  const { steps } = stepped(() => [
    () => (record = Retained.record<Record<string, unknown>>("T.proto", { n: 0 })),
    () => (record!["__proto__"] = { n: 0 }),
    () =>
      Retained.record(
        "T.protoGiven",
        Object.defineProperty({}, "__proto__", {
          value: { n: 0 },
          enumerable: true,
          writable: true,
          configurable: true,
        }),
      ),
  ]);
  assert.deepEqual(steps, ["ok", "refused", "refused"]);
});

test("a function's own accessor is refused where it is registered or the program reaches it", () => {
  const getter = () => Object.defineProperty(() => 0, "lazy", { get: () => ({ n: 0 }) });
  const { steps } = stepped(() => [
    () => Retained.closure("T.getter", getter()),
    () => Retained.program({ fn: getter() }),
  ]);
  assert.deepEqual(steps, ["refused", "refused"]);
});

test("the program's walk refuses an object whose prototype is no class's, as a `__proto__` key from data sets", () => {
  const names: readonly string[] = ["a", "__proto__"];
  const index: Record<string, { n: number }> = {};
  for (const name of names) index[name] = { n: 0 };
  const { steps } = stepped(() => [
    () => Retained.program({ index }),
    () => Retained.program({ node: new ProgramNode(), map: new Map<string, number>() }),
  ]);
  assert.deepEqual(steps, ["refused", "ok"]);
});

test("an upsert's callback that is no function throws as the native one does, held key or not", () => {
  const held = <T extends Upserting>(made: T): string => {
    try {
      // EVIDENCE: fixture: a callback that is no function, which the native method refuses with a TypeError.
      made.getOrInsertComputed("k", 1 as never);
      return "ok";
    } catch (error) {
      return error instanceof TypeError ? "TypeError" : String(error);
    }
  };
  const native = upserting(new Map<string, number>([["k", 1]]));
  const program = upserting(new Map<string, number>([["k", 1]]));
  let outcomes: string[] = [];
  withRetainedInstrument(new RetainedInstrument(), () => {
    const made = upserting(Retained.map<string, number>("T.nonCallable"));
    made.set("k", 1);
    Retained.program({ program });
    outcomes = [held(made), held(program)];
  });
  assert.deepEqual([held(native), ...outcomes], ["TypeError", "TypeError", "TypeError"]);
});
