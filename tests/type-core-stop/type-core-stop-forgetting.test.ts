// A key's stop at each occurrence of a read, and what a stop forgets (#1403, #1599).

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore, type Answers, type CorePass } from "../../src/type-inference/core/answers.js";
import { Contract } from "../../src/type-inference/core/contract.js";
import { DemandExhausted, withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import { Consumers, withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import {
  withEveryRecord,
  withSolverSeam,
  type Proof,
  type ProofDemand,
} from "../../src/type-inference/core/solver.js";
import { REASON, type Item } from "../../src/type-inference/core/items.js";
import type { PlaceId } from "../../src/type-inference/graph.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { narrowingPass } from "../helpers/type-core/type-core-narrowing.js";
import { inMode, itemText, MODES, stopSet } from "../helpers/type-core-oracles.js";

/** A test of the stopped-key family in the four modes: the solver's and consumers' orders, sharing on and off. */
const STOP_MODES: readonly (readonly [string, <T>(make: () => T) => T])[] = (() => {
  const reversed = <T>(make: () => T): T =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), make),
    );
  return [
    ["forward", (make) => make()],
    ["reversed", reversed],
    ["forward, unshared", (make) => withoutSharing(make)],
    ["reversed, unshared", (make) => withoutSharing(() => reversed(make))],
  ];
})();

const tagged = (items: readonly Item[]): string[] =>
  items.map((item) => `${item.tag}/${item.reasons}`);
const stoppedItems = (items: readonly Item[]): boolean =>
  items.some((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0);

/**
 * At a property or index read's occurrence (G3 3a): its answer kept before a key's decision stops is not
 * read after it (`Contract.stop` forgets it), so a read of the key, or of one below it, answers `budget` from the stop
 * on, as in a pass that starts with the key stopped. Each chain is read, its key stopped at every depth of its reads'
 * paths, and read again, in both read orders, directly and through a selection and an operation, and a proof read of
 * its deepest occurrence after the stop holds the stop too.
 */
test("a property or index read's occurrence answers its key's stop at every depth from the stop on", () => {
  const shapes = [
    {
      source: "let tree = [{q: [{q: 1}]}]\nlet copy = tree[0].q[0].q\nsay copy\nexit\n",
      reads: ["tree[0]", "tree[0].q", "tree[0].q[0]", "tree[0].q[0].q"],
    },
    {
      source: "let seed: integer = 1\nlet box = {q: {n: seed}}\nsay box.q.n\nexit\n",
      reads: ["box.q", "box.q.n"],
    },
    {
      source: "let pair = [{n: [1]}]\nsay pair.first.n[0]\nexit\n",
      reads: ["pair.first.n", "pair.first.n[0]"],
    },
    {
      source: "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n",
      reads: ["a.n", "(a.n otherwise {m: 2}).m"],
    },
  ];
  type Budget = Proof & { readonly stopped: boolean };
  for (const { source, reads } of shapes) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const at = (pass: CorePass): PlaceId[] =>
      reads.map((text) => {
        const found = pass.program.places.find(
          (place) =>
            place.site !== null &&
            source.slice(place.site.start, place.site.end) === text &&
            pass.program.projOf.has(place.id),
        );
        assert.ok(found !== undefined, text);
        return found.id;
      });
    const shape = narrowingPass(request);
    const roots = at(shape).map((value) => shape.program.targetRoot(value));
    const binding = roots[0]!.root;
    // (the binding itself and every prefix of its reads' paths)
    const stops = new Map<string, readonly string[]>();
    for (const { root, path } of roots)
      if (root === binding)
        for (let depth = 0; depth <= path.length; depth += 1)
          stops.set(path.slice(0, depth).join("."), path.slice(0, depth));
    for (const path of stops.values())
      for (const [mode, inMode] of STOP_MODES)
        for (const order of ["source", "deepest first"])
          inMode(() => {
            const where = `${source.split("\n")[1]} @${path.join(".") || "-"}, ${mode}, ${order}`;
            const own = (list: readonly PlaceId[]) =>
              order === "source" ? list : [...list].reverse();
            const pass = narrowingPass(request);
            const values = at(pass);
            const read = (value: PlaceId) => pass.solver.run(pass.contract.contractOfValue(value));
            for (const value of own(values)) assert.ok(!stoppedItems(read(value)), where);
            pass.contract.stop(binding, path);
            const after = new Map(own([...values].reverse()).map((value) => [value, read(value)]));
            const fresh = narrowingPass(request);
            fresh.contract.stop(binding, path);
            for (const [i, value] of at(fresh).entries()) {
              const expected = fresh.solver.run(fresh.contract.contractOfValue(value));
              assert.deepEqual(
                tagged(after.get(values[i]!)!),
                tagged(expected),
                `${reads[i]}: ${where}`,
              );
              const { root, path: below } = roots[i]!;
              if (root === binding && path.every((step, depth) => below[depth] === step))
                assert.ok(stoppedItems(expected), `${reads[i]}: ${where}`);
            }
            const deepest = values.at(-1)!;
            const proof: ProofDemand<Budget> = {
              key: "stop-proof",
              kind: "contract",
              file: 0,
              offset: 0,
              proves: true,
              *make() {
                const items = yield* pass.contract.contractOfValue(deepest);
                const stopped = stoppedItems(items);
                return { items, proof: { stopped, signature: () => String(stopped) } };
              },
            };
            assert.equal(
              pass.solver.run(pass.solver.proven(proof)).proof?.stopped,
              stoppedItems(after.get(deepest)!),
              where,
            );
          });
  }
});

