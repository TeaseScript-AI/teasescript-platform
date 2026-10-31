# The desktop corpus: stops

Kits and data on the desktop worker, under `desktop:~/work/evidence/corpus/<area>/` with one README per area unless an
entry names another path, indexed here and not imported: run each from its own folder there (`../README.md`, "Kept
outside the repository").

- `desktop:~/work/evidence/corpus/stops/owner-s8/`: the owner's independent S8 reviews. It holds the 75-source
  domain matrix, the every-allowance sweeps, the cache lifecycle probe and the JSON and load matrix. It is untrusted
  input, never imported into a build.
- `desktop:~/work/evidence/corpus/stops/owner-s8/compiler-enclosing-evidence/`: the owner's reviewer's second bundle
  (164 files, PR #1434). It holds the 75-source domain generator, a 134-text complete-requirement matrix with an
  implementation-independent predicate, the relocation-only replay driver (`replay.mjs`, `check-run.py`),
  `cost-probe.mjs` and the raw results, and its `README.md` gives the replay commands. It is the standard oracle for
  the stops area: it runs before a builder's first review there.
- `desktop:~/work/evidence/corpus/stops/i1433-fallback-labels/`: #1476's fallback-label kit (#1433). `labels.mjs`
  keeps an analysis's exception as its own row and exits 1 on it, and `labels-compare.py` counts such rows apart and
  rejects them (#1494). Its `canary-1494.sh` checks that; its changed files stay beside it as `<file>.pre-1494`
  (`PORTED-1494.md`). `labels.mjs` records any thrown value, as `unprintable <type>` where its conversion to text
  throws, through the folder's `describeCaught.mjs` (#1523; `canary-1523.sh`, which runs `canary-1494.sh`,
  `labels.mjs.pre-1523`, `PORTED-1523.md`).
- `desktop:~/work/evidence/corpus/stops/astra-1487/`: Astra's r1 of #1487; its `README.md` gives the commands. Its
  stalled replay (`builder-scripts/stalled-rerun.mjs`) and single-source readers (`scripts/one-source-strict.mjs`,
  `{scripts,builder-scripts}/one-family-source.mjs`) keep an exception apart, unhashed, and exit 1 on it (#1510), and so
  do its subset replays (`builder-scripts/families-subset.mjs`, `families-subset2.mjs`) and fixture hashes
  (`builder-scripts/fixture-pub.mjs`, #1514); each records a thrown value whose conversion to text throws as
  `unprintable <type>` (#1520). Its `canary-1514.sh`, which runs `canary-1510.sh`, checks that; its changed files stay
  beside them as `<file>.pre-1510`, `<file>.pre-1514` and `<file>.pre-1520` (`PORTED-1510.md`, `PORTED-1514.md`,
  `PORTED-1520.md`). Its delta replays (`{scripts,r3}/run-delta.mjs`) and the builder's `bounded-stats.mjs`,
  `corpus-own.mjs` and `witness.mjs` record any thrown value the same way, through the folder's `describeCaught.mjs`
  (#1523; `canary-1523.sh`, which runs `canary-1514.sh`, `<file>.pre-1523`, `PORTED-1523.md`).
- `desktop:~/work/evidence/corpus/stops/2b-1511-r1/`: Codex's r1 of #1511 (its `README.md` gives the commands), whose
  fixture hashes (`builder-scripts/fixture-pub.mjs`) keep an exception apart, unhashed, and exit 1 on it (#1516);
  `canary-1516.sh` checks that, and the original stays beside it as `fixture-pub.mjs.pre-1516` (`PORTED-1516.md`);
  its publication parity (`parity.mjs`) keeps an exception on either tree apart the same way (#1518; `canary-1518.sh`,
  `parity.mjs.pre-1518`, `PORTED-1518.md`); both record a thrown value whose conversion to text throws as
  `unprintable <type>` (#1520; `canary-1516.sh`, `<file>.pre-1520`, `PORTED-1520.md`), and so do its `probe.mjs` and
  the builder's `case-oracle.mjs` and `site-family.mjs`, through the folder's `describeCaught.mjs` (#1523;
  `canary-1523.sh`, which runs `canary-1516.sh` and `canary-1518.sh`, `<file>.pre-1523`, `PORTED-1523.md`).
- `desktop:~/work/evidence/corpus/stops/{2b-1487-r1,2b-1487-r2,2b-1487-r3,2b-1511-r2,astra-1461,i1432-r1}/`: Codex's
  r1 to r3 of #1487 and r2 of #1511, Astra's r1 of #1461 and the r1 of #1445 (#1432), each with a `README.md` that
  gives the commands. Their readers record any thrown value, as `unprintable <type>` where its conversion to text
  throws, through the folder's `describeCaught.mjs` (#1523). Each folder's `canary-1523.sh` checks that; its changed
  files stay beside it as `<file>.pre-1523` (`PORTED-1523.md`).
- `desktop:~/work/evidence/corpus/stops/1476-r1-labels/` and `stops/astra-1476/`: Codex's and Astra's r1 of #1476
  (each `README.md` gives the commands). Their stop readers (`stop-soundness.mjs`; `stops.mjs`) keep a
  `CandidateOutsideSlice` as an `outside` row, as `unprintable <type>` where its conversion to text throws, through the
  folder's `describeCaught.mjs`, and rethrow every other value as before (#1523). Each folder's `canary-1523.sh` checks
  that; its changed files stay beside it as `<file>.pre-1523` (`PORTED-1523.md`).

## Known problems

- `stops/astra-1405/lifecycle.mjs` loads on no tree since the consumers split (#1367). It drives `narrowingPass` and
  patches the consumers' private `#valueRun` and `#syntaxRead`, none of which exist on `main`, and the anchor of its
  `no-restart` mutant is gone, so it needs a rewrite against the current pass, not a port.
- The made-units probe (`stops/uncharged-making/`) attributes code to source lines. Across trees whose line numbers
  differ, compare per site by a stable key (function name and step), not by line.
