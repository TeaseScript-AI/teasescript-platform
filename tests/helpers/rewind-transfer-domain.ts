/*
 * The domain of Debug's rewind lineage transfers (docs/DEBUGGER.md "Rewind"): what each rewind transition does to the
 * parked and restored lineages, in each inspection state, declared once as rules with their sources. The obligations a
 * test must meet are generated from these rules: every transition and variant in every inspection state, and every
 * guard failure where the transition would act. A coverage check binds a test's observed cases to those obligations, so
 * a missing or unexpected case fails, not merely a missing row.
 */

import type { ParkedFate, ShownFate } from "../../player/engine-bridge/history/core.js";

/** The inspection states a transition can meet. */
export const INSPECTION = [
  "not inspecting",
  "inspecting with a future",
  "inspecting without a future",
  "adopting",
] as const;
export type Inspection = (typeof INSPECTION)[number];

/** What a transition does to the lineages, or that it is refused and changes no ownership. */
export type Expectation =
  | { readonly kind: "refused" }
  | { readonly kind: "unchanged"; readonly why: string }
  | { readonly kind: "transfer"; readonly parked: ParkedFate; readonly shown: ShownFate };

/** One transition's rule: its variants, the guards that can fail it, and what it does in each inspection state. */
export interface TransferRule {
  readonly transition: string;
  /** The transition's variants, each its own input; one unnamed variant when it has none. */
  readonly variants: readonly string[];
  /** Guards whose failure leaves ownership unchanged, checked wherever the transition would act. */
  readonly guards: readonly string[];
  /** Where the rule comes from, in the repository. */
  readonly source: string;
  /** What the transition does: one case, or several when an outcome the transition awaits decides it. */
  decide(
    inspection: Inspection,
    variant: string,
  ): readonly { readonly name: string; readonly expect: Expectation }[];
}

const refused = [{ name: "refused", expect: { kind: "refused" } }] as const;
const transfer = (name: string, parked: ParkedFate, shown: ShownFate) => [
  { name, expect: { kind: "transfer", parked, shown } as const },
];
const inspecting = (inspection: Inspection) =>
  inspection === "inspecting with a future" || inspection === "inspecting without a future";

