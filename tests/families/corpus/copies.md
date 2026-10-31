# The desktop corpus: copies

Kits and data on the desktop worker, under `desktop:~/work/evidence/corpus/<area>/` with one README per area unless an
entry names another path, indexed here and not imported: run each from its own folder there (`../README.md`, "Kept
outside the repository").

- `desktop:~/work/evidence/corpus/copies/astra-1423/`: Astra's r1 of #1423 (G3 part 2). It holds generators
  (`cases.mjs`, `families.mjs`, `stop-cases.mjs`, `route-cases.mjs`, `growth.mjs`), fixed case lists, and their
  publication, stop-set and growth harnesses. Its `README.md` gives the pins.
- `desktop:~/work/evidence/corpus/copies/astra-1441/` and `copies/sol-1441-r1/`: Astra's and Sol's r1 of #1441. Their
  runners keep an exception apart, unhashed, and exit 1 on it, and Astra's `run.mjs` and Sol's `compare.py` count it
  apart and reject it, never as an equal publication (#1494). Each folder's `canary-1494.sh` checks that; its changed
  files stay beside it as `<file>.pre-1494` (`PORTED-1494.md`). Astra's `spot.mjs` and `run.mjs` and Sol's four runners
  record any thrown value, as `unprintable <type>` where its conversion to text throws, through the folder's
  `describeCaught.mjs` (#1523; `canary-1523.sh`, which runs `canary-1494.sh`, `<file>.pre-1523`, `PORTED-1523.md`).
- `desktop:~/work/evidence/corpus/copies/sol-1437-r2/` and `copies/sol-1437-r3/`: Sol's r2 and r3 of #1437 (each
  `README.md` gives the commands). `delta.mjs` and `dispatch.mjs` keep a prediction that throws apart, in
  `exceptions`, never in `agree` or the mismatches, and exit 1 on it; every catch of theirs and of `boundaries.mjs`
  and `witnesses.mjs` records any thrown value it keeps, as `unprintable <type>` where its conversion to text throws,
  through the folder's `describeCaught.mjs` (#1523). Each folder's `canary-1523.sh` checks that; its changed files
  stay beside it as `<file>.pre-1523` (`PORTED-1523.md`).
- `desktop:~/work/evidence/corpus/copies/astra-1443/` and `copies/sol-1443-r1/`: Astra's and Sol's r1 of #1443 (each
  `README.md` gives the commands). Their stop readers (`own-stops.mjs` and `stops-v2.mjs`; `stops.mjs`) keep a value
  named `CandidateOutsideSlice` as an `outside` row, as `unprintable <type>` where its conversion to text throws,
  through the folder's `describeCaught.mjs`, and rethrow every other value as before, and Astra's
  `builder-probe/publication.mjs` records any thrown value the same way (#1523). Each folder's `canary-1523.sh` checks
  that; its changed files stay beside it as `<file>.pre-1523` (`PORTED-1523.md`).
