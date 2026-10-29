# Generator corpus

The generators reviewers and builders used as evidence on the type core, kept so later builders rerun them. Not in CI:
before a type-core review round, the builder runs the affected areas against the base and head builds and reports the
counts (`docs/TESTING.md`, test admission). A reviewer who writes a new generator adds it here with one line below.

## Running an area

Build both trees (`npm run build:typescript`; each needs `dist/tests/helpers/type-core-oracles.js`), then:

```sh
node tests/families/run.mjs <area> <base checkout or dist> <head checkout or dist> [--sizes 4,8] \
  [--allowances natural,16,256] [--shard i/N] [--timeout 60] [--memory 2048] [--out differences.jsonl]
```

Each source runs in the four modes (source and reversed order, the sharing on and off). The runner compares what it
publishes (`publication`) and, for a generator whose `checks` include `"stops"`, which decisions stop and when at each
demand allowance (`stopSet`). A source that takes more than `--timeout` seconds or `--memory` MB of heap is counted as
stalled, and the runner goes on with the next. It prints one JSON line per generator and a total (sources, unparsed,
stalled, modes, runs, differences), and exits 1 when any run differs or any source stalls. Run large sizes as one
capped job per area or shard on a worker.

## A generator

A module `tests/families/<area>/<name>.mjs` with no imports beyond `node:` built-ins and no side effects:

```js
// <what it generates>
export const sizes = [4, 8]; // default sizes, one doubling
export const shapes = { "<shape>": (n) => "<source>" }; // or (n) => [{ path, source }]
// or fixed sources: export const cases = [["<name>", "<source>"]];
export const checks = ["publication", "stops"]; // default ["publication"]
```

Sources may use the host globals `hostValue`, `hostOther`, `hostInit` and `otherHost`; a generator whose sources
need other names exports `globals`, the full list.

## Kept outside the repository

Data, indexed here and not imported: run each from its own folder on the desktop worker.

- `desktop:~/work/evidence/corpus/copies/astra-1423/`: Astra's r1 of #1423 (G3 part 2). It holds generators
  (`cases.mjs`, `families.mjs`, `stop-cases.mjs`, `route-cases.mjs`, `growth.mjs`), fixed case lists, and their
  publication, stop-set and growth harnesses. Its `README.md` gives the pins.
- `desktop:~/work/evidence/corpus/stops/owner-s8/`: the owner's independent S8 reviews. It holds the 75-source
  domain matrix, the every-allowance sweeps, the cache lifecycle probe and the JSON and load matrix. It is untrusted
  input, never imported into a build.
