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
import { Recorder, type RecorderReport } from "../helpers/retained-recorder.js";

/**
 * #1072 step 1b: the recorder's negative controls. Each shape changes retained state in a later solver run than the
 * one that made it; without its mark the recorder names the change, with it the recorder is quiet.
 */

/**
 * Makes a shape's steps under a recorder (so its collections are the recorder's), then runs each as its own solver run:
 * a demand of one top-level computation.
 */
function recorded(shape: () => readonly (() => void)[]): RecorderReport {
  const recorder = new Recorder();
  return withRetainedRecorder(recorder, () => {
    const steps = shape();
    const solver = new Solver(itemScope());
    const demands = steps.map((step, index): Demand => ({
      key: `run${index}`,
      kind: "value",
      file: 0,
      offset: index,
      *make(): Work<readonly Item[]> {
        step();
        return [];
      },
    }));
    solver.run(
      (function* (): Work<readonly Item[]> {
        for (const demand of demands) yield demand;
        return [];
      })(),
    );
    return recorder.report();
  });
}

/** The violations of a shape run without its marks, and with them. */
function controlled(shape: (mark: (target: object) => void) => readonly (() => void)[]): {
  readonly unmarked: readonly string[];
  readonly marked: readonly string[];
} {
  return {
    unmarked: recorded(() => shape(() => {})).violations,
    marked: recorded(() => shape(amend)).violations,
  };
}

class Owner {
  field = 1;
  public constructor() {
    Retained.owner(this, "Owner");
  }
}

test("a plain field of an owner changed in a later run is named unless amended", () => {
  const { unmarked, marked } = controlled((mark) => {
    let owner: Owner | undefined;
    return [
      () => (owner = new Owner()),
      () => {
        owner!.field = 2;
        mark(owner!);
      },
    ];
  });
  assert.deepEqual(unmarked, ["unrecorded change: Owner.field"]);
  assert.deepEqual(marked, []);
});

/** `KeyTrie`'s shape: a private slot filled on its first question, its nodes' maps filled later. */
class Trie {
  static readonly #hidden = (trie: Trie): Readonly<Record<string, unknown>> => ({
    roots: trie.#roots,
  });
  #roots: Map<number, { readonly children: Map<string, number> }> | null = null;
  public constructor() {
    Retained.owner(this, "Trie", Trie.#hidden);
  }
  public roots(
    mark: (target: object) => void,
  ): Map<number, { readonly children: Map<string, number> }> {
    if (this.#roots === null) {
      this.#roots = new Map([[1, { children: new Map() }]]);
      mark(this);
    }
    return this.#roots;
  }
}

test("a private trie's slot and its nodes filled in later runs are named unless amended", () => {
  const { unmarked, marked } = controlled((mark) => {
    let trie: Trie | undefined;
    return [
      () => (trie = new Trie()),
      () => trie!.roots(mark),
      () => {
        const node = trie!.roots(mark).get(1)!;
        node.children.set("a", 1);
        mark(node);
      },
    ];
  });
  assert.deepEqual(unmarked, ["unrecorded change: Trie.#roots"]);
  assert.deepEqual(marked, []);
});

test("a weak map's new entry is recorded by the map; a payload under a weak key is named unless amended", () => {
  const { unmarked, marked } = controlled((mark) => {
    const weak = Retained.weakMap<object, { value: number }>("T.weak");
    const key = {};
    return [
      () => weak.set(key, { value: 1 }),
      () => {
        const payload = weak.get(key)!;
        payload.value = 2;
        mark(payload);
      },
    ];
  });
  assert.equal(unmarked.length, 1);
  assert.match(unmarked[0]!, /^unrecorded change: T\.weak at o\d+$/);
  assert.deepEqual(marked, []);
});

test("a native weak map in retained state is named: its entries cannot be listed", () => {
  class Native {
    readonly weak = new WeakMap<object, number>();
    public constructor() {
      Retained.owner(this, "Native");
    }
  }
  const native = recorded(() => [() => new Native()]).violations;
  assert.deepEqual(native, ["a native weak collection in retained state, which cannot be listed"]);
});

test("a payload's field filled in a later run (`part.expansion ??=`) is named unless amended", () => {
  const { unmarked, marked } = controlled((mark) => {
    const parts = Retained.map<string, { expansion?: string }>("T.parts");
    return [
      () => parts.set("p", {}),
      () => {
        const part = parts.get("p")!;
        part.expansion ??= "x";
        mark(part);
      },
    ];
  });
  assert.deepEqual(unmarked, ['unrecorded change: T.parts at "p"']);
  assert.deepEqual(marked, []);
});

test("one payload held by two entries is named at both unless amended, and an amend covers both", () => {
  const { unmarked, marked } = controlled((mark) => {
    const first = Retained.map<string, { value: number }>("T.first");
    const second = Retained.map<number, { value: number }>("T.second");
    return [
      () => {
        const payload = { value: 1 };
        first.set("a", payload);
        second.set(7, payload);
      },
      () => {
        const payload = first.get("a")!;
        payload.value = 2;
        mark(payload);
      },
    ];
  });
  assert.deepEqual(unmarked, [
    'unrecorded change: T.first at "a"',
    "unrecorded change: T.second at n7",
  ]);
  assert.deepEqual(marked, []);
});

test("an amend in one run does not cover the change another run makes", () => {
  const parts = (moved: boolean): readonly string[] =>
    recorded(() => {
      const map = Retained.map<string, { value: number }>("T.moved");
      let payload: { value: number } | undefined;
      return [
        () => map.set("p", (payload = { value: 1 })),
        () => amend(payload!),
        () => {
          if (moved) payload!.value = 2;
        },
      ];
    }).violations;
  assert.deepEqual(parts(true), ['unrecorded change: T.moved at "p"']);
  assert.deepEqual(parts(false), []);
});

test("an instance of a class not compared by identity is named in retained state", () => {
  class Unlisted {
    value = 1;
  }
  class RecorderProbe {}
  const named = (made: object): readonly string[] =>
    recorded(() => {
      const map = Retained.map<string, object>("T.classes");
      return [() => map.set("c", made)];
    }).violations;
  assert.deepEqual(named(new Unlisted()), [
    "an instance of Unlisted, a class not in IDENTITY_CLASSES, in retained state",
  ]);
  assert.deepEqual(named(new RecorderProbe()), []);
});
