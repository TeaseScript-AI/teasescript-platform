import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import type { AdmittedType } from "../answers.js";
import type { CheapDecision } from "../consumers/model.js";
import { keepText, keptSteps, pathText } from "../budget.js";
import { keptKey } from "../definitions.js";
import { termAt, typeTags, writtenOf } from "../contract.js";
import { type CanonicalKey, isKeyId, keptKeyAt, keyAt } from "../contract/key-ids.js";
import { withoutEmpty } from "../exact-path.js";
import { kindsInItsOrder, REASON, type Item, type ItemTag } from "../items.js";
import { drive, openAbove } from "../inherited/inherited.js";
import { admitsNumber, concrete } from "./kinds.js";
import { inheritance } from "./landings/inheritance.js";
import { landed } from "./landings/landed.js";
import { permittedAt, unrestricted } from "./permitted.js";
import { inputsAt, scanAt } from "./scan.js";

// The admitted type at a path, the decision retained after a stop, and the deciding contribution's site.

/**
 * A path copies land in a place that `groups` left out, decided where an answer asks for it (`decide`'s `lazily`):
 * its contents fit, so its decision owes nothing, and its answer is the one deciding it with the copy gives.
 */
function lazily(admission: Admission, place: PlaceId, path: readonly string[]): void {
  const key = keyAt(admission.pass.contract, place, path);
  if (admission.attempted.has(key) || !landed(admission, place, path)) return;
  // (after a stop admission decides nothing more: such a path is answered from what it retained, `retainedSource`;
  // nor below a decision that stopped)
  if (admission.pass.program.work.stopped !== null || admission.decisionStopped(place, path))
    return;
  // (in a completion pass a decision of the completion's own, recorded with its work, #1526)
  const closure = admission.pass.closure;
  const decide = (): void => void admission.decide({ root: place, path }, true);
  if (closure !== undefined && closure !== null && closure.open) closure.decide(key, decide);
  else decide();
}

/**
 * #1526: a read of the decision at a path in a completion pass: no admission walk runs there, so a decision admission
 * makes at all (one of its groups; a landed copy path is `lazily`'s) is made, as a lazily decided path, where a level
 * first asks for it, a scoped decision from what is left of the total.
 */
function pull(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
  key: CanonicalKey,
): void {
  const closure = admission.pass.closure;
  if (closure === undefined || closure === null || !closure.open) return;
  if (!admission.attempted.has(key) && groupKeys(admission).has(key))
    closure.decide(key, () => admission.decide({ root: place, path }, true));
  closure.took("decision", key);
}

/** The keys of admission's groups (`Admission.groups`), each in its identity, once a pass. */
function groupKeys(admission: Admission): ReadonlySet<CanonicalKey> {
  if (admission.groupKeys !== null) return admission.groupKeys;
  const { contract } = admission.pass;
  const groups = admission.groups();
  admission.pass.program.work.charge("checks", groups.length);
  const keys = new Set(groups.map((at) => at.key ?? keyAt(contract, at.root, at.path)));
  admission.groupKeys = keys;
  return keys;
}

/**
 * A destination's admitted type: the written type (its null included), else the decided kinds (an integer decider
 * already widened by an admitted number, a copy of a written integer never; a literal's the type all its elements fit,
 * #2289, so `[lives, 2.5]` decides numbers), else, where admission decided nothing, the contract's kinds, one family,
 * an integer widened by an admitted number; with `null` where a null contribution is admitted and the decision admits
 * one (a copy of a written type without it does not), and wherever a copy of a written type with it decided, whatever
 * is stored (`permitsNull`), a written `null` alone too (`[null]`, a decision like any other, never none); never the
 * raw union of contributions. Not only a read: where copies land a path no decision has tried yet, before a stop
 * (`lazily`), or, in a completion pass, at a group's path not yet tried (`pull`), it first decides the path, recorded
 * and charged as a decision.
 */