/**
 * Through every answer the solver keeps (#1403): an answer kept before a key's decision stops may have
 * read the key at an occurrence (a selection, an operation, a literal's read) or through a copy's contract, a call's
 * result, a receiver, a narrowed read or a default's decision, so `Contract.stop` has the solver forget them all. In
 * each shape every value is read in one pass, on the contract side and on the value side, a key is stopped (each
 * binding and every prefix of its reads' paths), and every value is read again, in both read orders and the four
 * modes: each answers as in a pass that starts with the key stopped. A second stop in a pass that started with
 * another key stopped (the restarted pass) answers as a pass that starts with both. Between them the shapes reach
 * every memo that kept such an answer on `main`: forgetting all but one of them fails this test.
 */
test("every answer kept before a key's decision stops answers the stop from the stop on (#1403)", () => {
  const shapes = [
    "let box = [[{n: 1}]]\nsay box.first.first.n\nexit\n",
    "let v: integer? = null\nlet a = {n: v}\nsay a.n otherwise 2\nexit\n",
    "let a = {n: 1}\nsay [a][0].n\nexit\n",
    "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n",
    "let box = [[{n: 1}]]\nlet copy = box\nsay copy.first.first.n\nexit\n",
    "let xs = [1.5]\nlet removed = xs.removeAt(0)\nrepeat removed {}\nexit\n",
    'let handle = timer async hidden 1 s { say "done", instant }\nlet observed: integer = handle.stop()\nexit\n',
    "let box = {value: 2.0}\nif box != null {\nlet saved = box.value\nlet whole: integer = saved\n}\nexit\n",
    'let textHost = askText "text"\nlet d = 0\nlet result = fromJson(textHost, default: d)\nsay result\nexit\n',
  ];
  type Stop = { readonly place: PlaceId; readonly path: readonly string[] };
  for (const source of shapes) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { program } = narrowingPass(request);
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    const text = (value: PlaceId): string => {
      const site = program.places[value]!.site!;
      return source.slice(site.start, site.end);
    };
    const stops = new Map<string, Stop>();
    for (const place of program.places)
      if (place.kind.kind === "binding") stops.set(`${place.id}`, { place: place.id, path: [] });
    for (const value of values) {
      const { root, path } = program.targetRoot(value);
      if (stops.has(`${root}`))
        for (let depth = 1; depth <= path.length; depth += 1)
          stops.set(`${root}|${path.slice(0, depth).join(".")}`, {
            place: root,
            path: path.slice(0, depth),
          });
    }
    const named = (stop: Stop | null) =>
      stop === null ? "-" : `${program.places[stop.place]!.label}@${stop.path.join(".") || "-"}`;
    // (a stop alone, and a stop after another binding's, which the pass started with)
    const cases = [...stops.values()].flatMap((stop) => [
      { first: null, stop },
      ...[...stops.values()]
        .filter((first) => first.place !== stop.place && first.path.length === 0)
        .map((first) => ({ first, stop })),
    ]);
    for (const { first, stop } of cases)
      for (const lane of ["contract", "value"] as const)
        for (const [mode, inMode] of STOP_MODES)
          for (const order of ["source", "reversed"])
            inMode(() => {
              const keys = `${named(first)}, ${named(stop)}`;
              const where = `${source.split("\n").at(-3)} @${keys}, ${lane}, ${mode}, ${order}`;
              const read = (pass: CorePass, value: PlaceId) =>
                tagged(
                  pass.solver.run(
                    lane === "contract"
                      ? pass.contract.contractOfValue(value)
                      : pass.values.valueItems(value, null, []),
                  ),
                );
              const own = order === "source" ? values : [...values].reverse();
              const pass = narrowingPass(request);
              if (first !== null) pass.contract.stop(first.place, first.path);
              for (const value of own) read(pass, value);
              pass.contract.stop(stop.place, stop.path);
              const after = new Map(own.map((value) => [value, read(pass, value)]));
              const fresh = narrowingPass(request);
              if (first !== null) fresh.contract.stop(first.place, first.path);
              fresh.contract.stop(stop.place, stop.path);
              for (const value of values)
                assert.deepEqual(after.get(value), read(fresh, value), `${text(value)}: ${where}`);
            });
  }
});

