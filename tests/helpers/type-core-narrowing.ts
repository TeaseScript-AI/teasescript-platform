import type { CorePass } from "../../src/type-inference/core/answers.js";
import { Contract } from "../../src/type-inference/core/contract.js";
import {
  DefinitionIndex,
  DefinitionLists,
  type Definition,
} from "../../src/type-inference/core/definitions.js";
import { ExactPath } from "../../src/type-inference/core/exact-path.js";
import type { FlowNode } from "../../src/type-inference/core/flow-graph.js";
import { GuardIndex } from "../../src/type-inference/core/guards.js";
import { HandlerIndex } from "../../src/type-inference/core/handlers.js";
import type { ContextWord, ItemTag } from "../../src/type-inference/core/items.js";
import { pathKey, stablePath, type Narrowing } from "../../src/type-inference/core/narrowing.js";
import { CoreProgram, type CoreAnalysisRequest } from "../../src/type-inference/core/program.js";
import { Solver, withSolverSeam } from "../../src/type-inference/core/solver.js";
import { Values } from "../../src/type-inference/core/values.js";

/**
 * Stage 3b's narrowing index asked as its consumers will ask it (TABLE §13; S10's second part wires them): a pass made
 * as `analyseCore`'s first pass makes one, without its consumers, and each read's narrowing (N2, with N5's preserving
 * stores) and route (N3) asked, so a test sees the index's answers and a work family its construction and every visit,
 * charged to the pass's ledger.
 */

/** A pass of the analysis of `request`, its indexes built and nothing asked. */
export function narrowingPass(request: CoreAnalysisRequest): CorePass {
  const program = new CoreProgram(request);
  program.index();
  const definitions = new DefinitionIndex(program);
  const parts = {
    program,
    definitions,
    lists: new DefinitionLists(definitions, () => true),
    handlers: new HandlerIndex(program, definitions),
    guards: new GuardIndex(program),
    solver: new Solver(program.scope),
  };
  const pass: CorePass = {
    ...parts,
    get exact() {
      return exact;
    },
    get contract() {
      return contract;
    },
    get values() {
      return values;
    },
  };
  const exact = new ExactPath(pass);
  const contract = new Contract(pass);
  const values = new Values(pass);
  return pass;
}

/**
 * `narrowingPass`, with the solver's worklist reversed when `reversed`: the solver takes the seam when it is made, so
 * the second order of a work family is set here, not around the asks.
 */
export function narrowingPassIn(request: CoreAnalysisRequest, reversed: boolean): CorePass {
  return reversed
    ? withSolverSeam({ reverseWorklist: true }, () => narrowingPass(request))
    : narrowingPass(request);
}

/** G's filtered kinds: its items as `Values` reads them (its input at the test, filtered), without emptiness. */
function filteredKinds(pass: CorePass, g: Narrowing): readonly ItemTag[] {
  return pass.solver
    .run(pass.values.narrowingValue(g))
    .filter((item) => item.tag !== "empty")
    .map((item) => item.tag);
}

/** N2 at a read: its nearest narrowing, and `null` where that holds there, else the failing condition's word. */
export function narrowingAt(
  pass: CorePass,
  node: FlowNode,
): { readonly g: Narrowing; readonly fails: ContextWord | null } | null {
  const g = pass.guards.narrowing.nearestAt(node);
  if (g === null) return null;
  const kinds = filteredKinds(pass, g);
  const { events } = pass.guards.narrowings(pass);
  return { g, fails: pass.solver.run(events.holds(g, node, kinds)) };
}

/** N3 at a read of a stable path without element steps: the witness of a route carrying `tag` unchecked, or `null`. */
export function routeAt(pass: CorePass, node: FlowNode, tag: ItemTag = "null"): Definition | null {
  if (node.expression === undefined) return null;
  const path = stablePath(pass.program, node.file, node.expression);
  if (path === null || path.steps.some((step) => step.kind !== "property")) return null;
  return pass.solver.run(
    pass.guards.narrowings(pass).routes.witness(pathKey(path, pass.program.work), tag, node),
  );
}

/** The reads of a pass's program: the live nodes of identifiers, properties and indexes, in source order. */
function readNodes(pass: CorePass): FlowNode[] {
  return pass.program.flow.nodes.filter(
    (node) =>
      node.expression !== undefined &&
      ["identifier", "propertyAccessExpression", "indexExpression"].includes(
        node.expression.kind,
      ) &&
      pass.program.live(node),
  );
}

/**
 * Every read's narrowing and route asked once, in source order, or reversed (the work families' second order): what
 * S10's second part's consumers will ask. The solver's worklist order is the pass's, taken when the pass is made
 * (`narrowingPassIn`): a seam around the asks alone would reverse the reads and leave the components' order as it is.
 */
export function askEveryRead(pass: CorePass, reversed = false): void {
  const reads = readNodes(pass);
  for (const node of reversed ? reads.reverse() : reads) {
    narrowingAt(pass, node);
    routeAt(pass, node);
  }
}

/** The outermost read (an identifier, a property or an index) of the first file starting at `offset`. */
export function nodeAt(pass: CorePass, offset: number): FlowNode {
  let found: FlowNode | null = null;
  for (const node of readNodes(pass))
    if (
      node.file === 0 &&
      node.span !== null &&
      node.span.start.offset === offset &&
      (found === null || node.span.end.offset > found.span!.end.offset)
    )
      found = node;
  if (found === null) throw new Error(`No expression starts at ${offset}.`);
  return found;
}
