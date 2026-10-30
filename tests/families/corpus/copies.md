# The desktop corpus: copies

Kits and data on the desktop worker, indexed here and not imported: run each from its own folder there (`../README.md`,
"Kept outside the repository").

- `desktop:~/work/evidence/corpus/copies/astra-1423/`: Astra's r1 of #1423 (G3 part 2). It holds generators
  (`cases.mjs`, `families.mjs`, `stop-cases.mjs`, `route-cases.mjs`, `growth.mjs`), fixed case lists, and their
  publication, stop-set and growth harnesses. Its `README.md` gives the pins.
- `desktop:~/work/evidence/corpus/copies/astra-1441/` and `copies/sol-1441-r1/`: Astra's and Sol's r1 of #1441. Their
  runners keep an exception apart, unhashed, and exit 1 on it, and Astra's `run.mjs` and Sol's `compare.py` count it
  apart and reject it, never as an equal publication (#1494). Each folder's `canary-1494.sh` checks that; its changed
  files stay beside it as `<file>.pre-1494` (`PORTED-1494.md`).
