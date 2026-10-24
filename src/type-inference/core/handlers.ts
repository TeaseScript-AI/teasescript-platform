import { prefixesOf, sortCost, type DefinitionIndex, type Key } from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import type { CoreProgram } from "./program.js";

/*
 * The handler index of the coarse core (checkpoint 9, TABLE X7, §6.4 H1–H9, F24, §8): which keys a timer, media or
 * button block may store (its own code and every callable it may run), and for each callable whether a block may have
 * been registered before a node runs: a registration in the callable earlier in its text, a call or file transfer
 * into a callable that registers (H9, H6), the callable entered where a block may have run, a file with a label, or a
 * loop that holds a registration. Two worklists over the call sites and file transfers, each edge once.
 */

/** A callable's registration facts. */
interface Registrations {
  /** It registers a block, itself or through a callable it calls or goes to. */
  registers: boolean;
  /** The text offsets in it where a block may be registered: a registration, a call or transfer into a registering one. */
  readonly events: number[];
  /** The loops around those events. */
  readonly loops: Set<FlowNode>;
  /** It may run after a registration elsewhere: entered where a block may have run. */
  mayRunAfter: boolean;
  first: number;
}

const offsetOf = (node: FlowNode): number => node.span?.start.offset ?? -1;

export class HandlerIndex {
  /** The keys with a definition in block code (F24's handler stores). */
  readonly #handlerKeys = new Set<Key>();
  /** The keys above one: a prefix of a handler store's key. */
  readonly #handlerAbove = new Set<Key>();
  readonly #facts = new Map<Callable, Registrations>();

  public constructor(
    readonly program: CoreProgram,
    readonly definitions: DefinitionIndex,
  ) {
    const work = program.work;
    const flow = program.flow;
    for (const [key, list] of definitions.byKey)
      for (const d of list) {
        work.charge("indexSteps");
        if (!d.node.dead && program.inBlockCode(d.node)) this.#handlerKeys.add(key);
      }
    for (const key of this.#handlerKeys)
      for (const prefix of prefixesOf(key)) {
        work.charge("indexSteps");
        this.#handlerAbove.add(prefix);
      }
    const handlers = flow.regions.filter((region) => region.kind === "handler");
    work.charge("eventSteps", 2 * handlers.length + 3 * flow.callables.length + flow.sites.length);
    for (const callable of flow.callables)
      this.#facts.set(callable, {
        registers: false,
        events: [],
        loops: new Set(),
        mayRunAfter: false,
        first: Infinity,
      });
    for (const handler of handlers) {
      if (handler.creation.dead) continue;
      const callable = flow.callableOf(handler.creation.region);
      const facts = callable === null ? undefined : this.#facts.get(callable);
      if (facts === undefined) continue;
      facts.registers = true;
      facts.events.push(offsetOf(handler.creation));
      for (const loop of handler.creation.loops) facts.loops.add(loop);
    }
    // the edges of the call graph and the file transfers: from a caller's node into the callable it enters
    const edges = new Map<Callable, [FlowNode, Callable][]>();
    const callers = new Map<Callable, [Callable, FlowNode][]>();
    const edge = (from: Callable, at: FlowNode, to: Callable): void => {
      const list = edges.get(from);
      if (list === undefined) edges.set(from, [[at, to]]);
      else list.push([at, to]);
      const into = callers.get(to);
      if (into === undefined) callers.set(to, [[from, at]]);
      else into.push([from, at]);
    };
    // only a call that can run registers (G1(b), r4.25), as only a transfer that can run does
    for (const site of flow.sites) {
      if (site.callIn.dead) continue;
      const caller = flow.callableOf(site.caller);
      if (caller !== null) for (const callee of site.callees) edge(caller, site.callIn, callee);
    }
    for (const jump of flow.jumps) {
      if (jump.node.dead) continue;
      const from = flow.callableOf(jump.node.region);
      if (from !== null) for (const file of jump.files) edge(from, jump.node, file);
    }
    // H9, H6: a callable that calls or goes to a registering callable registers, at that call or transfer (whose
    // `end` returns to the transferring file's caller)
    const queue = flow.callables.filter((callable) => this.#facts.get(callable)!.registers);
    while (queue.length > 0) {
      const callee = queue.pop()!;
      for (const [caller, at] of callers.get(callee) ?? []) {
        work.charge("eventSteps");
        const facts = this.#facts.get(caller)!;
        if (program.handlerOf(at) === null) {
          facts.events.push(offsetOf(at));
          for (const loop of at.loops) facts.loops.add(loop);
        }
        if (!facts.registers) {
          facts.registers = true;
          queue.push(caller);
        }
      }
    }
    for (const facts of this.#facts.values()) {
      work.charge("eventSteps", sortCost(facts.events.length));
      facts.events.sort((a, b) => a - b);
      facts.first = facts.events[0] ?? Infinity;
    }
    // a callable entered, by a call or a file transfer, where a block may have run may itself run after one
    const pending: Callable[] = [];
    const mark = (callable: Callable): void => {
      const facts = this.#facts.get(callable)!;
      if (facts.mayRunAfter) return;
      facts.mayRunAfter = true;
      pending.push(callable);
    };
    for (const [, list] of edges)
      for (const [at, to] of list) {
        work.charge("eventSteps");
        if (program.handlerOf(at) !== null || this.afterSomeCreation(at)) mark(to);
      }
    while (pending.length > 0)
      for (const [, to] of edges.get(pending.pop()!) ?? []) {
        work.charge("eventSteps");
        mark(to);
      }
  }

  /** Whether the key, a prefix or a key below it has a store in block code (F24): a lookup per step of its path. */
  public handlerTouches(key: Key): boolean {
    const prefixes = prefixesOf(key);
    this.program.work.charge("eventSteps", prefixes.length + 1);
    return (
      this.#handlerKeys.has(key) ||
      this.#handlerAbove.has(key) ||
      prefixes.some((prefix) => this.#handlerKeys.has(prefix))
    );
  }

  /**
   * Whether a block may have been registered before `node` runs (X7): its callable may run after a registration, has a
   * label (a file) or is block code, a loop around the node holds a registration, or a registration event lies
   * earlier in the callable's text.
   */
  public afterSomeCreation(node: FlowNode): boolean {
    const callable = this.program.flow.callableOf(node.region);
    if (callable === null) return true;
    const facts = this.#facts.get(callable)!;
    if (
      facts.mayRunAfter ||
      (callable.kind === "file" && this.program.flow.labelled.has(callable)) ||
      this.program.flow.blockCalled.has(callable)
    )
      return true;
    if (node.loops.some((loop) => facts.loops.has(loop))) return true;
    return facts.first < offsetOf(node);
  }
}
