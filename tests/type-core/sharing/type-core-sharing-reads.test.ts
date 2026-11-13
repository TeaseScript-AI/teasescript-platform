// Reads that share work: the eligibility index's prefix keys (#1712), a group's missing writer (#1323) and a read's
// signature (#1822).

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { WorkLedger } from "../../../src/type-inference/core/budget.js";
import { prefixChains } from "../../../src/type-inference/core/admission/eligibility.js";
import type { Admission } from "../../../src/type-inference/core/admission.js";
import { Consumers } from "../../../src/type-inference/core/consumers.js";
import {
  keyAt,
  keyWalk,
  stepsFrom,
  stepsText,
  stepsTo,
} from "../../../src/type-inference/core/contract/key-ids.js";
import { DefinitionLists, prefixesOf } from "../../../src/type-inference/core/definitions.js";
import type { FlowNode } from "../../../src/type-inference/core/flow-graph.js";
import { Contract } from "../../../src/type-inference/core/contract.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import { inMode, inOrder, MODES, publication } from "../../helpers/type-core-oracles.js";
import { GLOBALS } from "../../helpers/type-core/type-core-sharing-setup.js";

/**
 * #1712: the alias classes' eligibility index makes each prefix key once (per-level interned keys):
 * `demandsOf` through a trie of each root's decided steps, its rests references into their decided paths, and each
 * class's prefixes of its demanded keys charged once each (`prefixChains`). Copies of a written list of depth 16, 32
 * and 64 (two copies, sharing on, source and reversed order): the index's shared build (`WorkLedger.shared`'s units)
 * grows at most 4.5 times a doubling (on main 8.8 and 9.4 times, its key texts made once per group and per demand).
 * Its memos are the build's own, made and dropped with it: the same analysis made twice charges the same builds, and a
 * restarted pass (the reversed order's depth 32 restarts, #1711's class) builds its index again whole, as the first.
 */
