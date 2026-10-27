import { boundParameterName } from "../../../function-arguments.js";
import type { BuildNode, FlowGraphBuilder } from "../flow-graph.js";
import { edgeKey } from "./keys.js";
import type { CallSite, FlowNode, FunctionRegion, HandlerRegion } from "./model.js";

// What never runs: the dead edges of decided defaults and of calls that cannot return, unentered code, liveness.

/**
 * P7: a default that every call supplies never runs, and one that no call supplies always runs. Each call's arguments
 * are bound to parameters once, as the lowering binds them (`boundParameterName`), and counted per parameter.
 */
export function decideDefaults(builder: FlowGraphBuilder): void {
  const suppliedBy = new Map<FunctionRegion, Map<string, number>>();
  const supplied = (callee: FunctionRegion): Map<string, number> => {
    const known = suppliedBy.get(callee);
    if (known !== undefined) return known;
    const counts = new Map<string, number>();
    for (const site of callee.sites) {
      if (site.call === null) continue;
      const bound = new Set<string>();
      site.call.arguments.forEach((argument, index) => {
        const name = boundParameterName(callee.declaration.parameters, argument, index);
        if (name !== undefined) bound.add(name);
      });
      for (const name of bound) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    suppliedBy.set(callee, counts);
    return counts;
  };
  for (const choice of builder.defaultChoices) {
    const sites = choice.function.sites.length;
    if (sites === 0) continue;
    const count = supplied(choice.function).get(choice.name) ?? 0;
    if (count === sites) {
      for (const next of choice.before.successors)
        if (next !== choice.binding) builder.deadEdges.add(edgeKey(choice.before, next));
    } else if (count === 0) builder.deadEdges.add(edgeKey(choice.before, choice.binding));
  }
}

/**
 * Which calls can return (G1(a)(b), L10, L11), by one least fixpoint over three facts, each node taking each fact
 * once. Two are carried backward over each region's own nodes: a node can reach its function's exit (a `return`), or
 * it can reach an `end` of the running file. A file's exit (its `end` statements, and its end, which the compiler's
 * closing `end` reaches) and every `end` in a function or block have the second. A call has a fact of the node after
 * it once a callee returns, and the second fact also once a function it calls may end the running file; a `goto` of
 * files has the second once one of them returns, since a started file's `end` returns to the running file's caller; a
 * `goto` from a function or block to a label has it once the label's own continuation has it (r4.25). A function
 * returns when its entry has the first fact and may end the running file when its entry has the second; a file
 * returns when its entry has the second.
 *
 * The third fact is carried forward from the session's start: the node is reached, crossing a call's summary edge
 * only once a callee is known to return. A block that may end a running file makes every file return (it may run
 * while any file runs), but only once its entry has the second fact and its registration is reached (r4.26): so a
 * block registered after a call that cannot return never justifies that call's return. Each dependency waits in one
 * list, registered once and woken once. A summary edge whose callees cannot return is dead.
 */
export function decideReturns(builder: FlowGraphBuilder): void {
  const regions = builder.regions;
  const RETURN = 0;
  const END = 1;
  const facts = [
    new Uint8Array(builder.nodes.length),
    new Uint8Array(builder.nodes.length),
  ] as const;
  const reached = new Uint8Array(builder.nodes.length);
  const returns = new Uint8Array(regions.length);
  const ends = new Uint8Array(regions.length);
  let blockEnds = false;
  const siteByCallOut = new Map<FlowNode, CallSite>();
  const siteByCallIn = new Map<FlowNode, CallSite>();
  for (const site of builder.sites) {
    siteByCallOut.set(site.callOut, site);
    siteByCallIn.set(site.callIn, site);
  }
  const created = new Map<FlowNode, HandlerRegion[]>();
  for (const handler of builder.handlers) {
    const list = created.get(handler.creation);
    if (list === undefined) created.set(handler.creation, [handler]);
    else list.push(handler);
  }
  /** A fact that a node takes once a callable returns, or once a function may end the running file. */
  type Waiting = { readonly node: FlowNode; readonly fact: typeof RETURN | typeof END };
  const onReturn = new Map<number, Waiting[]>();
  const onEnd = new Map<number, Waiting[]>();
  const onLabel = new Map<FlowNode, FlowNode[]>();
  /** The node after a call that the forward search reaches once one of its callees returns. */
  const reachOnReturn = new Map<number, FlowNode[]>();
  const wait = <K, V>(lists: Map<K, V[]>, key: K, waiting: V): void => {
    const list = lists.get(key);
    if (list === undefined) lists.set(key, [waiting]);
    else list.push(waiting);
  };
  const backward: Waiting[] = [];
  const forward: BuildNode[] = [];
  const give = (node: FlowNode, fact: typeof RETURN | typeof END): void => {
    if (facts[fact][node.id] === 1) return;
    facts[fact][node.id] = 1;
    backward.push({ node, fact });
  };
  const reach = (node: FlowNode): void => {
    if (reached[node.id] === 1) return;
    reached[node.id] = 1;
    forward.push(builder.built(node));
  };
  const markReturns = (region: number): void => {
    if (returns[region] === 1) return;
    returns[region] = 1;
    for (const waiting of onReturn.get(region) ?? []) give(waiting.node, waiting.fact);
    onReturn.delete(region);
    for (const after of reachOnReturn.get(region) ?? []) reach(after);
    reachOnReturn.delete(region);
  };
  const markEnds = (region: number): void => {
    if (ends[region] === 1) return;
    ends[region] = 1;
    for (const waiting of onEnd.get(region) ?? []) give(waiting.node, waiting.fact);
    onEnd.delete(region);
  };
  /** A registered block may end the running file: every file returns. */
  const markBlockEnds = (): void => {
    if (blockEnds) return;
    blockEnds = true;
    for (const file of builder.fileRegions) markReturns(file.id);
  };
  for (const site of builder.sites)
    for (const callee of site.callees)
      if (callee.kind === "function") wait(onEnd, callee.id, { node: site.callIn, fact: END });
  for (const jump of builder.jumps)
    if (jump.kind === "file")
      for (const file of jump.files) wait(onReturn, file.id, { node: jump.node, fact: END });
    else if (regions[jump.node.region]!.kind !== "file")
      for (const label of jump.targets) wait(onLabel, label, jump.node);
  for (const region of regions)
    if (region.kind === "function") give(region.exit, RETURN);
    else if (region.kind === "file") give(region.exit, END);
  for (const node of builder.ends) give(node, END);
  reach(builder.program.entry);
  while (backward.length > 0 || forward.length > 0) {
    if (forward.length > 0) {
      const node = forward.pop()!;
      for (const handler of created.get(node) ?? [])
        if (facts[END][handler.entry.id] === 1) markBlockEnds();
      const site = siteByCallIn.get(node);
      for (const next of node.successors) {
        if (builder.deadEdges.has(edgeKey(node, next))) continue;
        if (site === undefined || next !== site.callOut) reach(next);
        else if (site.callees.some((callee) => returns[callee.id] === 1)) reach(next);
        else for (const callee of site.callees) wait(reachOnReturn, callee.id, next);
      }
      continue;
    }
    const { node, fact } = backward.pop()!;
    const region = regions[node.region]!;
    if (node === region.entry)
      if (region.kind === "function") {
        if (fact === RETURN) markReturns(region.id);
        else markEnds(region.id);
      } else if (region.kind === "file") {
        if (fact === END) markReturns(region.id);
      } else if (region.kind === "handler" && fact === END && reached[region.creation.id] === 1)
        markBlockEnds();
    if (fact === END) for (const from of onLabel.get(node) ?? []) give(from, END);
    const site = siteByCallOut.get(node);
    for (const before of node.predecessors) {
      if (before.region !== node.region || builder.deadEdges.has(edgeKey(before, node))) continue;
      if (site === undefined || before !== site.callIn) give(before, fact);
      else if (site.callees.some((callee) => returns[callee.id] === 1)) give(before, fact);
      else for (const callee of site.callees) wait(onReturn, callee.id, { node: before, fact });
    }
  }
  for (const site of builder.sites)
    if (!site.callees.some((callee) => returns[callee.id] === 1))
      builder.deadEdges.add(edgeKey(site.callIn, site.callOut));
}

/**
 * A function nothing calls, a file nothing enters, and every node that no edge reaches, such as a label nothing jumps
 * to or a cycle nothing enters, hang below the startup region by dead edges, so that every node has a dominator.
 */
export function joinUnentered(builder: FlowGraphBuilder): void {
  const from = builder.built(builder.startup.exit);
  for (const region of builder.regions)
    if (
      (region.kind === "function" || region.kind === "file") &&
      region.entry.predecessors.length === 0
    )
      builder.link(from, builder.built(region.entry), true);
  for (const node of builder.nodes)
    if (node.predecessors.length === 0 && node !== builder.program.entry)
      builder.link(from, node, true);
  // A cycle that nothing enters, such as a function that only calls itself, hangs there by its first node.
  const reached = new Uint8Array(builder.nodes.length);
  const reach = (start: BuildNode): void => {
    const work = [start];
    reached[start.id] = 1;
    while (work.length > 0)
      for (const next of work.pop()!.successors)
        if (reached[next.id] === 0) {
          reached[next.id] = 1;
          work.push(next);
        }
  };
  reach(builder.program.entry);
  for (const node of builder.nodes)
    if (reached[node.id] === 0) {
      builder.link(from, node, true);
      reach(node);
    }
}

export function decideLiveness(builder: FlowGraphBuilder): void {
  const live = new Uint8Array(builder.nodes.length);
  const work: BuildNode[] = [builder.program.entry];
  live[builder.program.entry.id] = 1;
  while (work.length > 0) {
    const node = work.pop()!;
    for (const next of node.successors)
      if (live[next.id] === 0 && !builder.deadEdges.has(edgeKey(node, next))) {
        live[next.id] = 1;
        work.push(next);
      }
  }
  for (const node of builder.nodes) node.dead = live[node.id] === 0;
}
