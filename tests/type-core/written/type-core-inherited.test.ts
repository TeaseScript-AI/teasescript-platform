import assert from "node:assert/strict";
import test from "node:test";

import {
  Admission,
  admissionRunsInsideSolverRuns,
} from "../../../src/type-inference/core/admission.js";
import { analyseCore, solveDemands } from "../../../src/type-inference/core/answers.js";
import { DemandExhausted } from "../../../src/type-inference/core/budget.js";
import { exportNames, isKeyId } from "../../../src/type-inference/core/contract/key-ids.js";
import { keyOf } from "../../../src/type-inference/core/definitions.js";
import { inheritedAt } from "../../../src/type-inference/core/inherited/inherited.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import type { PlaceId } from "../../../src/type-inference/graph.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { narrowingPass } from "../../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES, publication } from "../../helpers/type-core-oracles.js";

/*
 * #1072 A2 checkpoint 2a: A4's inherited written type (ADR 0021 1.3) as a solver proof per key, a read of a key whose
 * component is still being solved cut, as A4's cycle rule cuts a copy between two places that wait on each other.
 * The covering sample at one doubling (k = 2, 4) of the equality family: each source's inherited types the same whatever
 * place a fresh admission asks first, and its publication the same in the four modes; the first rows and the decider
 * order with their answers; and no admission run made inside a solver run (each read of a proof's run yielded). The
 * full product against the frozen reference runs on the queue (the PR's evidence).
 */

const GLOBALS = ["hostValue"];
const W = "let w: number = 1\n";
const NUMBER = JSON.stringify({ kind: "atom", name: "number" });
const OPTIONAL_NUMBER = JSON.stringify({
  kind: "union",
  members: [
    { kind: "atom", name: "number" },
    { kind: "atom", name: "null" },
  ],
});

const orders = (places: readonly string[]): string[][] =>
  places.length <= 1
    ? [[...places]]
    : places.flatMap((first, at) =>
        orders(places.filter((_, other) => other !== at)).map((rest) => [first, ...rest]),
      );

function prepare(source: string) {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, `${JSON.stringify(source)}: its file parses and resolves`);
  const ids = new Map<string, PlaceId>();
  for (const { id, kind } of new CoreProgram(request).places)
    if (kind.kind === "binding" && !ids.has(kind.name)) ids.set(kind.name, id);
  return { request, ids };
}

/** Each place's inherited type at `path`, asked in `order` on a fresh admission: `none` where it copies none. */
function inheritedIn(
  source: string,
  order: readonly string[],
  path: readonly string[],
): Record<string, string> {
  const { request, ids } = prepare(source);
  const pass = narrowingPass(request);
  const admission = new Admission(
    pass,
    { run: (work) => pass.solver.run(work) },
    new Map(),
    new Set(),
  );
  const got: Record<string, string> = {};
  for (const place of order) {
    const term = inheritedAt(admission, ids.get(place)!, path);
    got[place] = term === null ? "none" : JSON.stringify(term);
  }
  return got;
}

/** The inherited types, the same in every entry order; the publication, the same in the four modes. */
function settled(
  source: string,
  places: readonly string[],
  path: readonly string[] = [],
): Record<string, string> {
  const first = inheritedIn(source, places, path);
  for (const order of orders(places))
    assert.deepEqual(inheritedIn(source, order, path), first, `${order.join(" > ")}\n${source}`);
  const published = new Set(
    MODES.map((mode) => publication([{ path: "main.tease", source }], mode, GLOBALS)),
  );
  assert.equal(published.size, 1, `four modes, one publication\n${source}`);
  return first;
}

const names = (k: number): string[] => Array.from({ length: k }, (_, at) => `p${at}`);
const said = (places: readonly string[]): string =>
  `${places.map((place) => `say "\${${place}}"`).join("\n")}\nexit\n`;

test("the first rows: a copy back after the first value decides waits on nothing; a cycle fed late cuts only its copies", () => {
  assert.deepEqual(settled(`${W}let a = w\nlet b = a\na = b\n${said(["a", "b"])}`, ["a", "b"]), {
    a: NUMBER,
    b: NUMBER,
  });
  assert.deepEqual(
    settled(`${W}let a = hostValue\nlet b = a\na = b\nb = w\n${said(["a", "b"])}`, ["a", "b"]),
    { a: "none", b: NUMBER },
  );
});

