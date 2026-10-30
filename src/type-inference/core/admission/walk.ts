import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import {
  keep,
  keepText,
  keptArray,
  keptParts,
  keptSlice,
  keptSteps,
  keptText,
  type WorkLedger,
} from "../budget.js";
import type { CarrierRole, StepsStrip, Strip } from "../carriers.js";
import { convert } from "../contract/key-ids.js";
import { keyLane } from "../contract/lanes.js";
import { pathAt } from "../contract/literal-index.js";
import { writtenOf } from "../contract.js";
import { keyPlace, sortCost, type Definition } from "../definitions.js";
import { keyStepsIn } from "../contract/key-ids.js";
import type { FlowNode } from "../flow-graph.js";
import { dictList } from "../method-categories.js";
import { stepName, type CoreProgram } from "../program.js";
import { sharing } from "../sharing.js";
import type { EvaluationKey, Expansion, Part, Stop, Stops, Via, ViaChain } from "./model.js";
import { permittedAt } from "./permitted.js";
import { fieldsOf, sourceOf } from "./structure.js";

// The store walk: a stored value's contributions by the path they stand at, the bindings it copies, their order.

/** A walk's empty key. */
const rootKey = (): EvaluationKey => ({ position: -1, longer: null, rank: 0 });

/** The key one `position` longer than `key`: one node per key and walk. */
function longerKey(key: EvaluationKey, position: number): EvaluationKey {
  key.longer ??= new Map();
  let found = key.longer.get(position);
  if (found === undefined) key.longer.set(position, (found = { position, longer: null, rank: 0 }));
  return found;
}

/** Ranks a walk's keys from `root` in evaluation order: the preorder of their tree, each key's longer ones by position. */
function rankKeys(work: WorkLedger, root: EvaluationKey): void {
  let rank = 0;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    node.rank = rank++;
    if (node.longer === null) continue;
    // (a walk makes a key's longer ones from the last position back, so they are mostly in order already)
    const longer = [...node.longer.values()];
    if (longer.some((each, index) => index > 0 && each.position > longer[index - 1]!.position)) {
      work.charge("checks", sortCost(longer.length));
      longer.sort((a, b) => b.position - a.position);
    }
    for (const each of longer) pending.push(each);
  }
}

/** A carrier's own contribution's position: after every operand it carries (A4: a selected copy precedes it). */
const OWN = Number.MAX_SAFE_INTEGER;

/** The order of two evaluation keys of one walk: negative where `a` is evaluated first. */
export function compareKeys(a: EvaluationKey, b: EvaluationKey): number {
  return a.rank - b.rank;
}

/** The roles of a typed ingress's default (F18). */
export const TYPED_ROLES: ReadonlySet<CarrierRole> = new Set([
  "load default/default",
  "parse default/default",
]);

/** The roles whose operation reads a member of its receiver, the member read C1 sits at (TABLE r4.60). */
export const RECEIVER_ROLES: ReadonlySet<CarrierRole> = new Set([
  "get/receiver",
  "copy/receiver",
  "removal/receiver",
]);

/** The roles of operations that combine or remove, whose operand brought the kind (TABLE r4.63 (2)). */
const COMBINING_ROLES: ReadonlySet<CarrierRole> = new Set([
  "concatenation/operand",
  "removal/receiver",
]);

/** The roles whose operand is its operation's own read (C10: an ingress there is checked at its read). */
export const OWN_ROLES: ReadonlySet<CarrierRole> = new Set([
  "otherwise/fallback",
  "get/default",
  "load default/default",
  "parse default/default",
]);

/** The chain one operation, `level`, inside `outer`. */
function viaLink(program: CoreProgram, outer: ViaChain | null, level: Via): ViaChain {
  const own = OWN_ROLES.has(level.role);
  const typed = TYPED_ROLES.has(level.role);
  return {
    level,
    outer,
    own: own || outer?.own === true,
    ownUntyped: (own && !typed) || outer?.ownUntyped === true,
    typed: typed || outer?.typed === true,
    combining:
      (COMBINING_ROLES.has(level.role) && program.hasOf.has(level.operand)) ||
      outer?.combining === true,
    joined: level.role === "concatenation/operand" || outer?.joined === true,
  };
}