test("the eligibility index makes each prefix key once, its shared build quadratic in a written type's depth (#1712)", () => {
  // (each outermost shared build's units, in order, read from the ledger's own `shared` for this test alone)
  const sharedBuilds = (make: () => Answers): number[] => {
    const builds: number[] = [];
    const shared = WorkLedger.prototype.shared;
    WorkLedger.prototype.shared = function <T>(this: WorkLedger, callback: () => T): T {
      const build: typeof shared = shared.bind(this);
      if (this.sharing) return build(callback);
      const before = this.total;
      try {
        return build(callback);
      } finally {
        builds.push(this.total - before);
      }
    };
    try {
      make();
    } finally {
      WorkLedger.prototype.shared = shared;
    }
    return builds;
  };
  const source = (depth: number) =>
    `let typed:integer${"[]".repeat(depth)}=hostValue\nlet out=typed\nout=typed\nout=hostValue\nexit\n`;
  let rebuilt = 0;
  for (const mode of MODES.filter((each) => !each.unshared)) {
    const units = [16, 32, 64].map((depth) => {
      const request = coreRequest([{ path: "main.tease", source: source(depth) }], GLOBALS)!;
      const built = () => sharedBuilds(() => inMode(mode, () => analyseCore(request)));
      const builds = built();
      // (no memo outlives its build: the same analysis again charges the same builds; the index, its largest, built
      // again whole where a pass restarts, as the first pass built it)
      assert.deepEqual(built(), builds);
      const index = Math.max(...builds);
      if (builds.filter((each) => each === index).length > 1) rebuilt += 1;
      return index;
    });
    for (let index = 1; index < units.length; index += 1)
      assert.ok(units[index]! <= 4.5 * units[index - 1]!, `${JSON.stringify(mode)}: ${units}`);
  }
  assert.ok(rebuilt > 0, "a restarted pass builds its index again");
  // (the demands are today's, every split of every decided path: its prefix's key as `keptKeyAt` makes it, its rest
  // from that step on, in the groups' order; each walk's that made them, the sharing on, in both orders)
  for (const mode of MODES) {
    const admissions: Admission[] = [];
    const check = Consumers.prototype.check;
    Consumers.prototype.check = function (this: Consumers) {
      admissions.push(this.admission);
      return check.call(this);
    };
    try {
      inMode(mode, () =>
        analyseCore(coreRequest([{ path: "main.tease", source: source(16) }], GLOBALS)!),
      );
    } finally {
      Consumers.prototype.check = check;
    }
    const built = admissions.filter((admission) => admission.demands !== null);
    // (the index, and the demands it reads, a structure only the sharing makes, #1703)
    assert.equal(built.length > 0, !mode.unshared, JSON.stringify(mode));
    for (const admission of built) {
      const { contract } = admission.pass;
      const want = new Map<string, string[]>();
      for (const group of admission.groups()) {
        const path = admission.stepsAt(group);
        const walk = group.key === undefined ? null : keyWalk(contract, group.key);
        for (let length = 0; length < path.length; length += 1) {
          const key =
            walk === null
              ? keyAt(contract, group.root, stepsTo(path, length))
              : walk.prefix(length);
          want.set(key, [...(want.get(key) ?? []), stepsText(stepsFrom(path, length))]);
        }
      }
      const got = new Map(
        [...admission.demands!].map(([key, list]) => [
          key,
          list.map(({ path, from }) => stepsText(stepsFrom(path, from))),
        ]),
      );
      assert.deepEqual(got, want, JSON.stringify(mode));
    }
  }
  // (a class's prefixes, `keptPrefixes`' list, each prefix's text charged once as it is first made, nearest first)
  const work = new WorkLedger(1_000_000);
  const charged: number[] = [];
  const charge = work.charge.bind(work);
  work.charge = (counter, units = 1) => {
    charged.push(units);
    charge(counter, units);
  };
  const prefixes = prefixChains(work);
  // (another index's prefixes are its own: made and charged again, no memo shared between indexes)
  const fresh = `7|${"z".repeat(16)}.${"y".repeat(16)}.${"x".repeat(16)}`;
  const chargedBy = (): number => {
    const before = charged.length;
    prefixChains(work)(fresh);
    return charged.length - before;
  };
  const once = chargedBy();
  assert.ok(once > 0);
  assert.equal(chargedBy(), once);
  charged.length = 0;
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((step) => step.repeat(16));
  const first = `7|${a}.${b}.${c}.${d}`;
  const second = `7|${a}.${b}.${c}.${e}`;
  const units = (length: number) => (length > 32 ? (length - 32 + 7) >> 3 : 0);
  assert.deepEqual(prefixes(first), prefixesOf(first));
  assert.deepEqual(
    charged,
    prefixesOf(first)
      .map((key) => units(key.length))
      .filter((each) => each > 0),
  );
  charged.length = 0;
  assert.deepEqual(prefixes(second), prefixesOf(second));
  assert.deepEqual(prefixes(`7|${a}.${b}`), prefixesOf(`7|${a}.${b}`));
  assert.deepEqual(charged, []);
  // (at `SHORT`'s edge: a parent of 31 or 32 characters charges nothing, of 33 and 40 one unit, of 41 two; a sibling
  // below the same parent charges nothing more)
  for (const [length, expected] of [
    [31, 0],
    [32, 0],
    [33, 1],
    [40, 1],
    [41, 2],
  ] as const) {
    const parent = `7|${"p".repeat(length - 2)}`;
    const edge = prefixChains(work);
    charged.length = 0;
    assert.deepEqual(edge(`${parent}.leaf`), prefixesOf(`${parent}.leaf`));
    assert.deepEqual(charged, expected === 0 ? [] : [expected], `${length}`);
    edge(`${parent}.other`);
    assert.deepEqual(charged, expected === 0 ? [] : [expected], `${length}`);
  }
});

/**
 * #1323: where the levels fold literals alike at a path, with the sharing on, F11's `missing` below the group is each
 * member's own, the earliest standing, so it names the object the unshared join names (F28) whichever member stands
 * for the group and whatever order the stores put them in: a prefix's first read and its property index (#1456), a
 * wide object the index never takes (the levels' own read), a pair alike written before the first store, a property
 * some members hold, a projection of an inline literal, literals in other files (Codex r1), a literal inside another's
 * call argument at one and two steps, three calls deep and with the outer's object first (Astra r1), and below a list
 * the fold merged them at, the earliest lacking object not each member's first (Codex r3).
 */