export function admitted(admission: Admission, place: PlaceId, path: readonly string[]): ItemTag[] {
  const { program, contract } = admission.pass;
  const written = writtenOf(program.place(place).kind);
  const term = written === null ? null : termAt(written, path);
  if (term !== null) return [...new Set(typeTags(term).filter((tag) => tag !== "unknown"))];
  // (a decision that stopped decides nothing at its key or below it)
  if (admission.decisionStopped(place, path)) return [];
  if (undecidedCopy(admission, place, path))
    return retainedSource(admission, place, path)?.tags ?? [];
  lazily(admission, place, path);
  const key = keyAt(contract, place, path);
  pull(admission, place, path, key);
  // (#2289: `lazily` or `pull` may have made the key's first decision, and a literal's stopped element
  // left it undecided, before any fallback below)
  // (no test reaches this guard; it stays so that a stop never loses a check, #2289)
  if (admission.decisionStopped(place, path)) return [];
  // (an unrestricted written part, or a copy's, admits every kind at and below it: never what is stored)
  if (admission.unrestricted.has(key) || openBelow(admission, place, path)) return ["unknown"];
  const kinds = withoutEmpty(admission.run(contract.contractOf(key)));
  const decided = admission.decided.get(key);
  // (undecided, the contract's concrete kinds answer, one possible only through external data among them; only the
  // widening of `integer` to `number` leaves such a number out, `admitsNumber`, #2727)
  let tags = [
    ...(decided ?? new Set(kinds.filter((item) => concrete(item)).map((item) => item.tag))),
  ];
  if (decided === undefined && tags.includes("integer") && kinds.some(admitsNumber))
    tags = [...new Set(tags.map((tag) => (tag === "integer" ? "number" : tag)))];
  return (tags.length > 0 || admission.permitsNull.has(key)) && admitsNull(admission, key, kinds)
    ? [...tags, "null"]
    : tags;
}

/**
 * Admission's null rule for a decided key, its checks' `against` (`admitted`): `null` where a copy of a written type with
 * it decided the key (`permitsNull`), else where the decision admits one and the key's contract holds one.
 */
function admitsNull(admission: Admission, key: CanonicalKey, kinds: readonly Item[]): boolean {
  return (
    admission.permitsNull.has(key) ||
    (admission.nullable.get(key) !== false && kinds.some((item) => item.tag === "null"))
  );
}

/**
 * After a stop, a path's admitted type as admission retained it, without new solving: its written type, its decision,
 * else a copied written type landing there (the inheritance's seeds), else, where a copy
 * of another place lands at or above it (a lazily decided copy path among them), that source's at the same path below
 * the copy, through the copy forest's edges; with `null` where the decision admits one, at a binding's root only where
 * its contract, as it finished, holds one or leaves the question open (admission's null rule, #1604); `null` where none
 * of these decides the path, `["unknown"]` where every
 * kind fits it. With whether a written type decides it through copies (`inherited`), which keeps its spelling (#1398).
 */
export function retained(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): { readonly tags: ItemTag[]; readonly inherited: boolean } | null {
  return retainedSource(admission, place, path);
}

/**
 * `retained`'s answer, and whether a written type decides it through copies (a seed, a copy's source's written type,
 * or a source's decision that inherits one): the copy forest walked from the path with an explicit worklist, each key
 * once, in the copies' order; round a cycle of copies a path never grows (a copy of a member's part is not followed
 * within the cycle), so the walk ends.
 */
