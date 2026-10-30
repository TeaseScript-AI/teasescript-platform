# The desktop corpus: limits across areas

Kits and data on the desktop worker, under `desktop:~/work/evidence/corpus/<area>/` with one README per area unless an
entry names another path, indexed here and not imported: run each from its own folder there (`../README.md`, "Kept
outside the repository").

These kits read `tests/helpers/type-core-oracles` with `publishedAnswers(answers, bindings, request)` and run on trees
from `main` `2960937a1` (#1446): `copies/astra-1423/` (`publication.mjs`, `route-check.mjs`), `copies/astra-1441/`,
`copies/astra-1443/builder-probe/`, `copies/sol-1437-r2/`, `copies/sol-1441-r1/`, `copies/sol-1443-r1/`,
`consumers/astra-1437/` (Astra's `seam-stops.mjs`, the spot publications and the proof scripts),
`consumers/owner-s9b/` and `stops/astra-1434/`; `consumers/sol-1437-r5/`, `-r6/` and `-r7/` read `stopIdentity` from
there too. Each folder's `PORTED-1446.md` names the ported files; each original stays beside its port as
`<file>.pre-1446`. Their `publication.mjs`, like the master's in `tooling/g3-probe/`, fails on an exception since #1439,
the #1446 port beside it as `publication.mjs.pre-1439`. The `sol-1437` kits still name their review's folders: retarget
those as their READMEs say.

## Known problems

- Sol's S8 runner (`~/work/evidence/i1416/<head>/s8-run.sh`) runs `ownership-maps.mjs`, a draft cut off inside its
  first loop, so it parses on no tree. `place-maps` writes the `ownership.json` its classifier reads: leave the
  probe out.
- Four drivers that #1249's reviews ran are in no archive (not on the workers, not in their evidence folders), so their
  runs cannot be reproduced and no module stands for them: `repro-ring.mjs`, `repro-many-fed.mjs` and
  `r3-product-head.mjs` (the report archive's `astra-m4-i1249-review-r2-evidence/builder/tools/run.sh:4`–`6`), and
  `probe/famsum.mjs` (`astra-m4-i1249-review-evidence/design-r5.md:797`).
- #1310's first paste family run on `c1` (`1310/4a11b0553…/run/outc1/paste-*`, `tools/c1-check.sh:13`: 6,507 cases,
  495 forms) ran on an uncommitted state of the paste helper, which no archive keeps, so its forms cannot be pasted
  again: `messages/1310-paste-family.mjs` holds the PR's thirteen other runs.
- #1188's case sets `rel-cases` (450 programs), `contain-cases` (36), `dead-cell-cases` (4) and `dead-reach-cases` (80),
  and the standalone witnesses of #1261's Sol reviews r1 to r5 (308, `sol-m4-i1188-held-nodes-r1-evidence`), reach the
  corpus only through later runs that read them. Their texts survive (the #1188 sets' copies under `1463/retained/`),
  but no record names the run that wrote them or the globals it passed, so no module stands for them.
- #1272's review r2 also ran `pair.mjs` over 155 of its builder's probe files (`1310/98dcbbae9…/tools/probe-paths.txt`);
  135 of them are in no archive, so no module stands for those runs (its focused pairs are
  `joins/1272-astra-r2-pair-focused`).
- Three of #1210's review `work.mjs` commands (`astra-m4-i1210-review-evidence/comment-0.md:87`–`88`, `comment-1.md:82`)
  ran an earlier `work.mjs` no archive keeps; `copies/1210-astra-work.mjs` holds the runs of the kept one.