test("a property store missing from literals the levels fold names the object written first, in the four modes (#1323)", () => {
  const reads =
    "let alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\n";
  const wide = (value: string): string =>
    `{f0:${value}${Array.from({ length: 9 }, (_, i) => `,g${i + 1}:1`).join("")}}`;
  const sources = [
    "let exact={f0:typed}\nlet fraction={f0:1.5}\nlet container=fraction\ncontainer=exact\nlet alias0=container\nalias0.extra0=typed\n",
    `let b=${wide("typed")}\nlet a=${wide("1.5")}\nlet container=a\ncontainer=b\n${reads}`,
    `let c={f0:1.5}\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\n${reads}`,
    `let c={f0:2.5,p:2}\nlet d={f0:typed,p:typed}\nlet b={f0:typed}\nlet a={f0:1.5,p:1}\nlet container=a\ncontainer=d\ncontainer=b\ncontainer=c\n${reads}let alias2=container\nlet got:integer=alias2.p\n`,
    // (two members alike at a held property, the one written first stored last: its group stands at its first holder)
    `let c={f0:typed,p:1.5}\nlet b={f0:1.5,p:typed}\nlet a={f0:"x",p:2.5}\nlet container=a\ncontainer=b\ncontainer=c\n${reads}let alias2=container\nlet got:integer=alias2.p\n`,
  ];
  const read = (path: string): string =>
    `function read(x:object) { let alias=x.${path}\nalias.extra=1\nreturn 0 }\n`;
  const nested = [
    `${read("p")}let result=read({noise:read({noise:0,p:{f0:1.5}}),p:{f0:1.5}})\nexit\n`,
    `${read("p.q")}let result=read({noise:read({noise:0,p:{q:{f0:1.5}}}),p:{q:{f0:1.5}}})\nexit\n`,
    `${read("p")}let result=read({noise:read({noise:read({noise:0,p:{f0:1.5}}),p:{f0:1.5}}),p:{f0:1.5}})\nexit\n`,
    `${read("p")}let result=read({p:{f0:1.5},noise:read({noise:0,p:{f0:1.5}})})\nexit\n`,
    `${read("p.q")}let result=read({p:{q:{f0:1.5}},noise:read({noise:0,p:{q:{f0:1.5}}})})\nexit\n`,
    `${read("p[0]")}let result=read({noise:read({noise:0,p:[{}]}),p:[{}]})\nexit\n`,
    `${read("p[0]")}let result=read({p:[{extra:1,noise:read({p:[{extra:1,noise:0},{f0:1.5}]})},{f0:1.5}]})\nexit\n`,
    `${read("p[0].q")}let result=read({p:[{f0:1.5,noise:read({p:[{f0:1.5,noise:0},{q:{f0:1.5}}]})},{q:{f0:1.5}}]})\nexit\n`,
  ];
  const projects: SourceFile[][] = [
    ...nested.map((source) => [{ path: "main.tease", source }]),
    ...sources.map((source) => [
      { path: "main.tease", source: `let typed:integer=17\n${source}exit\n` },
    ]),
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet early=({p:{f0:typed}}).p\nlet late=({p:{f0:1.5}}).p\nlet container=late\ncontainer=early\nlet alias=container\nalias.extra=typed\nexit\n",
      },
    ],
    [
      { path: "z.tease", source: "global late={f0:1.5}\n" },
      {
        path: "main.tease",
        source:
          "global typed:integer=17\nlet container=late\ncontainer=early\nlet alias=container\nalias.extra=typed\nexit\n",
      },
      { path: "a.tease", source: "global early={f0:typed}\n" },
    ],
  ];
  for (const files of projects) {
    const [first, ...others] = MODES.map((mode) => publication(files, mode, GLOBALS));
    assert.ok(
      first !== null && others.every((other) => other === first),
      files.map((file) => file.source).join("\n---\n"),
    );
  }
});

/**
 * #1323 (Sol's `fresh-growth` family): k calls of `read({noise:hostValue,p:{}})` and k reads of `x.p.f_i` in `read`,
 * every read a `missing` of the same objects: the members' reads that name it are shared between the reads the fold
 * proves alike (`membersMissing`'s classes), so the reads beyond the present-property control grow linearly in k, not
 * as k², with the sharing on, as the diagnostics do. #1948: and with k more calls whose arguments lack `p`, so that
 * the reads below `p` come from the property index, its holders' fold kept once per path (`holderGroups`).
 */
test("a group's missing writer is read once per class of alike reads, linear in the family's size (#1323)", () => {
  const program = (k: number, absent: boolean, lacking: boolean): SourceFile[] => [
    {
      path: "main.tease",
      source: [
        `let shared={${Array.from({ length: k }, (_, i) => `f${i}:1`).join(",")}}`,
        "function read(x:object) {",
        ...Array.from({ length: k }, (_, i) => `let got${i}=x.p.f${i}`),
        "return 0 }",
        ...Array.from(
          { length: k },
          (_, i) => `let r${i}=read({noise:hostValue,p:${absent ? "{}" : "shared"}})`,
        ),
        ...(lacking
          ? Array.from({ length: k }, (_, i) => `let z${i}=read({noise:hostValue,q:${i}})`)
          : []),
        "exit",
        "",
      ].join("\n"),
    },
  ];
  const original = Contract.prototype.contractOfValueAt;
  let reads = 0;
  Contract.prototype.contractOfValueAt = function (...args) {
    reads += 1;
    return original.apply(this, args);
  };
  try {
    for (const lacking of [false, true]) {
      const extra = (k: number): number => {
        const count = (absent: boolean): number => {
          reads = 0;
          inMode(MODES[0]!, () => analyseCore(coreRequest(program(k, absent, lacking), GLOBALS)!));
          return reads;
        };
        return count(true) - count(false);
      };
      const [small, large] = [extra(8), extra(32)];
      assert.ok(large <= 4 * small + 4, `${small} at 8, ${large} at 32, lacking ${lacking}`);
    }
  } finally {
    Contract.prototype.contractOfValueAt = original;
  }
});

