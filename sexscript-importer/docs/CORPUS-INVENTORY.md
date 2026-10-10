# Real-script corpus inventory

This document records the feasibility corpus and a dated measurement snapshot, and an aggregate measurement over a much
larger corpus ([Large corpus](#large-corpus-corpus2)). The source archives and their media remain external inputs (local
copies go under the ignored `external/` directory); this repository stores only aggregate findings and importer code.
The four-package corpus below stays the detailed reference.

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

Measured on 2026-10-05 at importer commit `869fb51e`, after merging `main` at `19a93bee` (since `df86064b`: globals
and global functions #576, labels and endings #582, file transfers with `goto`, `call`, and `fallback` #583, globs
#585, `script(...)` references and computed targets #588, the camera #475, and image tags #580 and #586; before that
the `---` file header #575, operand checks #564, project compilation #573, ADR 0022 on multi-file scripts #571, `dict`
#555, date and time, the type pass #526, unions #530, and the other merges listed in earlier rounds), with
`node src/cli.ts report --run <package scripts>` (default conversion: workarounds for the accepted forms `main` does
not implement yet, no proposals). Each package compiles as one project (`compileProject`) and runs natively from its
`main.tease`; the runtime follows `goto` between files, functions several scripts share are `global function`s in a
generated `helpers.tease`, and files that are not compiler-clean are stubs that end a run as `blocked`. Toy's 21
runtime-loaded modules are part of its single script `toy.groovy`, so Toy counts as one script whose statements include
all module code.

| Package | Scripts | Lowered | Dependency-closed | Compiler-clean except pending | Compiler-clean as generated | Root errors | Placeholders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Distribution | 14 | 12 | 12 | 12 | 12 | 8 | 8 |
| Domme3 | 24 | 17 | 14 | 14 | 14 | 21 | 23 |
| DisciplineClinic | 6 | 3 | 3 | 3 | 3 | 5 | 14 |
| Toy expanded | 1 | 0 | 0 | 0 | 0 | 107 | 178 |

The distribution compiles as one project as generated; Domme3, DisciplineClinic, and Toy compile except their
unconverted files. Before this round (importer `3cb85783`, stand-ins for transfers, globals, and the accepted forms),
Domme3 had 15 lowered and 12 compiler-clean scripts with 24 root errors, and only two files of all four packages
compiled as generated. Domme3's gain comes from its image-pack counts (`new File("images/Domme3/Domme${pack}/")
.listFiles().size()`), which now read the counts of the package's images at conversion time.

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
The merge of `main` at `540b8f2e`, whose stricter operand checks (#564) reach every generated script that gets past
name resolution, changes no count, compiler diagnostic, or smoke run either, and neither does writing the 23 legacy
`setInfos()` calls as `---` file headers (#575), which every generated file compiles with.

Native smoke runs of the package projects (the wall clock starts at 2026-10-02 12:00 UTC and follows simulated time):

- Distribution: all 12 runnable scripts run to the end. The flow starts at the generated `main.tease` menu, whose first
  option, the English introduction, passes through three other scripts; the German and French introductions do the
  same in isolated runs. The two remaining scripts are not converted (desktop font configuration with `try`/`catch`,
  and the adversarial `test.groovy`).
- Domme3: the entry flow now enters `introfirst`, whose image-pack counts convert, and reaches the step limit there
  (inconclusive). Isolated runs: `implements` and `inform` run to the end, `permission` reaches the step limit in a
  line-writing loop (the typed text must match the shown line), `explain` returns to `main.tease`, and eight scripts
  fail on settings that the introduction would have saved: `discipline`, `fun`, `sleep`, and `spanking` at the
  declaration of a Groovy `int` read from storage, which `main`'s runtime type check rejects when the key is missing
  (Groovy's `int` rejected null too), `confess` and `maintenance` comparing a missing setting, and `intro` and `task`
  calculating with one (see the null-comparison difference in `COMPATIBILITY-GAPS.md`).
- DisciplineClinic: the entry flow stops at the unconverted `DisciplineClinicMain`, which now declares `dialog` as
  `string | list` (it holds text in most functions and one menu's option list) but keeps that menu unconverted
  (`SX_DYNAMIC_CHOICE_OPTIONS`). Its two test functions nothing references (class loading, never-assigned variables) no
  longer block. `Exit` runs to the end; `WaitRoom` fails on a setting the main script saves (`TSR058`);
  `Punish` and `OffenseSelect` are not
  converted (Java files, a never-assigned variable, a menu option list, and assignments to undeclared names).

Smoke runs found two importer defects before they reached a snapshot: `getRandom(0)` (fixed with the legacy result)
and range switch cases tested as lists. A third-round run into DisciplineClinic's main script found a write by
position into a list that starts empty, which Groovy grew (see `SX_LIST_GROWTH` in `COMPATIBILITY-GAPS.md`).

Every compiler-clean script now compiles as generated: file transfers, globals, and global functions are native, and
the accepted forms `main` does not implement yet become marked workarounds. Script files per workaround: `askBooleans`
10 (distribution 8, Domme3 1, Toy 1), `showPopup` 5 (distribution 1, Domme3 3, Toy 1), `openUrl` 3 (DisciplineClinic 2,
Toy 1), and the image counts 3 (Domme3). Before, 22 otherwise compiler-clean scripts waited for file transfers, 13 for
global functions, 8 for `askBooleans`, and 4 for `showPopup`.

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

## Large corpus (corpus2)

**Source.** The owner's archive `Sexscripts.tar.gz` (14.743 GB compressed; 157,305 files, 15.892 GB unpacked, about 81%
of it duplicate copies of the same downloads and their ZIPs), deduplicated by a separate pass into 340 package folders
under the ignored `external/corpus2/`: 289 script packages (5 of them bundles that repeat other packages) and 51
resource packs without scripts. They hold 704 distinct scripts; 118 package paths have several versions, kept side by
side as `name__sha256_<hash>.groovy`. Media files are empty placeholders in the measured copy, so media checks see names
only. The deduplication record is `external/corpus2-inventory/INVENTORY.md` (not committed).

**Method.** Measured on 2026-10-04 at importer commit `09220d66` (`main` at `df86064b`), default conversion without
proposals, with the report's compiler gate and smoke run (`report --run`) for each script package on its own. A bundle
counts the scripts it repeats again, so the packages hold 728 scripts in 778 Groovy files. All files parse. The first
run of this round, at `3cb85783`, gave the "Before" column; the importer fixes it exposed are listed at the end.

| Measure | Before | After fixes |
| --- | ---: | ---: |
| Scripts recognized | 728 | 728 |
| Lowered (no root error) | 389 | 394 |
| Dependency-closed | 385 | 390 |
| Compiler-clean as generated | 107 | 118 |
| Compiler-clean except pending capabilities | 336 | 360 |
| Reached by a smoke run | 336 | 360 |
| Root errors | 8,805 | 8,512 |
| Placeholders | 8,846 | 8,657 |
| Packages with every script lowered | 107 | 111 |
| Packages with every script clean except pending | 89 | 102 |
| Entry flows that run to the end (`halted`) | 60 | 68 |
| Entry flows blocked at an unconverted or pending file | 183 | 172 |
| Entry flows that fail / hit the step limit / have no entry | 2 / 5 / 39 | 4 / 6 / 39 |

With the media-tags proposal (M1), 396 scripts lower and 362 are clean except pending; only 4 scripts use the proposal,
2 of them otherwise clean.

**Native projects (2026-10-05).** After the merge of `main` at `19a93bee` (#570 parts 3 to 7a), each package compiles as
one project and runs from `main.tease` with the runtime's own transfers, and a package with a single script gets it as
`main.tease` (importer `33772f2b`, before the workarounds for unimplemented accepted forms): 100 packages run end to end
from their entry (68 with stand-ins), 149 compile as one project with placeholders only for `askBooleans`, `openUrl`,
and `showPopup`, and 138 compile as generated. Scripts: 398 lowered, 384 compiler-clean except pending, 335
compiler-clean as generated (118 before), 356 reached by a run, 8,486 root errors. Entry flows: 100 halted, 174
blocked at an unconverted file, 8 failed, 7 at the step limit. New since the stand-ins: `guessthenumber` and
`guessthenumberalt` exceed the runtime's default budget of 10,000 instructions per invocation (`TSR037`) while filling a
10,000-element table, a provisional product limit (`RESOURCE-LIMITS.md`), not a defect.

**Root causes.** The 15 most frequent root diagnostics (count, packages), with their class from
[`COMPATIBILITY-GAPS.md`](COMPATIBILITY-GAPS.md):

| Code | Count | Packages | Main sources | Class |
| --- | ---: | ---: | --- | --- |
| `SX_DYNAMIC_OR_OBJECT_CALL` | 3,426 | 135 | see the method breakdown below | mixed: Java image, file, network, and process APIs (legacy baggage, about 1,700); list and text methods on receivers not proven to be lists or text (importer work, about 1,500); `String.format`, `Math.sqrt` |
| `SX_UNSUPPORTED_SEXSCRIPT_EXPRESSION` | 2,060 | 102 | the old online service (`send` 763, `receiveString` 398, `sendImage` 237, `receiveInteger` 166, `isConnected` 77, `receiveImage` 49), `getFile` 128, `useFile` 96, `getDataFolder`, `openCdTrays` | legacy baggage |
| `SX_JAVA_CONSTRUCTOR` | 538 | 103 | `new File` 295 (70 packages), `BufferedImage` 52, `ByteArrayOutputStream` 43, `Date` 20, `ArrayList` 14, `org.ini4j.Wini` 11 | legacy baggage; `Date` and `ArrayList` importer work |
| `SX_JAVA_OBJECT_CALL` | 367 | 58 | `new File(...).delete()` 191, `.exists()` 66, `.eachFile()` 20 | legacy baggage |
| `SX_UNSUPPORTED_OPERATOR` | 350 | 39 | `<<` on receivers not proven to be lists 226 (24 packages), `+=` inside an expression 40, bitwise `&` on pixels 34, `=~` 9 | importer work; pixels legacy |
| `SX_STRING_METHOD` | 309 | 33 | `replaceAll` with regular expressions 239, `tokenize` 58 | workaround (regular expressions); `tokenize` importer work |
| `SX_UNDEFINED_FUNCTION` | 177 | 13 | `teacherNScenarioN()` 144 in 3 packages, defined in no file of the package | legacy bug |
| `SX_UNSUPPORTED_LIST_METHOD` | 159 | 24 | `add(index, value)` 92 (2 packages), `collect()` copies, `pop`, `drop` | importer work |
| `SX_DYNAMIC_CHOICE_OPTIONS` | 117 | 20 | menus from spread or computed option lists (`list*.name`) | importer work |
| `SX_UNSUPPORTED_FOR` | 93 | 21 | `for (def c : cards)` with a typed loop variable 56, `for (;;)` 37 | importer work |
| `SX_CAPTURING_CLOSURE` | 86 | 8 | closures kept in data or capturing local state | importer work |
| `SX_UNSUPPORTED_EXPRESSION` | 76 | 13 | parser placeholders in `Escape` 37, ternaries in text, method pointers | importer work |
| `SX_LIST_DIFFERENCE` | 75 | 5 | `list - value` where the value is not proven to be one value or a list | importer work |
| `SX_UNSUPPORTED_STATEMENT` | 71 | 35 | `try`/`catch` 62 (30 packages) around file and network code, `throw`, `assert` | legacy baggage |
| `SX_SET_IMAGE_ARITY` | 58 | 30 | `setImage(bytes, 0)` showing an image composed in memory | legacy baggage |

By class (rule-based, approximate): legacy baggage about 4,770 root errors in 142 packages, importer work about 2,740 in
131, workarounds about 490 in 64, legacy bugs about 370 in 36.

`SX_DYNAMIC_OR_OBJECT_CALL` by method (count, packages): `get` 283/9 (mostly `org.ini4j` settings files), `add` 183/16,
`append` 173/10 (`File.append`), `read` 172/32 (`ImageIO.read`), `drawImage` 169/28, `contains` 164/34, `count` 155/9,
`execute` 127/4 (OS processes), `exists` 120/41, `write` 104/34, `format` 104/20 (`String.format`), `getWidth` and
`getHeight` 93/29 each, `toURL` 87/10, `getImage` 78/23 (`Toolkit`), `encode` 72/5 and `decode` 49/1 (`URLEncoder`),
`readLines` 68/8, `getProperty` 67/24, `join` 51/7, `sqrt` 44/13, `createGraphics` 36/17, `remove` 36/14, `indexOf`
32/5; 134 calls have no method name (dynamic receivers).

**Pending capabilities.** Scripts that only accepted-but-unimplemented forms keep from compiling, and all scripts using
each form: `goto` to a file 190 of 354, `global function` and `global` 118 of 299, `askBooleans()` 33 of 72,
`openUrl()` 15 of 61, `showPopup` 14 of 45, `goto script()` 1 of 24, `takePhoto()` 0 of 55 (every camera script has
other root errors).

**SexScript API usage** (packages using each method, of 289): `setInfos` 288, `show` 287, `setImage` 276, `showButton`
272, `wait` 260, `getBoolean` 206, `getRandom` 193, `loadString` 184, `loadBoolean` 181, `save` 180,
`getSelectedValue` 160, `loadInteger` and `playBackgroundSound` 137 each, `waitWithGauge` 121, `getString` 117,
`getInteger` 106, `playSound` 95, `getTime` 90, `useUrl` 60, `getImage` 40, `getBooleans` 39, `send` 37,
`receiveString`, `getFile`, `exit`, `getDataFolder`, and `isConnected` 35 each, `sendImage` 32, `receiveImage` 29,
`showPopup` 26, `useFile` and `loadFloat` 23 each, `loadFirstTrue` 22, `receiveInteger` 20, `load` and `openCdTrays` 16
each, `getFloat` 11, `loadMap` 6, `receiveBoolean`, `receive`, and `useEmailAddress` 5 each, `receiveMap` 1. The four
old packages never used `receiveString`, `receiveInteger`, `receiveBoolean`, `receiveImage`, `receiveMap`,
`sendImage`, or `getFile`.

**Constructs the four old packages never used** (packages, occurrences): prefix `++`/`--` 13/117 (now converted as
statements), `~` 2/5, `assert` 2/3, `synchronized` 1/3, `throw` 1/1; in-memory image composition (`BufferedImage`
34/70, `getWidth`/`getHeight` 36, `drawImage` 34/191, `ImageIO.read` 41/212, `Toolkit.getImage` 27/95, then
`setImage(bytes, 0)`); HTTP (`URL` 18/32, `openConnection` 14/23, request properties and streams 9–10 each),
`FileOutputStream`, `PrintWriter`, ZIP output, `org.ini4j` settings files 5/11, UDP sockets 1; Groovy conversions
`toInteger()` 34/358, `toFloat()` 9/33, `toDouble()` 4/6, `Integer.parseInt` 7/68 (now converted); text checks
`isInteger()` 8/36, `isNumber()` 6/6, `isFloat()` 3/17; `count(...)` 10/218, `toUpperCase()` 16/182, `replace` 12/55,
`toCharArray` 4/20, `charAt` 4/16; names with `$` (2 packages); list subtraction (about 214 sites in 17 packages, now
`difference()`).

**Smoke failures** (80 runs, 74 of them isolated runs of scripts no entry flow reached):

| Failure | Runs (packages) | Cause | Class |
| --- | ---: | --- | --- |
| `TSR027` arithmetic on null | 34 (7) | isolated runs calculate with settings an introduction saves (`load "domme.chores.todo" - ...`, `p += 1` after `p = load ...`) | legacy-equivalent: Groovy failed on null arithmetic too |
| `TSR027` on `itemKeys -= key` | 4 (3; 1 entry flow, `redgreen`) | `list -= value` on a function parameter of unknown type stays numeric | importer: parameter types are unknown |
| `TSR058` integer holds null | 24 (5) | isolated runs store a missing setting in a Groovy `int` | legacy-equivalent: Groovy's `int` rejected null |
| `TSR009` null comparison | 9 (5; 1 entry flow, `BreatheAcademy`) | `if (load "BreatheAcademy.MyTime") < 45` before anything saved it | semantic difference: Groovy ordered null below every value (documented) |
| `TSR058` integer takes a number | 2 (2) | `let t2 = 0` then `t2 = t2 + t1` with `t1 = t / 30` for a parameter `t`: the compiler cannot see the widening, because a value of unknown type decides nothing (V30 §13) | importer: Groovy division is always numeric, so the importer can write `t1: number` |
| `TSR044` loop over text | 2 (1) | `for (c in message)` iterated the characters of text | importer: `message.split("")` |
| `TSR052` empty `askText` default | 1 (1) | `getString(..., "${mistressName}")` with empty text | semantic difference: a TeaseScript default needs a non-whitespace character; the importer can leave out an empty default |
| `TSR052` `askInteger` default | 1 (1) | default from a missing setting, isolated run | legacy-equivalent |
| `TSR037` instruction budget | 1 (1, entry flow) | `keyGenerator` redraws a number until it is not a single digit; with the runner's 1-digit answer every draw is one, in Groovy too | smoke-input artifact |

None of these is a possible platform defect: each behaves as the specification says. Thirty scripts are lowered and
dependency-closed but still fail the compiler: null-start numbers read in functions (`TSV043`, `TSV039`; about 20
scripts, the class the null-start list decision covered for lists), reads of variables that are local to another
function or never declared (5, legacy bugs), a duplicated script body (`SMinder`, which Groovy refused to compile),
`whipped = true()` (legacy bug), and one generated dispatcher whose actions return text and booleans (`RileyReid`,
importer).

**Importer fixes from this corpus** (each with a text-only fixture): Groovy names with `$` keep their letters and
digits (`TSL001`, 248 compiler errors); consecutive and nested C-style loops reuse an earlier loop's counter (`TSV001`,
258); `x.toInteger()`, `toLong`, `toFloat`, `toDouble`, `Integer.parseInt`, `Double.parseDouble`, and their siblings
become `toInteger()` and `toNumber()`; prefix increments, `list[i]++`, `obj.field++`, and loops whose start is omitted
or a bare counter convert; a discarded storage read or computed text is dropped with a note; `list - value`,
`list - list`, and `list -= value` become `difference()` with a note; list element types now settle with variable
types, so a value read from a list has its element type; switch breaks in the cases a case falls through to are
removed; a shared helper stays in each file when a function it calls has variants, or when the scripts start a value it
reads with different types; a variable set from `loadFirstTrue` may hold null.