test("the earliest decider in source order: a call before the written copy decides inferred, the copy before it decides", () => {
  assert.deepEqual(settled(`${W}let a = fromJson("1", default: 0)\na = w\n${said(["a"])}`, ["a"]), {
    a: "none",
  });
  assert.deepEqual(settled(`${W}let a = w\na = fromJson("1", default: 0)\n${said(["a"])}`, ["a"]), {
    a: NUMBER,
  });
  assert.deepEqual(settled(`${W}let a = null\na = w\n${said(["a"])}`, ["a"]), {
    a: OPTIONAL_NUMBER,
  });
});

test("the covering sample at one doubling: chains, rings fed before and after their back edge, pure rings and self copies, at the root and a property, settle whatever place is asked first", () => {
  const before = admissionRunsInsideSolverRuns();
  for (const k of [2, 4]) {
    const p = names(k);
    const copies = p.slice(1).map((place, at) => `${place} = ${p[at]}`);
    const shapes: { readonly source: string; readonly want?: Record<string, string> }[] = [
      {
        source: `${W}let p0 = w\n${p
          .slice(1)
          .map((place) => `let ${place} = hostValue`)
          .join("\n")}\n${copies.join("\n")}\n${said(p)}`,
      },
      {
        source: `${W}let p0 = w\n${p
          .slice(1)
          .map((place, at) => `let ${place} = ${p[at]}`)
          .join("\n")}\np0 = ${p.at(-1)}\n${said(p)}`,
        want: Object.fromEntries(p.map((place) => [place, NUMBER])),
      },
      {
        source: `${W}let p0 = hostValue\n${p
          .slice(1)
          .map((place, at) => `let ${place} = ${p[at]}`)
          .join("\n")}\np0 = ${p.at(-1)}\n${p.at(-1)} = w\n${said(p)}`,
        want: Object.fromEntries(p.map((place) => [place, place === p.at(-1) ? NUMBER : "none"])),
      },
      {
        source: `${p.map((place) => `let ${place} = hostValue`).join("\n")}\n${copies.join("\n")}\np0 = ${p.at(-1)}\n${said(p)}`,
        want: Object.fromEntries(p.map((place) => [place, "none"])),
      },
      { source: `${W}let p0 = hostValue\np0 = p0\np0 = w\n${said(["p0"])}` },
    ];
    for (const { source, want } of shapes) {
      const places = source.includes("p1") ? p : ["p0"];
      const got = settled(source, places);
      if (want !== undefined) assert.deepEqual(got, want, source);
    }
    // (the same rings below a property)
    const objects = `let w: number = 1\nlet p0 = {f: hostValue}\n${p
      .slice(1)
      .map((place, at) => `let ${place} = ${p[at]}`)
      .join(
        "\n",
      )}\np0 = ${p.at(-1)}\n${p.at(-1)} = {f: w}\n${said(p.map((place) => `${place}.f`))}`;
    settled(objects, p, ["f"]);
  }
  assert.equal(admissionRunsInsideSolverRuns() - before, 0, "every read of a proof's run yielded");
});

test("the analysis decides each place as its inherited type says, in the four modes", () => {
  const source = `${W}let a = hostValue\nlet b = a\na = b\nb = w\n${said(["a", "b"])}`;
  const { request, ids } = prepare(source);
  for (const mode of MODES)
    assert.deepEqual(
      inMode(mode, () => {
        const answers = analyseCore(request);
        return ["a", "b"].map((place) => {
          const { admitted } = answers.place(ids.get(place)!, []);
          return `${place} ${admitted.by === "decided" && admitted.inherited ? "copied" : admitted.by}`;
        });
      }),
      ["a decided", "b copied"],
      JSON.stringify(mode),
    );
});

