import type { PlaceId, SourceSite } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keepText, keptSteps, pathText } from "../budget.js";
import { termAt, typeTags, writtenOf } from "../contract.js";
import { type CanonicalKey, isKeyId, keptKeyAt, keyAt } from "../contract/key-ids.js";
import { withoutEmpty } from "../exact-path.js";
import type { ItemTag } from "../items.js";
import { drive, openAbove } from "./inherited.js";
import { admitsNumber, concrete } from "./kinds.js";
import { inheritance, landed } from "./landings.js";
import { permittedAt, unrestricted } from "./permitted.js";
import { inputsAt, scanAt } from "./scan.js";

// The admitted type at a path (C9 r4.12), the decision retained after a stop, and the deciding contribution's site; each
// path's key in its identity (`keyAt`: a wrapper family's its cursor, as `decide` records it, G3 stage 1).

/**
 * A path copies land in a place that `groups` left out, decided where an answer asks for it (`decide`'s `lazily`):
 * its contents fit, so its decision owes nothing, and its answer is the one deciding it with the copy gives.
 */
function lazily(admission: Admission, place: PlaceId, path: readonly string[]): void {
  if (
    admission.attempted.has(keyAt(admission.pass.contract, place, path)) ||
    !landed(admission, place, path)
  )
    return;
  // (after a stop admission decides nothing more: such a path is answered from what it retained, `retainedSource`;
  // nor below a decision that stopped, S3 §5)
  if (admission.pass.program.work.stopped !== null || admission.decisionStopped(place, path))
    return;
  admission.decide({ root: place, path }, true);
}

/**
 * C9 r4.12 (A1–A7): a destination's admitted type: the written type (its null included), else the decided kinds (an
 * integer decider already widened by an admitted number, a copy of a written integer never: A4), else, where
 * admission decided nothing, the contract's kinds, one family, an integer widened by an admitted number; with `null`
 * where a null contribution is admitted and the decision admits one (a copy of a written type without it does not),
 * and wherever a copy of a written type with it decided, whatever is stored (`permitsNull`), a written `null` alone
 * too (`[null]`, a decision like any other, never none: the lead's ruling on the merged S6's B1); never the raw union
 * of contributions.
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
  // (an unrestricted written part, or a copy's, admits every kind at and below it: never what is stored)
  if (admission.unrestricted.has(key) || openBelow(admission, place, path)) return ["unknown"];
  const kinds = withoutEmpty(admission.run(contract.contractOf(key)));
  const decided = admission.decided.get(key);
  let tags = [
    ...(decided ?? new Set(kinds.filter((item) => concrete(item)).map((item) => item.tag))),
  ];
  if (decided === undefined && tags.includes("integer") && kinds.some(admitsNumber))
    tags = [...new Set(tags.map((tag) => (tag === "integer" ? "number" : tag)))];
  const permitsNull = admission.permitsNull.has(key);
  return (tags.length > 0 || permitsNull) &&
    (permitsNull ||
      (admission.nullable.get(key) !== false && kinds.some((item) => item.tag === "null")))
    ? [...tags, "null"]
    : tags;
}

/**
 * After a stop, a path's admitted type as admission retained it, without new solving (S3 §5 revision 14, TABLE r4.102):
 * its written type (A1), its decision (A2), else a copied written type landing there (A4's seeds), else, where a copy
 * of another place lands at or above it (a lazily decided copy path among them), that source's at the same path below
 * the copy, through the copy forest's edges; with `null` where the decision admits one (admission's null rule, its
 * contract question answered as admitting); `null` where none of these decides the path, `["unknown"]` where every
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
 * `retained`'s answer, and whether a written type decides it through copies (A4: a seed, a copy's source's written
 * type, or a source's decision that inherits one): the copy forest walked from the path with an explicit worklist,
 * each key once, in the copies' order; round a cycle of copies a path never grows (a copy of a member's part is not
 * followed within the cycle, as F1's landings), so the walk ends.
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
    // (a decision that stopped, the path's own or a copy's source's, retains nothing: undecided, S3 §5)
    if (admission.decisionStopped(at.place, at.path)) return null;
    // (kept in `seen`)
    const key = keptKeyAt(admission.pass.contract, at.place, at.path);
    if (admission.unrestricted.has(key)) return { tags: ["unknown"], inherited: at.copied };
    const decided = admission.decided.get(key);
    if (decided !== undefined)
      return {
        tags:
          admission.permitsNull.has(key) || admission.nullable.get(key) !== false
            ? [...new Set([...decided, "null" as const])]
            : [...decided],
        inherited: admission.inheritsWrittenKeys.has(key),
      };
    if (seen.has(key)) continue;
    seen.add(key);
    const { seeds, into, cycleOf } = inheritance(admission);
    const levels = seeds.get(at.place)?.get(pathText(at.path));
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
 * Whether, after a stop, a path is one `lazily` would decide now (copies land there, `groups` left it out): no
 * decision is made after a stop (S3 §5 revision 14), so it is answered from what admission retained.
 */
function undecidedCopy(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  return (
    admission.pass.program.work.stopped !== null &&
    !admission.attempted.has(keyAt(admission.pass.contract, place, path)) &&
    landed(admission, place, path)
  );
}

/** Whether a copy of a written type decides a place's path, not the place's own written type (A4, r4.75 (1)). */
export function inheritsWritten(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): boolean {
  if (undecidedCopy(admission, place, path))
    return retainedSource(admission, place, path)?.inherited ?? false;
  lazily(admission, place, path);
  return (
    admission.inheritsWrittenKeys.has(keyAt(admission.pass.contract, place, path)) ||
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
 * The site of the contribution that decided a place's path (A2's earliest definite one, A4's copy, S3 §1), `null`
 * where no store decides it. A path A3 settled without a scan (a settled family, a plain scalar root) has its earliest
 * definite contribution found here, once, where an answer asks for it.
 */
export function deciderAt(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): SourceSite | null {
  lazily(admission, place, path);
  const key = keyAt(admission.pass.contract, place, path);
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