test("a read's signature cuts only its source's prefixes with definitions, tagged by depth: it parts two reads of one source exactly where every prefix's cut does (#1822)", () => {
  // (a typed k-deep literal read through a copy, as the set's `typed-literal-copy-read`: each read's class asks the
  // signature of its source, a deep key whose prefixes but one have no definition)
  const head = "let typed:integer[][][][]=[[[[1]]]]\nlet out=typed";
  const read = (name: string) => `let ${name}=out[0][0][0][0]`;
  const programs = [
    [head, read("a"), read("b")],
    // a prefix stored in a branch between the reads, the parent or one below it: only that prefix's cut parts them
    [head, read("a"), "if hostValue is integer { out[0]=[[[2]]] }", read("b")],
    [head, read("a"), "if hostValue is integer { out[0][0]=[[2]] }", read("b")],
    // the reads in two branches, a prefix stored after both; a store below the path, which the source's own list cuts
    [head, "if hostValue is integer {", read("a"), "} else {", read("b"), "}", "out[0]=[[[2]]]"],
    [head, read("a"), "if hostValue is integer { out[0][0][0][0]=2 }", read("b")],
    // a prefix stored on the straight path, in a loop, by a call another callable makes (`ownedAway`); a store beside
    [head, read("a"), "out[0]=[[[2]]]", read("b")],
    [head, read("a"), "repeat 2 { out[0][0]=[[4]] }", read("b")],
    [head, "function f { out[0]=[[[5]]] }", read("a"), "f()", read("b")],
    [head, "let side=[1]", read("a"), "side[0]=2", read("b")],
  ];
  const sig = DefinitionLists.prototype.aliasSignature;
  type Call = {
    lists: DefinitionLists;
    source: string;
    node: FlowNode;
    calls: boolean;
    made: string;
  };
  let calls: Call[] = [];
  DefinitionLists.prototype.aliasSignature = function (
    this: DefinitionLists,
    source,
    node,
    flag = true,
  ) {
    const made = sig.call(this, source, node, flag);
    calls.push({ lists: this, source, node, calls: flag, made });
    return made;
  };
  const check = Consumers.prototype.check;
  let program: CoreProgram | null = null;
  Consumers.prototype.check = function (this: Consumers) {
    program = this.pass.program;
    check.call(this);
  };
  const bound = (sorted: readonly number[], target: number) => {
    let low = 0;
    for (let high = sorted.length; low < high;) {
      const middle = (low + high) >> 1;
      if (sorted[middle]! < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  let [deep, parted] = [0, 0];
  try {
    for (const lines of programs)
      for (const reversed of [false, true]) {
        calls = [];
        const source = `${lines.join("\n")}\nexit\n`;
        inOrder(reversed, () =>
          analyseCore(coreRequest([{ path: "main.tease", source }], GLOBALS)!),
        );
        // today's signature, every prefix cut untagged: the new one's last field but its prefixes' cuts, then each
        // prefix's of `prefixesOf`, the parent first
        const today = ({ lists, source, node, calls: flag, made }: Call): string => {
          const fields = made.split("|");
          const own = fields
            .at(-1)!
            .split(";")
            .slice(0, flag ? 2 : 1);
          const [begin, end] = [program!.position(node), program!.positionEnd(node) + 1];
          for (const prefix of prefixesOf(source)) {
            const positions = lists.definitionsOf(prefix).eventPositions;
            own.push(`${bound(positions, begin)},${bound(positions, end)}`);
          }
          return [...fields.slice(0, -1), own.join(";")].join("|");
        };
        for (const one of calls)
          for (const other of calls) {
            if (one.source !== other.source) continue;
            assert.equal(
              one.made === other.made,
              today(one) === today(other),
              `${one.source}\n${source}`,
            );
            // (a pair that only a prefix's cut parts: without the prefixes' cuts they would share one signature)
            const rest = (call: Call) => {
              const fields = call.made.split("|");
              const own = fields
                .at(-1)!
                .split(";")
                .slice(0, call.calls ? 2 : 1);
              return [...fields.slice(0, -1), own.join(";")].join("|");
            };
            if (one.made !== other.made && rest(one) === rest(other)) parted += 1;
          }
        deep += calls.filter(({ source }) => prefixesOf(source).length >= 4).length;
      }
  } finally {
    DefinitionLists.prototype.aliasSignature = sig;
    Consumers.prototype.check = check;
  }
  assert.ok(deep > 0, "a deep source's signature was asked");
  assert.ok(parted > 0, "two reads that a prefix's cut alone parts");
});