test("a proof cut short at its demand's allowance leaves nothing: the next run reads as a fresh admission", () => {
  // (Codex r1 on #2098: an unfinished proof's cycle joins kept past the stop read `a` as the number its cycle cuts)
  const source = `${W}let a = hostValue\nlet b = a\nlet c = b\na = c\nc = w\n${said(["a", "b", "c"])}`;
  const fresh = settled(source, ["a", "b", "c"]);
  assert.deepEqual(fresh, { a: "none", b: "none", c: NUMBER });
  for (const mode of MODES)
    inMode(mode, () => {
      let stopped = 0;
      for (let allowance = 1; ; allowance += 1) {
        const { request, ids } = prepare(source);
        const pass = narrowingPass(request);
        let limit: number | null = allowance;
        const admission = new Admission(
          pass,
          {
            run: (work) =>
              limit === null ? pass.solver.run(work) : pass.solver.demand(work, limit),
          },
          new Map(),
          new Set(),
        );
        try {
          inheritedAt(admission, ids.get("a")!, []);
        } catch (error) {
          if (!(error instanceof DemandExhausted)) throw error;
          stopped += 1;
          limit = null;
          const got = Object.fromEntries(
            ["a", "b", "c"].map((place) => {
              const term = inheritedAt(admission, ids.get(place)!, []);
              return [place, term === null ? "none" : JSON.stringify(term)];
            }),
          );
          assert.deepEqual(got, fresh, `${JSON.stringify(mode)} at ${allowance}`);
          continue;
        }
        break;
      }
      assert.ok(stopped > 0, "some allowance stops the first read");
    });
});

test("a wrapper's proof yields its setup's reads: a fresh admission's first read below it answers", () => {
  // (Codex r1 on #2098: the wrapper's stops were driven synchronously inside the proof's run)
  const source = `${W}let a = w\nlet d: number dict = dict{}\nlet box = {f: a, g: d.values}\n${said(["box.f"])}`;
  for (const mode of MODES)
    inMode(mode, () => {
      const before = admissionRunsInsideSolverRuns();
      assert.deepEqual(inheritedIn(source, ["box"], ["f"]), { box: NUMBER }, JSON.stringify(mode));
      assert.equal(admissionRunsInsideSolverRuns() - before, 0, JSON.stringify(mode));
    });
});

test("a pass's inherited proofs replay by their names, a cursor's by its token", () => {
  // (Codex r1 on #2098: a fresh pass had no admission to make them, and a cursor was read as a number)
  const ring = `${W}let a = hostValue\nlet b = a\nlet c = b\na = c\nc = w\n${said(["a", "b", "c"])}`;
  const request = coreRequest([{ path: "main.tease", source: ring }], GLOBALS)!;
  const components: { names: readonly string[]; packet: unknown }[] = [];
  withSolverSeam(
    {
      onComponent: (members, replay) =>
        components.push(
          replay ?? { names: members.map((member) => member.key), packet: undefined },
        ),
    },
    () => analyseCore(request),
  );
  const inherited = components.filter(({ names }) => names.some((name) => name.startsWith("a4|")));
  assert.ok(inherited.length > 0, "the analysis solves an inherited proof");
  for (const { names, packet } of inherited)
    assert.equal(solveDemands(request, names, packet).length, names.length, names.join(", "));
  // (a path below a wrapper is a cursor: its proof exported by its names and packet, replayed on a fresh pass)
  const { request: boxed, ids } = prepare(`${W}let a = w\nlet box = {f: a}\n${said(["box.f"])}`);
  const pass = narrowingPass(boxed);
  const admission = new Admission(
    pass,
    { run: (work) => pass.solver.run(work) },
    new Map(),
    new Set(),
  );
  const want = inheritedAt(admission, ids.get("box")!, ["f"]);
  assert.deepEqual(want, { kind: "atom", name: "number" });
  const key = pass.contract.canonicalKey(keyOf(ids.get("box")!, ["f"]));
  assert.ok(isKeyId(key), "a path below a wrapper is a cursor");
  const demand = pass.receivingDomain.replayProof!(key);
  assert.equal(demand.key, `a4|${key}`);
  const exported = exportNames(pass.contract, [demand.key]);
  assert.ok(exported !== null && exported !== undefined);
  assert.equal(solveDemands(boxed, exported.names, exported.packet).length, 1);
});