function retainedSource(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): { readonly tags: ItemTag[]; readonly inherited: boolean } | null {
  const { program } = admission.pass;
  const seen = new Set<CanonicalKey>();
  const pending: {
    readonly place: PlaceId;
    readonly path: readonly string[];
    readonly copied: boolean;
  }[] = [{ place, path, copied: false }];
  while (pending.length > 0) {
    const at = pending.pop()!;
    const written = writtenOf(program.place(at.place).kind);
    const term = written === null ? null : termAt(written, at.path);
    if (term !== null) return { tags: [...new Set(typeTags(term))], inherited: at.copied };
    // (a decision that stopped, the path's own or a copy's source's, retains nothing: undecided; nor one a
    // literal's stopped element left undecided, at the path or above it, #2289)
    // (no test reaches this guard; it stays so that a stop never loses a check, #2289)
    if (
      admission.decisionStopped(at.place, at.path) ||
      admission.budgetUndecidedAt(at.place, at.path, true)
    )
      return null;
    // (kept in `seen`)
    const key = keptKeyAt(admission.pass.contract, at.place, at.path);
    if (admission.unrestricted.has(key)) return { tags: ["unknown"], inherited: at.copied };
    const decided = admission.decided.get(key);
    if (decided !== undefined) {
      // (a binding's own value, which every read of it finds: its null by the rule its stores' checks admit by, the
      // key's contract read as it finished, no new solving, #1604; a contract of which nothing finished leaves the
      // question open. Below the root a decision admitting `null` keeps it: a read there may find no such member, which
      // the analysis tells and the retained decision does not)
      const kinds = admission.run(admission.pass.contract.contractOf(key));
      const open =
        at.path.length > 0 ||
        kinds.every((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0);
      return {
        tags:
          admitsNull(admission, key, kinds) || (open && admission.nullable.get(key) !== false)
            ? [...new Set([...decided, "null" as const])]
            : [...decided],
        inherited: admission.inheritsWrittenKeys.has(key),
      };
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const { seeds, into, cycleOf } = inheritance(admission);
    const levels = seeds.get(at.place)?.get(pathText(at.path));
    // (#2289: a seed a copy landed through a literal's cell is the literal's own type, not the copy's: its
    // decision's answer, by the cell's query, where no program stop is; none after one, #2289)
    if (levels !== undefined && literalBorne(admission, at.place, at.path))
      return literalSeed(admission, at.place, at.path);
    if (levels !== undefined)
      return {
        tags: [...new Set([...levels].flatMap((level) => typeTags(level)))],
        inherited: true,
      };
    const copies = into.get(at.place) ?? [];
    const cycle = cycleOf.get(at.place);
    // (pushed in reverse: the first copy is taken first)
    for (let index = copies.length - 1; index >= 0; index -= 1) {
      const copy = copies[index]!;
      program.work.charge("checks");
      if (copy.path.length > at.path.length || copy.path.some((step, i) => at.path[i] !== step))
        continue;
      if (
        cycle !== undefined &&
        cycleOf.get(copy.from) === cycle &&
        copy.strip.length > copy.path.length
      )
        continue;
      pending.push({
        place: copy.from,
        path: keptSteps(admission.work, copy.strip, at.path.slice(copy.path.length)),
        copied: true,
      });
    }
  }
  return null;
}

/**
 * Whether a path, or a path above it, is one copies of written bindings land at through a literal's cell
 * (`literalLandings`).
 */
function literalBorne(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  // (no test reaches this guard; it stays so that a stop never loses a check, #2289)
  if (admission.literalLandings.size === 0) return false;
  for (let length = 0; length <= path.length; length += 1)
    if (admission.literalLandings.has(keptKey(admission.work, place, path.slice(0, length))))
      return true;
  return false;
}

/**
 * A literal-borne seed's level (`retainedSource`): the path's decision as its scan gives it, the literal's cell's
 * answer among its contributions, as `deciderAt` asks it; `null` after a program stop (#2289) or where nothing
 * decides.
 */
function literalSeed(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): { readonly tags: ItemTag[]; readonly inherited: boolean } | null {
  if (admission.pass.program.work.stopped !== null) return null;
  const key = keyAt(admission.pass.contract, place, path);
  const inputs = inputsAt(admission, isKeyId(key) ? { root: place, key } : { root: place, path });
  const found =
    inputs === null
      ? null
      : drive(admission, scanAt(admission, inputs.direct, inputs.prefixes, key));
  if (found === null || found.stopped === true || found.tags.length === 0) return null;
  // (a strict answer's complete type with its null; an inferred one's kinds, with null by admission's null rule, as a
  // retained decision's)
  if (found.copied !== null)
    return { tags: [...new Set(typeTags(found.copied))], inherited: found.byWritten };
  const kinds = admission.run(admission.pass.contract.contractOf(key));
  const open =
    path.length > 0 ||
    kinds.every((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0);
  const nullable =
    found.permitsNull || (found.nullable && (open || kinds.some((item) => item.tag === "null")));
  return {
    tags: nullable ? [...new Set([...found.tags, "null" as const])] : [...found.tags],
    inherited: found.byWritten,
  };
}

/**
 * Whether, after a stop, a path is one `lazily` would decide now (copies land there, no decision has tried it): no
 * decision is made after a stop, so it is answered from what admission retained.
 */
function undecidedCopy(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  return (
    admission.pass.program.work.stopped !== null &&
    !admission.attempted.has(keyAt(admission.pass.contract, place, path)) &&
    landed(admission, place, path)
  );
}

/** Whether a copy of a written type decides a place's path, not the place's own written type. */
export function inheritsWritten(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): boolean {
  if (undecidedCopy(admission, place, path))
    return retainedSource(admission, place, path)?.inherited ?? false;
  lazily(admission, place, path);
  const key = keyAt(admission.pass.contract, place, path);
  pull(admission, place, path, key);
  return (
    admission.inheritsWrittenKeys.has(key) ||
    (writtenOf(admission.pass.program.place(place).kind) === null &&
      openBelow(admission, place, path))
  );
}

/**
 * Whether a path no decision was taken at lies below an unrestricted part of its place's written type, or of a written
 * type a copy decides above it (`openAbove`): every kind fits it, as where a store there decides it (`decide`), never
 * the kinds the place's contents hold there (V30 §13; ADR 0021 1.3: a copy keeps the written type).
 */
function openBelow(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  const written = writtenOf(admission.pass.program.place(place).kind);
  if (written === null)
    return (
      !admission.attempted.has(keyAt(admission.pass.contract, place, path)) &&
      openAbove(admission, place, path)
    );
  const term = permittedAt(written, path);
  return term !== null && unrestricted(term);
}

/**
 * The site of the contribution that decided a place's path (the earliest definite one, or a copy of a written
 * binding), `null` where no store decides it. A path settled without a scan (a settled single-family contract, a plain
 * scalar root) has its earliest definite contribution found here, once, where an answer asks for it.
 */
function deciderAt(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): SourceSite | null {
  lazily(admission, place, path);
  const key = keyAt(admission.pass.contract, place, path);
  pull(admission, place, path, key);
  if (!admission.deciderSites.has(key)) {
    const inputs = inputsAt(admission, isKeyId(key) ? { root: place, key } : { root: place, path });
    const below = path.length > 0 && admission.run(admission.pass.contract.refReceiver(key));
    keepText(admission.work, key.length);
    admission.deciderSites.set(
      key,
      inputs === null || below
        ? null
        : (drive(admission, scanAt(admission, inputs.direct, inputs.prefixes, key))?.site ?? null),
    );
  }
  return admission.deciderSites.get(key)!;
}

/**
 * A path's admitted type as every answer reads a level: its written type (`term`), else what admission decided
 * (`admitted`), with the decider found where it is read and whether a copy of a written type decides it; after a stop
 * before admission settled nothing but the written type; after one where it had settled, a path admission retained
 * nothing for answered by what the stores' syntax decides (`cheap`, as the finishing read's last source before
 * `STOPPED`).
 */
export function admittedLevel(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
  term: TypeTerm | null,
  after: {
    readonly stopped: boolean;
    readonly settled: boolean;
    readonly cheap: (place: PlaceId, path: readonly string[]) => CheapDecision | null;
  },
): AdmittedType {
  // (each kind once: `(null | string)?` admits `null` and `string`)
  if (term !== null) return { by: "written", kinds: [...new Set(typeTags(term))] };
  // (after a stop nothing is decided but what is written, unless admission had settled: its decisions stand)
  if (after.stopped && !after.settled) return { by: "undecided" };
  const kinds = admitted(admission, place, path);
  // (after a stop admission decides nothing more: where what it retained leaves the path undecided, what every
  // store's syntax decides answers, as the finishing read's last source before `STOPPED`)
  if (kinds.length === 0 && after.stopped) {
    const decided = after.cheap(place, path);
    if (decided !== null)
      return {
        by: "decided",
        // (in their one order once more, by the spelling the decision kept, #1398)
        kinds: kindsInItsOrder(decided.kinds, decided.spelling),
        decider: decided.decider.site,
        inherited: decided.inherited,
      };
  }
  // (the decider's site is found where it is read: settled paths have no scan to keep it from)
  return kinds.length === 0
    ? { by: "undecided" }
    : {
        by: "decided",
        kinds,
        get decider(): SourceSite | null {
          return deciderAt(admission, place, path);
        },
        inherited: inheritsWritten(admission, place, path),
      };
}