/**
 * A4: the bindings a stored value copies, with the paths they land at and the path into each (`strip`), directly,
 * through the literals that hold them, or through the values that carry them (a projection, an operation: the path
 * read into it), in element order; once per value. A path below the value is a chain of steps, one per field, made
 * into an array once and only where a binding lands at it, so a literal nested k deep costs k steps, not k paths of
 * up to k steps each (TABLE r4.100 (2)).
 */
export function copySources(
  admission: Admission,
  value: PlaceId,
): readonly {
  readonly path: readonly string[];
  readonly binding: PlaceId;
  readonly strip: readonly string[];
  /**
   * Whether the literal cells the copy passes through are all live (Astra's B2), kept as one answer, not the cells:
   * a list of them per copy grew with the literal's depth, a source of every reference below it (16,384 references
   * 4,096 deep held about 780 MiB after a stop before admission settled, the fresh pass's copies beside the stopped
   * one's).
   */
  readonly cellsLive: boolean;
}[] {
  const known = admission.copies.get(value);
  if (known !== undefined) return known;
  const { program, definitions } = admission.pass;
  interface Steps {
    readonly parent: Steps | null;
    readonly step: string;
    made: readonly string[] | null;
  }
  const top: readonly string[] = [];
  const made = (at: Steps | null): readonly string[] => {
    if (at === null) return top;
    if (at.made === null) {
      const steps: string[] = [];
      for (let node: Steps | null = at; node !== null; node = node.parent) steps.push(node.step);
      at.made = keptArray(admission.work, steps.reverse());
    }
    return at.made;
  };
  const out: {
    path: readonly string[];
    binding: PlaceId;
    strip: readonly string[];
    cellsLive: boolean;
  }[] = [];
  // (a read of a wrapper's family carries its strip as a path of the arena kept in reverse, one step on in front per
  // projection, made once for each copy it reaches: G3 stage 1; any other walk its arrays as before)
  const reversed = readsCursorFamily(admission, value);
  const start: CopyStrip = reversed ? reverseStrip(admission, 0) : admission.arrayStrip([]);
  const pending: [PlaceId, Steps | null, CopyStrip, boolean][] = [[value, null, start, true]];
  while (pending.length > 0) {
    const [current, path, strip, cellsLive] = pending.pop()!;
    program.work.charge("indexSteps");
    const binding = program.occurrenceOf.get(current);
    if (binding !== undefined) {
      out.push({ path: made(path), binding, strip: stripSteps(admission, strip), cellsLive });
      continue;
    }
    const next: [PlaceId, Steps | null, CopyStrip, boolean][] = [];
    // (its cells' tasks share one rest of the strip, charged as kept)
    let rest: CopyStrip | null = null;
    if (program.hasOf.has(current))
      for (const has of program.hasOf.get(current)!) {
        const on = strip.length > 0 ? admission.termAt(has.type, strip.at(0)!) : undefined;
        const fields: readonly (readonly [string, TypeTerm])[] =
          strip.length === 0 ? fieldsOf(has.type) : on === undefined ? [] : [[strip.at(0)!, on]];
        for (const [name, term] of fields)
          if (term.kind === "ref") {
            // (one step per field, which its cells share)
            const child: Steps | null =
              strip.length === 0 ? { parent: path, step: name, made: null } : path;
            for (const d of definitions.cellDefs.get(term.place) ?? []) {
              rest ??=
                strip.length === 0
                  ? strip
                  : strip.kind === "steps"
                    ? admission.arrayStrip(keptSlice(admission.work, strip.steps, 1))
                    : strip.rest();
              next.push([d.value!, child, rest, cellsLive && admission.pass.lists.live(d)]);
            }
          }
      }
    else
      for (const [carried, rest] of strip.kind === "steps"
        ? admission.carriersBy(current, strip)
        : admission.carriersBy(current, strip))
        next.push([carried, path, rest, cellsLive]);
    for (let index = next.length - 1; index >= 0; index -= 1) pending.push(next[index]!);
  }
  admission.copies.set(value, out);
  return out;
}

