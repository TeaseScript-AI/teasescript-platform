# The desktop corpus: rings

Kits and data on the desktop worker, indexed here and not imported: run each from its own folder there (`../README.md`,
"Kept outside the repository").

## Known problems

- #1293's review r3 (`desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/`): its first `matrix.mjs` run used a version
  of the driver it then overwrote, whose source and arguments no archive keeps; its focused gate's cells run ended out of
  memory before saving which inputs it reached, and its candidate suite's inputs depend on answers no log keeps. The
  matrix's second run is `rings/1293-r3-matrix-cases`; the gates' inputs are the repository's tests' own.
