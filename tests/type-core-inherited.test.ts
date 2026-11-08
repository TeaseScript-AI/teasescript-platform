import assert from "node:assert/strict";
import test from "node:test";

import { Admission, admissionRunsInsideSolverRuns } from "../src/type-inference/core/admission.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { inheritedAt } from "../src/type-inference/core/inherited/inherited.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";
import { HELD_MODES, heldFamily, heldProblems, heldStops } from "./helpers/type-core-held-host.js";
import { inMode, MODES, publication } from "./helpers/type-core-oracles.js";

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

test("after a stop a key whose proof did not finish is resolved by its own scan: a copy of a written object keeps its boundary check at every settled walk and extraction stop", () => {
  // (the held family's cases where an unfinished proof read as none lost root's check, #1072 A2's ruling on option 1)
  for (const name of ["writtenObjectBelow-4-repeat-plain", "writtenObjectBelow-4-written-plain"]) {
    const c = heldFamily().find((each) => each.name === name)!;
    const mode = HELD_MODES[0]!;
    const stops = heldStops(c, mode).filter(
      (stop) => stop.phase === "walk" || stop.phase === "extraction",
    );
    assert.ok(stops.length > 0, name);
    for (const { allowance, phase } of stops)
      assert.deepEqual(heldProblems(c, mode, allowance), [], `${name} ${phase} @${allowance}`);
  }
});
