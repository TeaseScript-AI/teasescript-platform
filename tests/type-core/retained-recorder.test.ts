import assert from "node:assert/strict";
import test from "node:test";

import {
  keyBelowIn,
  keyIdOf,
  keyIdPath,
  keyPrefixIn,
  spanRef,
  stepsOfId,
  type KeyId,
  type PathSteps,
} from "../../src/type-inference/core/contract/key-ids.js";
import {
  collectMarks,
  depthOf,
  markAccepts,
} from "../../src/type-inference/core/contract/marks.js";
import type { Item } from "../../src/type-inference/core/items.js";
import {
  amend,
  Retained,
  withRetainedRecorder,
} from "../../src/type-inference/core/retained/retained.js";
import { Solver, type Demand, type Work } from "../../src/type-inference/core/solver.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { readFixture } from "../helpers/type-core/type-core-fixture.js";
import { narrowingPass } from "../helpers/type-core/type-core-narrowing.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { itemScope } from "../helpers/type-core-items.js";
import { publishedRoute } from "../helpers/type-core-oracles.js";
import { Recorder, RecorderProbe, type RecorderReport } from "../helpers/retained-recorder.js";

// #1072 step 1b: the recorder's negative controls. Each shape changes retained state in a later solver run than the one
// that made it; without its mark the recorder names the change, with it the recorder is quiet.

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
function controlled(
  shape: (mark: <T extends object>(target: T) => void) => readonly (() => void)[],
): { readonly unmarked: readonly string[]; readonly marked: readonly string[] } {
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
  static readonly #hidden = (trie: Trie) => ({ roots: trie.#roots });
  #roots: Map<number, { readonly children: Map<string, number> }> | null = null;
  public constructor() {
    Retained.owner(this, "Trie", Trie.#hidden);
  }
  public roots(
    mark: (target: Trie | { readonly children: Map<string, number> }) => void,
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
  const named = (made: Unlisted | RecorderProbe): readonly string[] =>
    recorded(() => {
      const map = Retained.map<string, Unlisted | RecorderProbe>("T.classes");
      return [() => map.set("c", made)];
    }).violations;
  assert.deepEqual(named(new Unlisted()), [
    "an instance of Unlisted, a class not in IDENTITY_CLASSES, in retained state",
  ]);
  assert.deepEqual(named(new RecorderProbe()), []);
});

test("a set's or a weak set's member changed in place in a later run is named unless amended", () => {
  for (const kind of ["set", "weakSet"] as const) {
    const { unmarked, marked } = controlled((mark) => {
      const members =
        kind === "set"
          ? Retained.set<{ value: number }>("T.set")
          : Retained.weakSet<{ value: number }>("T.set");
      const member = { value: 1 };
      return [
        () => members.add(member),
        () => {
          member.value = 2;
          mark(member);
        },
      ];
    });
    assert.equal(unmarked.length, 1, kind);
    assert.match(unmarked[0]!, /^unrecorded change: T\.set at o\d+$/, kind);
    assert.deepEqual(marked, [], kind);
  }
});

test("a native map's key changed in place in a later run is named unless amended", () => {
  const { unmarked, marked } = controlled((mark) => {
    const key = { value: 1 };
    const owner = { map: new Map([[key, 0]]) };
    Retained.owner(owner, "T.native");
    return [
      () => {},
      () => {
        key.value = 2;
        mark(key);
      },
    ];
  });
  assert.deepEqual(unmarked, ["unrecorded change: T.native.map"]);
  assert.deepEqual(marked, []);
});

test("an owner's field added or deleted in a later run is named unless the owner is amended", () => {
  for (const change of ["add", "delete"] as const) {
    const { unmarked, marked } = controlled((mark) => {
      const owner: { field?: number; extra?: number } = { field: 1 };
      Retained.owner(owner, "T.owner");
      return [
        () => {},
        () => {
          if (change === "add") owner.extra = 2;
          else delete owner.field;
          mark(owner);
        },
      ];
    });
    assert.deepEqual(unmarked, ["unrecorded change: T.owner's fields"], change);
    assert.deepEqual(marked, [], change);
  }
});

test("a subclass of a walked built-in, or a class named like a listed one, is named in retained state", () => {
  class UnlistedMap extends Map<string, number> {
    value = 1;
  }
  class UnlistedArray extends Array<number> {
    value = 1;
  }
  const Listed = class Solver {
    value = 1;
  };
  for (const [made, name] of [
    [new UnlistedMap(), "UnlistedMap"],
    [new UnlistedArray(), "UnlistedArray"],
    [new Listed(), "Solver"],
  ] as const) {
    const violations = recorded(() => {
      const map = Retained.map<string, object>("T.classes");
      return [() => map.set("c", made)];
    }).violations;
    assert.deepEqual(violations, [
      `an instance of ${name}, a class not in IDENTITY_CLASSES, in retained state`,
    ]);
  }
});

test("an accessor in retained state is named and never called, unless its owner's `hidden` gives it", () => {
  const payload = {
    reads: 0,
    get data(): number {
      this.reads += 1;
      return 1;
    },
  };
  const violations = recorded(() => {
    const map = Retained.map<string, typeof payload>("T.accessor");
    return [() => map.set("p", payload), () => {}];
  }).violations;
  assert.deepEqual(violations, ["an accessor `data` of Object in retained state"]);
  assert.equal(payload.reads, 0);
  // (`CorePass`'s shape: a getter of a value made after its owner, which the owner's `hidden` reads)
  const { unmarked } = controlled(() => {
    const later = { value: 1 };
    const owner = {
      get later(): { value: number } {
        return later;
      },
    };
    Retained.owner(owner, "T.declared", (made) => ({ later: made.later }));
    return [() => {}, () => (later.value = 2)];
  });
  assert.deepEqual(unmarked, ["unrecorded change: T.declared.#later"]);
});

test("an owner's symbol-keyed field changed or added in a later run is named unless amended", () => {
  for (const change of ["change", "add"] as const) {
    const { unmarked, marked } = controlled((mark) => {
      const slot = Symbol("slot");
      const added = Symbol("added");
      const owner: { [slot]: { value: number }; [added]?: number } = { [slot]: { value: 1 } };
      Retained.owner(owner, "T.symbols");
      return [
        () => {},
        () => {
          if (change === "change") owner[slot].value = 2;
          else owner[added] = 1;
          mark(owner);
        },
      ];
    });
    assert.equal(unmarked.length, 1, change);
    assert.match(
      unmarked[0]!,
      change === "change"
        ? /^unrecorded change: T\.symbols\.\[y\d+\]$/
        : /^unrecorded change: T\.symbols's fields$/,
      change,
    );
    assert.deepEqual(marked, [], change);
  }
});

test("a built-in's own field beyond its contents, changed in a later run, is named unless amended", () => {
  const { unmarked, marked } = controlled((mark) => {
    const child = { n: 1 };
    const map = Retained.map<string, unknown[]>("T.extra");
    return [
      () => map.set("a", Object.assign([], { child })),
      () => {
        child.n = 2;
        mark(child);
      },
    ];
  });
  assert.deepEqual(unmarked, ['unrecorded change: T.extra at "a"']);
  assert.deepEqual(marked, []);
});

test("a field changed from zero to negative zero in a later run is named unless amended", () => {
  const { unmarked, marked } = controlled((mark) => {
    const owner = { n: 0 };
    Retained.owner(owner, "T.zero");
    return [
      () => {},
      () => {
        owner.n = -0;
        mark(owner);
      },
    ];
  });
  assert.deepEqual(unmarked, ["unrecorded change: T.zero.n"]);
  assert.deepEqual(marked, []);
});

test("an accessor at an array's index, or a class's `constructor` getter, is never called", () => {
  let reads = 0;
  const array: number[] = [];
  Object.defineProperty(array, 0, {
    enumerable: true,
    get: (): number => {
      reads += 1;
      return 1;
    },
  });
  class Getter {}
  Object.defineProperty(Getter.prototype, "constructor", {
    get: (): typeof Getter => {
      reads += 1;
      return Getter;
    },
  });
  const violations = recorded(() => {
    const map = Retained.map<string, object>("T.getters");
    return [() => map.set("a", array), () => map.set("c", new Getter()), () => {}];
  }).violations;
  assert.deepEqual(violations, [
    "an accessor `0` of Array in retained state",
    "an instance of anonymous, a class not in IDENTITY_CLASSES, in retained state",
  ]);
  assert.equal(reads, 0);
});

test("a demand's factory runs as its own run: its caller's amend does not cover the change it makes", () => {
  // (an eager factory, `make` an ordinary function, and a generator one change the payload alike)
  for (const eager of [true, false]) {
    const recorder = new Recorder();
    withRetainedRecorder(recorder, () => {
      const payload = { value: 1 };
      Retained.map<string, { value: number }>("T.factory").set("p", payload);
      const change = (): void => {
        payload.value = 2;
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
          amend(payload);
          yield child;
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
    assert.deepEqual(
      recorder.report().violations,
      ['unrecorded change: T.factory at "p"'],
      `eager: ${eager}`,
    );
  }
});

test("a mark automaton compiled for real holders, each in its own run, is recorded", () => {
  const recorder = new Recorder();
  const holders = withRetainedRecorder(recorder, () => {
    const request = coreRequest([
      {
        path: "main.tease",
        source:
          "let seed: integer = 1\nlet a = {p: seed}\nlet b = {q: seed}\n" +
          "if a.p != null { repeat a.p {} }\nif b.q != null { repeat b.q {} }\nexit\n",
      },
    ]);
    assert.ok(request !== null);
    const pass = narrowingPass(request);
    collectMarks(pass.contract);
    const marked = [...pass.contract.holders.values()].filter(
      (holder) => depthOf(pass.contract, holder) !== Infinity,
    );
    pass.solver.run(
      (function* (): Work<readonly Item[]> {
        for (const [index, holder] of marked.entries())
          yield {
            key: `mark${index}`,
            kind: "value",
            file: 0,
            offset: index,
            *make(): Work<readonly Item[]> {
              markAccepts(pass.contract, holder, ["p"]);
              return [];
            },
          };
        return [];
      })(),
    );
    return marked.length;
  });
  assert.ok(holders > 1);
  assert.deepEqual(recorder.report().violations, []);
});

test("a path's facts and steps, and a stop, made after what they fill, are recorded", () => {
  // (each lazy fill of `key-ids.ts` in its own run, after the run that made what it fills: the sites the fixture's
  // sources fill only in the run that made them)
  const recorder = new Recorder();
  withRetainedRecorder(recorder, () => {
    const request = coreRequest([
      {
        path: "main.tease",
        source: "let seed: integer = 1\nlet leaf = {n: seed}\nlet box = {shell: leaf}\nexit\n",
      },
    ]);
    assert.ok(request !== null);
    const pass = narrowingPass(request);
    const { contract } = pass;
    const box = pass.program.places.find(
      (place) => place.kind.kind === "binding" && place.label === "box",
    );
    assert.ok(box !== undefined);
    let id: KeyId | undefined;
    let other: KeyId | undefined;
    let steps: PathSteps | undefined;
    let suffix: PathSteps | undefined;
    let view: PathSteps | undefined;
    const runs: readonly (() => void)[] = [
      () => {
        id = keyIdOf(contract, box.id, ["a", "b", "c", "d"]);
        other = keyIdOf(contract, box.id, ["e", "f", "g"]);
      },
      // (its facts' steps)
      () => (steps = stepsOfId(contract, id!)),
      // (their suffixes)
      () => (suffix = stepsOfId(contract, id!, 1)),
      // (a suffix's path, found on first use)
      () => void suffix!.path,
      // (the other path's suffix, then its steps: its facts made by the first)
      () => void stepsOfId(contract, other!, 1),
      () => void stepsOfId(contract, other!),
      // (the steps' text, kept on their path's facts)
      () => void steps!.text(),
      () => (view = steps!.from(1)),
      // (the view's path: its id, its span, the viewed steps' views, the view's entry)
      () => void view!.path,
      // (its text, and its entry's)
      () => void view!.text(),
      // (a prefix's path, found from its ancestors)
      () => void steps!.to(2).path,
      // (the path's prefixes)
      () => void keyPrefixIn(contract, id!, 2),
      // (the paths below it by their steps' text)
      () => void keyBelowIn(contract, id!, ["x", "y"]),
      // (a path joined below another's: the joins kept on the base's facts, made by a run before)
      () => void stepsOfId(contract, keyIdOf(contract, box.id, ["x"])),
      () => void spanRef(contract, keyIdPath(id!)).after(["x"]).id(),
    ];
    const solve = (steps: readonly (() => void)[]): void =>
      void pass.solver.run(
        (function* (): Work<readonly Item[]> {
          for (const [index, run] of steps.entries())
            yield {
              key: `fill${index}`,
              kind: "value",
              file: 0,
              offset: index,
              *make(): Work<readonly Item[]> {
                run();
                return [];
              },
            };
          return [];
        })(),
      );
    solve(runs);
    // (a stop between two solves, as admission's decision stops a key: the contract's count of stops)
    contract.stop(box.id, ["a", "b"]);
    solve([() => {}]);
  });
  assert.deepEqual(recorder.report().violations, []);
});

/**
 * The recorder's sample of real sources: each type-core fixture family's first source (in the fixture's order) that
 * reaches the core and takes at most 600 ms under the recorder in the four held modes, as #1072 1b measured them
 * (pull request text, "Recorder cost"). The recorder walks every entry at every run switch, so its cost grows with a
 * source's size; the evidence runs the whole of the fixture's small sources and the #1072 cases.
 */
const SAMPLE: readonly string[] = [
  "cp9-cells/F1/let",
  "cp9-cells/F2/written-pass",
  "cp9-cells/F3/whole",
  "cp9-cells/F8/sort",
  "cp9-cells/F12/first",
  "cp9-cells/F14/list",
  "cp9-cells/F17a/otherwise",
  "cp9-cells/F18/json-integer",
  "cp9-cells/F19/json-unknown",
  "cp9-cells/F26a/say-object",
  "cp9-cells/F27a/list",
  "cp9-cells/F27c/range",
  "cp9-cells/F28/earliest-admitted",
  "cp9-cells/X1/live",
  "cp9-cells/X5/body-definition",
  "cp9-cells/C3/condition",
  "cp9-cells/C5a/definite-null",
  "cp9-cells/C5b/no-member",
  "cp9-cells/C5c/never",
  "cp9-cells/C6/last",
  "cp9-cells/C10/otherwise",
  "cp9-cells/C13/bad-iterable",
  "cp9-cells/A2/source-order",
  "cp9-cells/A3/numeric-family",
  "cp9-cells/P7/literal-condition",
  "cp9-cells/guard/ordinary-receiver",
  "cp9-cells/r4/null-otherwise",
  "cp9-cells/C2/index-fractional",
  "cp9-cells/r42/store-present-property",
  "cp9-cells/r46/guard/branch-is/guarded",
  "cp9-cells/r47/primitive-elements/singleton",
  "cp9-cells/r49/sharing/scalar-copy/guarded",
  "cp9-cells/3b/numeric/positive-2.0",
  "cp9-cells/r422/for-empty/held",
  "cp9-cells/r6-bugs/admission/overwritten",
  "cp9-cells/r7-bugs/numeric/scalar-inferred",
  "cp9-cells/r8/get-dispatch/unknown",
  "cp9-cells/r9/numeric/direct-number-external",
  "cp9-cells/s4/followup/temporal/property-absent-in-every-source",
  "cp9-cells/s6/rule-function/loop/decided",
  "cp9-cells/s9b/f18-held/named/load/definite-integer",
];

test("the recorder finds no unrecorded change in its sample of the fixture, in the four held modes (#1072)", () => {
  const fixture = new Map(readFixture().map((record) => [record.name, record]));
  const found: string[] = [];
  for (const name of SAMPLE) {
    const record = fixture.get(name);
    assert.ok(record !== undefined, `${name}: in the fixture`);
    for (const mode of HELD_MODES) {
      const recorder = new Recorder();
      withRetainedRecorder(recorder, () =>
        mode.run(() => publishedRoute(record.files, ["hostValue", "hostOther", "hostInit"])),
      );
      const report = recorder.report();
      assert.ok(report.entries > 0, `${name} (${mode.name}): reaches retained state`);
      for (const violation of report.violations) found.push(`${name} (${mode.name}): ${violation}`);
    }
  }
  assert.deepEqual(found, []);
});
