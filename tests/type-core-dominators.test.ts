import assert from "node:assert/strict";
import test from "node:test";

import { CORE_RUNTIME_BUILTINS } from "../src/compiler.js";
import { staticText } from "../src/expression-children.js";
import { parse } from "../src/parser.js";
import { validateProjectSemantics } from "../src/semantic.js";
import {
  dominators,
  insideLoopsOf,
  type Dominators,
} from "../src/type-inference/core/dominators.js";
import {
  buildFlowGraph,
  type FlowGraph,
  type FlowNode,
} from "../src/type-inference/core/flow-graph.js";
import { filesOf } from "./helpers/type-core-flow-oracle.js";
import { FLOW_PROGRAMS, HOST_GLOBALS } from "./helpers/type-core-flow-programs.js";

/*
 * The dominators of the coarse core's flow graph (the coarse-core table's §3.1): Lengauer and Tarjan's algorithm
 * against the iterative one on every graph of the corpus, and the shapes the exact path depends on, each expected by
 * the table's rule or by what a run does: literal loops (P7), labels and boundaries (X4), loops (X5), computed
 * transfers (L11), blocks, early leaves (F5a), and calls that cannot return (L10).
 */

/**
 * A node by its id. Assertions compare ids, never nodes: a failing assertion prints its values in full, and a node reaches
 * the whole graph through its edges, once per way through it.
 */
const id = (node: FlowNode | null | undefined): number | null => node?.id ?? null;

function analyse(files: string | readonly { readonly path: string; readonly source: string }[]): {
  readonly graph: FlowGraph;
  readonly dom: Dominators;
  readonly at: (marker: string) => FlowNode;
  /** The node of the expression written as `text`, its first occurrence in `main.tease`. */
  readonly expression: (text: string) => FlowNode;
} {
  const sources = filesOf({ name: "shape", files });
  const parsed = sources.map((file) => {
    const result = parse(file.source);
    assert.deepEqual(result.diagnostics, [], file.source);
    return { path: file.path, program: result.program };
  });
  const names = validateProjectSemantics(parsed, {
    builtins: CORE_RUNTIME_BUILTINS,
    globals: HOST_GLOBALS,
  });
  const graph = buildFlowGraph(
    parsed.map((file, index) => ({ ...file, picks: names[index]!.picks })),
  );
  const markers = new Map<string, FlowNode>();
  for (const node of graph.nodes)
    if (node.statement?.kind === "sayStatement") {
      const text = staticText(node.statement.value);
      if (text !== undefined) markers.set(text, node);
    }
  return {
    graph,
    dom: dominators(graph),
    at: (marker) => {
      const node = markers.get(marker);
      assert.notEqual(node, undefined, `marker ${marker}`);
      return node!;
    },
    expression: (text) => {
      const start = sources[0]!.source.indexOf(text);
      const node = graph.expressionAt({ file: 0, start, end: start + text.length });
      assert.notEqual(node, undefined, `expression ${text}`);
      return node!;
    },
  };
}