/**
 * #1599: what a stop forgets by is kept only where a decision can still stop (a place before its last decision ends,
 * and the readers of what a stop may then forget), so a forget sees exactly the answers it would with every record
 * kept (`withEveryRecord`). Shapes whose decisions read a place before, between and after its stores' decisions, through
 * copies, selections and an operation, each at demand allowances from 1 to 1,024 in the four modes, where decisions
 * stop: the stop set and what is published at it the same either way, and a decision stops at some allowance. The
 * oracle compares what production can reach: complete runs and runs cut short at a demand's allowance (a budget stop
 * closes forgetting, `Solver.run`).
 */
test("a stop forgets what it would with every record kept: the same stop sets in the four modes (#1599)", () => {
  const shapes = [
    'let seed = {n: "origin", m: "other"}\nseed.n = "later"\nlet c = seed.n\nlet d = [seed.n, seed.m][0]\nsay c\nsay d\nexit\n',
    'let seed = {n: "origin"}\nlet c0 = seed.n\nlet c1 = [seed.n][0]\nseed.n = "later"\nlet c2 = seed.n\nsay c2\nexit\n',
    "let box = {q: {n: 1}}\nlet copy = box\nbox.q.n = 2\ncopy.q.n = 3\nlet out = copy.q.n\nsay out\nexit\n",
    "let box = [[{n: 1}]]\nlet copy = box\nbox[0][0].n = 2\nsay copy.first.first.n\nexit\n",
    "let v: integer? = null\nlet a = {n: {m: v}}\na.n.m = 3\nsay (a.n otherwise {m: 2}).m\nexit\n",
  ];
  for (const source of shapes) {
    const files = [{ path: "main.tease", source }];
    let stopped = 0;
    for (const mode of MODES)
      for (let allowance = 1; allowance <= 1024; allowance *= 2) {
        const stops = () => stopSet(files, mode, ["hostValue"], allowance);
        const kept = stops();
        assert.deepEqual(
          kept,
          withEveryRecord(stops),
          `${source.split("\n")[1]} ${JSON.stringify(mode)} at demand ${allowance}`,
        );
        if ((kept?.stops.length ?? 0) > 0) stopped += 1;
      }
    assert.ok(stopped > 0, `${source.split("\n")[1]}: a decision stops`);
  }
});

/**
 * #1599: what a stop forgets by stands for a place until its last decision ends (`Contract.openDecisions`, `decided`).
 * Each binding is given two decisions and every other binding one; every value is read; every other binding's decision
 * ends, and one of the two of the binding to stop; the binding's key, or one below it, stops: every value then answers
 * as in a pass that starts with that key stopped, in both read orders and the four modes, so what was asked of the
 * place before its first decision ended is still forgotten.
 */