/**
 * Whether a value reads a wrapper's family (`keyLane`): its projections down to a read of a binding, the lowest's step
 * the family's first. Its walk's strips are then kept in reverse (`reverseStrip`).
 */
function readsCursorFamily(admission: Admission, value: PlaceId): boolean {
  const { program, contract } = admission.pass;
  let at = value;
  let first: string | null = null;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined;
    projection = program.projOf.get(at)
  ) {
    if (projection.step === "iteration") return false;
    first = stepName(projection.step);
    at = projection.owner;
  }
  const binding = program.occurrenceOf.get(at);
  return first !== null && binding !== undefined && keyLane(contract, binding, first) === "cursor";
}

/**
 * A strip as a path of the arena kept in reverse (`rev`: its last step the strip's first): a step goes on in front as a
 * child, its first step and its rest are the path's last step and parent, each new node charged as `pathAt` keeps it.
 */
interface ReverseStrip extends Strip<ReverseStrip> {
  readonly kind: "reverse";
  readonly rev: number;
}

/** A copy walk's strip: an array's, or a wrapper's family's kept in reverse (`reverseStrip`). */
type CopyStrip = StepsStrip | ReverseStrip;

function reverseStrip(admission: Admission, rev: number): ReverseStrip {
  const { contract } = admission.pass;
  const { pathDepths: depths, pathParents: parents, pathLastSteps: last } = contract;
  return {
    kind: "reverse",
    rev,
    length: depths[rev]!,
    at: (index) =>
      index === 0
        ? rev === 0
          ? undefined
          : last[rev]
        : depths[rev]! >= 2
          ? last[parents[rev]!]
          : undefined,
    rest: () => reverseStrip(admission, rev === 0 ? 0 : parents[rev]!),
    under: (below) => {
      let at = rev;
      convert(contract, below.length, 0, 0);
      for (let index = below.length - 1; index >= 0; index -= 1)
        at = pathAt(contract, at, below[index]!);
      return reverseStrip(admission, at);
    },
  };
}

/** A strip's steps: an array's itself; a reversed path's made once, in order, charged as kept. */
function stripSteps(admission: Admission, strip: CopyStrip): readonly string[] {
  if (strip.kind === "steps") return strip.steps;
  const { contract } = admission.pass;
  const { rev } = strip;
  const steps: string[] = [];
  convert(contract, contract.pathDepths[rev]!, 0, 0);
  for (let at = rev; at !== 0; at = contract.pathParents[at]!)
    steps.push(contract.pathLastSteps[at]!);
  return keptArray(admission.work, steps);
}

/**
 * A4, F12: the binding a value copies, directly or through its projections (`typed[0]`, `typed.first`), with the path
 * into it the copy stands at: the projections' steps, then `strip`; with its written type (`term`), or, for an
 * unwritten place that may inherit one (`inheriting`), that place (`from`: its type at each path the one its own
 * decision copies, `inheritedAt`); `null` for any other value, and for a projection the written type has no path for
 * (a dict's lists, a length).
 */
