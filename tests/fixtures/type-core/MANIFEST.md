# The core's compact fixture (M4 steps S0 and S6)

Opus, 2026-10-24, builder for M4 step S0 (brief `/tmp/agent-work/o4-3a-lead-fable/m4/s0-brief.md`, lead Fable): the
port plan's S0 (a) and (b) (`../checkpoint-9/port-plan/PLAN.md` revision 4, §2 row S0, §3.1 "Host globals"). S4
commits the fixture with its test as `tests/fixtures/type-core/cells.jsonl`; nothing here is in the repository.

## Refresh (M4 step S6)

Opus, 2026-10-25, builder for M4 step S6 (lead Fable). `cells.jsonl` is regenerated from the expectation set at
`716ac7091de2b95e…` (1,874 gate records, 9 deferred) by the same tooling, unchanged: `convert.py` (`eef78c11…`) with
`collection-rewrites.json` (`981e40ee…`), the host rewrite and the four collection rewrites below. 197 records are
rewritten (193 prefixed files and the four collection records); `cells-deferred.jsonl` is unchanged.

The exit condition, rerun on the laptop worker with the reference model round 19d (`points14.mjs` `2edb329e…`) on a
compiler build of `main` `6187eb145`, in both demand orders:
- zero skipped records;
- preservation equality (`verify.py`'s invariance check, every record's model output moved through the remapping
  against its output on the rewritten record): 1,874 of 1,874;
- the fixture against the model's compacted records on the rewritten set: 1,842 the same, the 9 adapter records apart,
  and 23 different, all `cp9-cells/s4/followup/…` records of TABLE r4.47 that round 19d predates (the lead's comparator
  gives the same 23 on the original set);
- boundary checks and ingress stores one to one in 1,860 records, 4 more consumed in place, 3 more with a store owing
  none, and 7 different, the same follow-up records (clock reads, r4.47 (5)).

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
| `cells.jsonl` | `ebae3eaaf6890f1818c8f1a5d5c6fb975c3ade743c7634e1fd22b807b56ec0b3` | the 1,874 gate records, 1,002,122 bytes (S6's refresh; S0's snapshot `cea67bb6…`, 1,782 records) |
| `cells-deferred.jsonl` | `f6db26a8f33612c5f57d2506cc322b0e925318a7e943e6cd18426fabd52d8e4e` | the 9 deferred-syntax records, never in the gate |
| `convert.py` | `eef78c1122233e97806cf3423a13bbbe65347131624faae19cdce1ef0eec7ba8` | the converter: deterministic (two runs byte-identical), one record per line, fixed key order |
| `collection-rewrites.json` | `981e40ee4a1490609eb4e78f9a3095d514edc256acfe580dc77e628ab03970c2` | the four collection rewrites, all `confirmed: true` |
| `verify.py` | `8062a453a4ee8c6d7f90203f349148dfc30e5695427972e26f9691467d4694bb` | the exit condition's own checks, beside the lead's comparator |
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
 "diagnostics": [{"kind", "class", "site": {"file", "offset"}, "context", "requiredCheck"}],
 "checks": [{"kind", "target", "against", "boundary", "site": {"file", "offset"}}]}
```

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
- **Spans.** Every site is a start offset. Span ends and the separate `expression` span are dropped, as §3.1 intends.
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
