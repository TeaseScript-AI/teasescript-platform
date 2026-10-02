# Real-script corpus inventory

This document records the feasibility corpus and a dated measurement snapshot. The source archives and their media
remain external inputs (local copies go under the ignored `external/` directory); this repository stores only aggregate
findings and importer code.

## Corpus

| Package | Groovy files | Source bytes | Source lines | Notes |
| --- | ---: | ---: | ---: | --- |
| SexScript desktop distribution | 14 | 46,638 | 1,078 | bundled examples, including localized variants |
| Domme3 | 25 | 474,372 | 14,524 | multi-script package plus the `Domme3Class` helper class |
| DisciplineClinic | 6 | 813,848 | 20,479 | very long scripts; menus built from runtime lists |
| Toy expanded | 22 | 316,758 | 8,298 | anonymous-object script with runtime-loaded `metaClass` modules |
| **Total** | **67** | **1,651,616** | **44,379** | |

All 67 files parse through the Groovy 2.5.21 `CONVERSION` phase. Ordinary SexScript files are parsed inside the
reconstructed method-body context; `Domme3Class.groovy` is parsed as an auxiliary compilation unit. The media packs
(DisciplinePack 1–10, the Toy Emily packs) contain images, sounds, and persona data files, not scripts.

Groovy 2.5 has no `do`/`while` loop, so legacy scripts cannot contain one. The parser exports two expression classes as
explicit unsupported nodes: `EmptyExpression` (29, a declaration without initializer, which the importer now lowers) and
`ArrayExpression` (4, `new Boolean[n]`-style arrays).

## Feasibility snapshot

Measured on 2026-10-02 at importer commit `32d8241b` with `node src/cli.ts report --run <package scripts>`.
Toy's 21 runtime-loaded modules are part of its single script `toy.groovy`, so Toy counts as one script whose
statements include all module code.

| Package | Scripts | Lowered | Dependency-closed | Compiler-clean except pending | Root errors | Placeholders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Distribution | 14 | 10 | 10 | 10 | 15 | 13 |
| Domme3 | 24 | 13 | 10 | 10 | 35 | 37 |
| DisciplineClinic | 6 | 3 | 3 | 3 | 17 | 17 |
| Toy expanded | 1 | 0 | 0 | 0 | 229 | 397 |

Root errors count independent causes that need manual work; placeholders count unconverted statements. Converting a
statement can expose more root causes inside it, so the two counts can rise while coverage improves. Toy's 229 come
from about 4,800 source statements, mostly method calls on maps (dictionaries) and Java objects, conditionals in
positions where moving them would change evaluation order, string methods, and menus from runtime lists.

Runtime smoke runs of the compiler-clean scripts (placeholder copies with host stand-ins):

- Distribution: all 10 runnable scripts run to the end; the French introduction's flow passes through three other
  scripts. The four remaining entry scripts are not converted (locale detection, desktop font configuration, and the
  adversarial `test.groovy`).
- Domme3: the entry flow stops at the unconverted `introfirst`, which counts installed image packs by listing
  directories. Isolated runs: `implements` and `inform` run to the end, `permission` reaches the step limit in a
  line-writing loop (the typed text must match the shown line), `spanking` returns to the entry flow, and four
  scripts fail comparing or calculating with settings that the introduction would have saved (see the null-comparison
  difference in `COMPATIBILITY-GAPS.md`).
- DisciplineClinic: the entry flow stops at the unconverted `DisciplineClinicMain` (menus from runtime lists);
  `Exit` runs to the end, `WaitRoom` fails on a setting saved by the main script.

Smoke runs found two importer defects before they reached a snapshot: `getRandom(0)` (fixed with the legacy result)
and range switch cases tested as lists.

No script is compiler-clean as generated, because almost all use storage or script chaining. Scripts using each
accepted-but-unimplemented capability, and how many otherwise compiler-clean scripts use it:

| Capability | Scripts using it | Otherwise compiler-clean scripts using it |
| --- | ---: | ---: |
| storage (`save`/`load`/`delete`) | 45 | 23 |
| `run`/`end` | 41 | 19 |
| `switch` | 26 | 9 |
| `getSeconds()` | 18 | 3 |
| `showButton` timeout/elapsed | 14 | 4 |
| `getDateTime()` | 13 | 2 |
| `askBooleans()` | 10 | 8 |
| `showPopup` | 10 | 4 |
| `askInteger()` | 9 | 0 |

## SexScript API usage

Calls to API-9/source-level SexScript methods, counting inherited calls and `main.<method>` calls from helper classes:

| API method | Calls | API method | Calls |
| --- | ---: | --- | ---: |
| `show` | 4,859 | `getSelectedValue` | 91 |
| `wait` | 3,622 | `playSound` | 74 |
| `showButton` | 1,783 | `load` | 66 |
| `getRandom` | 1,253 | `waitWithGauge` | 60 |
| `save` | 965 | `playBackgroundSound` | 50 |
| `setImage` | 446 | `getInteger` | 43 |
| `getBoolean` | 323 | `getString` | 29 |
| `loadInteger` | 299 | `setInfos` | 23 |
| `loadBoolean` | 258 | `useUrl` | 20 |
| `loadString` | 146 | `getBooleans` | 12 |
| `getTime` | 125 | `exit`, `loadFloat` | 8 each |
| `showPopup` | 116 | `loadFirstTrue` | 6 |

The remaining API calls (`getImage`, `getFloat`, `useFile`, `getDataFolder`, `isConnected`, ...) occur three times or
fewer each.

## Plain-Groovy patterns that matter

- Closure-based collection methods: `each` 53, `collect` 32, `add` 34, `indexOf` 24, `times` 20, `findAll` 19,
  `push` 13, `max` 11, `containsKey` 10, `join` 10; mostly in the Toy package.
- String methods are rare: `contains` ≤ 5 (some are list calls), `split` 4, `startsWith` 2, `substring` 1.
- `sleep(...)` 94 calls; `GroovyClassLoader` 23 (Domme3 loads `Domme3Class` this way); `java.util.Calendar` and
  `Date` reads about 40; `File` 11; reflection helpers in the distribution's adversarial `test.groovy`.
- `Domme3Class.groovy` has 21 methods; several call interactions, media, storage, or delays through a `main` parameter,
  so the importer lowers them to ordinary TeaseScript functions rather than synchronous `.ts` helpers.