test("the dominators agree with the iterative algorithm on every graph of the corpus", () => {
  for (const program of FLOW_PROGRAMS) {
    const { graph, dom } = analyse(program.files);
    const counts = (from: FlowNode, to: FlowNode): boolean =>
      !(from.dead && !to.dead) && !(graph.isDeadEdge(from, to) && !to.dead);
    // Cooper, Harvey and Kennedy: immediate dominators by intersecting the predecessors' in reverse postorder.
    const order: FlowNode[] = [];
    {
      const seen = new Set<FlowNode>([graph.program.entry]);
      const stack: [FlowNode, number][] = [[graph.program.entry, 0]];
      while (stack.length > 0) {
        const top = stack.at(-1)!;
        const [node, index] = top;
        if (index < node.successors.length) {
          top[1] = index + 1;
          const next = node.successors[index]!;
          if (!seen.has(next) && counts(node, next)) {
            seen.add(next);
            stack.push([next, 0]);
          }
        } else {
          order.push(node);
          stack.pop();
        }
      }
    }
    order.reverse();
    assert.equal(
      order.length,
      graph.nodes.length,
      `${program.name}: the search reaches every node`,
    );
    const rank = new Map(order.map((node, index) => [node, index]));
    const idom = new Map<FlowNode, FlowNode>([[graph.program.entry, graph.program.entry]]);
    const intersect = (a: FlowNode, b: FlowNode): FlowNode => {
      while (a !== b) {
        while (rank.get(a)! > rank.get(b)!) a = idom.get(a)!;
        while (rank.get(b)! > rank.get(a)!) b = idom.get(b)!;
      }
      return a;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const node of order) {
        if (node === graph.program.entry) continue;
        let candidate: FlowNode | null = null;
        for (const predecessor of node.predecessors)
          if (idom.has(predecessor) && counts(predecessor, node))
            candidate = candidate === null ? predecessor : intersect(predecessor, candidate);
        if (candidate !== null && idom.get(node) !== candidate) {
          idom.set(node, candidate);
          changed = true;
        }
      }
    }
    for (const node of graph.nodes) {
      assert.equal(
        id(dom.idom(node)),
        id(idom.get(node)),
        `${program.name}: the dominator of node ${node.id}`,
      );
      const above = idom.get(node)!;
      // The intervals nest as the tree does, so a dominance query is two comparisons.
      if (above !== node)
        assert.ok(
          dom.dfsIn(above) < dom.dfsIn(node) && dom.dfsOut(node) < dom.dfsOut(above),
          `${program.name}: the interval of node ${node.id} lies in its dominator's`,
        );
      // The nearest boundary and block entry are found up the tree. A boundary is X4's: a function's entry, a file's
      // entry that something other than the session's start enters, a label that some `goto` enters.
      const boundary = (candidate: FlowNode): boolean =>
        candidate.kind === "function-entry" ||
        (candidate.kind === "file-entry" &&
          candidate.predecessors.some(
            (before) => before.kind !== "startup-exit" && counts(before, candidate),
          )) ||
        (candidate.statement?.kind === "labelStatement" &&
          candidate.predecessors.some(
            (before) => before !== candidate.fallthrough && counts(before, candidate),
          ));
      let nearest: FlowNode | null = null;
      let block: FlowNode | null = null;
      for (
        let up: FlowNode | null = node;
        up !== null;
        up = up === graph.program.entry ? null : idom.get(up)!
      ) {
        if (nearest === null && boundary(up)) nearest = up;
        if (block === null && up.kind === "handler-entry") block = up;
      }
      assert.equal(
        id(dom.edom(node)),
        id(nearest),
        `${program.name}: the boundary of node ${node.id}`,
      );
      assert.equal(
        id(dom.hdom(node)),
        id(block),
        `${program.name}: the block entry of node ${node.id}`,
      );
    }
  }
});

test("a literal count of one or more runs the body before the loop is left (P7)", () => {
  const twice = analyse('repeat 2 {\n  say "B"\n  say "D"\n}\nsay "R"\nexit');
  assert.equal(twice.dom.dominates(twice.at("D"), twice.at("R")), true);
  assert.equal(insideLoopsOf(twice.at("D"), twice.at("R")), true);
  const folded = analyse('repeat (1 + 1) {\n  say "D"\n}\nsay "R"\nexit');
  assert.equal(folded.dom.dominates(folded.at("D"), folded.at("R")), true);
  const unknown = analyse('repeat hostValue {\n  say "D"\n}\nsay "R"\nexit');
  assert.equal(unknown.dom.dominates(unknown.at("D"), unknown.at("R")), false);
  const never = analyse('repeat 0 {\n  say "B"\n}\nsay "R"\nexit');
  assert.deepEqual([never.at("B").dead, never.at("R").dead], [true, false]);
  const forever = analyse('while true {\n  say "B"\n  if hostFlag { break }\n}\nsay "R"\nexit');
  assert.equal(forever.dom.dominates(forever.at("B"), forever.at("R")), true);
  const maybe = analyse('while hostFlag {\n  say "B"\n}\nsay "R"\nexit');
  assert.equal(maybe.dom.dominates(maybe.at("B"), maybe.at("R")), false);
  // A `for` over a literal collection: an empty one never runs its body, a non-empty one runs it first (r4.22).
  const filled = analyse('for item in [1, 2] {\n  say "D"\n}\nsay "R"\nexit');
  assert.equal(filled.dom.dominates(filled.at("D"), filled.at("R")), true);
  const empty = analyse('for item in [] {\n  say "B"\n}\nsay "R"\nexit');
  assert.deepEqual([empty.at("B").dead, empty.at("R").dead], [true, false]);
  const host = analyse('for item in hostList {\n  say "D"\n}\nsay "R"\nexit');
  assert.equal(host.dom.dominates(host.at("D"), host.at("R")), false);
});

