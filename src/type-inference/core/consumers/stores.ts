import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import {
  concrete,
  contributes,
  deciding,
  fits,
  isExternal,
  isOpaque,
  requiredKind,
  type Decision,
} from "../admission.js";
import {
  BudgetExhausted,
  DemandExhausted,
  demandAllowanceFor,
  joinParts,
  keptParts,
  keptSteps,
} from "../budget.js";
import type { Consumers } from "../consumers.js";
import { writtenOf } from "../contract.js";
import { keyPlace, type Definition } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import { REASON, type Item, type ItemTag, type Writer } from "../items.js";
import { propertyStep } from "../program.js";
import { offendingKinds, type DiagnosticRule } from "../result.js";
import { error } from "./diagnostics.js";
import { kindsOf, quietKinds } from "./names.js";
import { copiesOnly, deferred, storeReach } from "./reach.js";
import {
  nullWarning,
  obligation,
  placeText,
  storeRoot,
  storeSteps,
  storeWarning,
} from "./warnings.js";

// The stores' obligations (C1): each admitted store's check, a key's decision on demand, a stopped key's marks.

const writerRank = (writer: Writer | null): number =>
  writer === null ? Infinity : writer.file * 1e9 + writer.start;

/**
 * One admission decision for one key as one demand (S3 §5), with the program's nodes' allowance (S3 revision 14: a
 * decision's stores come from every call site, so its callable's nodes do not bound its work): past it the decision
 * stops between two solver steps, what it made of its key is taken back (`Admission.stopDecision`), and every read
 * of the key answers `unknown` with the reason `budget`, so each owes its check, with its warning, as for external
 * data (C9). The pass is then not settled: the next starts with the key stopped and runs no decision at or below it
 * (TABLE r4.180); a decision stopping in that next pass stops the analysis there, as the work allowance does, so a
 * pass's work at most doubles (TABLE r4.183). A stopped decision stands for its stores' obligations
 * (`stoppedStores`), whichever pass stopped it.
 */
export function decide(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
  lazily = false,
): Decision | null {
  const ledger = walk.pass.program.work;
  const before = ledger.own;
  const allowance = demandAllowanceFor(walk.pass.program.flow.nodes.length);
  // (a key whose decision stopped, in this pass or before it, or a key below one: undecided, no decision runs)
  if (walk.admission.decisionStopped(root, path)) {
    walk.decisions.push({ place: root, path, units: 0, allowance, stopped: true });
    walk.stoppedStores(root, path);
    return null;
  }
  // (its work is the decision's, not a consumer read's)
  walk.reading = null;
  walk.deciding = before + allowance;
  let stopped = false;
  try {
    return walk.admission.decide(root, path, lazily);
  } catch (error) {
    if (!(error instanceof DemandExhausted)) throw error;
    stopped = true;
    walk.decisionStopped = true;
    walk.admission.stopDecision(root, path);
    walk.stoppedStores(root, path);
    // (in a pass that restarted one whose decision stopped, a second stop stops the analysis: D4, TABLE r4.183)
    if (walk.restarted) throw new BudgetExhausted("work");
    return null;
  } finally {
    walk.deciding = null;
    walk.decisions.push({ place: root, path, units: ledger.own - before, allowance, stopped });
  }
}

/**
 * The places and paths admission decides by a written type: the roots `Admission.groups` starts from (every key with a
 * definition or a candidate: a store, add, argument or return, a multi-site or dead call's argument among them, which
 * decides nothing but C1 checks, ADR 0021 1.5), the written ones, each at every path of its written type, which is as
 * large as the source that writes it. The fresh pass's C1 decides these alone (`groups` would group every key and walk
 * every store's landings again, unbounded after a stop: TABLE r4.55, r4.126).
 */