test("what a stop forgets by stands for a place until its last decision ends (#1599)", () => {
  const shapes = [
    "let box = [[{n: 1}]]\nlet copy = box\nsay copy.first.first.n\nexit\n",
    "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n",
    "let a = {n: 1}\nsay [a][0].n\nexit\n",
  ];
  for (const source of shapes) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { program } = narrowingPass(request);
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    const bindings = program.places
      .filter((place) => place.kind.kind === "binding")
      .map((place) => place.id);
    const stops: { readonly place: PlaceId; readonly path: readonly string[] }[] = [];
    for (const place of bindings) stops.push({ place, path: [] });
    for (const value of values) {
      const { root, path } = program.targetRoot(value);
      if (bindings.includes(root) && path.length > 0) stops.push({ place: root, path });
    }
    for (const stop of stops)
      for (const [mode, inMode] of STOP_MODES)
        for (const order of ["source", "reversed"])
          inMode(() => {
            const where = `${source.split("\n").at(-3)} @${program.places[stop.place]!.label}.${stop.path.join(".")}, ${mode}, ${order}`;
            const read = (pass: CorePass, value: PlaceId) =>
              tagged(pass.solver.run(pass.contract.contractOfValue(value)));
            const own = order === "source" ? values : [...values].reverse();
            const pass = narrowingPass(request);
            pass.contract.openDecisions([
              ...bindings.map((root) => ({ root })),
              { root: stop.place },
            ]);
            for (const value of own) read(pass, value);
            for (const root of bindings) pass.contract.decided(root);
            pass.contract.stop(stop.place, stop.path);
            const after = new Map(own.map((value) => [value, read(pass, value)]));
            const fresh = narrowingPass(request);
            fresh.contract.stop(stop.place, stop.path);
            for (const value of values)
              assert.deepEqual(after.get(value), read(fresh, value), where);
          });
  }
});

/**
 * #1601's Astra r1 (R1): a demand a stop forgets and that is made again stays forgettable (`Solver.#forgettable`), since
 * what reached it before (an ask kept at a place still open, a reader edge kept from another demand) reaches it again.
 * Each value is read; one binding stops and its decisions end; every value is read again, the forgotten demands made
 * again; a second binding stops. What the second stop forgets, the answers and every charged counter equal those with
 * every record kept (`withEveryRecord`), in the four modes and both read orders: Astra's witness (`c`, then `a`, through
 * admission's groups) and her family of three sources, every ordered pair of their bindings.
 */
test("a demand made again after a forget stays forgettable until forgetting closes (#1599)", () => {
  const sources = [
    "let a: integer? = null\nlet b = 1\nlet c = a otherwise b\nlet d = [c]\nsay d.first\nexit\n",
    "let a = [{n: 1}]\nlet b = a\nlet c = [b.first, a.last]\nlet d = c.first.n\nsay d\nexit\n",
    "let a = [1]\nlet b = [2]\nlet c = a + b\nlet d = c.first\nsay d\nexit\n",
  ];
  const apart = new Set(["readerRecords", "stopAsks"]);
  interface Witnessed {
    readonly before: readonly string[][];
    readonly between: readonly string[][];
    readonly forgotten: readonly string[];
    readonly after: readonly string[][];
    readonly work: {
      readonly total: number;
      readonly counts: readonly (readonly [string, number])[];
      readonly apart: readonly (readonly [string, number])[];
    };
  }
  // (two stops with every value read before, between and after them; `groups`: the places opened by admission's own
  // groups, else one decision per binding)
  const run = (
    source: string,
    first: number,
    second: number,
    reversed: boolean,
    groups: boolean,
  ): Witnessed => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const pass = narrowingPass(request);
    const { program, contract, solver } = pass;
    const roots = program.places
      .filter((place) => place.kind.kind === "binding")
      .map((place) => place.id);
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    if (reversed) values.reverse();
    const decisions = groups
      ? new Consumers(pass).admission.groups()
      : roots.map((root) => ({ root }));
    contract.openDecisions(decisions);
    const ask = () =>
      values.map((value) => solver.run(contract.contractOfValue(value)).map(itemText));
    const kept = () =>
      [...new Set(solver.demandWork().map(({ key }) => key))]
        .filter((key) => solver.answer(key) !== undefined)
        .sort();
    const work = () => ({
      total: program.work.total,
      counts: [...program.work.counts()],
      apart: [...program.work.apartCounts()].filter(([counter]) => !apart.has(counter)),
    });
    const before = ask();
    contract.stop(roots[first]!, []);
    for (const decision of decisions)
      if (decision.root === roots[first]) contract.decided(decision.root);
    const between = ask();
    const memo = kept();
    contract.stop(roots[second]!, []);
    const forgotten = memo.filter((key) => solver.answer(key) === undefined);
    const after = ask();
    return { before, between, forgotten, after, work: work() };
  };
  for (const [index, source] of sources.entries()) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const labels = narrowingPass(request)
      .program.places.filter((place) => place.kind.kind === "binding")
      .map((place) => place.label);
    const pairs: (readonly [number, number, boolean])[] = [];
    // (Astra's witness: `c`, then `a`, through admission's groups)
    if (index === 0) pairs.push([labels.indexOf("c"), labels.indexOf("a"), true]);
    for (let first = 0; first < labels.length; first += 1)
      for (let second = 0; second < labels.length; second += 1)
        if (first !== second) pairs.push([first, second, false]);
    for (const [first, second, groups] of pairs)
      for (const mode of MODES)
        for (const reversed of [false, true])
          inMode(mode, () => {
            const where = `${source.split("\n")[2]} ${labels[first]} then ${labels[second]}${groups ? " (groups)" : ""} ${JSON.stringify(mode)}${reversed ? " reversed" : ""}`;
            assert.deepEqual(
              run(source, first, second, reversed, groups),
              withEveryRecord(() => run(source, first, second, reversed, groups)),
              where,
            );
          });
  }
});