test("a literal count of one has no second round, and a `continue` ends it (P7)", () => {
  const once = analyse('repeat 1 {\n  say "B"\n  say "D"\n}\nsay "R"\nexit');
  assert.equal(once.dom.dominates(once.at("D"), once.at("R")), true);
  const reached = new Set<FlowNode>();
  const work = [once.at("D")];
  while (work.length > 0)
    for (const next of work.pop()!.successors)
      if (!reached.has(next)) {
        reached.add(next);
        work.push(next);
      }
  assert.equal(reached.has(once.at("B")), false);
  // A run that takes the `continue` leaves the loop without "D", so "D" does not dominate what follows the loop.
  const leaving = analyse(
    'repeat 1 {\n  say "B"\n  if hostFlag { continue }\n  say "D"\n}\nsay "R"\nexit',
  );
  assert.equal(leaving.at("R").dead, false);
  assert.equal(leaving.dom.dominates(leaving.at("D"), leaving.at("R")), false);
  assert.equal(leaving.dom.dominates(leaving.at("B"), leaving.at("R")), true);
});

test("a condition its literals decide has a dead way, as the type check reads conditions (P7)", () => {
  for (const [condition, dead] of [
    ["not false", "C"],
    ["hostFlag and false", "B"],
    ["hostFlag or true", "C"],
    ["(true) and not false", "C"],
  ] as const) {
    const { at } = analyse(`if ${condition} {\n  say "B"\n} else {\n  say "C"\n}\nexit`);
    assert.equal(at(dead).dead, true, condition);
    assert.equal(at(dead === "B" ? "C" : "B").dead, false, condition);
  }
});

test("every loop around a read must enclose its definition (X5)", () => {
  const { at } = analyse(
    'say "BEFORE"\nrepeat hostValue {\n  say "OUTER"\n  repeat hostValue {\n    say "INNER"\n  }\n  say "AFTER_INNER"\n}\nexit',
  );
  assert.equal(insideLoopsOf(at("BEFORE"), at("OUTER")), false);
  assert.equal(insideLoopsOf(at("OUTER"), at("AFTER_INNER")), true);
  assert.equal(insideLoopsOf(at("INNER"), at("AFTER_INNER")), true);
  assert.equal(insideLoopsOf(at("OUTER"), at("INNER")), false);
  assert.equal(insideLoopsOf(at("INNER"), at("BEFORE")), true);
  const each = analyse('for item in hostList {\n  say "BODY"\n}\nexit');
  // A loop variable's binding counts as inside its loop.
  assert.equal(insideLoopsOf(each.graph.loops[0]!.body, each.at("BODY")), true);
});

test("a label that some `goto` enters is a boundary, one that only the code before it reaches is not (X4)", () => {
  // L2: the label before both, the `goto` after both: the same boundary.
  const before = analyse('label again\nsay "D"\nsay "N"\nif hostFlag { goto again }\nexit');
  assert.equal(id(before.dom.edom(before.at("D"))), id(before.dom.edom(before.at("N"))));
  assert.equal(before.dom.edom(before.at("N"))?.statement?.kind, "labelStatement");
  // L3, L4: the label between them, entered by a `goto`, also behind another label.
  for (const labels of ["label again", "label again\nlabel next"]) {
    const between = analyse(`say "D"\n${labels}\nsay "N"\nif hostFlag { goto again }\nexit`);
    assert.equal(id(between.dom.edom(between.at("D"))), null, labels);
    assert.notEqual(id(between.dom.edom(between.at("N"))), null, labels);
  }
  // L5: a label that no `goto` enters.
  const unused = analyse('say "D"\nlabel again\nsay "N"\nexit');
  assert.equal(id(unused.dom.edom(unused.at("N"))), null);
});

