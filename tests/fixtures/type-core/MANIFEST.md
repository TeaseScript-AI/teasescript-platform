# The core's compact fixture (M4 steps S0, S6 and S6b)

Opus, 2026-10-24, builder for M4 step S0 (brief `/tmp/agent-work/o4-3a-lead-fable/m4/s0-brief.md`, lead Fable): the
port plan's S0 (a) and (b) (`../checkpoint-9/port-plan/PLAN.md` revision 4, §2 row S0, §3.1 "Host globals"). S4
commits the fixture with its test as `tests/fixtures/type-core/cells.jsonl`; nothing here is in the repository.

## End offsets (M4 step S6, `S6-CARRIERS.md` revision 5, §9 step 0)

Opus, 2026-10-26, builder for M4 step S6 (lead Fable; the lead's answer 4, option B). Both files are regenerated from
the same pinned set revision `1de3570831c7bc4b…` (deferred `79a837a06da38169…`) with Sol's extended tooling, so every
compact site now carries its exclusive `end`. The tooling is `convert.py` `ba04601abfc9e012…` and `verify.py`
`9a5b8e73c7bd46f9…`, and the method and command are in the research `MANIFEST.md` (`4991fb45a36d40ef…`, "To
regenerate S6's committed fixture").
- `verify.py --preservation` passes for both files, against the set's own records: every diagnostic, check and N10
  writer span, starts and ends.
- Removing only the new `end` of each diagnostic and check site gives back the previous bytes, record for record:
  1,913 of 1,913 gate records (`b9ddd0fd…`) and 9 of 9 deferred records (`f6db26a8…`). The N10 writer spans carried
  their ends before.
- The converter rewrote the same 197 gate records (193 prefixed files and the four collection records) and the same 2
  deferred records.

## Refresh to the set's revision `81b3a0c4…` (M4 step S6b)

Opus, builder for M4 step S6b (lead Fable). Both files are regenerated from the set's revision
`81b3a0c419ed542b…` (1,981 gate records) and its deferred records `77b11b86eae67cf7…` (9) with the tooling unchanged:
`convert.py` `ba04601abfc9e012…`, `verify.py` `9a5b8e73c7bd46f9…`, `collection-rewrites.json` `981e40ee…`.

```sh
F=/home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/3a-newcore/fixture
S=$F/../expected-cp9-cells
work=$(mktemp -d /tmp/agent-work/o4-m4-s6b/fixture-XXXXXX)
mkdir "$work/set" "$work/out"
cp "$S/cases.jsonl" "$S/cases-deferred.jsonl" "$work/set/"
python3 -I "$F/convert.py" --set "$work/set" --out "$work/out"
python3 -I "$F/verify.py" --preservation "$work/set/cases.jsonl" "$work/out/cells.jsonl"
python3 -I "$F/verify.py" --preservation "$work/set/cases-deferred.jsonl" "$work/out/cells-deferred.jsonl"
cp "$work/out/cells.jsonl" "$work/out/cells-deferred.jsonl" tests/fixtures/type-core/
```

- `verify.py --preservation`: 1,981 of 1,981 gate records and 9 of 9 deferred records the same, every diagnostic,
  expression, obligation, check and N10 writer span. The converter rewrote 199 gate records (195 prefixed files and the
  four collection records) and the same 2 deferred records.
- Against `1de35708…`, 68 records are added, 114 changed and none removed. Added: the 40 presence records
  `cp9-cells/s4/presence/…`; the ten rule-function records `cp9-cells/s6/rule-function/…` (TABLE r4.63–r4.66), the
  same bytes as S6's separate `cells-rule-function.jsonl` (`987bc86d…`), which this refresh removes; and TABLE r4.52's
  18: AD-3's six `cp9-cells/s4/s6b/dead-code/…`, AD-2's five `cp9-cells/s4/s7/load-field-repair/…` and AD-1's seven.
  Changed: AD-1's 92 re-derived expectations, r4.62's 21 member-read and operator site ends, and r4.60's corrected
  `cp9-cells/r8/get-dispatch/unknown`. AD-1's 55 metadata re-derivations leave their compact records as they were. In
  the deferred file AD-1 re-derives `cp9-cells/3b/review-late/json/constant`.
- Every AD-1 record cites a cell of stage 3b (N1–N10), so that class holds it until S10; the tests name the held
  classes and their counts (`heldBack`, `tests/helpers/type-core-fixture.ts`).

## Refresh (M4 step S6)

Opus, 2026-10-25, builder for M4 step S6 (lead Fable). `cells.jsonl` is regenerated from the expectation set at
`1de3570831c7bc4b…` (1,913 gate records, 9 deferred; TABLE r4.50) by the same tooling, unchanged: `convert.py`
(`eef78c11…`) with `collection-rewrites.json` (`981e40ee…`), the host rewrite and the four collection rewrites below.
197 records are rewritten (193 prefixed files and the four collection records); `cells-deferred.jsonl` is unchanged.
Against the set's previous revision `60751a0f17a0f8cf…` (1,888 records) it adds the 25 records
`cp9-cells/s4/s6/owner/…` (`ingress/`, `bound/` and `default/`: the owner's review of 2026-10-25); the other 1,888
compact records are byte-identical. The 25 were compared with the core in both orders before the refresh: 25 of 25 the
same. The set's revision `6f102107b71f3dde…` before it differs only in the 25 records' reason citations and pins (TABLE
r4.50 states the owner's three readings); both convert to the same bytes.

`60751a0f…` against its previous revision `01eccb2f1a7da537…` (1,874 records; `716ac7091de2b95e…` before it differs in
five reason texts only) added the 14 records `cp9-cells/s4/s6/returns/…` and `cp9-cells/s4/s6/defaults/…`. The exit
condition, rerun for it on the laptop worker with the reference model round 19d (`points14.mjs` `2edb329e…`) on a
compiler build of `main` `6187eb145`, in both demand orders:
- zero skipped records;
- preservation equality (`verify.py`'s invariance check, every record's model output moved through the remapping
  against its output on the rewritten record): 1,888 of 1,888;
- the fixture against the model's compacted records on the rewritten set: 1,850 the same, the 9 adapter records apart,
  and 29 different, records round 19d predates: the 23 `cp9-cells/s4/followup/…` records of TABLE r4.47 and 6 of the
  14 `cp9-cells/s4/s6/…` records of r4.48 (the research folder's later model, `d0d44513…`, differs in those 6 only);
- boundary checks and ingress stores one to one in 1,874 records, 4 more consumed in place, 3 more with a store owing
  none, and 7 different, follow-up records (clock reads, r4.47 (5)).

The sections below are S0's record of the method; the file table names the refreshed fixture.

## S0

**Status: complete.** (a) and (b) are done:
- 193 gate records and 2 deferred records read `hostFlag` or `hostText`, and are rewritten;
- the four collection records are rewritten as Sol confirmed (relayed by the lead, 2026-10-24).

`cells.jsonl` is the candidate verified before the confirmation, byte for byte (`cea67bb6…`). The exit condition was
rerun on it: zero skips and zero differences in both orders.

## Files

| file | SHA-256 | content |
|---|---|---|
| `cells.jsonl` | `157de4ba7df82208bce73d13eaab0566588203f705a307c3eb8be5ae1eace5ff` | the 1,981 gate records with site ends, 1,075,165 bytes (S6's `d8cf041a…`, 1,913 records; S0's snapshot `cea67bb6…`, 1,782 records) |
| `cells-deferred.jsonl` | `ec01c689673fd084dab9bd1d0182dda838804880adf0b35e473d030ba86245a8` | the 9 deferred-syntax records with site ends, never in the gate (S6's `c4836620…`) |
| `convert.py` | `ba04601abfc9e012cc466bc084d92bf3f7289ae4731428d95a32e2e8046c7464` | the converter: deterministic, one record per line, fixed key order, full compact spans (earlier S6 refresh: `eef78c11…`) |
| `collection-rewrites.json` | `981e40ee4a1490609eb4e78f9a3095d514edc256acfe580dc77e628ab03970c2` | the four collection rewrites, all `confirmed: true` |
| `verify.py` | `9a5b8e73c7bd46f9f647f33e597829b503b1634df0d40d4055a95a3e0fd5eeb5` | the exit condition's own checks, beside the lead's comparator, and span preservation (`--preservation`) (earlier: `8062a453…`) |
| `check/results.txt` | | every run's counts, the negative controls, the reader check |
| `check/run-batch.sh`, `check/read-check.mjs` | | the laptop batch (shards through `sx-queue`) and the reader check |

`convert.py --full <path>` writes the rewritten gate records in the set's own shape, for the model and the
comparator: `2c805c153aabf89a3c73bba3e59253cd4ebe10e559d2b0e1894de6ca751358f7`. It is not stored, since it can be
regenerated.

Inputs, all pinned by SHA-256:
- the set `../expected-cp9-cells/cases.jsonl` `9f3d41dc383e35d4…` (1,782 gate records) and `cases-deferred.jsonl`
  `79a837a06da38169…` (9);
- the model `../checkpoint-9/spike14/points14.mjs` round 16b `93103f36a47d2f88…`;
- the comparator `spike14/tools/compare-r410.py` `0a4bfb6a114fd3a9…`;
- a compiler `dist` built from `main` `9a73a1a2d` on the laptop (`npm ci`, `npm run build:typescript`, Node 24.18.0);
- the record shape `tests/helpers/type-core-records.ts` on `main` `9a73a1a2d`.

## Record shape

One JSON object per line, keys in this order:

```
{"name", "cells", "owner", "files": [{"path", "source"}], "outcome",
 "diagnostics": [{"kind", "class", "site": {"file", "offset", "end"}, "context", "requiredCheck"}],
 "checks": [{"kind", "target", "against", "boundary", "site": {"file", "offset", "end"}}]}
```

- Every site is the half-open span `[offset, end)` in its rewritten file (S6's end offsets, above).
- `outcome`, the diagnostics' `kind`, `class`, `site` and `context`, and the checks' fields are exactly
  `CompactRecord` (`readCompactRecord` accepts every line of both files: `check/read-check.mjs`).
- `class` is the set's `status`. In every record, `status` equals `class` and `at` equals `site`.
- `context` is the set's word, or `null` where the set leaves it unasserted (`contextUnspecified`). Every word in
  the set is in `CONTEXT_WORDS`.
- `boundary` is `true` only where the set says so.
- `owner` is `"adapter"` for the 9 adapter records (S9b) and `null` otherwise.
- `files` is always a list. A single-source record has one `main.tease`.
- `requiredCheck` is `null`, or the N10 payload: `{"rule", "writer": {"file", "offset", "end"}, "missingTests"}`
  (153 payloads in 139 records). The writer keeps its `end` because the lead's comparator compares the writer span.

## The host rewrite (§3.1)

Rules, per file of a record (`convert.py`):

1. Rename `hostFlag` to `flagHost` and `hostText` to `textHost`. The names have the same length, so in-line offsets
   hold. Every occurrence is an identifier: none is inside a string or a comment (checked).
2. Start the file with one line per renamed name it reads, flag first: `let flagHost = askBoolean "flag"` and
   `let textHost = askText "text"`. Every site of that file moves by the prefix's length: 33, 30, or 63 for both. This
   covers the expectation's sites, the N10 writer sites, `writerSites` keys and `provenance.writers` entries. Only the
   file that reads the name gets the line: in `r422/transfer/entered-label` that is `worker.tease`.
3. `hostValue` stays a declared global, as production has it (`FreshRuntimeOptions.globals`). 104 gate records read
   it. The model declares its globals for every record, so S4 declares `hostValue` for every record too.
4. Collection records: the confirmed rewrite replaces the host read in place (next section). Sites at or before its
   start stay. A span ending at its end ends at the replacement's end. Later sites move by the length difference.
5. Targets, `against`, `missingTests`, rules and `on` texts carry no offset and no host name (checked), so they stay
   as derived. No expectation is regenerated from model output.

`convert.py` checks on every run, and stops at the first failure:
- each set site's text, line and column agree with its source;
- after the rewrite, every site's text is its original text under the rewrite;
- no `hostFlag` or `hostText` remains;
- no other string in a rewritten expectation carries a `file:offset`.

Counts (gate set):
- `hostFlag` in 183 records and `hostText` in 11 (one record reads both): 193 records, 193 prefixed files;
- 3 of them multi-file (`r422/block-end/nonreturning-worker-control`, `…-registered-end`,
  `r422/transfer/entered-label`);
- 3 read `hostFlag` inside a function body. V30 §14 and §29: a function sees its file's top-level variables;
- 5 register a handler after the leading line (`3b/bodies/timer`, `/button`, `/media`,
  `3b/deferred/no-interrupts/plain`, `r422/block-end/nonreturning-worker-registered-end`).

Deferred set: 2 records read `hostFlag`, and one of them registers a timer. They are rewritten the same way. No front
end runs them, so they are unverified by construction.

## The four collection records (confirmed by Sol)

These are `cases.jsonl` lines 578, 579, 722 and 1137. Each rewrite replaces the host read in place with a `load` that
has a typed collection default. Under TABLE F18, a load with a typed default has the default's kind, definite, and
"a loaded … collection's M is `open`": the runtime checks the shape, not emptiness. Its contents are external data,
and the `load` call is a C9 ingress expression (reason `external-data`), so the boundary stays at the same start
offset with the same target and `against`. V30 uses the same form (`load("pushups", default: [])`).

| record | before | after | sites after the read |
|---|---|---|---|
| `r42/host-list-elements` | `let xs = hostList` | `let xs = load("list", default: [])` | +17 |
| `r42/host-dict-values` | `let entries = hostDict` | `let entries = load("dict", default: dict{})` | +21 |
| `r46/ingress/addAll/external` | `numbers.addAll(hostList)` | `numbers.addAll(load("list", default: []))` | +17 |
| `r46/m3/sol-m3d/addAll-external` | `xs.addAll(hostList)` | `xs.addAll(load("list", default: []))` | +17 |

What each rewrite keeps:
- **External provenance:** the boundary check stays, with reason `external-data`.
- **Element and value kinds:** `unknown`:`external`. `xs.first` and `entries.get(…)` still owe the integer
  destination's copy-type and its warning, and `xs.last` its integer-check.
- **Emptiness:** the list stays open and may be empty, so `xs.first` still owes its empty-check.
- **Ingress sites:** the model's ingress store stays at offset 9, 14, 33 or 23, with the same target and `against`.
  Its consumers move by the delta.

The model on the rewritten records gives exactly the remapped expectations, in both orders, and with only `hostValue`
declared as well. Rejected alternatives:
- `let xs: list = hostValue`: the written type adds a written-target warning;
- `[hostValue]`: non-empty, and the ingress moves into the literal (§3.1);
- a prefixed `let listHost = load(…)`: the boundary target and site move to the prefix line.

**Sol's confirmation** (relayed by the lead, 2026-10-24): all four confirmed, per record.
- `r42/host-list-elements`: the boundary stays at 9 (`xs [list]`); the empty-check and the integer copy-check move to
  56.
- `r42/host-dict-values`: the boundary stays at 14 (`entries [dict]`); the integer copy-check moves to 65.
- `r46/ingress/addAll/external`: both checks stay at 33 (`numbers.element [integer]`).
- `r46/m3/sol-m3d/addAll-external`: the insertion checks stay at 23 (`xs.element [integer]`); the integer-check moves
  to 57; `xs` stays held, with no empty-check added.

All four keep `external-data` provenance and unknown external contents, and the +17/+21 remapping is right.

## The exit condition

The final runs on the laptop, after Sol's confirmation, in both demand orders (forward and `--reverse`). Each run
used 4 shards through `sx-queue`, each shard in a named 3 GB no-swap scope; all 24 jobs ran 07:05–07:06 UTC. Every
run had **zero skipped records**. The runs:
- `forig`: the set;
- `ffinal`: the rewritten set;
- `ffinalhv`: `ffinal` under a copy of the model whose `GLOBALS` is `["hostValue"]`, the production declaration.

All counts are in `check/results.txt`. The same counts held before the confirmation for the candidate and for the
unconfirmed state.

- **The lead's comparator** (`compare-r410.py`, check sites and `requiredCheck` included), each run's expectations
  against the model's records: **1,773 same, 9 adapter, 0 outcome, 0 diagnostics, 0 context, 0 checks, 0 check-site,
  0 required-check, 0 missing**, in all 3 runs × 2 orders.
- **`verify.py`**, identical in both rewritten runs × 2 orders:
  - fixture against the model's compacted records (the semantics of `recordDifferences`, plus N10 multisets): 1,773
    of 1,773 gate records the same. The 7 adapter differences are the comparator's adapter records;
  - invariance: each original record's model output, moved through the remapping, equals the rewritten record's in
    all 1,782 records. This covers outcome, every diagnostic, obligation and N10 payload, every check with its
    reason and span, the ingress stores, the ingress map, and writer provenance;
  - one-to-one ingress correspondence: 1,775 records with boundary checks and ingress stores one to one. 4 more have
    a boundary on an ingress consumed in place, where no store exists (`repeat load(…) {}` and
    `repeat fromJson(…) {}`: targets `load.result`, `fromJson.result`). 3 more have a store that owes
    no boundary in the expectation and in the model alike (a destination against `[unknown]`, a result never used).
    No record differs. Multiplicity is part of every comparison.
- **Negative controls**, built from the final fixture (`check/results.txt`), each caught:
  - a check site off by one: 1 record differs;
  - the second boundary check replaced by a copy of the first (review B5's control): 1 record differs, in the
    fixture check and the ingress check;
  - every rewrite's shift left out: 155 records differ. The other 42 rewritten records carry no site that moves,
    such as `addAll/external`, whose sites all stand at 33;
  - the unshifted model records taken as the rewritten run: 156 invariance differences (spans included);
  - the comparator, original expectations against the rewritten run: 148 diagnostics and 7 check-site differences.
- **The repository reader:** `readCompactRecord` (`main` `9a73a1a2d`) reads every line of both files.

## What the compact shape does not carry

- **N10 payloads.** `CompactDiagnostic` has no field for them. See "For S4's test" below. Not carried: the
  writer's kind (`declaration` 65, `assignment` 58, `source-definition` 30), the payload's `reason`
  (`unchecked-null-route` 113, `unchecked-written-union-route` 40), its `target` and `against`, and one
  `missingTestExplanation`. The lead's comparator compares none of these.
- **Diagnostic details.** The link from a diagnostic to its obligation (909 diagnostics): the shape compares checks
  as a separate multiset, so it never asserts which check a warning owes. Also `offendingKind` (216 diagnostics, 148
  checks), `resultStatus` and `operationStatus` (179 each), a check's `reason` (`external-data` on all 197 boundary
  checks: implied by `boundary`) and the `on` texts.
- **Spans.** S0's sites were start offsets only; S6's regeneration added each site's exclusive `end` (above). The
  separate `expression` span is dropped, as §3.1 intends.
- **Writer evidence.** `expect.writerSites` (32 records), `provenance.writers` (27 diagnostics), and the record-level
  `writerAssertions` (23), `requiredCheckMetadata` (20), `writerCandidates` (4), `ingressIdentities`,
  `rejectedStores`, `unserializedWriterEvidence` (1 each) and `consumerSite` (2). The lead's comparator does not
  compare these either.
- **The host declaration.** Not per record: the rule is `hostValue` declared for every record (rule 3).
- **Classes held back.** The adapter class is `owner`. The set has no per-record field for S0(c)'s class. The fixture
  carries `cells`, from which a cell-based positive list (S4) or hold-back (S6) can be computed.

## For S4's test

The N10 payload travels as the extra per-diagnostic field `requiredCheck`, which the current reader ignores
(`tests/helpers/type-core-records.ts` on `main` `9a73a1a2d`: `readCompactRecord` and `recordDifferences` read only
kind, class, site and context). Without a change, S4's test would pass a record whose N10 payload is wrong. So S4
either adds the field to the compact record (`CompactDiagnostic.requiredCheck`, `null` or
`{rule, writer: {file, offset, end}, missingTests}`), or adds a second comparison of the payloads as multisets of
(kind, site, rule, writer span, missing tests), as `compare-r410.py` and `verify.py` compare them. The writer carries
its `end` because the lead's comparator compares the writer span.

Also for S4:
- declare `hostValue` as a global for every record (rule 3);
- hold back the 9 records whose `owner` is `"adapter"`.

## Where the plan's text is out of date (for the lead)

- **Counts.** §3.1 counts 105 `hostFlag` records and 1 `hostText`. This set has 183 and 11 (193 records), and 104
  `hostValue` records.
- **Scope of the equality.** §3.1 says every `hostFlag`/`hostText` record is single-file and none has a
  registration. This set has 3 multi-file records, 5 with a registration and 3 with the read inside a function. The
  model run covers them all: their verdicts are invariant.
- **Fixture size.** The S0 row estimates about 490 KB. The fixture is 961 KB, of which 348 KB is source text.
- **`r42/typed-host-globals`** asserts F19's typed host globals (`hostFlag` boolean, `hostText` string). After the
  rewrite it asserts the same outcome through `askBoolean`'s and `askText`'s results (F25). F19's typed host globals
  have no production counterpart, so this record no longer tests them.

## Reproduce

```sh
F=…/evidence/3a-newcore/fixture
python3 -I $F/convert.py                                   # cells.jsonl, cells-deferred.jsonl
python3 -I $F/convert.py --out <dir> --full <dir>/cases-rewritten.jsonl
node points14.mjs <dist> <dir>/cases-rewritten.jsonl [--reverse] --json <rw.jsonl>   # also on cases.jsonl: <orig.jsonl>
python3 -I compare-r410.py <dir>/cases-rewritten.jsonl <rw.jsonl>
python3 -I $F/verify.py ../expected-cp9-cells/cases.jsonl <orig.jsonl> <dir>/cells.jsonl <rw.jsonl>
```