/**
 * #1601's Codex r3 (R1): a run cut short at a demand's allowance drops what has not finished, after each pending read of
 * it keeps its reader as the read's return would have (`Solver.run`), so a demand made again after it and after a stop
 * is reached by the next stop as with every record kept. Codex's witness (every value read in one demand of a few
 * hundred units, which stops; `c` stops and its decision ends; every value is read again; `a` stops), at a few
 * allowances from that one up, in the four modes and both read orders: what the second stop forgets, every answer and
 * the charged counters equal those with every record kept (`withEveryRecord`). The oracle compares what production can
 * reach: complete runs and runs cut short at a demand's allowance; a run the analysis's budget stops closes forgetting
 * instead (`Solver.run`), so no forget follows it (`solver/type-core-solver-forgetting`).
 */
test("a run cut short keeps the readers its returns would have kept (#1599)", () => {
  const source =
    "let a: integer? = null\nlet b = 1\nlet c = a otherwise b\nlet d = [c]\nsay d.first\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  interface Witnessed {
    readonly cut: boolean;
    readonly before: readonly string[][];
    readonly forgotten: readonly string[];
    readonly after: readonly string[][];
    readonly total: number;
    readonly counts: readonly (readonly [string, number])[];
  }
  const run = (allowance: number, reversed: boolean): Witnessed => {
    const { program, contract, solver } = narrowingPass(request);
    const bindings = program.places.filter((place) => place.kind.kind === "binding");
    contract.openDecisions(bindings.map(({ id }) => ({ root: id })));
    const at = (label: string): PlaceId => bindings.find((place) => place.label === label)!.id;
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    if (reversed) values.reverse();
    const ask = () =>
      values.map((value) => solver.run(contract.contractOfValue(value)).map(itemText));
    let cut = false;
    try {
      solver.demand(
        (function* () {
          for (const value of values) yield* contract.contractOfValue(value);
          return [];
        })(),
        allowance,
      );
    } catch (error) {
      if (!(error instanceof DemandExhausted)) throw error;
      cut = true;
    }
    contract.stop(at("c"), []);
    contract.decided(at("c"));
    const before = ask();
    const memo = [...new Set(solver.demandWork().map(({ key }) => key))]
      .filter((key) => solver.answer(key) !== undefined)
      .sort();
    contract.stop(at("a"), []);
    const forgotten = memo.filter((key) => solver.answer(key) === undefined);
    const after = ask();
    return {
      cut,
      before,
      forgotten,
      after,
      total: program.work.total,
      counts: [...program.work.counts()],
    };
  };
  let cut = 0;
  for (const allowance of [96, 192, 392, 600])
    for (const mode of MODES)
      for (const reversed of [false, true])
        inMode(mode, () => {
          const own = run(allowance, reversed);
          if (own.cut) cut += 1;
          assert.deepEqual(
            own,
            withEveryRecord(() => run(allowance, reversed)),
            `at ${allowance}, ${JSON.stringify(mode)}${reversed ? ", reversed" : ""}`,
          );
        });
  assert.ok(cut > 0, "a run is cut short");
});