test("a function's entry and the entry of a file that something enters are boundaries (X4)", () => {
  const { graph, dom, at } = analyse([
    {
      path: "main.tease",
      source: 'say "MAIN"\nfunction f {\n  say "F"\n}\nf()\ncall "part.tease"\nexit',
    },
    { path: "part.tease", source: 'say "PART"\nend' },
  ]);
  assert.equal(id(dom.edom(at("MAIN"))), null);
  assert.equal(dom.edom(at("F"))?.kind, "function-entry");
  const part = graph.regions.find(
    (region) => region.kind === "file" && region.path === "part.tease",
  )!;
  assert.equal(id(dom.edom(at("PART"))), id(part.entry));
  // The file the session starts in becomes a boundary once a transfer may enter it again.
  const again = analyse([
    { path: "main.tease", source: 'say "MAIN"\ncall "part.tease"\nexit' },
    { path: "part.tease", source: 'goto "main.tease"' },
  ]);
  assert.equal(again.dom.edom(again.at("MAIN"))?.kind, "file-entry");
});

test("a computed transfer may enter every file: one call site, or a jump to every entry (L11)", () => {
  const files = (transfer: string) => [
    { path: "main.tease", source: `say "MAIN"\n${transfer} (script(hostText))\nexit` },
    { path: "one.tease", source: 'say "ONE"\nend' },
    { path: "two.tease", source: 'say "TWO"\nend' },
  ];
  const call = analyse(files("call"));
  assert.equal(call.graph.sites.length, 1);
  assert.deepEqual(
    call.graph.sites[0]!.callees.map((callee) =>
      callee.kind === "file" ? callee.path : callee.kind,
    ),
    ["main.tease", "one.tease", "two.tease"],
  );
  assert.equal(call.graph.sites[0]!.uncertain, true);
  assert.equal(call.dom.edom(call.at("ONE"))?.kind, "file-entry");
  const jump = analyse(files("goto"));
  assert.deepEqual(
    jump.graph.jumps[0]!.targets.map((target) => target.kind),
    ["file-entry", "file-entry", "file-entry"],
  );
  assert.deepEqual([jump.at("ONE").dead, jump.at("TWO").dead], [false, false]);
});

test("code in a block has its block's entry as the nearest block entry", () => {
  const { dom, at } = analyse(
    'say "OUT"\nshowPermanentButton "Go" {\n  say "IN"\n  let t = timer(duration: 1 s, async: true) {\n    say "NESTED"\n  }\n}\nwait 1 s\nexit',
  );
  assert.equal(id(dom.hdom(at("OUT"))), null);
  assert.equal(dom.hdom(at("IN"))?.kind, "handler-entry");
  assert.notEqual(id(dom.hdom(at("NESTED"))), id(dom.hdom(at("IN"))));
  assert.equal(dom.dominates(dom.hdom(at("IN"))!, at("NESTED")), true);
});

test("the way past a branch that always leaves dominates the code after it, and only a `break` or `goto` leaves a loop (F5a)", () => {
  const leave = analyse('if hostFlag {\n  exit\n}\nsay "R"\nexit');
  assert.equal(
    leave.dom.dominates(leave.graph.conditionUses[0]!.branches[1]!, leave.at("R")),
    true,
  );
  const otherwise = analyse('if hostFlag {\n  exit\n} else {\n  say "E"\n}\nsay "R"\nexit');
  assert.equal(otherwise.dom.dominates(otherwise.at("E"), otherwise.at("R")), true);
  const left = (body: string): readonly boolean[] => {
    const { graph } = analyse(
      `label top\nrepeat hostValue {\n  repeat hostValue {\n    ${body}\n  }\n}\nexit`,
    );
    return graph.loops.map((loop) => graph.leftBy.has(loop.head));
  };
  assert.deepEqual(left("if hostFlag { goto top }"), [true, true]);
  assert.deepEqual(left("if hostFlag { break }"), [false, true]);
  for (const body of ["if hostFlag { continue }", "if hostFlag { exit }", 'say "x"'])
    assert.deepEqual(left(body), [false, false], body);
});

