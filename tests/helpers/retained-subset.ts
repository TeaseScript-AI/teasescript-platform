/*
 * #1072 step 1b (R28): the type-core test files CI runs frozen (`retained-instrument-preload.ts`), chosen by measurement:
 * per file, what it exercises frozen (each kind `Retained` makes, by its name and site; each owner kind; each registered
 * function) and what freezing it costs in CI; then a greedy cover of everything the 86 files exercise, the cheapest
 * first per item it adds, within no CI shard above 10 minutes. The whole frozen survey (`RETAINED_FREEZE=all`, docs/TESTING.md) runs every file. Measured at
 * #2417's head 10a2ad0f (notes `o4-lead/plans/1072-retained-head0.md`, Amendment 3, "The frozen subset").
 */

/** The files CI freezes, by name, each with what it is the first of the subset to exercise. */
export const FROZEN_IN_CI: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "type-core-landings.test",
    "302 first: arena Contract.layersById (contract.ts), arena Contract.pathChildren (contract.ts) and 300 more",
  ],
  [
    "type-core-answers.test",
    "32 first: array Contract.#stopped[] (contract.ts), array Listing.run.sources (property-names.ts) and 30 more",
  ],
  [
    "type-core-contract-descriptors.test",
    "14 first: arena Frontier.pending (contract/frontier/walk.ts), arena Frontier.pending (contract/frontier.ts) and 12 more",
  ],
  [
    // (main split `type-core-discharge-runtime` into `discharge/`; of its five files, this one and `-typed-parse` make all
    // four, measured at #2417's 893cd3c4, and this one costs the least)
    "type-core-discharge-runtime-checks.test",
    "4 first: map answers.KEPT_NAMES[] (answers.ts), map site.EVALUATIONS.at (messages/site.ts) and 2 more",
  ],
  [
    "type-core-labels.test",
    "5 first: function DefinitionLists.joined (definitions.ts), function DefinitionLists.live (tests/helpers/type-core/type-core-narrowing.ts) and 3 more",
  ],
  [
    "type-core-plus-index.test",
    "13 first: array PlusIndex.bindingsHolding[] (indexes/plus-index.ts), map DefinitionIndex.storeTargets (answers.ts) and 11 more",
  ],
  [
    "type-core-contributions.test",
    "2 first: map SubLayer.own (contract/prefix-index/layers.ts), record SubLayer.paths[] (contract/prefix-index/layers.ts)",
  ],
  [
    "type-core-object-presence.test",
    "8 first: function PathSteps.kept (contract/key-ids.ts), map ExactPath.#sourceSpans[] (exact-path.ts) and 6 more",
  ],
  ["type-core-items.test", "1 first: record IngressCell (items.ts)"],
  [
    "type-core-discharge.test",
    "8 first: map Contract.prefixUnions[] (contract/prefix-index/tries.ts), map Contract.prefixViews[] (contract/prefix-index/tries.ts) and 6 more",
  ],
  [
    "type-core-written-decider.test",
    "2 first: map PathFacts.joined (contract/key-ids.ts), map PathFacts.prefixAt (contract/key-ids.ts)",
  ],
  [
    "type-core-pushed-reads.test",
    "47 first: arena Frontier.product.atoms (contract/frontier/shapes.ts), arena Frontier.terms.pending (contract/frontier/nodes.ts) and 45 more",
  ],
  [
    "type-core-lost-check.test",
    "2 first: map Contract.#belowStop[] (contract.ts), set SubLayer.own[] (contract/prefix-index/layers.ts)",
  ],
  [
    "type-core-property-names.test",
    "9 first: function SubLayer.paths.demand (contract/prefix-index/summaries.ts), map Contract.holdersBelow[] (contract/prefix-index/layers.ts) and 7 more",
  ],
  [
    "type-core-key-ids.test",
    "4 first: function PathSteps.followedBy (contract/key-ids.ts), function test.copiedKey (tests/type-core/type-core-key-ids.test.ts) and 2 more",
  ],
  [
    "type-core-messages-site.test",
    "4 first, measured at #2535's split of type-core-messages: map site.PARAMETERS[], map site.PROPERTIES[] " +
      "(messages/site.ts) and their two module captures",
  ],
  [
    "type-core-written-default.test",
    "7 first, measured at #2403's rebase: owner WrittenDefaults, maps WrittenDefaults.cells[] and .kinds.below " +
      "(contract/written-default.ts), which only a typed default's literal or written type makes, and 3 more",
  ],
]);

// What the subset does not exercise, by site; the whole survey covers all but the last, which no test makes:
// - maps `ExactPath.copies.exits[]` and `.markSeveral[]`, and the sets `.markSeveral[][]` (`exact-path.ts`): only
//   `type-core-work-b` and `work/type-core-work-carriers` (split from `work-a` on main) exercise all three; `work-a`
//   would have cost about 40 s of each CI shard, past the 10 minutes of a slow runner, and `work-carriers` is not
//   measured frozen in CI;
// - set `Contract.bindingNamesOf.stored` (`contract/selections.ts`): only files of `signatures/`, `cells/`, `sharing/`
//   and `work/` exercise it (measured at #2417's 893cd3c4); `type-core-signatures`, before main split it, cost 77 s
//   frozen in CI against main's 25, and with it a CI shard took 10.1 minutes at #2417's `25ece341`, so it left the
//   subset;
// - function `test.subAt` (`tests/type-core/contract/type-core-contract.test.ts`): a test's probe, exercised only by that file;
// - set `SubSource.defs` (`contract/prefix-index/layers.ts`, `relevantSubs`): a source two found layers bring.
