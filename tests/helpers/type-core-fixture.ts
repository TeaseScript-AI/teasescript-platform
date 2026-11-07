import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { SourceFile } from "./type-core-analysis.js";
import { readCompactRecord, type CompactRecord } from "./type-core-records.js";

/**
 * The expectation set of the coarse core (checkpoint 9) as its compact fixture (`tests/fixtures/type-core/`, made by
 * the port plan's step S0; its `MANIFEST.md` says how): per record its name, the TABLE cells it tests, the class it
 * belongs to (`owner`: `adapter` for the records the kept adapters own), its files, and its expected record.
 */
export interface FixtureRecord {
  readonly name: string;
  readonly cells: readonly string[];
  readonly owner: string | null;
  readonly files: readonly SourceFile[];
  readonly expected: CompactRecord;
}

const FIXTURES = new URL("../../../tests/fixtures/type-core/", import.meta.url);

function fields(value: unknown, where: string): Readonly<Record<string, unknown>> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${where}: an object`,
  );
  // EVIDENCE: validation: the assertion above admits only plain non-array objects, read here by key.
  return value as Readonly<Record<string, unknown>>;
}

function texts(value: unknown, where: string): string[] {
  assert.ok(Array.isArray(value), `${where}: a list`);
  return value.map((entry, index) => {
    assert.equal(typeof entry, "string", `${where}[${index}]: a text`);
    return String(entry);
  });
}

/** The adapters' records S9b's checks give, released from the adapters' hold (`heldBack`). */
const RELEASED_ADAPTER_RECORDS: ReadonlySet<string> = new Set([
  "cp9-cells/C13/bad-iterable",
  "cp9-cells/C13/bad-pair-iterable",
  "cp9-cells/C13/join-argument",
  "cp9-cells/C13/string-argument",
  "cp9-cells/C13/sort-receiver",
  "cp9-cells/C13/pass",
]);

/**
 * Stage 3b's records the route rule completes (#1073 PR 4, AD-1 with U5): the required-check errors with N10's payload
 * where a route to the use has no check, and the context word a failed test's warning names. Each proven complete in
 * the four modes before its release; the records whose witness needs a corridor the route query does not follow stay
 * held (#1938).
 */
const RELEASED_S10_ROUTE_RULE_RECORDS: ReadonlySet<string> = new Set([
  // (S9b's F18 hold of this record was the route rule's error itself, Sol's scoping r1 §4)
  "cp9-cells/s9b/f18-held/computed-key/null-default",
  // (a use reached only by a `while n != null` loop's exit has no check on that route: the route rule's error, V30 §13;
  // their records corrected with this PR)
  "cp9-cells/3b/forms/while-false-exit",
  "cp9-cells/3b/review-early/n9-while-false-exit",
  "cp9-cells/3b/ad1/e1a/two-consumers",
  "cp9-cells/3b/ad1/e1a/unchecked",
  "cp9-cells/3b/ad1/e1b/unchecked",
  "cp9-cells/3b/bodies/button",
  "cp9-cells/3b/bodies/media",
  "cp9-cells/3b/bodies/timer",
  "cp9-cells/3b/deferred/compound",
  "cp9-cells/3b/deferred/no-interrupts/plain",
  "cp9-cells/3b/forms/equal-null-else/absent",
  "cp9-cells/3b/forms/is-not-null/absent",
  "cp9-cells/3b/forms/is-null-else/absent",
  "cp9-cells/3b/forms/not-equal-else/absent",
  "cp9-cells/3b/forms/not-is-null/absent",
  "cp9-cells/3b/forms/not-null/absent",
  "cp9-cells/3b/invalidation/handler-False",
  "cp9-cells/3b/invalidation/handler-True",
  "cp9-cells/3b/invalidation/helper-False",
  "cp9-cells/3b/invalidation/helper-True",
  "cp9-cells/3b/paths/fixed-index/changed",
  "cp9-cells/3b/paths/fixed-key/changed",
  "cp9-cells/3b/paths/variable-index/changed",
  "cp9-cells/3b/paths/variable-key/changed",
  "cp9-cells/3b/review-early/a1-correlated-null",
  "cp9-cells/3b/review-early/a1-right-operand-call",
  "cp9-cells/3b/review-early/a2-rows-index-changed",
  "cp9-cells/3b/review-early/a2-sibling-rhs",
  "cp9-cells/3b/review-early/a3-handler-helper-interaction",
  "cp9-cells/3b/review-early/a3-handler-helper-none",
  "cp9-cells/3b/review-early/a3-handler-helper-save",
  "cp9-cells/3b/review-early/a3-handler-helper-say",
  "cp9-cells/3b/review-early/a3-handler-helper-timer",
  "cp9-cells/3b/review-early/a3-handler-helper-wait",
  "cp9-cells/3b/review-early/a3-helper-reorder",
  "cp9-cells/3b/review-early/a4-two-sibling-element-events",
  "cp9-cells/3b/review-early/a5-infix-later-call",
  "cp9-cells/3b/review-early/a5-live-repeat-variable",
  "cp9-cells/3b/review-early/a5-live-repeat-zero",
  "cp9-cells/3b/review-early/a5-live-while-variable",
  "cp9-cells/3b/review-early/astra-r1-fence-3",
  "cp9-cells/3b/review-early/astra-r2-fence-3",
  "cp9-cells/3b/review-early/astra-r2-fence-4",
  "cp9-cells/3b/review-early/n3-nonnull-open-else",
  "cp9-cells/3b/review-early/n3-written-union",
  "cp9-cells/3b/review-early/n7-declaration-does-not-execute",
  "cp9-cells/3b/review-early/n7-fallthrough-label",
  "cp9-cells/3b/review-early/n7-handler-no-inherit",
  "cp9-cells/3b/review-early/s1-correlated-null",
  "cp9-cells/3b/review-early/s3-candidates-as-stored",
  "cp9-cells/3b/review-early/s3-remove-restoring-call",
  "cp9-cells/3b/review-early/s4-optional-restoring-call",
  "cp9-cells/3b/review-early/s5-later-argument",
  "cp9-cells/3b/review-early/sol-r1-fence-4",
  "cp9-cells/3b/review-early/sol-r2-fence-3",
  "cp9-cells/3b/review-early/sol-r2-fence-4",
  "cp9-cells/3b/review-late/calls/live-void-input",
  "cp9-cells/3b/review-late/calls/multisite",
  "cp9-cells/3b/review-late/calls/omitted-branch",
  "cp9-cells/3b/review-late/calls/only-nonvoid-call",
  "cp9-cells/3b/review-late/calls/recursive-binding",
  "cp9-cells/3b/review-late/calls/rounds-local-true",
  "cp9-cells/3b/review-late/calls/rounds-unrestricted",
  "cp9-cells/3b/review-late/copies/field-chain-surviving",
  "cp9-cells/3b/review-late/copies/refuse-dict",
  "cp9-cells/3b/review-late/copies/refuse-element",
  "cp9-cells/3b/review-late/copies/refuse-literal",
  "cp9-cells/3b/review-late/copies/refuse-result",
  "cp9-cells/3b/review-late/copies/refuse-whole-record",
  "cp9-cells/3b/review-late/copies/scalar-before-call-field",
  "cp9-cells/3b/review-late/copies/scalar-chain-surviving",
  "cp9-cells/3b/review-late/copies/snapshot-call-after",
  "cp9-cells/3b/review-late/copies/snapshot-restore-after",
  "cp9-cells/3b/review-late/copies/surviving-copy",
  "cp9-cells/3b/review-late/corridor/later-binary",
  "cp9-cells/3b/review-late/corridor/literal-if-false",
  "cp9-cells/3b/review-late/corridor/nonnull-empty-else",
  "cp9-cells/3b/review-late/corridor/optional-restore",
  "cp9-cells/3b/review-late/corridor/optional-while",
  "cp9-cells/3b/review-late/corridor/variable-repeat",
  "cp9-cells/3b/review-late/defaults/decryptFile-matching",
  "cp9-cells/3b/review-late/defaults/decryptFile-wrong",
  "cp9-cells/3b/review-late/defaults/decryptText-matching",
  "cp9-cells/3b/review-late/defaults/decryptText-wrong",
  "cp9-cells/3b/review-late/defaults/fileFromBase64-dynamic",
  "cp9-cells/3b/review-late/defaults/fileFromBase64-successful",
  "cp9-cells/3b/review-late/defaults/fromBase64-dynamic",
  "cp9-cells/3b/review-late/defaults/fromBase64-successful",
  "cp9-cells/3b/review-late/defaults/toRegex-dynamic",
  "cp9-cells/3b/review-late/defaults/toRegex-successful",
  "cp9-cells/3b/review-late/fallback/chain-surviving",
  "cp9-cells/3b/review-late/fallback/nested-selected",
  "cp9-cells/3b/review-late/fallback/source-surviving",
  "cp9-cells/3b/review-late/fallback/union-source-surviving",
  "cp9-cells/3b/review-late/json/concat",
  "cp9-cells/3b/review-late/json/constant-function",
  "cp9-cells/3b/review-late/json/constrained-input",
  "cp9-cells/3b/review-late/json/copied-text",
  "cp9-cells/3b/review-late/json/copy-after-refused-parse",
  "cp9-cells/3b/review-late/json/direct-roundtrip-two",
  "cp9-cells/3b/review-late/json/encoded-external",
  "cp9-cells/3b/review-late/json/literal-four",
  "cp9-cells/3b/review-late/json/malformed",
  "cp9-cells/3b/review-late/json/unchanged-four",
  "cp9-cells/3b/review-late/json/unchanged-three",
  "cp9-cells/3b/review-late/json/unconstrained-input",
  "cp9-cells/3b/review-late/json/union-fallback-composition",
  "cp9-cells/3b/review-late/json/union-identifier",
  "cp9-cells/3b/review-late/json/union-roundtrip-four",
  "cp9-cells/3b/review-late/json/union-unconstrained",
  "cp9-cells/3b/review-late/lookup/dict-missing",
  "cp9-cells/3b/review-late/lookup/dict-present",
  "cp9-cells/3b/review-late/lookup/field-store",
  "cp9-cells/3b/review-late/lookup/scalar-copies",
  "cp9-cells/3b/review-late/lookup/variable-missing",
  "cp9-cells/3b/review-late/lookup/variable-union",
  "cp9-cells/3b/review-late/producers/direct-null",
  "cp9-cells/3b/review-late/producers/field-null",
  "cp9-cells/3b/review-late/producers/written-literal",
  "cp9-cells/3b/review-late/r10/sol-field-snapshot-after-restore",
  "cp9-cells/3b/review-late/r10/sol-json-fallback-composition",
  "cp9-cells/3b/review-late/r7/astra-variable-lookup",
  "cp9-cells/3b/review-late/r8/astra-json-nullable",
  "cp9-cells/3b/review-late/r8/astra-json-union",
  "cp9-cells/3b/review-late/r8/astra-void-particular-call",
  "cp9-cells/3b/review-late/r8/sol-json-nullable",
  "cp9-cells/3b/review-late/r8/sol-json-union",
  "cp9-cells/3b/review-late/r8/sol-void-other-invocation",
  "cp9-cells/3b/review-late/r9/astra-json-nullable",
  "cp9-cells/3b/review-late/r9/astra-json-union",
  "cp9-cells/3b/review-late/r9/astra-save-before-load",
  "cp9-cells/3b/review-late/r9/sol-json-identifier",
  "cp9-cells/3b/review-late/r9/sol-json-roundtrip-variable",
  "cp9-cells/3b/review-late/r9/sol-save-before-load",
  "cp9-cells/3b/review-late/storage/computed-key",
  "cp9-cells/3b/review-late/storage/debug-mode-check",
  "cp9-cells/3b/review-late/storage/delete",
  "cp9-cells/3b/review-late/storage/plain",
  "cp9-cells/3b/review-late/storage/previous-load-check",
  "cp9-cells/3b/review-late/storage/save-both-arms",
  "cp9-cells/3b/review-late/storage/save-twice",
  "cp9-cells/C10/external-get-nullable",
  "cp9-cells/C10/null-default-required-destination",
  "cp9-cells/C5a/possible-null",
  "cp9-cells/F15/unknown-member",
  "cp9-cells/F17b/present-null",
  "cp9-cells/F20/void-exit",
  "cp9-cells/S4/possible",
  "cp9-cells/provenance/external-opaque-merge",
  "cp9-cells/r42/nullable-copy-required",
  "cp9-cells/r42/result-count-void",
  "cp9-cells/r46/m3/astra-m3/null-kind/and/no-null",
  "cp9-cells/r46/m3/astra-m3/null-kind/and/null",
  "cp9-cells/r46/m3/astra-m3/null-kind/condition/no-null",
  "cp9-cells/r46/m3/astra-m3/null-kind/condition/null",
  "cp9-cells/r46/m3/astra-m3/null-kind/key/no-null",
  "cp9-cells/r46/m3/astra-m3/null-kind/key/null",
  "cp9-cells/r46/m3/astra-m3/null-kind/not/no-null",
  "cp9-cells/r46/m3/astra-m3/null-kind/not/null",
  "cp9-cells/r46/m3/astra-m3/null-kind/plus/no-null",
  "cp9-cells/r46/m3/astra-m3/null-kind/plus/null",
  "cp9-cells/r46/m3/astra-m3/null-kind/repeat/no-null",
  "cp9-cells/r46/m3/astra-m3/null-kind/repeat/null",
  "cp9-cells/r46/m3/astra-m3/nullable-elements/first",
  "cp9-cells/r46/m3/astra-m3/nullable-elements/get(0,default:null)",
  "cp9-cells/r46/m3/astra-m3/operator/nulls",
  "cp9-cells/r46/m3/astra-m3/result/True",
  "cp9-cells/r46/m3/astra-m3/routes/read-null-kind",
  "cp9-cells/r46/m3/astra-m3/routes/read-null-missing",
  "cp9-cells/r46/m3/astra-m3/routes/store-null-missing",
  "cp9-cells/r46/m3/astra-m3/routes/store-object-integer",
  "cp9-cells/r46/m3/astra-m3/store-mixed/object|boolean",
  "cp9-cells/r46/m3/astra-m3/store-mixed/object|integer",
  "cp9-cells/r46/m3/astra-m3/store-mixed/object|string",
  "cp9-cells/r46/m3/sol-m3/independent-37",
  "cp9-cells/r46/m3/sol-m3/independent-38",
  "cp9-cells/r46/m3/sol-m3/independent-39",
  "cp9-cells/r46/m3/sol-m3/independent-40",
  "cp9-cells/r46/m3/sol-m3/independent-41",
  "cp9-cells/r46/m3/sol-m3/independent-42",
  "cp9-cells/r46/m3/sol-m3/independent-43",
  "cp9-cells/r46/m3/sol-m3/independent-44",
  "cp9-cells/r46/m3/sol-m3/independent-49",
  "cp9-cells/r46/m3/sol-m3/independent-50",
  "cp9-cells/r46/m3/sol-m3/independent-51",
  "cp9-cells/r46/m3/sol-m3/independent-52",
  "cp9-cells/r46/m3/sol-m3b/external-0",
  "cp9-cells/r46/m3/sol-m3b/external-10",
  "cp9-cells/r46/m3/sol-m3b/external-2",
  "cp9-cells/r46/m3/sol-m3b/external-4",
  "cp9-cells/r46/m3/sol-m3b/external-6",
  "cp9-cells/r46/m3/sol-m3b/external-8",
  "cp9-cells/r46/m3/sol-m3c/0",
  "cp9-cells/r46/m3/sol-m3c/1",
  "cp9-cells/r46/m3/sol-m3c/10",
  "cp9-cells/r46/m3/sol-m3c/11",
  "cp9-cells/r46/m3/sol-m3c/12",
  "cp9-cells/r46/m3/sol-m3c/13",
  "cp9-cells/r46/m3/sol-m3c/14",
  "cp9-cells/r46/m3/sol-m3c/2",
  "cp9-cells/r46/m3/sol-m3c/3",
  "cp9-cells/r46/m3/sol-m3c/4",
  "cp9-cells/r46/m3/sol-m3c/5",
  "cp9-cells/r46/m3/sol-m3c/6",
  "cp9-cells/r46/m3/sol-m3c/7",
  "cp9-cells/r46/m3/sol-m3c/8",
  "cp9-cells/r46/m3/sol-m3c/9",
  "cp9-cells/r46/m3/sol-m3d/consumer-null-control",
  "cp9-cells/r46/m3/sol-m3d/consumer-null-kind",
  "cp9-cells/r46/m3/sol-m3d/member-null-missing",
  "cp9-cells/r46/m3/sol-m3d/opaque-before",
  "cp9-cells/r46/obligations/and/kind-only",
  "cp9-cells/r46/obligations/and/null-and-kind",
  "cp9-cells/r46/obligations/condition/kind-only",
  "cp9-cells/r46/obligations/condition/null-and-kind",
  "cp9-cells/r46/obligations/dict-get/kind-only",
  "cp9-cells/r46/obligations/dict-get/null-and-kind",
  "cp9-cells/r46/obligations/dict-index/kind-only",
  "cp9-cells/r46/obligations/dict-index/null-and-kind",
  "cp9-cells/r46/obligations/dict-literal/kind-only",
  "cp9-cells/r46/obligations/dict-literal/null-and-kind",
  "cp9-cells/r46/obligations/dict-remove/kind-only",
  "cp9-cells/r46/obligations/dict-remove/null-and-kind",
  "cp9-cells/r46/obligations/dict-store/kind-only",
  "cp9-cells/r46/obligations/dict-store/null-and-kind",
  "cp9-cells/r46/obligations/not/kind-only",
  "cp9-cells/r46/obligations/not/null-and-kind",
  "cp9-cells/r46/obligations/or/kind-only",
  "cp9-cells/r46/obligations/or/null-and-kind",
  "cp9-cells/r7-bugs/m2/strict-parse-local",
  "cp9-cells/r7-bugs/m2/strict-parse-parameter",
  "cp9-cells/r8/short-circuit/optional-restore",
  "cp9-cells/r8/union-seed/load",
  "cp9-cells/r8/union-seed/parse",
  "cp9-cells/r8/written-union/assignment/unchecked",
  "cp9-cells/r8/written-union/boolean-member/unchecked",
  "cp9-cells/r8/written-union/copy/unchecked",
  "cp9-cells/r8/written-union/parameter-binding/unchecked",
  "cp9-cells/review/dict-get-present-null",
  "cp9-cells/review/possible-no-member",
  "cp9-cells/s4/presence/fromJson-null-expected/component-typeless",
  "cp9-cells/s4/presence/fromJson-null-expected/component-written",
  "cp9-cells/s4/presence/fromJson-null-expected/method-typeless",
  "cp9-cells/s4/presence/fromJson-null-expected/method-written",
  "cp9-cells/witness/astra-get-null-consumer",
]);

/**
 * Stage 3b's records the consumers' read of the narrowing completes (#1073 PR 2: every read takes its nearest G, an exact
 * definition answers before the guard mark, a consumer's descendant demand takes its path's G), each proven complete in
 * the four modes before its release; and, with the candidate's activation (#1073 PR 2 phase 2), the three known-literal
 * records whose dead branch `KnownValues` now reads through the narrowing.
 */
const RELEASED_S10_CONSUMER_RECORDS: ReadonlySet<string> = new Set([
  "cp9-cells/3b/ad1/e1a/tested",
  "cp9-cells/3b/ad1/e1b/tested",
  "cp9-cells/3b/collection/nested",
  "cp9-cells/3b/collection/root",
  "cp9-cells/3b/collection/sibling-Gs",
  "cp9-cells/3b/forms/and-operand",
  "cp9-cells/3b/forms/equal-null-else/held",
  "cp9-cells/3b/forms/is-integer",
  "cp9-cells/3b/forms/is-not-integer",
  "cp9-cells/3b/forms/is-not-null/held",
  "cp9-cells/3b/forms/is-null-else/held",
  "cp9-cells/3b/forms/leaving-break",
  "cp9-cells/3b/forms/leaving-continue",
  "cp9-cells/3b/forms/leaving-exit",
  "cp9-cells/3b/forms/leaving-goto",
  "cp9-cells/3b/forms/not-equal-else/held",
  "cp9-cells/3b/forms/not-is-null/held",
  "cp9-cells/3b/forms/not-null/held",
  "cp9-cells/3b/forms/or-operand",
  "cp9-cells/3b/forms/while-body",
  "cp9-cells/3b/invalidation/add/held",
  "cp9-cells/3b/invalidation/addAll/held",
  "cp9-cells/3b/invalidation/clear/held",
  "cp9-cells/3b/invalidation/removeFirst/held",
  "cp9-cells/3b/invalidation/removeLast/held",
  "cp9-cells/3b/invalidation/reverse/held",
  "cp9-cells/3b/invalidation/shuffle/held",
  "cp9-cells/3b/invalidation/sort/held",
  "cp9-cells/3b/loop/after/held",
  "cp9-cells/3b/loop/break/held",
  "cp9-cells/3b/loop/continue/held",
  "cp9-cells/3b/loop/nested/changed",
  "cp9-cells/3b/loop/no-store",
  "cp9-cells/3b/loop/save",
  "cp9-cells/3b/loop/unconditional-null",
  "cp9-cells/3b/numeric/negative-2.0",
  "cp9-cells/3b/numeric/negative-2.5",
  "cp9-cells/3b/numeric/overlap-18",
  "cp9-cells/3b/numeric/overlap-19",
  "cp9-cells/3b/numeric/overlap-20",
  "cp9-cells/3b/numeric/positive-2.0",
  "cp9-cells/3b/numeric/positive-2.5",
  "cp9-cells/3b/paths/fixed-index/held",
  "cp9-cells/3b/paths/fixed-key/held",
  "cp9-cells/3b/paths/property/held",
  "cp9-cells/3b/paths/variable-index/held",
  "cp9-cells/3b/paths/variable-key/held",
  "cp9-cells/3b/r430/and-call/quiet",
  "cp9-cells/3b/review-early/a1-exact-null-after-check",
  "cp9-cells/3b/review-early/a1-reorder-saved-reverse",
  "cp9-cells/3b/review-early/a1-reorder-saved-shuffle",
  "cp9-cells/3b/review-early/a1-reorder-saved-sort",
  "cp9-cells/3b/review-early/a2-division-preserves-number",
  "cp9-cells/3b/review-early/a2-root-collection",
  "cp9-cells/3b/review-early/a2-rows-index-scope",
  "cp9-cells/3b/review-early/a2-same-location-loop",
  "cp9-cells/3b/review-early/a4-fractional-case",
  "cp9-cells/3b/review-early/a4-later-case-excludes-null",
  "cp9-cells/3b/review-early/a4-number-case-3",
  "cp9-cells/3b/review-early/a4-number-case-3dot0",
  "cp9-cells/3b/review-early/a4-number-case-3e0",
  "cp9-cells/3b/review-early/a4-number-case-plus3",
  "cp9-cells/3b/review-early/a4-one-element-preserving",
  "cp9-cells/3b/review-early/a4-root-shelves",
  "cp9-cells/3b/review-early/astra-r1-fence-4",
  "cp9-cells/3b/review-early/astra-r1-fence-6",
  "cp9-cells/3b/review-early/astra-r1-fence-7",
  "cp9-cells/3b/review-early/astra-r3-fence-2",
  "cp9-cells/3b/review-early/loop-breaking-before",
  "cp9-cells/3b/review-early/loop-preserving-after",
  "cp9-cells/3b/review-early/loop-preserving-continue",
  "cp9-cells/3b/review-early/n1-early-exit",
  "cp9-cells/3b/review-early/n1-number-negative",
  "cp9-cells/3b/review-early/n1-unknown-positive",
  "cp9-cells/3b/review-early/n6-saved-computed",
  "cp9-cells/3b/review-early/s1-nonreordering-control",
  "cp9-cells/3b/review-early/s4-grid-scopes",
  "cp9-cells/3b/review-early/s4-grid-use-selector-change",
  "cp9-cells/3b/review-early/sol-r1-fence-5",
  "cp9-cells/3b/review-early/sol-r1-fence-7",
  "cp9-cells/3b/review-late/corridor/test-leaves",
  "cp9-cells/3b/saved/held",
  "cp9-cells/3b/switch/fractional",
  "cp9-cells/3b/switch/later-case",
  "cp9-cells/3b/switch/null-case-error",
  "cp9-cells/3b/switch/null-default",
  "cp9-cells/3b/switch/whole-2",
  "cp9-cells/3b/switch/whole-2.0",
  "cp9-cells/r42/guard/else-branch",
  "cp9-cells/r42/guard/equals-null",
  "cp9-cells/r42/guard/is-integer",
  "cp9-cells/r42/guard/not-null",
  "cp9-cells/r42/guard/tested-key-counterpart",
  "cp9-cells/r44/guard/null-member-guarded",
  "cp9-cells/r46/guard/branch-null-eq/guarded",
  "cp9-cells/r46/guard/branch-null-ne/guarded",
  "cp9-cells/r46/m3/astra-m3/guard/get-index/guard",
  "cp9-cells/r46/m3/astra-m3/guard/repeat/guard",
  "cp9-cells/r46/m3/astra-m3/guard/same-path",
  "cp9-cells/r46/m3/sol-m3/guard-null-16",
  "cp9-cells/r46/m3/sol-m3/guard-null-18",
  "cp9-cells/r46/m3/sol-m3/guard-null-20",
  "cp9-cells/r8/n5/component-preserving",
]);

/**
 * Why a record is held back from the positive list, named by its cell or by its name, or `null` for an asserted record:
 * the tests that assert the set (the cells test's records, the candidate route's plans) hold back the same records.
 */
export function heldBack(record: FixtureRecord): string | null {
  // Its right-hand datetime has no subtraction row: §3.4 sites that operand, not the whole pair. Keep the set
  // unchanged until its maintainer corrects this start as well as its end (r4.62).
  if (record.name === "cp9-cells/F16/invalid-datetime-difference")
    return "operator site awaiting set correction (TABLE §3.4, r4.62)";
  // S9b's F18 shapes (TABLE r4.77 (2)): a copy of a written type as `fromJson`'s and `load`'s receiving context, which
  // the core takes with its A4 receiving design (#1072's A2); `files: true` is outside the slice's syntax, and the text
  // operand's warning there is C13's, not F18's
  if (record.name.startsWith("cp9-cells/s9b/f18-held/copy/scalar-json-host-value/"))
    return "fromJson with files: true outside the slice, and C13's text operand";
  if (record.name.startsWith("cp9-cells/s9b/f18-held/copy/"))
    return "S9b's F18 copy of a written type as the receiving context (r4.77 (2))";
  // Known text the conversion cannot convert is a compile error of its own (V30 §13, #1105), which the core's record
  // holds since the checks that owe the runtime nothing publish there (the lead's decision 3 on #1072): the record lacks
  // it until its maintainer adds it.
  if (record.name === "cp9-cells/r46/m3/astra-m3/conversion/default")
    return "a known-value error the record lacks (decision 3 on #1072)";
  // A button's value from outside the script owes C13's warning and its check at the choice, as an argument's does (the
  // sentence review of #1437, ruling 4): the record lacks them until its maintainer adds them.
  if (
    record.name === "cp9-cells/s4/choice-external/inferred" ||
    record.name === "cp9-cells/s4/choice-external/written" ||
    record.name === "cp9-cells/s4/choice-value/external-written"
  )
    return "C13's warning of a choice value from outside the script the record lacks (#1437)";
  // the adapters' cell (C13 and the storage rules' adapter rows): the kept checks the consumer calls run with S9b; C13's
  // released as S9b's checks give them (#1072)
  if (record.owner === "adapter" && !RELEASED_ADAPTER_RECORDS.has(record.name))
    return "the adapters' records (S9b)";
  // stage 3b (§13: N1–N10): narrowing definitions, N3's required checks for a possible null and for written unions, and
  // with them S0(c)'s class of expectations that rest on the null and written-union deviation and TABLE r4.52 AD-1's
  // re-derived records (each cites one of these cells), enter with S10
  if (
    record.cells.some((cell) => /^N\d/.test(cell)) &&
    !RELEASED_S10_CONSUMER_RECORDS.has(record.name) &&
    !RELEASED_S10_ROUTE_RULE_RECORDS.has(record.name)
  )
    return "stage 3b's cells (S10)";
  return null;
}

/** The fixture's records (`cells.jsonl`), each line checked, so a malformed line fails where it is. */
export function readFixture(): FixtureRecord[] {
  return readFileSync(new URL("cells.jsonl", FIXTURES), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const record = fields(JSON.parse(line), `line ${index + 1}`);
      const name = record["name"];
      assert.equal(typeof name, "string", `line ${index + 1}: a name`);
      const where = String(name);
      const owner = record["owner"];
      assert.ok(owner === null || typeof owner === "string", `${where}.owner: a text or null`);
      const files = record["files"];
      assert.ok(Array.isArray(files) && files.length > 0, `${where}.files: a list of files`);
      return {
        name: where,
        cells: texts(record["cells"], `${where}.cells`),
        owner: owner === null ? null : String(owner),
        files: files.map((file, position) => {
          const entry = fields(file, `${where}.files[${position}]`);
          assert.equal(typeof entry["path"], "string", `${where}.files[${position}].path`);
          assert.equal(typeof entry["source"], "string", `${where}.files[${position}].source`);
          return { path: String(entry["path"]), source: String(entry["source"]) };
        }),
        expected: readCompactRecord(record, where),
      };
    });
}