test("a callable that calls and file transfers may run twice at once is recursive (F21's condition)", () => {
  const recursive = (files: Parameters<typeof analyse>[0]): string[] => {
    const { graph } = analyse(files);
    return graph.callables
      .filter((callable) => graph.recursive.has(callable))
      .map((callable) =>
        callable.kind === "function" ? callable.declaration.name.name : callable.path,
      )
      .sort();
  };
  assert.deepEqual(recursive('function once {\n  say "x"\n}\nonce()\nexit'), []);
  assert.deepEqual(recursive('label top\nsay "x"\nif hostFlag { goto top }\nexit'), []);
  assert.deepEqual(recursive("function f(n) {\n  if n > 0 { f(n - 1) }\n}\nf(2)\nexit"), ["f"]);
  assert.deepEqual(
    recursive("function f {\n  g()\n}\nfunction g {\n  if hostFlag { f() }\n}\nf()\nexit"),
    ["f", "g"],
  );
  // One call of `visit`, which calls a file that starts, by a `goto`, the file that calls `visit` again.
  assert.deepEqual(
    recursive([
      { path: "main.tease", source: 'global depth = 0\ncall "b.tease"\nexit' },
      {
        path: "a.tease",
        source:
          'global function visit(n) {\n  if n < 2 {\n    depth = n + 1\n    call "a.tease"\n  }\n}\ngoto "b.tease"',
      },
      { path: "b.tease", source: "visit(depth)\nend" },
    ]),
    ["a.tease", "b.tease", "visit"],
  );
});

test("operands run in written order, each call before the next, across summarized calls (V30 order, F21)", () => {
  const helpers =
    'function left {\n  say "LEFT"\n  return 1\n}\nfunction right {\n  say "RIGHT"\n  return 2\n}\nfunction pair(a, b) {\n  return a\n}\n';
  for (const [use, first, second] of [
    ["let p = pair(left(), right())", "left()", "right()"],
    ["let p = pair(b: right(), a: left())", "right()", "left()"],
    ["let p = left() + right()", "left()", "right()"],
    ["let p = [left(), right()]", "left()", "right()"],
    ["let p = [left()].get(right(), default: 0)", "left()", "right()"],
  ] as const) {
    const { dom, expression } = analyse(`${use}\n${helpers}exit`);
    assert.equal(dom.dominates(expression(first), expression(second)), true, use);
    assert.equal(dom.dominates(expression(second), expression(first)), false, use);
  }
  const { dom, expression } = analyse(`let p = pair(left(), right())\n${helpers}exit`);
  assert.equal(dom.dominates(expression("right()"), expression("pair(left(), right())")), true);
});

test("each parameter has its own binding node, in order, after its default (F21, F22)", () => {
  const { graph, dom, at, expression } = analyse(
    'function f(a, b = g(), c: integer = 3) {\n  say "BODY"\n}\nfunction g {\n  return 1\n}\nf(1)\nf(1, 2)\nexit',
  );
  const f = graph.regions.find(
    (region) => region.kind === "function" && region.declaration.name.name === "f",
  );
  assert.equal(f?.kind, "function");
  const bindings = ["a", "b", "c"].map((name) =>
    f?.kind === "function" ? f.parameters.get(name) : undefined,
  );
  assert.deepEqual(
    bindings.map((node) => node?.kind),
    ["parameter", "parameter", "parameter"],
  );
  assert.equal(new Set(bindings.map(id)).size, 3);
  const a = bindings[0]!;
  const b = bindings[1]!;
  const c = bindings[2]!;
  assert.equal(dom.dominates(f!.entry, a), true);
  assert.equal(dom.dominates(a, b) && dom.dominates(b, c) && dom.dominates(c, at("BODY")), true);
  // `b`'s default runs after `a` is bound, and only where a call leaves `b` out.
  assert.equal(dom.dominates(a, expression("g()")), true);
  assert.equal(dom.dominates(expression("g()"), b), false);
});

