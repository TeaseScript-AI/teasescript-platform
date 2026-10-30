# The desktop corpus: stops

Kits and data on the desktop worker, indexed here and not imported: run each from its own folder there (`../README.md`,
"Kept outside the repository").

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
  (`PORTED-1494.md`).

## Known problems

- `stops/astra-1405/lifecycle.mjs` loads on no tree since the consumers split (#1367). It drives `narrowingPass` and
  patches the consumers' private `#valueRun` and `#syntaxRead`, none of which exist on `main`, and the anchor of its
  `no-restart` mutant is gone, so it needs a rewrite against the current pass, not a port.
- The made-units probe (`stops/uncharged-making/`) attributes code to source lines. Across trees whose line numbers
  differ, compare per site by a stable key (function name and step), not by line.
