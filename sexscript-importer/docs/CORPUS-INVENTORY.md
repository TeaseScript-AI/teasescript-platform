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

Measured on 2026-10-04 at importer commit `870add02`, after merging `main` at `2ea87216` (since `337388d2`: `dict`
#555, date and time #551, #554, #556, #561, and #563, element widening #538, and the conformance fixes #567; before
that the type pass #526, runtime type checks #520, unions #530 and #535, text operations #518, `sort` #546,
`min`/`max` #550, `askInteger` #548, `switch` #529 and #557, the `showButton` timeout #534, and `load` defaults
#545; ADR 0022 on multi-file scripts, #571), with `node src/cli.ts report --run <package scripts>` (default conversion,
without proposals). Script chains follow ADR 0022: each package starts at `main.tease`, and scripts transfer with `goto`
and end with `exit`; functions several scripts share are `global function`s in a generated `helpers.tease` (#570). Toy's 21 runtime-loaded modules are part of its
single script `toy.groovy`, so Toy counts as one script whose statements include all module code.

| Package | Scripts | Lowered | Dependency-closed | Compiler-clean except pending | Root errors | Placeholders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Distribution | 14 | 12 | 12 | 12 | 8 | 8 |
| Domme3 | 24 | 15 | 12 | 12 | 24 | 26 |
| DisciplineClinic | 6 | 3 | 3 | 3 | 5 | 14 |
| Toy expanded | 1 | 0 | 0 | 0 | 107 | 178 |

Root errors count independent causes that need manual work; placeholders count unconverted statements. Converting a
statement can expose more root causes inside it, so the two counts can rise while coverage improves. Toy's 107 come
from about 4,800 source statements, mostly Java objects and APIs, collection methods on receivers the importer cannot
prove to be lists (closure parameters, persona data, map entries), and closures that capture variables or are kept
in data.

The previous snapshot (2026-10-03, importer `d713b469`) counted 15, 35, 17, and 267 root errors, as did the same
importer after merging `main` (`6e0d4d03`). Since then menus from runtime lists, text operations, input defaults, date
formatting, `getImage`, and lookup-table maps (as `dict`, #536; Toy 254 to 183) convert by default, while
DisciplineClinic's 8 variables that change type (#519) and 10 reads of never-assigned variables (legacy bugs in Domme3
and DisciplineClinic) are newly reported; see [`PROPOSED-LANGUAGE-CHANGES.md`](PROPOSED-LANGUAGE-CHANGES.md) and
[`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md). The third round (from 13, 24, 22, and 183) converts conditional
expressions, inputs, and collection loops inside larger expressions through temporaries, starts empty-text
placeholders with their later type's empty value, notes what functions nothing references cannot convert, and adds
marked workarounds for two regular expressions and the system language.

Before the merge of `main` at `337388d2` (importer `61ee928e`, `main` at `b459787c`) the counts were 8, 24, 8, and 108
root errors, with DisciplineClinic at 3 scripts compiler-clean except pending and 17 placeholders and Toy at 180. The
merge replaces most stand-ins with `main`'s implementations, and its type pass now checks every generated script that
gets past name resolution. DisciplineClinic's three variables that changed type now get declared unions (8 to 5 root
errors), as does Toy's list of text that later holds lists (108 to 107). Lists that start as null start empty where no
code compares them with null (owner decision; 9 declarations), so their reads need no null tests after calls (see
[`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md)). The merge of `main` at `242ada7a` changes no count or smoke run:
the corpus's dicts and date and time values now compile and run with `main`'s implementations instead of stand-ins,
and 11 compiler warnings point at legacy null tests that can never be true or false (see `COMPATIBILITY-GAPS.md`).

Runtime smoke runs of the compiler-clean scripts (placeholder copies with host stand-ins for what `main` does not
implement yet; the wall clock starts at 2026-10-02 12:00 UTC and follows simulated time):

- Distribution: all 12 runnable scripts run to the end. The flow starts at the generated `main.tease` menu, whose first
  option, the English introduction, passes through three other scripts; the German and French introductions do the
  same in isolated runs. The two remaining scripts are not converted (desktop font configuration with `try`/`catch`,
  and the adversarial `test.groovy`).
- Domme3: the entry flow stops at the unconverted `introfirst`, which counts installed image packs by listing
  directories. Isolated runs: `implements` and `inform` run to the end, `permission` reaches the step limit in a
  line-writing loop (the typed text must match the shown line), `explain` returns to the entry flow, and seven scripts
  fail on settings that the introduction would have saved: `discipline`, `fun`, `sleep`, and `spanking` at the
  declaration of a Groovy `int` read from storage, which `main`'s runtime type check rejects when the key is missing
  (Groovy's `int` rejected null too), `confess` and `maintenance` comparing a missing setting, and `task` calculating
  with one (see the null-comparison difference in `COMPATIBILITY-GAPS.md`).
- DisciplineClinic: the entry flow stops at the unconverted `DisciplineClinicMain`, which now declares `dialog` as
  `string | list` (it holds text in most functions and one menu's option list) but keeps that menu unconverted
  (`SX_DYNAMIC_CHOICE_OPTIONS`). Its two test functions nothing references (class loading, never-assigned variables) no
  longer block. `Exit` runs to the end; `WaitRoom` fails on a setting the main script saves (`TSR058`);
  `Punish` and `OffenseSelect` are not
  converted (Java files, a never-assigned variable, a menu option list, and assignments to undeclared names).

Smoke runs found two importer defects before they reached a snapshot: `getRandom(0)` (fixed with the legacy result)
and range switch cases tested as lists. A third-round run into DisciplineClinic's main script found a write by
position into a list that starts empty, which Groovy grew (see `SX_LIST_GROWTH` in `COMPATIBILITY-GAPS.md`).

Two scripts compile as generated (two distribution examples; DisciplineClinic's `Exit` now calls global functions);
file transfers are the main remaining gap. Scripts using each accepted-but-unimplemented capability, and how many otherwise compiler-clean scripts
use it (capabilities used by fewer than three scripts are omitted):

| Capability | Scripts using it | Otherwise compiler-clean scripts using it |
| --- | ---: | ---: |
| `goto` to a file (#570) | 39 | 22 |
| `global function` and `global` (#570) | 28 | 13 |
| `askBooleans()` | 10 | 8 |
| `showPopup` | 10 | 4 |
| `openUrl()` | 3 | 0 |

Date and time (`getTimestamp().toSeconds()` in 18 scripts, `getDateTime()` in 14, `toISO()` and `formatTime()` in 3
each), `dict`, `switch` (26), the conversions (20), the `showButton` timeout and elapsed result (14), `askInteger` (9),
integer widening, `load "key", default:`, rounding, text operations, and `sort` were in this table before and are now
compiled and run with `main`'s implementations.

The proposal mode's measurements are in [`PROPOSED-LANGUAGE-CHANGES.md`](PROPOSED-LANGUAGE-CHANGES.md).

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