test("a global with a default has a session-start store and an executable store, each with its own lookup (F1a)", () => {
  const source =
    'say "BEFORE"\nglobal n = 1, default: 0\nsay "AFTER"\nspeaker vera { mood: "calm" }\nexit';
  const { graph, dom, at } = analyse(source);
  const site = (text: string) => {
    const start = source.indexOf(text);
    return { file: 0, start, end: start + text.length };
  };
  const global = site("global n = 1, default: 0");
  const start = graph.startupAt(global);
  const store = graph.statementAt(global);
  assert.deepEqual(
    [start, store].map((node) => (node === undefined ? null : graph.regions[node.region]!.kind)),
    ["startup", "file"],
  );
  assert.equal(dom.dominates(start!, at("BEFORE")), true);
  assert.equal(dom.dominates(at("BEFORE"), store!), true);
  // A speaker is set up at session start and runs nothing where it stands.
  const speaker = site('speaker vera { mood: "calm" }');
  assert.equal(graph.regions[graph.startupAt(speaker)!.region]!.kind, "startup");
  assert.equal(graph.statementAt(speaker), undefined);
});

test("code after a call that cannot return is dead, and after one that may return it is not (L10)", () => {
  const live = (files: Parameters<typeof analyse>[0]): boolean => !analyse(files).at("R").dead;
  assert.equal(live('function stop {\n  exit\n}\nstop()\nsay "R"\nexit'), false);
  assert.equal(live('function maybe {\n  if hostFlag { exit }\n}\nmaybe()\nsay "R"\nexit'), true);
  // A call of itself before any return never returns: the run fails once the calls nest too deep.
  assert.equal(live('function spin {\n  spin()\n}\nspin()\nsay "R"\nexit'), false);
  assert.equal(
    live([
      { path: "main.tease", source: 'call "part.tease"\nsay "R"\nexit' },
      { path: "part.tease", source: 'say "P"\nexit' },
    ]),
    false,
  );
  // A file returns through a file it starts with `goto` that ends, and through a function that ends it.
  assert.equal(
    live([
      { path: "main.tease", source: 'call "a.tease"\nsay "R"\nexit' },
      { path: "a.tease", source: 'goto "b.tease"' },
      { path: "b.tease", source: "end" },
    ]),
    true,
  );
  assert.equal(
    live([
      { path: "main.tease", source: 'call "part.tease"\nsay "R"\nexit' },
      { path: "part.tease", source: "function leave {\n  end\n}\nleave()\nexit" },
    ]),
    true,
  );
  // A block may end the running file at any wait: here the called file, which never ends itself, returns through it.
  assert.equal(
    live([
      {
        path: "main.tease",
        source: 'showPermanentButton "Stop" {\n  end\n}\ncall "part.tease"\nsay "R"\nexit',
      },
      { path: "part.tease", source: 'say "P"\nwait 1 s\nexit' },
    ]),
    true,
  );
  // A `goto` out of a function to a label returns the file only through the label's continuation (r4.25).
  const leave = (ending: string) => [
    { path: "main.tease", source: 'say "START"\ncall "part.tease"\nsay "R"\nexit' },
    {
      path: "part.tease",
      source: `function f {\n  goto done\n}\nf()\nlabel done\nsay "TARGET"\n${ending}`,
    },
  ];
  assert.equal(live(leave("exit")), false);
  assert.equal(live(leave("end")), true);
  // Only a block whose registration can run may end a running file: not one in dead code or an uncalled function.
  for (const never of [
    'if false {\n  showPermanentButton "Never" {\n    end\n  }\n}\n',
    'function unused {\n  showPermanentButton "Never" {\n    end\n  }\n}\n',
  ])
    assert.equal(
      live([
        { path: "main.tease", source: `${never}call "part.tease"\nsay "R"\nexit` },
        { path: "part.tease", source: 'say "TARGET"\nwait 1 s\nexit' },
      ]),
      false,
      never,
    );
  // A glob call returns when one of the files it may pick returns.
  const glob = (second: string) => [
    { path: "main.tease", source: 'call "parts/*.tease"\nsay "R"\nexit' },
    { path: "parts/a.tease", source: "exit" },
    { path: "parts/b.tease", source: second },
  ];
  assert.equal(live(glob("end")), true);
  assert.equal(live(glob("exit")), false);
});
