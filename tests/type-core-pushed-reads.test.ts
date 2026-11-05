import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { Consumers } from "../src/type-inference/core/consumers.js";
import { pushedFacts, withoutPushedReads } from "../src/type-inference/core/contract/frontier.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { inMode, MODES, publication } from "./helpers/type-core-oracles.js";

/*
 * #1655 (TABLE r4.385): a key entry below its place's root in a copy cycle through a projection (`p1 = p1.q` beside the
 * ring `p1 = p0`, `p0 = p1`) is read one step at a time below its writing edge (`contract/frontier.ts`), over a finite
 * producer graph of the pass, instead of as a longer key at every read. Where the native reader ends (a terminating
 * spine, a ring without its closing copy) the two publish the same; where it does not, the program now reaches its
 * check, and the graph grows with the ring and the projection, not with the reads.
 */

const GLOBALS = ["hostValue", "hostOther"];

interface Ring {
  readonly n?: number;
  readonly d?: number;
  readonly q?: string;
  readonly sides?: readonly string[];
  readonly cycle?: boolean;
  readonly extra?: readonly string[];
}

/** The issue's ring of `n` whole copies, its last member holding `q` and read back through its projection `d` deep. */
function ring({ n = 2, d = 1, q = "p0", sides = ["s"], cycle = true, extra = [] }: Ring): string {
  const last = `p${n - 1}`;
  const rows = ["let typed:object={x:1}", "let p0={g:2}"];
  for (let i = 1; i < n; i++) rows.push(`let p${i}={f:typed,g:"s"}`);
  for (const side of sides) rows.push(`${last}.${side}=p0`);
  rows.push(`${last}.q=${q}`);
  for (let i = n - 1; i > 0; i--) rows.push(`p${i}=p${i - 1}`);
  if (cycle) rows.push(`p0=${last}`);
  rows.push(`${last}=${last}${".q".repeat(d)}`, ...extra);
  rows.push(`${last}.f=hostValue`, "let out={p:p0}", "out.p.g=hostOther", 'say "AFTER"', "exit");
  return rows.join("\n") + "\n";
}

/** A literal spine `{q:{q:…leaf}}` of depth `k`. */
function spine(k: number, leaf = '{f:typed,g:"end"}'): string {
  return `${"{q:".repeat(k - 1)}${leaf}${"}".repeat(k - 1)}`;
}

function analysed(source: string, mode = MODES[0]!) {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const passes: CorePass[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    passes.push(this.pass);
    check.call(this);
  };
  try {
    const answers = inMode(mode, () => analyseCore(request));
    // (the publishing pass's graph, and every pass's)
    const all = passes.map((pass) => pushedFacts(pass.contract));
    return { answers, facts: all.at(-1)!, all };
  } finally {
    Consumers.prototype.check = check;
  }
}

test("a ring of whole copies read through a projection reaches its check in four modes", () => {
  const sources = [
    ring({}),
    ring({ sides: ["s0", "s1"] }),
    ring({ d: 3 }),
    ring({ n: 3 }),
    // a store below the projection, read there
    ring({ extra: ["p1.q.q.g=5", 'say "${p1.q.q.g}"'] }),
  ];
  for (const source of sources)
    for (const mode of MODES) {
      const { answers, all } = analysed(source, mode);
      assert.equal(answers.budget.exhausted, null, source);
      assert.ok(
        all.some((facts) => facts.reads > 0) && all.every((facts) => facts.declines.size === 0),
        source,
      );
    }
});

test("where the native reader ends, a pushed read publishes what it does, in four modes", () => {
  const controls = [
    // terminating spines: with the ring, without its closing copy, with a ring of four, read back to the spine's end
    ring({ q: spine(3) }),
    ring({ q: spine(3), cycle: false }),
    ring({ n: 4, q: spine(2) }),
    ring({ q: spine(3), extra: ['say "${p1.q.q.q.g}"'] }),
    // a host's unknown beside the literals' `missing` (reasons that are not `missing` alone), an operation's (`fan`)
    ring({ q: spine(2, "hostValue"), extra: ['say "${p1.q.q.q}"'] }),
    ring({ q: spine(2, "{f:hostValue+1}"), extra: ['say "${p1.q.q.f}"'] }),
    // the ring without its closing copy, with a store below the projection read there
    ring({ cycle: false }),
    ring({ cycle: false, extra: ["p1.q.q.g=5", 'say "${p1.q.q.g}"'] }),
    // a chain of three whose literals all lack the step: a read that is `missing` alone, its earliest literal's
    ring({ n: 3, q: spine(1, "{g:1}"), cycle: false, extra: ['say "${p2.q.q.q}"'] }),
  ];
  for (const source of controls)
    for (const mode of MODES) {
      const files = [{ path: "main.tease", source }];
      const pushed = publication(files, mode, GLOBALS);
      const native = withoutPushedReads(() => publication(files, mode, GLOBALS));
      assert.ok(pushed !== null, source);
      assert.equal(pushed, native, source);
    }
});

test("the producer graph grows with the ring and the projection's depth, each by a constant", () => {
  const rings = [4, 8, 16].map((n) => analysed(ring({ n })).facts);
  const depths = [4, 8, 16].map((d) => analysed(ring({ d })).facts);
  for (const sizes of [rings, depths])
    for (const field of ["nodes", "goals", "edges", "sets"] as const)
      assert.equal(
        sizes[2]![field] - sizes[1]![field],
        2 * (sizes[1]![field] - sizes[0]![field]),
        `${field}: ${sizes.map((facts) => facts[field]).join(", ")}`,
      );
});