- `desktop:~/work/evidence/corpus/stops/owner-s8/compiler-enclosing-evidence/`: the owner's reviewer's second bundle
  (164 files, PR #1434). It holds the 75-source domain generator, a 134-text complete-requirement matrix with an
  implementation-independent predicate, the relocation-only replay driver (`replay.mjs`, `check-run.py`),
  `cost-probe.mjs` and the raw results, and its `README.md` gives the replay commands. It is the standard oracle for
  the stops area: it runs before a builder's first review there.

## Inventory

Default outputs retain complete driver construction; archived inputs that no longer resolve are omitted unless
they deliberately test parse/name errors. Per area, each file: what it generates; its PR/review and original path (`R/` is
`~/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/` on the main container, `desktop:` the desktop
worker).

### copies

- `1077-astra-cases.mjs`: list/inferred/add, list/inferred/add/guard-0 and related fixed cases; #1077, Astra review, round unrecorded (R/astra-m4-i1077-evidence/cases.mjs).
- `1105-astra-make-cases.mjs`: toNumber/default/literal, toNumber/default/copies and related fixed cases; #1105, Astra review, round unrecorded (R/astra-m4-i1105-review/scripts/make-cases.mjs).
- `1105-sol-run-probes.mjs`: original toNumber-plain-literal, toNumber-plain-copy and related inputs; #1105, Sol review, r1 (R/sol-m4-i1105-recon-r1/run-probes.mjs).
- `1106-astra-probe.mjs`: number/direct, number/list and related fixed cases; #1106, Astra review, round unrecorded (R/astra-m4-i1106-review-files/probe.mjs).
- `1165-astra-written-spines.mjs`: original list, object and related inputs; #1165 S8 part 3, r7 retained Astra review scripts (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/astra/astra-b2.mjs).
- `1188-astra-admission-matrix.mjs`: nested-diamonds-1, nested-diamonds-3 and related fixed cases; #1188, Astra review, round unrecorded (R/astra-m4-i1188-design-review-evidence/probe/matrix.mjs).
- `1188-astra-r3-small-sccs.mjs`: small whole-copy SCCs and fed rings; #1188, astra-m4-i1188-design-recheck-r3-evidence, archived Python/shell evidence (R/astra-m4-i1188-design-recheck-r3-evidence/focused.py).
- `1188-astra-r4-containment-controls.mjs`: reversed destinations and containment controls; #1188, astra-m4-i1188-design-recheck-r4-evidence, archived Python/shell evidence (R/astra-m4-i1188-design-recheck-r4-evidence/focus.py).
- `1188-astra-r4-r5-retained-families.mjs`: original r4/r5 generation with 84 retained analysis-selected inputs; #1188, Astra r4/r5 (R/astra-m4-i1188-design-recheck-r4-evidence/generate.py; R/astra-m4-i1188-recheck-r5-evidence/prepare-cases.py).
- `1188-astra-r4-split-and-dormant-families.mjs`: split, dormant, residual and ring families; #1188, Astra review, r4 (R/astra-m4-i1188-design-recheck-r4-evidence/shapes.mjs).
- `1188-astra-r5-extra-cases.mjs`: r5 independent extra controls; #1188, astra-m4-i1188-recheck-r5-evidence, archived Python/shell evidence (R/astra-m4-i1188-recheck-r5-evidence/extra-cases.py).
- `1188-astra-rejected-and-opaque-families.mjs`: rejected and opaque candidate families; #1188, Astra review, round unrecorded (R/astra-m4-i1188-design-recheck-evidence/probe/shapes.mjs).
- `1188-sol-candidate-neighbours.mjs`: prefix-paths, prefix-paths-narrow and related shapes; #1188, Sol review, r1 (R/sol-m4-i1188-held-nodes-r1-evidence/extra-shapes.mjs).
- `1188-sol-dormant-groups.mjs`: rejected-relay-literal, dormant-meetings-literal and related shapes; #1188, Sol review, r1 (R/sol-m4-i1188-held-nodes-r1-evidence/sol6-shapes.mjs).
- `1188-sol-guard-probe-source.mjs`: 1 fixed sol guard probe source input; #1188, Sol review, r1 (R/sol-m4-i1188-held-nodes-r1-evidence/guard-probe.mjs).
- `1188-sol-inherited-astra-shapes.mjs`: nested-diamonds, rejected-projections and related shapes; #1188, Sol review, r1 (R/sol-m4-i1188-held-nodes-r1-evidence/astra-shapes.mjs).
- `1192-astra-class-and-sibling-families.mjs`: discovery classes, written-depth and sibling stores; #1192, astra-m4-i1192-review-evidence, archived Python/shell evidence, round unrecorded (R/astra-m4-i1192-review-evidence/generate.py).
- `1196-astra-cases.mjs`: original nested-list-leaves, nested-record-leaves and related inputs (original host globals); #1196, Astra review, round unrecorded (R/astra-m4-i1196-review-evidence/review-cases.mjs).
- `1203-astra-semantics.mjs`: pure-scalar, pure-null and related fixed cases; #1203, Astra review, round unrecorded (R/astra-m4-i1203-review/semantics.mjs).
- `1210-astra.mjs`: three-same-index, three-property and related fixed cases; #1210, Astra review, round unrecorded (R/astra-m4-i1210-review-evidence/review.mjs).
- `1215-astra-notes.mjs`: 3 fixed astra notes inputs; #1215, astra-m4-i1215-review-evidence, review/builder evidence (R/astra-m4-i1215-review-evidence/notes.mjs).
- `1223-astra-witness-source.mjs`: captured astra witness source input; #1223, Astra review, round unrecorded (R/astra-m4-i1223-review-evidence/witness.mjs).
- `1233-astra-option-families.mjs`: option transport and independent alias cases; #1233, Astra review, round unrecorded (R/astra-m4-i1233-review-evidence/cases.mjs).
- `1233-astra-residual-option-family.mjs`: captured family; #1233, Astra review, round unrecorded (R/astra-m4-i1233-review-evidence/residuals.mjs).
- `1249-astra-r2-written-axis.mjs`: seven written-field families at 64/128 fields; #1249, Astra review, r2 (R/astra-m4-i1249-review-r2-evidence/builder/tools/written-axis.mjs).
- `1253-astra-deep-file-source.mjs`: captured astra deep file source input; #1253, Astra review, round unrecorded (R/astra-m4-i1253-review-evidence/deep-files.mjs).
- `1253-astra-named-file-source.mjs`: fileSource; #1253, Astra review, round unrecorded (R/astra-m4-i1253-review-evidence/deep-files.mjs).
- `1253-astra-union-selection-sourcecases.mjs`: captured let parcel: integer dict? = fromJson(hostValue, default: null, files: false) say "complete" exit; #1253, Astra review, round unrecorded (R/astra-m4-i1253-review-evidence/union-selection.mjs).
- `1272-astra-r2-runtime-sources.mjs`: captured open, null and related inputs; #1272, Astra review, r2 (R/astra-m4-i1272-review-r2/runtime.mjs).
- `1278-astra-attribution-growth.mjs`: captured undefined@4; #1278, Astra review, round unrecorded (R/astra-m4-i1278-review-evidence/attribution.mjs).
- `1278-astra-bound-option-forms.mjs`: bound-option forms at semantic size 4 and growth sizes 64/128; #1278, Astra review, round unrecorded (R/astra-m4-i1278-review-evidence/builder-evidence/generators/fam.mjs).
- `1278-astra-initial-controls.mjs`: partial, added and related fixed cases; #1278, Astra review, round unrecorded (R/astra-m4-i1278-review-evidence/controls-initial.mjs).
- `1278-astra-observe-same-variant.mjs`: captured guarded-overlap; #1278, Astra review, round unrecorded (R/astra-m4-i1278-review-evidence/observe-same.mjs).
- `1278-astra-provenance-controls.mjs`: partial, added and related fixed cases; #1278, Astra review, round unrecorded (R/astra-m4-i1278-review-evidence/controls.mjs).
- `1278-astra-r2-definition-chain.mjs`: captured program; #1278, Astra review, r2 (R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/definition-counts.mjs).
- `1278-astra-r2-option-alias-product.mjs`: complete depth/location/wrapper/source/event/option product at 3/10 fields; #1278, Astra review, r2 (R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/fam1233.mjs).
- `1278-astra-r2-option-controls.mjs`: original loop, branches and related inputs; #1278, Astra review, r2 (R/astra-m4-i1278-review-r2-evidence/cases.mjs).
- `1278-astra-r2-option-product.mjs`: option form, event, reader and binding product; #1278, Astra review, r2 (R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/fam1278.mjs).
- `1278-astra-sparse-growth.mjs`: captured sparse-overlap-deep, sparse-late-stores and related inputs; #1278, Astra review, round unrecorded (R/astra-m4-i1278-review-evidence/cases.mjs).
- `1303-astra-probes.mjs`: direct-first, test-first and related fixed cases; #1303, Astra review, round unrecorded (R/astra-m4-i1303-review-evidence/probes.mjs).
- `1303-astra-runtime.mjs`: typed-first, nullable-first and related fixed cases; #1303, Astra review, round unrecorded (R/astra-m4-i1303-review-evidence/runtime.mjs).
- `1313-astra-composite-cases.mjs`: named and nested composite cases and growth; #1313, Astra review, round unrecorded (R/astra-m4-i1313/cases.mjs).
- `1313-astra-named-composites.mjs`: named/composite families at growth sizes 64/128; #1313, Astra review, round unrecorded (R/astra-m4-i1313/builder-evidence/shapes.mjs).
- `1359-astra-regular-subsets.mjs`: alias-subsets-regular, alias-subsets-fixed-width; #1359 contract roles design review (Astra), round unrecorded (R/astra-m4-contract-roles-design-review-evidence/probes/regular-shapes.mjs).
- `1359-astra-role-design.mjs`: original role-fixed, role-rotated and related inputs; #1359 contract roles design review (Astra), round unrecorded (R/astra-m4-contract-roles-design-review-evidence/probes/design-shapes.mjs).
- `1359-astra-role-subsets.mjs`: original path-subsets-differing-definitions, path-subsets-missing-properties and related inputs; #1359 contract roles design review (Astra), round unrecorded (R/astra-m4-contract-roles-design-review-evidence/probes/own-shapes.mjs).
- `1375-astra-history-prelude.mjs`: captured astra history prelude input; #1375 Astra review r1 (R/astra-m4-g3-p1-review-evidence/history-replay.mjs).
- `1375-astra-history-witness.mjs`: captured astra history witness input; #1375 Astra review r1 (R/astra-m4-g3-p1-review-evidence/history-replay.mjs).
- `1375-astra-integration-witness.mjs`: 1 fixed astra integration witness input; #1375 Astra review r1 (R/astra-m4-g3-p1-review-evidence/integration.mjs).
- `1375-astra-nested-carriers.mjs`: original nested carriers, selections and copies; #1375 Astra review r1 (R/astra-m4-g3-p1-review-evidence/generate.py).
- `1375-astra-r2-cache-family-sources.mjs`: captured chain-1-false, chain-1-true and related inputs; #1375 Astra review r2 (R/astra-m4-g3-p1-review-r2-evidence/cache-family.mjs).
- `1375-astra-r2-integration.mjs`: r1-witness, restarted-stop-depth-1 and related fixed cases; #1375 Astra review r2 (R/astra-m4-g3-p1-review-r2-evidence/integration.mjs).
- `1405-astra-wrapper-cases.mjs`: nested wrapper and copied-property cases; #1405 / #1403 Astra review, round unrecorded (R/astra-m4-g3-p3-review-evidence/cases.mjs).
- `1405-astra-wrapper-growth.mjs`: original wrapper, long-step-wrapper and related inputs; #1405 / #1403 Astra review, round unrecorded (R/astra-m4-g3-p3-review-evidence/cases.mjs).
- `1405-retained-wrappers.mjs`: nested-selection-variable, nested-choice-variable and related shapes; #1405, builder/review archive (desktop:~/work/evidence/1405/3627aa0f4/probe/families.mjs).
- `1405-written-projection.mjs`: 1 fixed written projection input; #1405, builder/review archive, r180 (desktop:~/work/evidence/1405/3627aa0f4/probe/r180.mjs).
- `3a-admission-controls.mjs`: nine original askInteger admission controls; experimental askRating inputs excluded; 3a model, builder (R/3a-newcore/checkpoint-9/port-plan/extensibility/s6/admission-trial.mjs).
- `3a-astra-r2-nested-empty-controls.mjs`: nested-empty-under-nonempty, named-recursive-json-default and related fixed cases; Astra review, r2 (R/astra-3a-simplification-design-review-r2-replay/support-contracts/probe.mjs).
- `3a-astra-r5-ledger-cases.mjs`: singleton-union/new-kind controls; unsupported quoted-property experiments excluded; 3a review, r5 (R/pr-3a-review-r5-files/astra/ledger-probe.mjs).
- `3a-astra-r5-mutation-boundary.mjs`: 1 fixed astra r5 mutation boundary input; 3a review, r5 (R/pr-3a-review-r5-files/astra/mutation-boundary.mjs).
- `3a-call-width-families.mjs`: original astra-wide-helper-many-calls, astra-wide-helper-fixed-calls and related inputs (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike3/families3.mjs).
- `3a-closing-alias-probes.mjs`: original self-dynamic-split, other-dynamic-split and related inputs; 3a review, round unrecorded (R/pr-3a-closing-check-files/own-probe.mjs).
- `3a-closing-declaration-init.mjs`: captured init; 3a review, round unrecorded (R/pr-3a-closing-check-files/declaration-probe.mjs).
- `3a-closing-list-declarations.mjs`: complete closing-bench list programs at the retained family/size arguments; 3a review, round unrecorded (R/pr-3a-closing-check-files/bench.mjs).
- `3a-closing-scalar-declarations.mjs`: complete closing-bench scalar programs at the retained family/size arguments; 3a review, round unrecorded (R/pr-3a-closing-check-files/bench.mjs).
- `3a-closing-self-store-json.mjs`: self-null-json-split, other-null-json-split and related fixed cases; 3a review, round unrecorded (R/pr-3a-closing-check-files/self-store-json-probe.mjs).
- `3a-closing-strict-parameters.mjs`: original script-label, script-path and related inputs; 3a review, round unrecorded (R/pr-3a-closing-check-files/strict-parameters.mjs).
- `3a-collection-work-families.mjs`: complete collection/work families at the original 16/32 growth sizes; 3a model, builder (R/3a-newcore/checkpoint-8/acct/families.mjs).
- `3a-copy-widths.mjs`: original tested and guarded copy widths (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs).
- `3a-file-control-graphs.mjs`: original function/file control graphs (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs).
- `3a-guarded-alias-marks.mjs`: original guarded alias chains and sibling marks (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs).
- `3a-handler-call-and-reader-families.mjs`: original handler, call, file and reader dimensions (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike13/families8.mjs).
- `3a-mark-pairs.mjs`: captured another contribution tested, no contribution tested and related inputs (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs).
- `3a-narrowing-widths.mjs`: original test and invalidation widths (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs).
- `3a-parser-snippets.mjs`: integer[] copy, list<integer> copy and related fixed cases; 3a model, builder (R/3a-newcore/checkpoint-9/spike8/parse-check.mjs).
- `3a-sol-delta3-varied-stores.mjs`: variedSource; 3a review, round unrecorded (R/pr-3a-delta-check-3-sol-files/varied-source.mjs).
- `3a-store-and-call-corridors.mjs`: original record stores, calls and child-layer corridors (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs).
- `3a-wide-field-stores.mjs`: original wide literals and interleaved field stores (original host globals); 3a model, builder (R/3a-newcore/checkpoint-9/spike14/budget-check.mjs).
- `f1-astra-projection-cases.mjs`: forward/local projections and work shapes; Astra review, round unrecorded (R/astra-m4-f1-review-evidence/cases.mjs).
- `f1-astra-r2-overlapping-forests.mjs`: forest-disjoint-deep, forest-overlap-prefix and related fixed cases; Astra review, r2 (R/astra-m4-f1-review-r2-evidence/overlap-cases.mjs).
- `f1-astra-r2-projection-cases.mjs`: original r1-original, r1-reverse and related inputs; Astra review, r2 (R/astra-m4-f1-review-r2-evidence/cases.mjs).
- `f1-astra-r2-work-shapes.mjs`: original forest-disjoint-deep, forest-overlap-prefix and related inputs; Astra review, r2 (R/astra-m4-f1-review-r2-evidence/cases.mjs).
- `f1-astra-r3-deferred-meetings.mjs`: original meeting; Astra review, r3 (R/astra-m4-f1-review-r3-evidence/deferred.mjs).
- `f1-astra-r3-field-families.mjs`: complete field families, independent 64/128 store/read matrix, and original instrument sizes; Astra review, r3 (R/astra-m4-f1-review-r3-evidence/cases.mjs).
- `f1-astra-r3-store-reader-control.mjs`: original source; Astra review, r3 (R/astra-m4-f1-review-r3-evidence/original-control.mjs).
- `s10-astra-default-helper-bound.mjs`: source; Astra review, round unrecorded (R/astra-m4-s10p2-plan-review/n5-bound.mjs).
- `s10-astra-r2-narrowing-families.mjs`: original W27, W27leave and related inputs; Astra review, r2 (R/astra-m4-s10-part1-review-r2/work.mjs).
- `s10-u4a-opus-mkcases.mjs`: collection test: xs[0], collection test: xs.first and related fixed cases; Opus builder (R/opus-m4-s10-u4a/mkcases.mjs).
- `s10-u4a-opus-series-own.mjs`: U4a-selection-width, U4a-selection-width-declared and related shapes; Opus builder (R/opus-m4-s10-u4a/series.mjs).
- `s10p2-astra-probes.mjs`: 21 fixed astra probes inputs; astra-m4-s10p2-plan-review, review/builder evidence (R/astra-m4-s10p2-plan-review/probes.mjs).
- `s10p2b-astra-r2-retained-r1-cases.mjs`: store/holding, store/call and related fixed cases; Astra review, r2 (R/astra-m4-s10p2b-review-r2/r1-cases.mjs).
- `s10p2b-astra-r2-wheel-families.mjs`: original literal-wheel, computed-wheel and related inputs; Astra review, r2 (R/astra-m4-s10p2b-review-r2/own-shapes.mjs).
- `s6c-astra-nested-value-growth.mjs`: original aliases-choice, nested-selection and related inputs; Astra review, round unrecorded (R/astra-m4-s6c-review-evidence/scales.mjs).
- `s6c-astra-value-classes.mjs`: family-choice-read, family-literal-read and related fixed cases; Astra review, round unrecorded (R/astra-m4-s6c-review-evidence/cases.mjs).
- `s8d-astra-r2-check-extra-collision.mjs`: random-selection control; unintended collision input excluded; Astra review, r2 (R/astra-m4-s8d-review-r2-evidence/check-extra.mjs).
- `s8d-astra-r2-order-witness-source.mjs`: 1 fixed astra r2 order witness source input; Astra review, r2 (R/astra-m4-s8d-review-r2-evidence/order-witness.mjs).
- `s8d-astra-r2-runtime-samples.mjs`: captured count, empty-external and related inputs; Astra review, r2 (R/astra-m4-s8d-review-r2-evidence/runtime.mjs).
- `s8d-astra-r2-selection-witness-capture.mjs`: captured capture; Astra review, r2 (R/astra-m4-s8d-review-r2-evidence/selection-witness.mjs).
- `s8d-astra-r2-selection-witness-fixed.mjs`: captured fixed; Astra review, r2 (R/astra-m4-s8d-review-r2-evidence/selection-witness.mjs).
- `s8d-astra-r2-selection-witness-source.mjs`: captured astra r2 selection witness source input; Astra review, r2 (R/astra-m4-s8d-review-r2-evidence/selection-witness.mjs).
- `s8d-astra-run-host.mjs`: typed-load-default, typed-load-record and related fixed cases; Astra review, round unrecorded (R/astra-m4-s8d-review-evidence/run-host.mjs).
- `s8d-astra-run-repairs-repairs.mjs`: original diagnostic replacements applied to complete sources; Astra review, round unrecorded (R/astra-m4-s8d-review-evidence/run-repairs.mjs).
- `s8d-astra-verify-mutant-source.mjs`: 1 fixed astra verify mutant source input; Astra review, round unrecorded (R/astra-m4-s8d-review-evidence/verify-mutant.mjs).
- `s8d-r3-astra-cases-selectionprelude.mjs`: complete selection/property matrix; Astra review, r3 (R/astra-m4-s8d-r3-evidence/cases.mjs).
- `s8d-r3-astra-fixture-delta-source.mjs`: 1 fixed r3 astra fixture delta source input; Astra review, r3 (R/astra-m4-s8d-r3-evidence/fixture-delta.mjs).
- `s8d-r3-astra-speaker-check.mjs`: captured r3 astra speaker check input; astra-m4-s8d-r3-evidence, review/builder evidence (R/astra-m4-s8d-r3-evidence/speaker-check.mjs).
- `s8d-r3-astra-speaker-source-programs.mjs`: loaded-branch, loaded-fallback and related fixed cases; Astra review, r3 (R/astra-m4-s8d-r3-evidence/speaker-source.mjs).
- `s8d-r4-astra-applied.mjs`: captured r4 astra applied inputs; astra-m4-s8d-r4-evidence, review/builder evidence (R/astra-m4-s8d-r4-evidence/applied.mjs).
- `s8d-r4-astra-fixture-tiesources.mjs`: captured let packet: integer | string | null = null say packet * 7 exit ; Astra review, r4 (R/astra-m4-s8d-r4-evidence/fixture.mjs).
- `s8d-r4-astra.mjs`: condition/integer/fixed, condition/integer/variable-index and related fixed cases; Astra review, r4 (R/astra-m4-s8d-r4-evidence/review.mjs).
- `s9b-astra-output-canaries-examples.mjs`: ways, storage and related fixed cases; Astra review, round unrecorded (R/astra-m4-s9b-plan-review-evidence/output-canaries.mjs).
- `s9b-astra-probes.mjs`: captured 2, 2 and related inputs; Astra review, round unrecorded (R/astra-m4-s9b-plan-review-evidence/probes.mjs).
- `u4a-astra-growth.mjs`: complete width/independent/computed/invalidated programs at 16/32; Astra review, round unrecorded (R/astra-m4-u4a-review/growth.mjs).
- `u4a-astra-probes.mjs`: first/positive, first/none and related fixed cases; Astra review, round unrecorded (R/astra-m4-u4a-review/probes.mjs).

### joins

- `1272-astra-joins.mjs`: captured literal, copy and related inputs; #1272, Astra review, round unrecorded (R/astra-m4-i1272-review/review.mjs).
- `1297-wide-record-cases.mjs`: wide-object and host-read cases; #1417, builder/review archive (desktop:~/work/evidence/1417/a0abf39f0/tools/family1297.mjs).
- `1297-wide-record-shapes.mjs`: original wide-inline, wide-inline-same and related inputs; #1417, builder/review archive (desktop:~/work/evidence/1417/a0abf39f0/tools/shapes1297.mjs).
- `1310-astra-domains.mjs`: captured astra domains input; #1310, 1310, review/builder evidence (desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra/domains.mjs).
- `1310-astra-probe.mjs`: complete quick-probe collection; #1310, 1310, review/builder evidence (desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra/probe.mjs).
- `1310-call-union-sources.mjs`: written-result, variable-control and related fixed cases; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/call-union.mjs).
- `1310-early-join-growth.mjs`: original join-run, join-run-mixed and related inputs; #1310, builder/review archive (desktop:~/work/evidence/1310/e31779d45c8bc60b3426f1c670403156674312a1/pre-rebase-6d8f874a7/tools/growth.mjs).
- `1310-extended-join-cases.mjs`: kinds-0-depth-0, kinds-0-depth-1 and related fixed cases; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/extended2.mjs).
- `1310-join-family.mjs`: join domains, positions, stores and kept prefixes; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/family.mjs).
- `1310-n1-source.mjs`: 1 fixed n1 source input; #1310, builder/review archive (desktop:~/work/evidence/1310/e31779d45c8bc60b3426f1c670403156674312a1/pre-rebase-6d8f874a7/tools/n1.mjs).
- `1310-n1probe.mjs`: 2 fixed n1probe inputs; #1310, 1310, review/builder evidence (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n1probe.mjs).
- `1310-n2-checks-fit-source.mjs`: 1 fixed n2 checks fit source input; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n2-checks-fit.mjs).
- `1310-n2-checks-source.mjs`: 1 fixed n2 checks source input; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n2-checks.mjs).
- `1310-paste.mjs`: parameter-0-0, values-0-0 and related fixed cases; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/paste.mjs).
- `1310-probe.mjs`: 4 fixed probe inputs; #1310, 1310, review/builder evidence, r9 (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/probe.mjs).
- `1310-r10-blocker-reproductions.mjs`: bad, host and related fixed cases; #1310, builder/review archive, r10 (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r10/repro.mjs).
- `1310-r10-stop-programs.mjs`: first/bad, first/host and related fixed cases; #1310, builder/review archive, r10 (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r10/stops.mjs).
- `1310-r3-null-and-open-growth.mjs`: original open-right-fields, open-empty-run and related inputs; #1310, builder/review archive, r3 (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/growth-r3.mjs).
- `1310-r8-join-prefix-growth.mjs`: original right-fields, left-fields and related inputs; #1310, builder/review archive, r8 (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/growth-r8.mjs).
- `1310-r9-join-cases.mjs`: binding-inferred-left-inline, binding-inferred-left-kept and related fixed cases; #1310, builder/review archive, r9 (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/cases.mjs).
- `1310-r9-open-crosses.mjs`: integer[]-typed-first-inline, integer[]-typed-first-kept and related fixed cases; #1310, builder/review archive, r9 (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/cross.mjs).
- `1310-r9-prefix-growth.mjs`: original prefix-sibling-depth, prefix-distinct-width and related inputs; #1310, builder/review archive, r9 (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r9/growth.mjs).
- `1310-selection-read-variants.mjs`: original left-fields-reads, left-same-field-reads and related inputs; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/reads-variants.mjs).
- `1310-stopfam-sources.mjs`: captured first/bad, first/fit and related inputs; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/stopfam.mjs).
- `1310-sweep-b2.mjs`: 5 fixed sweep b2 inputs; #1310, builder/review archive (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/sweep-b2.mjs).
- `1357-astra-fixed-order.mjs`: original roles, leaves; #1357, Astra review, round unrecorded (R/astra-m4-i1357-review-evidence/vps/fixed-order.mjs).
- `1357-astra-operation-cases.mjs`: end-string, end-number and related fixed cases; #1357, Astra review, round unrecorded (R/astra-m4-i1357-review-evidence/vps/review.mjs).
- `1357-astra-operation-neighbours.mjs`: original end-string, end-number and related inputs; #1357, Astra review, round unrecorded (R/astra-m4-i1357-review-evidence/vps/own-shapes.mjs).
- `1357-astra-proof-controls.mjs`: node-key-order, disjoint-leaf-groups and related fixed cases; #1357, Astra review, round unrecorded (R/astra-m4-i1357-review-evidence/vps/proof-controls.mjs).
- `1357-join-and-operation-shapes.mjs`: original joinMixedDeclared, joinMixedUndeclared and related inputs; #1417, builder/review archive (desktop:~/work/evidence/1417/a0abf39f0/tools/shapes.mjs).
- `1357-join-gates.mjs`: original join-run-ending-in-another-type, join-prefixes-each-in-an-object; #1417, builder/review archive (desktop:~/work/evidence/1417/a0abf39f0/tools/gates.mjs).
- `1359-checks.mjs`: original peersBesideHostList, peersBesideNumberList and related inputs; #1359, builder/review archive (desktop:~/work/evidence/1359/67b1d250b/tools/shapes-checks.mjs).
- `1359-choice-leaf-peers.mjs`: original choicePeers, choicePeersBesideLiteral and related inputs; #1417, builder/review archive (desktop:~/work/evidence/1417/a0abf39f0/tools/shapes-leaf.mjs).
- `1359-issues.mjs`: original getChainInKList, getChainReadOnce and related inputs; #1359, builder/review archive (desktop:~/work/evidence/1359/67b1d250b/tools/shapes-issues.mjs).
- `1359-peer-set-orders.mjs`: original role-fixed, role-rotated and related inputs; #1417, builder/review archive (desktop:~/work/evidence/1417/a0abf39f0/tools/shapes-order.mjs).
- `1359-r1-bound-prefixes.mjs`: original boundWideHost, boundWideHostProjection and related inputs; #1359, r1, reviewer unrecorded (retained in #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r1/own-shapes.mjs).
- `1359-r1-ordering-cases.mjs`: concrete-conflicts-padding-0-third-2-order-012, concrete-conflicts-padding-0-third-2-order-210 and related fixed cases; #1359, r1, reviewer unrecorded (retained in #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r1/ordering-cases.mjs).
- `1359-r1-peer-conflicts.mjs`: conflict-direct-rotation-0, conflict-direct-rotation-1 and related fixed cases; #1359, r1, reviewer unrecorded (retained in #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r1/own-cases.mjs).
- `1359-r2-peer-writers.mjs`: original peerJoinSeparateLists, peerJoinOneList and related inputs; #1359, r2, reviewer unrecorded (retained in #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r2/peer-shapes.mjs).
- `1359-r3-leaf-writers.mjs`: original wideMaxLeaves, reversedMaxPeers and related inputs; #1359, r3, reviewer unrecorded (retained in #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r3/own-shapes.mjs).
- `1359-r4-permuted-peers.mjs`: original permutedPeers, aliases and related inputs; #1359, r4, reviewer unrecorded (retained in #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r4-own-shapes.mjs).
- `1359-r5-tied-peers.mjs`: original ties-rotated, ties-fixed and related inputs; #1359, r5, reviewer unrecorded (retained in #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r5-shapes.mjs).
- `i1357-astra-permutations.mjs`: original rotated role and choice-leaf peers; #1357, Astra permutation review (retained in #1359/#1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/astra-permutations.mjs).