/**
 * Astra r1's B1 witness: through its consumers the decision of `tree`'s element stops at a small demand allowance, and
 * every read of an occurrence of the stopped key after it, `tree[0]`, `tree[0].q` and `tree[0].q[0]` among them, answers
 * `budget` (observed by wrapping `contractOfValue`, for this analysis only, without a charge), with the one restart.
 */
test("after a decision stops through its consumers, every read of an occurrence of its key answers the stop (B1)", () => {
  const source = "let tree = [{q: [{q: 1}]}]\nlet copy = tree[0].q[0].q\nsay copy\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const original = Contract.prototype.contractOfValue;
  const seen: string[] = [];
  const stale: string[] = [];
  Contract.prototype.contractOfValue = function* (this: Contract, value: PlaceId) {
    const items = yield* original.call(this, value);
    const { program } = this.pass;
    const { root, path } = program.targetRoot(value);
    const site = program.places[value]!.site!;
    if (
      this.stoppedKeys().some(
        (key) => key.place === root && key.path.every((step, i) => path[i] === step),
      )
    ) {
      seen.push(source.slice(site.start, site.end));
      if (!stoppedItems(items)) stale.push(source.slice(site.start, site.end));
    }
    return items;
  };
  try {
    for (const [mode, inMode] of STOP_MODES) {
      seen.length = 0;
      stale.length = 0;
      const answers: Answers = inMode(() =>
        withTestDemandAllowance(25, () => analyseCore(request)),
      );
      assert.equal(answers.budget.counts.get("stopPasses"), 1, mode);
      for (const text of ["tree[0]", "tree[0].q", "tree[0].q[0]"])
        assert.ok(seen.includes(text), `${text}: ${mode}`);
      assert.deepEqual(stale, [], mode);
    }
  } finally {
    Contract.prototype.contractOfValue = original;
  }
});

/**
 * #1466, the families runner's stops area at demand allowance 256 (`1249-astra-r2-written-origins`,
 * `1249-astra-copy-and-cycle-cases`): a read one holder's source answers asks that source by reference,
 * so its decision costs what `main`'s does and stops where `main`'s does; a summary rebuilt from the path's record cost
 * the decision about 80 units more and stopped `c` at `next.n`, and `other` at `inner.tone`, which `main` completes.
 * Every stop set in the four modes is `main`'s (measured on 7d6c4d3d4: a regression oracle of these sources).
 */
test("a read its one holder's source answers stops where main's does at a small demand allowance (#1466)", () => {
  const written = (read: boolean): string =>
    [
      "let w:integer=1",
      "let first=w",
      "let alias=first",
      "let a={n: alias, next: null}",
      "a.next=a",
      'let b={next:{n:"text"}}',
      "let c=a",
      "c=b",
      ...(read ? ["say c.next.n"] : []),
      "exit",
    ].join("\n");
  const cycle = [
    "let a={tone:1,inner:null}",
    "a.inner=a",
    'let bad={inner:{tone:"bad"}}',
    "let other=bad",
    "other=a",
    "say other.inner.tone",
    "exit",
  ].join("\n");
  const tone = (decided: number) => [1, "other", "inner.tone", decided];
  const cases = [
    {
      source: written(false),
      globals: ["hostValue", "hostInit", "hostOther"],
      stops: [[], [], [], []],
    },
    {
      source: written(true),
      globals: ["hostValue", "hostInit", "hostOther"],
      stops: [[], [], [], []],
    },
    {
      source: cycle,
      globals: ["hostValue", "hostOther"],
      stops: [[tone(7)], [], [tone(1)], [tone(1)]],
    },
  ];
  for (const { source, globals, stops } of cases)
    MODES.forEach((mode, index) => {
      const set = stopSet([{ path: "main.tease", source }], mode, globals, 256);
      assert.deepEqual(set?.stops, stops[index], `${source}\nmode ${index}`);
    });
});