export function writtenSource(
  admission: Admission,
  value: PlaceId,
  strip: readonly string[],
): {
  readonly term: TypeTerm | null;
  readonly from: PlaceId | null;
  readonly strip: readonly string[];
} | null {
  const { program, contract } = admission.pass;
  const binding = program.occurrenceOf.get(value);
  if (binding !== undefined) {
    const term = writtenOf(program.place(binding).kind);
    if (term !== null) return { term, from: null, strip };
    return admission.inheriting.has(binding) ? { term: null, from: binding, strip } : null;
  }
  const key = program.projOf.has(value) ? contract.copiedKey(value) : null;
  if (key === null) return null;
  const place = keyPlace(key);
  const term = writtenOf(program.place(place).kind);
  if (term === null && !admission.inheriting.has(place)) return null;
  // (a projection of a receiver that may be a reference is the runtime's member, no copy: F19a)
  for (let at = value; program.projOf.has(at); at = program.projOf.get(at)!.owner)
    if (admission.keepsOwn(at)) return null;
  const steps = keyStepsIn(contract, key);
  const path = keptSteps(admission.work, steps, strip);
  if (steps.some((step) => dictList(step) !== undefined)) return null;
  if (term === null) return { term: null, from: place, strip: path };
  return permittedAt(term, path) === null ? null : { term, from: null, strip: path };
}

/**
 * One task of the store walk, by its value, node and strip alone (`Expansion`), once per pass: what it stands as at
 * its own path and the parts below it, whatever reached it. A4 through copies: a copy of an unwritten place that may
 * inherit a written type stands as a written copy too, carrying at each path the type that place's own decision
 * copies there (`inheritedAt`); its value stays where it stood, and decides where it carries none. A literal read
 * into stands by its cells on the path; a projection or another carrier is its own contribution at the path, and
 * below it what it carries (F12), an operation's under the certainty of its own value, its own contribution after
 * what it carries, so a written copy it selects precedes its snapshot (A4); any other value is a stop, a literal's
 * cells below it.
 */
export function expand(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  strip: readonly string[],
  after = false,
): Expansion {
  const memoKey = keptParts(admission.work, value, node.id, after, strip);
  const known = admission.expansions.get(memoKey);
  if (known !== undefined) return known;
  const { program, definitions } = admission.pass;
  program.work.charge("indexSteps");
  // a literal's cells at a step, in evaluation order: each with its position, its value's place in the literal's own
  // source, never its index in a list one step filtered
  const cells = (step: string | null): (readonly [Definition, string, number])[] => {
    const next: (readonly [Definition, string, number])[] = [];
    for (const has of program.hasOf.get(value) ?? []) {
      const fields: readonly (readonly [string, TypeTerm])[] =
        step === null
          ? fieldsOf(has.type)
          : ((on) => (on === undefined ? [] : [[step, on] as const]))(
              admission.termAt(has.type, step),
            );
      for (const [name, field] of fields)
        if (field.kind === "ref")
          for (const d of definitions.cellDefs.get(field.place) ?? [])
            next.push([d, name, program.places[d.value!]?.site?.start ?? 0]);
    }
    program.work.charge("checks", sortCost(next.length));
    return next.sort(([, , x], [, , y]) => x - y);
  };
  const part = (
    of: PlaceId,
    at: FlowNode,
    fields: Pick<Part, "step" | "strip" | "deep" | "single" | "position" | "after" | "role">,
  ): Part => ({ value: of, node: at, ...fields, expansion: null });
  const written = writtenSource(admission, value, strip);
  const term = written?.term ?? null;
  const inherits =
    !after && written !== null && written.from !== null
      ? { from: written.from, strip: written.strip }
      : null;
  const literal = term === null && program.hasOf.has(value);
  let stop: Expansion["stop"] = null;
  const parts: Part[] = [];
  const carried =
    literal || after || term !== null || sourceOf(admission, value) !== null
      ? []
      : admission.carriersOf(value, strip);
  if (literal && strip.length > 0) {
    const next = cells(strip[0]!);
    // (its cells' tasks share one rest of the strip, charged as kept)
    const below = next.length === 0 ? strip : keptSlice(admission.work, strip, 1);
    for (const [d, , position] of next)
      parts.push(
        part(d.value!, d.node ?? node, {
          step: null,
          strip: below,
          deep: null,
          single: next.length === 1,
          position,
          after: false,
          role: null,
        }),
      );
  } else if (carried.length > 0) {
    const projection = program.projOf.has(value);
    for (const [operand, rest, role, position] of carried)
      parts.push(
        part(operand, node, {
          step: null,
          strip: rest,
          deep: true,
          single: true,
          position,
          after: false,
          role: projection ? null : role,
        }),
      );
    parts.push(
      part(value, node, {
        step: null,
        strip,
        deep: null,
        single: true,
        position: OWN,
        after: true,
        role: null,
      }),
    );
  } else {
    stop = {
      list: term !== null ? "written" : literal ? "literals" : "values",
      term,
      strip: term !== null ? written!.strip : strip,
    };
    if (literal)
      for (const [d, step, position] of cells(null))
        parts.push(
          part(d.value!, d.node ?? node, {
            step,
            strip: [],
            deep: false,
            single: true,
            position,
            after: false,
            role: null,
          }),
        );
  }
  keep(admission.work, 1 + parts.length);
  const expansion: Expansion = {
    id: admission.expansions.size,
    value,
    node,
    strip,
    inherits,
    stop,
    parts,
  };
  admission.expansions.set(memoKey, expansion);
  return expansion;
}