### messages

- `1240-astra-control-sources.mjs`: nested, nestedFinal and related fixed cases; #1240, Astra review, round unrecorded (R/astra-m4-i1240-review/control.mjs).
- `1241-astra-own.mjs`: original objects, dicts and related inputs; #1241, Astra review, round unrecorded (R/astra-m4-i1241-review/own.mjs).
- `1241-astra-r2-finding.mjs`: 0/original, 0/pasted and related fixed cases; #1241, Astra review, r2 (R/astra-m4-i1241-review-r2/finding.mjs).
- `1241-astra-r2-growth.mjs`: original independent, errorChain and related inputs; #1241, Astra review, r2 (R/astra-m4-i1241-review-r2/growth.mjs).
- `1241-astra-r2-regression-test-setup.mjs`: captured setup; #1241, Astra review, r2 (R/astra-m4-i1241-review-r2/regression.test.mjs).
- `1241-astra-r3-delta.mjs`: captured astra r3 delta inputs; #1241, astra-m4-i1241-review-r3, review/builder evidence (R/astra-m4-i1241-review-r3/delta.mjs).
- `1241-astra-r3-regression-test-nullable.mjs`: captured nullable; #1241, Astra review, r3 (R/astra-m4-i1241-review-r3/regression.test.mjs).
- `1241-astra-r3-spot-extra-guarded.mjs`: guarded/nested diagnostics and retained fixture controls; #1241, Astra review, r3 (R/astra-m4-i1241-review-r3/spot-extra.mjs).
- `1241-astra-r3.mjs`: original r2:duration, r2:member and related inputs; #1241, Astra review, r3 (R/astra-m4-i1241-review-r3/review.mjs).
- `1241-astra-r4-extra.mjs`: captured astra r4 extra inputs; #1241, astra-m4-i1241-review-r4, review/builder evidence (R/astra-m4-i1241-review-r4/extra.mjs).
- `1241-astra-r4.mjs`: captured astra r4 inputs; #1241, astra-m4-i1241-review-r4, review/builder evidence (R/astra-m4-i1241-review-r4/review.mjs).
- `1241-astra-regression-test.mjs`: captured astra regression test inputs; #1241, astra-m4-i1241-review, review/builder evidence (R/astra-m4-i1241-review/regression.test.mjs).
- `1268-astra-r3-explore.mjs`: declaration, top_before and related fixed cases; #1273, #1268, Astra review, r3 (R/astra-m4-i1268-review-r3-evidence/explore.mjs).
- `1268-astra-r3-verify.mjs`: captured astra r3 verify inputs; #1273, astra-m4-i1268-review-r3-evidence, review/builder evidence (R/astra-m4-i1268-review-r3-evidence/verify.mjs).
- `1268-astra-r4-cases.mjs`: original declaration-call, declaration-call-later and related inputs; #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/cases.mjs).
- `1268-astra-r4-extra.mjs`: guard-call-say, guard-call-repeat and related fixed cases; #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/extra.mjs).
- `1268-astra-r4-grid-probe-sources.mjs`: captured a nullable list element added to a parameter, a copy and a host value, in functions and at the top level; #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/builder/generators/grid-probe.mjs).
- `1268-astra-r4-growth.mjs`: original own-selection-stores, object-index and related inputs; #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/builder/generators/growth.mjs).
- `1268-astra-r4-paste-1273-errors.mjs`: captured say/1, let/1 and related inputs; #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/builder/generators/paste-1273.mjs).
- `1268-astra-regression-test.mjs`: captured astra regression test inputs; #1268, astra-m4-i1268-review-evidence, review/builder evidence (R/astra-m4-i1268-review-evidence/regression.test.mjs).
- `1272-astra-conversion-supplement.mjs`: original conversion and operand supplements; #1272, astra-m4-i1272-review, archived Python/shell evidence, round unrecorded (R/astra-m4-i1272-review/make-supplement.py).
- `s10p2a-astra-unary-controls.mjs`: original case-(null), case-8 and related inputs; Astra review, round unrecorded (R/astra-m4-s10p2a-review/u1.mjs).

