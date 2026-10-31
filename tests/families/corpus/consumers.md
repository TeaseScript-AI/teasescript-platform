# The desktop corpus: consumers

Kits and data on the desktop worker, under `desktop:~/work/evidence/corpus/<area>/` with one README per area unless an
entry names another path, indexed here and not imported: run each from its own folder there (`../README.md`, "Kept
outside the repository").

- `desktop:~/work/evidence/corpus/consumers/sol-1455-r1/`: Sol's r1 of #1455 (#1436, object presence): the
  natural-budget family (`review-family.mjs` over `review-cases.json` and `opaque-cases.json`), every-allowance stops
  (`stops.mjs`), checkpoint restores (`checkpoints.mjs`) and the builder spot check (`spot.mjs`). Head `3f0bcb1bd`,
  base `2960937a1`; `SHA256SUMS` sha256 `a42f4ef4…`. Its family and checkpoints run on `main` `2960937a1`.
- `desktop:~/work/evidence/corpus/consumers/sol-1465-r1/`: Sol's r1 of #1465 (its `README.md` gives the commands).
  `dimensions.mjs` keeps a publication or run that throws apart, as the mode's `exception` beside a null route, and
  exits 1 on it, and `judge.py` fails a row with such a mode on either tree, counts it apart and exits 1, so modes or
  trees that throw alike never pass as agreeing; both catches of `dimensions.mjs` record any thrown value, as
  `unprintable <type>` where its conversion to text throws, through the folder's `describeCaught.mjs` (#1523). Its
  `canary-1523.sh` checks that; its changed files stay beside them as `<file>.pre-1523` (`PORTED-1523.md`).
- `desktop:~/work/evidence/corpus/consumers/astra-1437/`: Astra's r1 of #1437 (its `README.md` gives the commands),
  whose `budget-repro.mjs`, `explore.mjs`, `runtime-model.mjs`, `seam-stops.mjs`, `stop-core.mjs` and spot publications
  (`spot-{head,base}/publication.mjs`) record any thrown value, as `unprintable <type>` where its conversion to text
  throws, through the folder's `describeCaught.mjs` (#1523). Its `canary-1523.sh` checks that; its changed files stay
  beside them as `<file>.pre-1523` (`PORTED-1523.md`).

## Known problems

- `consumers/sol-1437-r5/probe.mjs` (`controls`, `chain-work`) hooks `readSnapshot(contentSource(walk, value))` in the
  consumers' signatures, which `main` no longer has (the read's class comes from `contract.readClass`): its alias
  bypass needs a redesign. The folder's other scripts run on `main`.
- `consumers/sol-1437-r7/identity-r7.mjs mutant` recreates #1437's B1 by caching a JSON proof's root and items, and
  anchors on the items expression that `main` extended with the unread (stopped) branch. Its other flavors run.
- `consumers/sol-1437-r6/spot.mjs` refuses a tree whose sources differ from its review's head (`source-hashes.json`),
  by design: it reproduces that review on its pinned build only.
- `consumers/sol-1437-r7/spot-r7.mjs`, which the folder's README lists, is in no archive (not on the workers, not in
  the builder's r7 evidence): the r7 spot check cannot be rerun.