/** The ten rules, each with its source. */
export const RULES: readonly TransferRule[] = [
  {
    transition: "back",
    variants: [""],
    guards: ["target", "read", "readiness"],
    source:
      'docs/DEBUGGER.md "Rewind"; player/engine-bridge/ops/history.ts rewindBack; player/vue/src/rewindOwner.ts back',
    decide: (inspection) =>
      inspection === "not inspecting"
        ? transfer("parks the live lineage", "parked", "target")
        : inspecting(inspection)
          ? transfer("keeps the shown one for Forward", "kept", "target")
          : refused,
  },
  {
    transition: "forward",
    variants: [""],
    guards: ["read", "readiness"],
    source: "player/engine-bridge/ops/history.ts rewindForward (refused without a state Back left)",
    decide: (inspection) =>
      inspection === "inspecting with a future"
        ? transfer("consumes the last future entry", "kept", "future")
        : refused,
  },
  {
    transition: "return",
    variants: [""],
    guards: [],
    source: 'docs/DEBUGGER.md "Rewind"; player/vue/src/rewindOwner.ts returnToSession',
    decide: (inspection) =>
      inspecting(inspection)
        ? transfer("reinstates the parked lineage", "live", "released")
        : refused,
  },
  {
    transition: "adopt begun",
    variants: ["replacing saved data", "session-local"],
    guards: [],
    source:
      "player/vue/src/session/useSessionRewind.ts adoptShown (work begins before an optional replacement)",
    decide: (inspection) =>
      inspecting(inspection) ? transfer("becomes adopting", "kept", "adopting") : refused,
  },
  {
    transition: "adopt ended",
    variants: [
      "succeeded, replacing saved data",
      "succeeded, session-local",
      "failed, replacing saved data",
      "failed, session-local",
    ],
    guards: [],
    source: "player/vue/src/session/useSessionRewind.ts adoptShown",
    decide: (inspection, variant) =>
      inspection !== "adopting"
        ? refused
        : variant.startsWith("succeeded")
          ? transfer("the shown lineage is live", "released", "live")
          : transfer("inspecting again, unchanged", "kept", "inspecting"),
  },
  {
    transition: "close by debugOff",
    variants: [""],
    guards: [],
    source: 'docs/DEBUGGER.md "Rewind"; player/vue/src/rewindOwner.ts debugOff',
    decide: (inspection) =>
      inspection === "not inspecting"
        ? [
            {
              name: "nothing to transfer",
              expect: { kind: "unchanged", why: "no lineage is parked" },
            },
          ]
        : inspection === "adopting"
          ? [
              ...transfer("kept on the adoption's success", "released", "live"),
              ...transfer(
                "the parked one reinstated on its failure, while current",
                "live",
                "released",
              ),
            ]
          : transfer("reinstates the parked lineage", "live", "released"),
  },
  {
    transition: "close by replacement",
    variants: [""],
    guards: [],
    source: "player/vue/src/usePlayerSession.ts generation",
    decide: (inspection) =>
      inspection === "not inspecting"
        ? [
            {
              name: "nothing to transfer",
              expect: { kind: "unchanged", why: "no lineage is parked" },
            },
          ]
        : transfer("all retired", "released", "released"),
  },
  {
    transition: "close by import",
    variants: ["with a replacement", "ending the session"],
    guards: [],
    source: 'docs/DEBUGGER.md "Rewind" (an import ends an inspected state)',
    decide: (inspection) =>
      inspection === "not inspecting"
        ? [
            {
              name: "nothing to transfer",
              expect: { kind: "unchanged", why: "no lineage is parked" },
            },
          ]
        : transfer("all retired", "released", "released"),
  },
  {
    transition: "close by clear",
    variants: [""],
    guards: [],
    source:
      "player/vue/src/session/persistence/useSavedValues.ts canClearScriptStorage (requires !inspecting)",
    decide: (inspection) =>
      inspection === "not inspecting"
        ? [
            {
              name: "retires the history",
              expect: { kind: "unchanged", why: "no lineage is parked" },
            },
          ]
        : refused,
  },
  {
    transition: "close by disposal",
    variants: [""],
    guards: [],
    source: "the Player's scope",
    decide: () => transfer("all released, nothing shows", "released", "released"),
  },
];

/** One obligation: a transition, its variant, an inspection state, a case or a failed guard, and what it expects. */
export interface Obligation {
  readonly key: string;
  readonly transition: string;
  readonly variant: string;
  readonly inspection: Inspection;
  readonly case: string;
  readonly expect: Expectation;
  readonly source: string;
}

const keyOf = (parts: readonly string[]) => parts.filter((part) => part !== "").join(" / ");

/**
 * Every obligation of `rules` over `inspection`: each case of each variant in each state, and each guard's failure in
 * each state where the transition would act (not refused).
 */
export function obligations(
  rules: readonly TransferRule[] = RULES,
  inspection: readonly Inspection[] = INSPECTION,
): Obligation[] {
  const found: Obligation[] = [];
  for (const rule of rules)
    for (const variant of rule.variants)
      for (const state of inspection) {
        const cases = rule.decide(state, variant);
        for (const each of cases)
          found.push({
            key: keyOf([rule.transition, variant, state, each.name]),
            transition: rule.transition,
            variant,
            inspection: state,
            case: each.name,
            expect: each.expect,
            source: rule.source,
          });
        if (cases.every((each) => each.expect.kind === "refused")) continue;
        for (const guard of rule.guards)
          found.push({
            key: keyOf([rule.transition, variant, state, `${guard} guard fails`]),
            transition: rule.transition,
            variant,
            inspection: state,
            case: `${guard} guard fails`,
            expect: { kind: "unchanged", why: `the ${guard} guard failed` },
            source: rule.source,
          });
      }
  return found;
}

/**
 * What `observed` (the keys of the cases a test ran) misses of `required`, and what it has that is no obligation;
 * both empty means the test ran exactly the declared obligations.
 */
export function transferCoverage(
  required: readonly Obligation[],
  observed: Iterable<string>,
): { readonly missing: string[]; readonly unexpected: string[] } {
  const want = new Set(required.map((each) => each.key));
  const have = new Set(observed);
  return {
    missing: [...want].filter((key) => !have.has(key)),
    unexpected: [...have].filter((key) => !want.has(key)),
  };
}