### rings

- `1105-astra-sharing.mjs`: captured astra sharing input; #1105, astra-m4-i1105-review, review/builder evidence (R/astra-m4-i1105-review/scripts/sharing.mjs).
- `1293-sol-r2-permutations.mjs`: r2 repeated/('good', 'bad', 'bad')/[2, 0, 1]/True, r2 repeated/('good', 'flag', 'flag')/[2, 0, 1]/True and related fixed cases; #1293 A2 / G5 Sol reconstruction, r1 (R/sol-m4-admission-design-g5-r1-evidence/r2-permutations.json).
- `1293-sol-ring-recon.mjs`: ring-member-stores, ring-member-stores-width-2 and related shapes; #1293 A2 / G5 Sol reconstruction, r1 (R/sol-m4-admission-design-g5-r1-evidence/recon-shapes.mjs).
- `1375-astra-sharing-props-source.mjs`: 1 fixed astra sharing props source input; #1375 Astra review r1 (R/astra-m4-g3-p1-review-evidence/builder-probe/sharing-props.mjs).
- `g5-5a-astra-guard-neighbours.mjs`: marks-2-0-duplicate-before, marks-2-0-duplicate-after and related fixed cases; #1394 G5 5a Astra review / builder corpus (R/astra-m4-g5-5a-review-evidence/guard-neighbours.mjs).
- `g5-5a-astra-r2-local-stores.mjs`: nested-port, indexed-port and related fixed cases; #1394 G5 5a Astra review / builder corpus, r2 (R/astra-m4-g5-5a-review-r2-evidence/own.mjs).
- `g5-5a-astra-r2-proof-stops.mjs`: nested-ring-proof, index-ring-proof; #1394 G5 5a Astra review / builder corpus, r2 (R/astra-m4-g5-5a-review-r2-evidence/proof-stop.mjs).
- `g5-5a-astra-r2-ring-stops.mjs`: i1339-many-fed/conflict-read-4, i1339-chord/quiet-read-4 and related fixed cases; #1394 G5 5a Astra review / builder corpus, r2 (R/astra-m4-g5-5a-review-r2-evidence/builder-tools/ring-stop.mjs).
- `g5-5a-astra-ring-cases.mjs`: single-2, fed-2 and related fixed cases; #1394 G5 5a Astra review / builder corpus (R/astra-m4-g5-5a-review-evidence/generate.mjs).
- `g5-5a-astra-ring-growth.mjs`: original many-quiet, many-conflict and related inputs; #1394 G5 5a Astra review / builder corpus (R/astra-m4-g5-5a-review-evidence/growth.mjs).
- `g5-5a-astra-s8-object-source.mjs`: 1 fixed 5a astra s8 object source input; #1394 G5 5a Astra review / builder corpus (R/astra-m4-g5-5a-review-evidence/s8-object.mjs).
- `g5-5a-builder-ring-families.mjs`: original fed/chord rings, cut axes and written controls; #1394 G5 5a Astra review / builder corpus (R/astra-m4-g5-5a-review-evidence/builder-tools/g5-families.mjs).

