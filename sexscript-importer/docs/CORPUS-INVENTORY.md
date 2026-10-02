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

Measured on 2026-10-02 at importer commit `6d6f0be3` with `node src/cli.ts report --compile <package scripts>`:

| Package | Scripts | Lowered | Dependency-closed | Compiler-clean except pending | Root errors | Placeholders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Distribution | 14 | 10 | 10 | 10 | 15 | 13 |
| Domme3 | 24 | 9 | 7 | 5 | 29 | 32 |
| DisciplineClinic | 6 | 2 | 2 | 2 | 34 | 33 |
| Toy expanded | 22 | 0 | 0 | 0 | 23 | 22 |

No script is compiler-clean as generated, because almost all use storage or script chaining. Scripts using each
accepted-but-unimplemented capability, and the scripts it alone blocks (otherwise compiler-clean):

| Capability | Scripts using it | Only blocker in |
| --- | ---: | ---: |
| storage (`save`/`load`/`delete`) | 44 | 17 |
| `run`/`end` | 40 | 13 |
| `switch` | 28 | 5 |
| `getDateTime()` | 13 | 1 |
| `showButton` timeout/elapsed | 12 | 1 |
| `getSeconds()` | 10 | 0 |
| `askBooleans()` | 9 | 8 |
| `showPopup` | 9 | 1 |
| `askInteger()` | 7 | 0 |

The Toy package is not yet lowered: its body is one anonymous Groovy object and its modules are runtime-evaluated
closures, so the statement-level importer reports each file as a single unsupported construct.

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