function writtenGroups(
  walk: Consumers,
): { readonly root: PlaceId; readonly path: readonly string[] }[] {
  const { program, definitions } = walk.pass;
  const out: { readonly root: PlaceId; readonly path: readonly string[] }[] = [];
  const seen = new Set<PlaceId>();
  for (const key of [...definitions.byKey.keys(), ...definitions.candidates.keys()]) {
    program.work.charge("checks");
    const place = keyPlace(key);
    if (seen.has(place)) continue;
    seen.add(place);
    const written = writtenOf(program.place(place).kind);
    if (written === null) continue;
    const pending: [TypeTerm, readonly string[]][] = [[written, []]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      program.work.charge("checks");
      const [term, path] = next;
      out.push({ root: place, path });
      if (term.kind === "union") for (const member of term.members) pending.push([member, path]);
      else if (term.kind === "list" || term.kind === "set" || term.kind === "dict")
        pending.push([term.element, keptSteps(program.work, path, ["element"])]);
      else if (term.kind === "object")
        for (const property of term.properties ?? [])
          pending.push([
            property.type,
            keptSteps(program.work, path, [propertyStep(property.name)]),
          ]);
    }
  }
  // (a union's members reach one path more than once: each path once)
  const unique = new Map<string, { readonly root: PlaceId; readonly path: readonly string[] }>();
  for (const group of out) unique.set(keptParts(program.work, group.root, group.path), group);
  return [...unique.values()];
}

/**
 * C1, C7 against a place's admitted type (A1–A9): every candidate store admission names is checked against the
 * decided type, the store's value at its node by §3. A definite contribution that does not fit, where no kind of the
 * value fits, is an error at the innermost offending expression and the store is rejected (A6, r4.35); a store of a
 * rejection cycle a warning; a definite element of a collection literal none of whose kinds fits a written element
 * type an error at that element (A8); a value none of whose kinds fits a written type or one decided earlier in the
 * source an error even when every item is possible (ADR 1.7), never under a guard; otherwise one `copy-type` per
 * offending kind, whatever its certainty, a copy made before its decider with context `later` (A7), and a
 * `null-check` for a possible null. The store's external data brings its boundary checks (C9). `writtenOnly`: the
 * places whose written type reaches the path alone, the finishing path's C1 before admission settled (TABLE r4.126: one
 * derivation, the written type final at every stop).
 */