### stops

- `1165-cascade.mjs`: copies32, copies64 and related fixed cases; #1165 S8 part 3, r7 retained builder/probe9 evidence (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/matrix/cascade.mjs).
- `1165-family-b1-shapes.mjs`: complete scalar/list/object reader programs at 4/12 stores, with the dependent reader at 60; #1165 S8 part 3, r7 retained builder/probe9 evidence (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/family/family-b1.mjs).
- `1165-family-b3-forms.mjs`: captured two, three and related inputs; #1165 S8 part 3, r7 retained builder/probe9 evidence (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/family/family-b3.mjs).
- `1165-matrix.mjs`: complete position/value matrix, including declarations and consumers; #1165 S8 part 3, r7 retained builder/probe9 evidence (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/matrix.mjs).
- `1165-mutation-smoke-source.mjs`: 1 fixed mutation smoke source input; #1165 S8 part 3, r7 retained builder/probe9 evidence (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/mutation-smoke.mjs).
- `1165-oracle-source.mjs`: 1 fixed oracle source input; #1165 S8 part 3, r7 retained builder/probe9 evidence (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/oracle.mjs).
- `1165-probe9-matrix.mjs`: probe9 stopped-check matrix; #1165 S8 part 3, r7 retained builder/probe9 evidence (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/cases.mjs).
- `1249-astra-copy-and-cycle-cases.mjs`: copies, cycles, projections and controls; #1249, astra-m4-i1249-review-evidence, archived Python/shell evidence, round unrecorded (R/astra-m4-i1249-review-evidence/make-cases.py).
- `1249-astra-r2-stop-sweep-sources.mjs`: literal, place and related fixed cases; #1249, Astra review, r2 (R/astra-m4-i1249-review-r2-evidence/builder/tools/stop-sweep.mjs).
- `1249-astra-r2-written-origins.mjs`: written origins and guarded-disjoint companions; #1249, astra-m4-i1249-review-r2-evidence, archived Python/shell evidence (R/astra-m4-i1249-review-r2-evidence/make-cases.py; R/astra-m4-i1249-review-r2-evidence/make-disjoint.py).
- `1249-astra-small-projected-growth.mjs`: projected set/dict/store/alias cases at 4/64/128/256; #1249, astra-m4-i1249-review-evidence, archived Python/shell evidence, round unrecorded (R/astra-m4-i1249-review-evidence/make-growth.py).
- `1268-astra-r4-stop-repair.mjs`: set-hidden, list-hidden and related fixed cases; #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/stop-repair.mjs).
- `1268-astra-r4-stops.mjs`: captured set-hidden, list-hidden and related inputs; #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/stops.mjs).
- `1375-astra-r2-stop-cache.mjs`: index step, property and related fixed cases; #1375 Astra review r2 (R/astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache.mjs).
- `1375-astra-r2-stop-cache2.mjs`: 5 fixed astra r2 stop cache2 inputs; #1375 Astra review r2 (R/astra-m4-g3-p1-review-r2-evidence/builder/probe/stop-cache2.mjs).
- `1405-astra-stops-sources.mjs`: captured let leaf: integer=1 let root={n:leaf} let box={q:root} let outer={r:box} let last=outer.r.q.n exit ; #1405 / #1403 Astra review, round unrecorded (R/astra-m4-g3-p3-review-evidence/stops.mjs).
- `1405-settled-sweep-demand.mjs`: 38 fixed settled sweep demand inputs; #1405, builder/review archive (desktop:~/work/evidence/1405/3627aa0f4/probe/settled-sweep-demand.mjs).
- `s8b-astra-fallback-repro-sources.mjs`: get, written and related fixed cases; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8b-evidence/fallback-repro.mjs).
- `s8b-astra-finishing-source.mjs`: 1 fixed astra finishing source input; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8b-evidence/finishing.mjs).
- `s8b-astra-sweep.mjs`: record, quiet and related fixed cases; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8b-evidence/sweep.mjs).
- `s8b-r3-astra-cases.mjs`: storemissing, storenull and related fixed cases; #1165 / S8, Astra review, r3 (R/astra-m4-s8b-r3-evidence/cases.mjs).
- `s8b-r3-astra-guard-source.mjs`: 1 fixed r3 astra guard source input; #1165 / S8, Astra review, r3 (R/astra-m4-s8b-r3-evidence/guard.mjs).
- `s8b-r3-astra-oracle-probe-s.mjs`: captured r3 astra oracle probe s input; #1165 / S8, Astra review, r3 (R/astra-m4-s8b-r3-evidence/oracle-probe.mjs).
- `s8b-r3-astra-read-depth-source.mjs`: 1 fixed r3 astra read depth source input; #1165 / S8, Astra review, r3 (R/astra-m4-s8b-r3-evidence/read-depth.mjs).
- `s8b-r4-astra-boundary-capture-variants.mjs`: add, add-say and related fixed cases; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/boundary-capture.mjs).
- `s8b-r4-astra-cases.mjs`: set-record, list-record and related fixed cases; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/cases.mjs).
- `s8b-r4-astra-limits-programs.mjs`: original wide, nested and related inputs; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/limits.mjs).
- `s8b-r4-astra-mutation-smoke-source.mjs`: 1 fixed r4 astra mutation smoke source input; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/mutation-smoke.mjs).
- `s8b-r4-astra-oracle-carried.mjs`: captured carried; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/oracle.mjs).
- `s8b-r4-astra-oracle-source.mjs`: 1 fixed r4 astra oracle source input; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/oracle.mjs).
- `s8b-r4-astra-oracle-store.mjs`: captured store; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/oracle.mjs).
- `s8b-r6-astra-edges.mjs`: named-parse, named-load and related fixed cases; #1165 / S8, Astra review, r6 (R/astra-m4-s8b-r6-evidence/probe/edges.mjs).
- `s8b-r6-astra-matrix-positions.mjs`: complete position/value matrix with its shared declarations; #1165 / S8, Astra review, r6 (R/astra-m4-s8b-r6-evidence/probe/matrix.mjs).
- `s8b-r6-astra-matrix-prefix.mjs`: complete position/value matrix with its shared declarations; #1165 / S8, Astra review, r6 (R/astra-m4-s8b-r6-evidence/probe/matrix.mjs).
- `s8b-r6-astra-quiet-reads.mjs`: 4 fixed r6 astra quiet reads inputs; #1165 / S8, Astra review, r6 (R/astra-m4-s8b-r6-evidence/probe/quiet-reads.mjs).
- `s8b-r6-astra-views.mjs`: direct, literal-list and related fixed cases; #1165 / S8, Astra review, r6 (R/astra-m4-s8b-r6-evidence/probe/views.mjs).
- `s8b-r7-astra-written-span-source.mjs`: 1 fixed r7 astra written span source input; #1165 / S8, Astra review, r7 (R/astra-m4-s8b-r7-evidence/probe/written-span.mjs).
- `s8b-r8-astra-cases.mjs`: deep-selected-child, deep-selected-set and related fixed cases; #1165 / S8, Astra review, r8 (R/astra-m4-s8b-r8-evidence/probe/cases.mjs).
- `s8b-r8-astra-ingress.mjs`: original r8 astra ingress inputs; astra-m4-s8b-r8-evidence, review/builder evidence (R/astra-m4-s8b-r8-evidence/builder/probe7/ingress.mjs).
- `s8c-astra-cheap-scale.mjs`: repeated/field/field-store/deep setup programs at the original per-family sizes; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/builder/generators/tools/cheap-scale.mjs).
- `s8c-astra-combine-source.mjs`: 1 fixed astra combine source input; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/worker/combine.mjs).
- `s8c-astra-family-programs.mjs`: scalar, list and related fixed cases; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/builder/generators/tools/family.mjs).
- `s8c-astra-geometry-source.mjs`: callable/top/recursive forms, 24/96 links, and 0/192 padding functions; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/worker/geometry.mjs).
- `s8c-astra-new-cases.mjs`: literal-grid, number-promotion and related fixed cases; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/worker/new-cases.mjs).
- `s8c-astra-r2-deep.mjs`: copies-nullable-40, copies-union-40 and related fixed cases; #1165 / S8, Astra review, r2 (R/astra-m4-s8c-review-r2-evidence/worker/deep.mjs).
- `s8c-astra-r2-harness-source.mjs`: captured astra r2 harness source input; #1165 / S8, Astra review, r2 (R/astra-m4-s8c-review-r2-evidence/worker/harness.mjs).
- `s8c-astra-r2-own-stops-forms.mjs`: captured object-list, list-object and related inputs; #1165 / S8, Astra review, r2 (R/astra-m4-s8c-review-r2-evidence/worker/own-stops.mjs).
- `s8c-astra-r2-r1-exact-source.mjs`: 1 fixed astra r2 r1 exact source input; #1165 / S8, Astra review, r2 (R/astra-m4-s8c-review-r2-evidence/worker/r1-exact.mjs).
- `s8c-astra-repro-report.mjs`: B1, B2 and related fixed cases; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/builder/generators/tools/repro-report.mjs).
- `s8c-astra-shared-index.mjs`: captured let value: integer? = hostValue if value != null { let local = value repeat local {} }; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/worker/shared-index.mjs).
- `s8c-astra-top-level-forms.mjs`: original direct, mutate and related inputs; #1165 / S8, Astra review, round unrecorded (R/astra-m4-s8c-review-evidence/worker/top-level.mjs).
- `s8d-astra-r2-origin-and-join-cases.mjs`: original subject origins, joins and argument-literal cases; astra-m4-s8d-review-r2-evidence, archived Python/shell evidence (R/astra-m4-s8d-review-r2-evidence/make-cases.py).