/** A part's own task (`expand`), made once and kept on the part. */
export function partOf(admission: Admission, part: Part): Expansion {
  part.expansion ??= expand(admission, part.value, part.node, part.strip, part.after);
  return part.expansion;
}

/**
 * A stored value's contributions by the path they stand at, in evaluation order: the copies of written bindings
 * (A4), the other values no literal of it holds (a read, a call, external data), and its literals, whose fields and
 * elements stand below them; once per value, from its tasks' recipes (`expand`). `once`: later copies or calls of one
 * source identity at a path are one stop (F2), as every walk made before a stop has them; a walk made after one keeps
 * every stop instead, the same boundaries and sites without asking identities nothing else after the stop asks (TABLE
 * r4.55, r4.126).
 */
export function stopsOf(admission: Admission, value: PlaceId, node: FlowNode, once = true): Stops {
  const memo = once ? admission.stops : admission.everyStop;
  const known = memo.get(value);
  if (known !== undefined) return known;
  const { program, contract } = admission.pass;
  const stops: Stops = { written: new Map(), values: new Map(), literals: new Map() };
  const sources = new Set<string>();
  const root = rootKey();
  // a task: its recipe, its path, whether below an operation, its chain of operations, whether single, its evaluation
  // key; each array a task or a stop keeps is the one it came from, shared, or made by a kept helper (each evaluation
  // key and chain of operations a task or stop keeps is one node onto the one it extends: #1230)
  const pending: (readonly [
    Expansion,
    readonly string[],
    boolean,
    ViaChain | null,
    boolean,
    EvaluationKey,
  ])[] = [[expand(admission, value, node, []), [], false, null, true, root]];
  while (pending.length > 0) {
    const [task, path, deep, via, single, key] = pending.pop()!;
    program.work.charge("indexSteps");
    const { value: current, node: at, strip } = task;
    if (task.inherits !== null) {
      const inherits: Stop = {
        key,
        value: current,
        node: at,
        path,
        term: null,
        from: task.inherits.from,
        strip: task.inherits.strip,
        deep,
        single,
        via,
      };
      const text = keptText(admission.work, path);
      const list = stops.written.get(text);
      if (list === undefined) stops.written.set(text, [inherits]);
      else list.push(inherits);
    }
    const own = task.stop;
    // (a later copy or call of one source identity at a path holds what the first holds: one stop, F2; a copy only
    // where it reads the same snapshot, r4.68 (1); and only through the same operations, selected alike: an operand
    // a `get` never gives is no copy of the store's own element beside it, Astra r5 D1; never a read of an ingress,
    // itself or through projections (`Contract.ingressOf`), which lands by its own leaf, S6-CARRIERS §3.1, #1210)
    const map = own === null ? null : own.list === "written" ? stops.written : stops[own.list];
    const pathKey = own === null ? "" : keptText(admission.work, path);
    let kept = own !== null;
    if (
      own !== null &&
      once &&
      sharing() &&
      path.length > 0 &&
      own.list === "values" &&
      sourceOf(admission, current) !== null &&
      contract.ingressOf(current) === null
    ) {
      const identity = keptParts(
        admission.work,
        pathKey,
        strip,
        viaSignature(admission, via),
        deep,
        single,
        contract.identityOf(current).id,
        contract.readSnapshot(current) ?? "",
      );
      if (sources.has(identity)) kept = false;
      else sources.add(identity);
    }
    if (kept) {
      const stop: Stop = {
        key,
        value: current,
        node: at,
        path,
        term: own!.term,
        from: null,
        strip: own!.strip,
        deep,
        single,
        via,
      };
      const list = map!.get(pathKey);
      if (list === undefined) map!.set(pathKey, [stop]);
      else list.push(stop);
    } else if (own !== null) continue;
    for (let index = task.parts.length - 1; index >= 0; index -= 1) {
      const part = task.parts[index]!;
      pending.push([
        partOf(admission, part),
        part.step === null ? path : keptSteps(admission.work, path, [part.step]),
        part.deep ?? deep,
        part.role === null
          ? via
          : viaLink(program, via, {
              value: current,
              node: at,
              path,
              strip,
              operand: part.value,
              role: part.role,
            }),
        single && part.single,
        longerKey(key, part.position),
      ]);
    }
  }
  // each path's stops in evaluation order: the walk reaches a later row of one operand before an earlier cell
  rankKeys(program.work, root);
  for (const map of [stops.written, stops.values, stops.literals])
    for (const list of map.values()) {
      program.work.charge("checks", sortCost(list.length));
      list.sort((a, b) => compareKeys(a.key, b.key));
    }
  memo.set(value, stops);
  return stops;
}