export function admittedStores(walk: Consumers, writtenOnly = false): void {
  const { program, definitions } = walk.pass;
  const admission = walk.admission;
  for (const { root, path } of walk.order(writtenOnly ? writtenGroups(walk) : admission.groups())) {
    const decision = decide(walk, root, path);
    if (decision === null) continue;
    const { label, tags, nullable, decider } = decision;
    const written = decision.written;
    const nullableTags = written && nullable ? [...tags, "null" as const] : tags;
    const fitsAny = (item: Item): boolean =>
      item.tag === "unknown" ||
      (item.tag === "null" ? nullable : tags.some((tag) => fits(item.tag, tag, written)));
    const fitting = (item: Item): boolean =>
      item.tag === "unknown" ||
      (concrete(item) && tags.some((tag) => fits(item.tag, tag, written)));
    // D1: the sentence's rule, the place in its own text, its type (optional where it holds null too, ADR 0021 rule
    // 1.2) and the store that decided it
    const named = (): readonly ItemTag[] =>
      written || !admission.admitted(root, path).includes("null")
        ? nullableTags
        : [...tags, "null"];
    const rule = (brought: SourceSite | null = null): DiagnosticRule => ({
      rule: "store",
      into: placeText(walk, root, path),
      type: named(),
      written,
      decider: decider?.site ?? null,
      brought,
      root: storeRoot(walk, root),
      steps: storeSteps(walk, root, path, written ? writtenOf(program.place(root).kind) : null),
    });
    // C9 r4.12, r4.50 (1): a place published with its contract's kinds owes the check of external data another store
    // brought, at each candidate carrying it, against those kinds; data a store brings inline has its boundary there,
    // an opaque value C5's obligation at its access (A7)
    if (decision.published) {
      for (const candidate of decision.candidates)
        // (its members by reference, read one by one only while each owes: no per-path member list, Codex r22 F1)
        for (let index = 0; index <= (candidate.members?.length ?? 0); index += 1) {
          const d = index === 0 ? candidate.d : candidate.members![index - 1]!;
          const { at } = candidate;
          walk.reading = d.node;
          // (S6-CARRIERS §4.4: the representative's site is its class's proof, each member a visit)
          program.work.charge(index === 0 ? "quietProofs" : "c1Visits");
          const site = admission.namedExternalSite(d, at);
          // (an equivalent copy holds what its representative holds: none of them owes it)
          if (site === null) break;
          const value = admission.valueAt(d, at);
          const named = value.filter(
            (item) => isExternal(item) && !admission.ownIngress(item, d, at),
          );
          const against = admission.admitted(root, path);
          for (const { item } of offendingKinds(named))
            storeWarning(walk, site, label, item, against, rule(), value.filter(fitting));
          // C9: the named data's own ingress keeps its boundary, as at a decided store
          for (const item of named)
            admission.boundaryFor(
              item,
              obligation(
                "copy-type",
                site,
                label,
                against.map(requiredKind),
                `validate ${label} against ${against.join("|")}`,
              ),
            );
        }
      continue;
    }
    // C1 per candidate; an equivalent copy (`Candidate.members`) only where its representative leaves an obligation
    const visit = (d: Definition, at: readonly string[]): void => {
      if (d === decider && at.length === 0) return;
      walk.reading = d.node;
      // §3.3: a candidate the admitted type accepts whatever its value
      if (at.length === 0) {
        const quiet = quietKinds(walk, d.value);
        if (
          quiet !== null &&
          quiet.every((tag) =>
            tag === "null" ? nullable : tags.some((ref) => fits(tag, ref, written)),
          )
        ) {
          walk.skip(d.value);
          return;
        }
      }
      const items = admission.valueAt(d, at);
      // a dead call's argument holding a kind that came through a call may lack the marks that call's binding would
      // give (F21, `called`): it stays unchecked, as every dead call's argument was before AD-3
      if (
        d.how === "argument" &&
        !program.live(d.node) &&
        items.some((item) => item.called === true)
      )
        return;
      const before = decider !== null && admission.sourceOrder(d) < admission.sourceOrder(decider);
      const bad = deciding(items).filter(
        (item) => !tags.some((tag) => fits(item.tag, tag, written)),
      );
      const nulls = items.filter((item) => item.tag === "null");
      // A6: a store of a rejection cycle is a possibility
      if (bad.length > 0 && d !== decider && admission.cycling.has(d.uid)) {
        storeWarning(
          walk,
          d.site,
          label,
          { ...bad[0]!, cert: "pos" },
          tags,
          rule(),
          items.filter(fitting),
        );
        return;
      }
      // A8: a collection literal stored into a written element type admits each element by the scalar rule: a
      // definite element none of whose kinds fits is A6's error at that element, the store rejected
      const wrong =
        written &&
        at.includes("element") &&
        d.kind === "whole" &&
        d !== decider &&
        !admission.cycling.has(d.uid)
          ? admission.offendingAt(
              d,
              at,
              (elements) =>
                elements.length > 0 &&
                elements.every((item) => item.cert === "def" && concrete(item)) &&
                !elements.some((item) => tags.some((tag) => fits(item.tag, tag, written))),
            )
          : null;
      if (wrong !== null) {
        error(
          walk,
          "written-target",
          program.place(wrong.value!).site ?? d.site,
          rule(),
          kindsOf(walk, wrong.value!, d.node).map((item) => item.tag),
        );
        admission.reject(d, root, path);
        return;
      }
      // A6: a definite contribution that does not fit, where no kind of the value fits (r4.46: a fitting kind beside it
      // makes it a warning), is rejected, its error at the innermost offending expression (r4.35)
      if (bad.length > 0 && d !== decider && !items.some(fitting)) {
        const reach = !written && d.place === root ? storeReach(walk, d, path) : null;
        const { site, brought } = deferred(
          walk,
          admission.siteAt(d, at, (elements) =>
            deciding(elements).some((item) => !tags.some((tag) => fits(item.tag, tag, written))),
          ),
          root,
          path,
          reach !== null &&
            reach.brought &&
            !admission.atCopy(root, path) &&
            copiesOnly(walk, root, path),
          () => reach?.copy ?? null,
        );
        error(
          walk,
          "written-target",
          site,
          rule(brought),
          bad.map((item) => item.tag),
        );
        admission.reject(d, root, path);
        return;
      }
      // C1, ADR 1.7: a value none of whose kinds fits errs, against a written type at any path or a type decided
      // earlier in the source for a store into the place itself; never against a later decider (A7), never under a
      // guard (§3.2), and not where the collection may be empty (no element: the empty list fits); the store is
      // rejected (A6), whether its kinds are definite or possible: none of them fits
      if (
        !before &&
        items.length > 0 &&
        (written || at.length === 0) &&
        !(
          at.length > 0 &&
          d.kind !== "const" &&
          walk.valueRun(d.value!, d.node, at).some((item) => item.tag === "empty")
        ) &&
        !items.some((item) => item.guarded === true) &&
        !items.some(fitsAny)
      ) {
        error(
          walk,
          "written-target",
          admission.siteAt(d, at, (elements) => elements.length > 0 && !elements.some(fitsAny)),
          rule(),
          items.map((item) => item.tag),
        );
        admission.reject(d, root, path);
        return;
      }
      // A7: a copy made before the decider is checked against it with context `later`
      const later = (item: Item): Item => (before ? { ...item, context: "later" } : item);
      // A7's whole-store exception (r4.9): below a value the store holds whole from an external ingress, external data
      // is that record's, which its boundary check validates, so only an opaque value warns there; a whole copy of
      // internal data keeps A7 per descendant (an `addAll`'s first element step is its inserted value's own
      // destination, no descendant: C9)
      const inserted = d.kind === "add" && d.how === "elements" ? 1 : 0;
      const whole =
        written || at.length <= inserted || d.kind === "const"
          ? null
          : admission.wholeBelow(d.value!, at);
      // (a `load` or `fromJson` typed by its default alone validates the loaded value by the default's own kinds: host
      // data the default holds leaves the path's kind open, its contribution C1's, TABLE r4.66 (3))
      const record =
        whole !== null && definitions.ingress.has(whole) && !admission.typedByDefault(whole);
      const wholeKinds =
        whole === null || definitions.ingress.has(whole)
          ? []
          : withoutEmpty(walk.valueRun(whole, d.node, []));
      const below =
        whole !== null &&
        (record || (wholeKinds.length > 0 && wholeKinds.every((item) => isExternal(item))));
      // every concrete kind that does not fit, definite or possible, owes its check (TABLE §4, r4.46)
      const offending = items
        .filter(
          (item) =>
            (concrete(item) && !tags.some((tag) => fits(item.tag, tag, written))) ||
            (item.tag === "unknown" &&
              (at.length === 0
                ? isOpaque(item) || isExternal(item)
                : // (an own read's data is no record's: its boundary checks nothing against the destination,
                  // TABLE r4.67 (2))
                  below && !admission.ownReadItem(item, d)
                  ? isOpaque(item) && item.reasons !== REASON.missing
                  : contributes(item))),
        )
        .sort((a, b) => writerRank(a.writer) - writerRank(b.writer));
      // one copy-type diagnostic per offending kind, its earliest writer (§4, F28); against the destination's required
      // kinds, a written optional type's null among them (a decided type's admitted null is C9's)
      for (const { item } of offendingKinds(offending))
        storeWarning(
          walk,
          !isExternal(item)
            ? d.site
            : d.kind === "whole"
              ? admission.ingressSiteOf(d, at, item)
              : admission.contributionSited(d.site, item, d),
          label,
          later(item),
          nullableTags,
          rule(),
          items.filter(fitting),
        );
      // C9: at the ingress store (an addAll's at its elements' destination); and each external item's, so named data
      // a typed default holds keeps its own boundary (TABLE r4.66 (2))
      if (
        d.value !== undefined &&
        definitions.ingress.has(d.value) &&
        (at.length === 0 || (d.kind === "add" && at.length === 1 && at[0] === "element"))
      )
        admission.boundaryAt(d);
      for (const item of items)
        admission.boundaryFor(
          item,
          obligation(
            "copy-type",
            admission.cellSited(d.site, item, d),
            label,
            tags.map(requiredKind),
            `validate ${label} against ${tags.join("|")}`,
          ),
        );
      // a null beside external data owes its null-check, unless the destination's admitted type holds null; a possible
      // null into a non-nullable type a null-check, a definite one an error
      const external = items.some(isExternal);
      if (
        (!nullable && (at.length === 0 || written) && !before) ||
        (external && !admission.admitted(root, path).includes("null"))
      )
        for (const item of nulls)
          if (item.cert === "def" && !external) {
            error(
              walk,
              "written-target",
              admission.siteAt(d, at, (elements) =>
                elements.some((element) => element.tag === "null" && element.cert === "def"),
              ),
              rule(),
              ["null"],
            );
            admission.reject(d, root, path);
          } else
            nullWarning(
              walk,
              "written-target",
              d.site,
              later(item),
              `check that the value is not null before ${label} holds it`,
              label,
              rule(),
              items.filter(fitting),
              tags.map(requiredKind),
            );
    };
    // S6-CARRIERS §4.4: a class's quiet proofs, one per side of the decider, each its side's first member but the
    // decider's own store; a proof that emits nothing (no diagnostic, rejection or check) proves its side quiet, else
    // each member of the side is visited. The class in source order (its representative, then its members by
    // reference), each side a range of it found by a binary search: no per-path member list (Codex r22 F1)
    const emitted = (): number =>
      walk.diagnostics.length + admission.rejections + admission.readChecks.length;
    const order = decider === null ? null : admission.sourceOrder(decider);
    for (const { d, at, members } of decision.candidates) {
      if (members === undefined) {
        visit(d, at);
        continue;
      }
      const member = (index: number): Definition => (index === 0 ? d : members[index - 1]!);
      const size = members.length + 1;
      let split = 0;
      if (order !== null) {
        let high = size;
        while (split < high) {
          const middle = (split + high) >> 1;
          program.work.charge("quietProofs");
          if (admission.sourceOrder(member(middle)) < order) split = middle + 1;
          else high = middle;
        }
      }
      for (const [low, high] of [
        [0, split],
        [split, size],
      ] as const) {
        let proof = low;
        if (proof < high && member(proof) === decider && at.length === 0) proof += 1;
        if (proof >= high) continue;
        program.work.charge("quietProofs");
        const was = emitted();
        visit(member(proof), at);
        const value = member(proof).value;
        if (emitted() === was) {
          // (equivalent values are quiet alike, §3.3: each side's once)
          const side = joinParts(d.uid, low, high);
          if (value !== undefined && walk.quiet.has(value) && !walk.quietSides.has(side)) {
            walk.quietSides.add(side);
            program.work.charge("checksSkipped");
            for (let index = low; index < high; index += 1) {
              program.work.charge("checksSkipped");
              const skipped = member(index).value;
              if (index !== proof && skipped !== undefined) walk.quiet.add(skipped);
            }
          }
          continue;
        }
        for (let index = low; index < high; index += 1) {
          if (index === proof) continue;
          program.work.charge("c1Visits");
          visit(member(index), at);
        }
      }
    }
  }
  // (the stores above a decision that stopped, the pass's decisions taken: #1416)
  walk.enclosingStores();
  // (the member-answer oracle's paths the copies land and no decision took)
  admission.compareLanded();
}