/**
 * A chain of operations by what selects through it (S6-CARRIERS §4.5's via signature): each level's carrier value
 * and role, its operand aside, so a choice's options read alike while a fallback's two operands, or a `get`'s receiver
 * and default, stay apart. Once per chain, as a short name of its outer chain's name and its innermost level, so equal
 * chains have equal names and no name grows with its chain (#1230).
 */
export function viaSignature(admission: Admission, via: ViaChain | null): string {
  const unnamed: ViaChain[] = [];
  let at = via;
  for (; at !== null && !admission.viaSignatures.has(at); at = at.outer) unnamed.push(at);
  let name = at === null ? "" : admission.viaSignatures.get(at)!;
  for (let index = unnamed.length - 1; index >= 0; index -= 1) {
    const { level } = unnamed[index]!;
    admission.pass.program.work.charge("checks");
    const parts = `${name}>${level.value}:${level.role}`;
    let known = admission.viaNames.get(parts);
    if (known === undefined) {
      keepText(admission.work, parts.length);
      admission.viaNames.set(parts, (known = `${admission.viaNames.size}`));
    }
    admission.viaSignatures.set(unnamed[index]!, (name = known));
  }
  return name;
}

/**
 * A contribution's own expression, C1's site for it (§3.4): a member a receiver's operation reads of it (a `get`, a
 * copy, a removal of the data: TABLE r4.60), else the contribution itself, an ingress, a member read of one or a named
 * read.
 */
export function contributionSite(admission: Admission, stop: Stop, d: Definition): SourceSite {
  const { program } = admission.pass;
  // (only the innermost row takes the stop's value as its operand: a walk descends, each value one row's operand)
  const level = stop.via?.level;
  if (level !== undefined && RECEIVER_ROLES.has(level.role) && level.operand === stop.value)
    return program.places[level.value]?.site ?? d.site;
  return program.places[stop.value]?.site ?? d.site;
}
