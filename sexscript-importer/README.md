# SexScript importer POC

This directory is an isolated feasibility project for migrating legacy SexScript packages to ordinary TeaseScript
packages.

The intended architecture is:

```text
SexScript source
  -> Groovy parser used only at import time
  -> SexScript-aware semantic analysis
  -> migration IR
  -> ordinary .tease
  -> narrow .ts helpers only for portable advanced logic
  -> explicit diagnostics for unsafe or unsupported Groovy
```

The importer must not embed, reproduce, or require the SexScript runtime in generated packages. Legacy Groovy is an
input language only.

## Directory boundary

All importer-specific code, documentation, tests, and text fixtures live under `sexscript-importer/`. The POC does
not place importer planning or research in the main project's `docs/` or `tests/` trees.

Large legacy archives, Groovy JARs, media, and other binary fixtures are intentionally not committed. They may be used
locally as external test inputs. When a reproducible fixture is needed in Git, prefer the smallest text-only extracted
source that is legally and technically appropriate.

## Prerequisites

- Node.js as pinned by the repository.
- Java 17 or newer and the Groovy 2.5.21 `groovy` and `groovy-json` JARs (the version SexScript embeds). The parser
  helper uses `SEXSCRIPT_GROOVY_JAR` and `SEXSCRIPT_GROOVY_JSON_JAR`, defaulting to the Maven local-repository layout
  under `~/.m2/repository/org/codehaus/groovy/`. See [`parser-groovy/README.md`](parser-groovy/README.md).
- The repository build (`npm run build:typescript` in the repository root), which provides the real TeaseScript
  compiler and runtime under `dist/` for `--compile`, `--run`, and the compiler-checked fixtures, and the message-markup
  parser that measures a text's reading time for every conversion.

The parser output is cached per file content, parse mode, and parser version (the exporter source and the Groovy
JARs), so only a new or changed file starts a JVM. The cache lives in `~/.cache/sexscript-importer/groovy-ast/`
(`$XDG_CACHE_HOME` if set), shared by every checkout; `SEXSCRIPT_AST_CACHE=<dir>` moves it and
`SEXSCRIPT_AST_CACHE=off` disables it. Each JVM runs with a small serial heap, so four parallel parses stay light.

## Usage

```sh
node src/cli.ts convert [--accepted[=forms]] /path/to/script.groovy > script.tease
node src/cli.ts convert-package [--compile] [--accepted[=forms]] /path/to/legacy/scripts /path/to/output
node src/cli.ts report [--compile | --run] [--accepted[=forms]] /path/to/legacy/scripts > report.json
node src/cli.ts inventory /path/to/legacy/scripts > inventory.json
```

`convert-package` writes text `.tease` files only; it never copies legacy media, JARs, or archives. The converted
package keeps the legacy architecture (owner decision 2026-10-05): each `scripts/X.groovy` becomes `X.tease` and
`scripts/X/sub.groovy` becomes `X/sub.tease`, and functions copied between scripts stay in each file. The package starts
at a generated `main.tease` (ADR 0022) that asks the legacy profile and goes to the package's entry: the script of
`scripts/` that calls `setInfos` and that no other script chains to (or, without one there, such a script one folder
down); several entries get a menu labelled by their titles, and a legacy `main.groovy` is `main.tease` itself. The importer's generated helpers are `global function`s in `main.tease`. The methods of a package-local helper
class (such as `Domme3Class`) that other files call are `global function`s in the class's own file; a method that cannot
be global is copied into each script that calls it, so the result depends on neither Groovy nor the old runtime. Mixin
modules that one script loads at runtime are their own files with `global function`s, and what those use of the script
is global too; modules that several scripts load stay composed into each. With `--compile`, the generated files compile as
one project, so transfers and global functions resolve across files. `report` and `inventory`
accept `.groovy` files, directories, or parser JSON; inputs of one invocation form one package.

`report` compiles the package as one project (`compileProject`); a file is compiler-clean when the project reports no
error for it. `report --run` also smoke-runs the project in the real runtime, which follows the transfers between files
itself: from `main.tease`, then each runnable script no run reached in isolation, starting with the storage the run
from `main.tease` left (setup that only a script no run reached saves can still be missing). A file runs where the
project compiles it, also with unconverted statements kept as TODO comments; a file that does not compile becomes a
stub in the run's project, and a run that reaches it ends as `blocked`. Answers are deterministic: buttons are pressed, each visit of a choice takes the next
option, text and number inputs cycle through fixed values, forms are submitted with their starting values, `takePhoto()`
returns null as in a Player without a camera,
and time and media advance in simulation; the wall clock starts at 2026-10-02 12:00 UTC and follows that time. Accepted
forms selected with `--accepted` use host stand-ins with the same answer rotation. A run proves one path executes;
`stepLimit` is inconclusive (for example a loop that waits until the typed text matches), while `TSR037` means the work
between two events exceeds the product's instruction budget, which fails in the Player too.
With a single directory argument, the sibling `images/` folder holds the package's images.

Accepted TeaseScript that `main` does not implement yet becomes a workaround in implemented TeaseScript, marked with a
`// NOTE` at every site, so that converted packages play natively: `showPopup` the message and an OK button, `openUrl`
the link in the chat and a button, and an image composition its base image. Legacy `getBooleans` becomes native
`askBooleans message, texts:, prefill:`, with `cancel:` where the script tests the answers for null, as the legacy
dialog's Cancel gave null. `--accepted` (every form) or `--accepted=showPopup,openUrl,chooseFile,layeredScene`
emits the accepted forms instead, for when `main` implements them; the report then compiles and runs them through host
stand-ins.

A legacy count of the images in a package folder becomes a tag query (#572): when a package lists an images folder,
`convert-package` gives each of its images a generated XMP sidecar (`x.jpg.xmp`) with one tag for its full legacy
folder path, `images/Domme3/Pack 2/x.jpg` → `images-domme3-pack-2`, and the count becomes
`findImages(all: ["images-domme3-pack-2"]).length`, or the `sexscriptLegacyPathTag` helper's tag of a computed folder
(`SX_IMAGE_TAGS`). The report's gate and smoke runs give the compiler these tags. A count filtered by file name stays
counted at conversion time (`SX_IMAGE_COUNT_WORKAROUND`).

A package text file that no script of the package writes, such as quiz lines, Properties strings, or INI settings, is
part of the package as converted: a `File`, stream, or reader over it becomes its path text, and `readLines()`,
`Properties.load()`, and `Wini.get()` read a generated function that holds the file's text at conversion time, marked
with a `// NOTE`. A file some script writes, deletes, or hands to code the importer cannot follow stays manual work.

Java library calls convert where their receiver and arguments are proven and TeaseScript has the same behavior
(`src/java-time.ts`, `src/java-text.ts`): a Calendar or Date becomes a `datetime`, a Random object the session's random
numbers, a StringBuilder text, and URL encoding, Math functions, Groovy number checks, and similar operations generated
`sexscriptLegacy*` helpers. A remaining difference, such as the last digits of a Math helper, gets a `// NOTE`.

Generated files follow these conventions:

- legacy comments and paragraph breaks are kept; `setInfos()` metadata becomes the `---` file header (V30 §41), with
  the legacy fields that have no header field in a comment after it;
- `// TODO CODE line N: ...` marks the root cause of something that needs manual migration, followed by the original
  Groovy as `// | ...` lines; `// NOTE CODE line N: ...` marks a converted construct whose behavior differs;
- a file with unresolved errors starts with `// MIGRATION INCOMPLETE`.

Mapping decisions and their rationale are in [`docs/POC-SCOPE.md`](docs/POC-SCOPE.md) and
[`docs/LEGACY-SEXSCRIPT-ANALYSIS.md`](docs/LEGACY-SEXSCRIPT-ANALYSIS.md); TeaseScript feedback from the corpus is in
[`docs/COMPATIBILITY-GAPS.md`](docs/COMPATIBILITY-GAPS.md), and language changes proposed from it are tracked in
[`docs/PROPOSED-LANGUAGE-CHANGES.md`](docs/PROPOSED-LANGUAGE-CHANGES.md).

## Corpus catalog

A page that opens every converted package of a legacy corpus in the Player, with the status from playing it there:

```sh
node tools/convert-corpus.ts [--jobs N] [--only id,id] [--units-file file] [--report-only] [--patches dir] /path/to/corpus external/converted
# from the repository root, after npm run build: the converted and the verified packages, then the HTTPS front
HOST=127.0.0.1 PORT=4182 PLAYGROUND_PACKAGES=$PWD/sexscript-importer/external/converted node dist/playground/server.js
HOST=127.0.0.1 PORT=4183 PLAYGROUND_PACKAGES=$PWD/sexscript-importer/external/verified node dist/playground/server.js
node sexscript-importer/tools/serve-catalog.ts --catalog sexscript-importer/external/catalog \
  --upstream http://127.0.0.1:4182 --verified-root sexscript-importer/external/verified \
  --verified-upstream http://127.0.0.1:4183 --cert cert.pem --key key.pem --port 4443 [--http-port 4180] \
  [--pins sexscript-importer/external/catalog-pins.json]
# from sexscript-importer/:
node tools/play-check.ts [--base https://host:4443] [--runs N] [--steps N] [--only id,id] external/converted external/play-checks
node tools/verify-package.ts --checks external/play-checks --verified external/verified --manual "<note>" external/converted <id>
node tools/catalog.ts [--player https://host:port] [--build <repository>] --play-checks external/play-checks \
  [--explorer <dir>]... --verified external/verified [--approved docs/APPROVED.md] external/converted external/catalog/index.html
```

`convert-corpus` takes one corpus folder per package, each with `scripts/`, `images/`, and `sounds/`. It runs
`convert-package` on each folder whose `scripts/` holds Groovy, then `report --run --package`, whose JSON it keeps as
`.report.json`; its `finalPackage` reads the package as the Player does (the playground server's package scan, with
the images and their tags), compiles the `.tease` files as written, and runs them natively from `main.tease`. Legacy scripts name media relative to `images/` and `sounds/`, and package paths start at the package
root, so both trees are hard-linked into the package root, and a `videos/` folder keeps its name. Media stay as they
are (copies where the output is on another mount than the corpus, since hard links fail there); only MIDI files become MP3s and videos in formats
browsers do not play become MP4s (H.264), both rendered with ffmpeg. A resource pack (a folder without scripts) is linked into each script package whose source names
one of its top media folders, narrowed to the packages that name its subfolder when any do. Each package folder records
the conversion in `.conversion.json` (the converter commit, the SHA-256 of each legacy script, the patches applied,
and the unit's status) and `.conversion.log`; `.conversion-summary.json` in the root records the importer commit and
the date. A merged unit's `unit.json`, beside its `scripts/`, gives its status, such as `unfinished-content-stub`, and
its `internalScripts`: scripts of expansions, story chapters, resource scripts, or hub games that are no entries of
their own, which `convert-package` and `report` leave out of a generated entry menu. A menu with one script left
starts there directly.

Each unit is converted in `<converted-root>/.staging/<unit>/` and replaces its published folder only when every step
succeeded. When a patch does not apply, or the converter, the report, or the driver fails, the previous output stays,
the driver exits with status 1, and `.failures/<unit>.json` records the step and the message until a later conversion
succeeds. TODOs, compiler errors, and smoke-run outcomes are results, not failures. A replacement interrupted between
its two moves leaves the previous output in the staging folder, and the next run restores it.

### Core test set

`core-units.txt` lists the core units: the owner's favourites, and the units that a greedy set cover added because
each exercises something no other core unit does (a converter rule's SX_ code, a report counter, an engine name or token
kind in the generated code, a compile or smoke-run status or failure code). A comment beside each unit says what it
adds. The core set is for routine checks after a converter change; convert all 210 units after large changes, before
a checkpoint push, and periodically:

```sh
# from sexscript-importer/: the core units into a scratch root, then compare their reports with the published ones
node tools/convert-corpus.ts --jobs 2 --units-file core-units.txt external/corpus2-selected external/core-check
# reports only, of units already converted
node tools/convert-corpus.ts --jobs 2 --report-only --units-file core-units.txt external/corpus2-selected external/core-check
# what each core unit alone adds, what no core unit exercises, and the next 5 units a greedy cover would add
node tools/core-units.ts --suggest 5 external/converted-merged
```

`--units-file` takes one unit per line, with `#` comments, and combines with `--only`; a unit the corpus does not
have stops the run. `core-units.ts` reads `core-units.txt` unless `--units-file` names another list. Rerun `core-units.ts` after adding a converter rule: a new SX_ code or counter that no core unit
exercises shows up under the features no listed unit has.

### Manual unit patches

Script-specific fixes stay out of the converter (owner decision 2026-10-05). They live in `patches/<unit>/` with a
`patches.json`, and every conversion of the unit applies them again, so reconversion never overwrites them:

```json
{
  "patches": [
    {
      "id": "greeting",
      "layer": "source",
      "category": "b",
      "reason": "…",
      "diff": "greeting.diff"
    },
    {
      "id": "farewell",
      "layer": "output",
      "category": "e",
      "reason": "…",
      "file": "main.tease",
      "baseHash": "<SHA-256 of main.tease as generated>",
      "edits": [{ "find": "say \"Bye\"\nexit", "replace": "say \"Goodbye\"\nexit", "count": 1 }]
    }
  ]
}
```

- Source patches are the default layer: a unified diff of legacy files with paths from the unit folder, applied with
  `patch -p1 --fuzz=0` to a staged copy before conversion, so the report and the package both come from the patched
  sources. Edit a copy, never the corpus file, and keep its line endings, which `patch` matches exactly. `patch` reads
  a path with spaces only when a tab and a timestamp follow it in the `---`/`+++` header, so give such a label one:
  `--label $'a/scripts/My file.groovy\t2026-10-05 00:00:00'`.

  ```sh
  cd external/corpus2-merged/<unit>
  cp scripts/start.groovy /tmp/agent-work/fix/start.groovy   # then edit the copy
  diff -u --label a/scripts/start.groovy --label b/scripts/start.groovy scripts/start.groovy \
    /tmp/agent-work/fix/start.groovy > ../../../patches/<unit>/greeting.diff
  ```

- Output edits are for additions that have no legacy form. Each names the SHA-256 of its file as the converter
  generated it from the patched sources (`sha256sum` of the file after a conversion without the output patch) and how
  often each `find` occurs; edits apply in order before the media are linked, so they reach only generated files. A changed or missing file, or another
  count, fails the unit for review. An anchor needs code: generated `// NOTE` and `// TODO` lines move as the converter
  changes. A patch that removes a TODO needs its diagnostic actually resolved.
- Every patch needs an `id` and a `reason`; `category` is free text, such as the inspection category.
- `"keepParagraphs": { "reason": "…" }` beside `"patches"` keeps each text with blank lines as one message for the
  whole unit, where its blank lines are layout, such as ASCII art, tables, or stat blocks, that the converter does not
  recognize as such (see COMPATIBILITY-GAPS.md). Conversion then passes `--keep-paragraphs` to `convert-package`.

The Player needs a secure context (HTTPS or localhost) on another machine, and the playground server serves its own
page at `/`. `serve-catalog` therefore puts the catalog page and the Player on one HTTPS origin. It serves `/` and
`/source/` itself, with the sources as UTF-8 plain text, and forwards the other GET requests to the playground server
on loopback, or, for a package with a verified copy, to the one that offers the verified copies; the package id
`latest~<id>` reaches the latest conversion of such a package. With `--pins`, `/pins.json` keeps the page's pins in
that file (GET, and PUT of a JSON array of package ids), so they outlive regenerations of the page, restarts, other
origins, and browser storage. A self-signed certificate works once its browser warning is accepted.

`play-check` plays each package in the real Player with Playwright (`PLAYWRIGHT_CORE` names the `playwright-core`
folder), one browser at a time. A run presses buttons, picks choices, and types answers until the session halts,
fails, hangs, or uses up its steps. It opens `/player/?dev&package=<id>&time=skip`, whose development time controls
skip waits, timers, pacing, and audio while no input is pending; `--clock fake` falls back to Playwright's fake clock.
When the same prompt comes back three times in a row, the script may time its answer, so the runner lets 30, then 120,
then 300 seconds pass before answering (+10 s and +1 min presses), noted as `[waited 30 s]` in the run's path. A text
prompt that quotes a sentence gets that sentence. Each run prefers the choices that earlier runs tried least, and a
package stops after a run that reaches nothing new. The session state is read from the Player's Vue tree, because the
Player shows no runtime failure. The result in `<out>/<id>/result.json` records each run's stop, the path of answers,
the files and interactions reached, missing media, legacy HTML shown as text, and a screenshot of each stop, for the
package's current `.tease` files.

`verify-package` freezes a package whose check plays to the end without missing media, after a manual check, into
`external/verified/<id>/` and adds a row to [`docs/VERIFIED.md`](docs/VERIFIED.md). It never replaces a verified copy.

`catalog` writes one HTML page and reads each package as the Player does: the playground server's package scan, then
`compileProject` with the package images, from this repository's build or, with `--build`, from that of another
checkout, such as the one the served Player was built in. Under the time it was written, in the reader's time zone, a few counts:
the packages listed, that convert fully, compile, and play to the end, then the other counts that are not zero, each
explained in its tooltip. A filter under each of the title, author, keywords, and description columns narrows the
rows on that column, the filters combined; a coverage range and a sort order (coverage, crashes, traps) use the
explorer column. Each table row shows the `---` header of
`main.tease`, or of the first script that a generated `main.tease` menu goes to: title (the Player link), author,
keywords, and description. A package with a verified copy has two Player links instead, `Play (verified copy)` and
`Play (latest conversion)`, and source links to both. The status column takes, in
this order, the owner-approved list (the first column of the Markdown table in `--approved`), the verified copy, the
Player check of the current files, or else the compiler and the report's smoke run. A `partly converted` mark counts
unconverted code, and a grey `older conversion` mark shows the latest Player check of files the importer has converted
again since, which the summary counts apart; click a status for details. The explorer column shows the latest [`explore`](#branch-explorer)
report of the current files from the `--explorer` folders (`<unit>.json` or `<unit>/<unit>.json`), for a verified
copy else of the unit's latest conversion, marked so, else the latest report of other files, marked stale: line coverage and the numbers of crashes and traps, with the first crash's code
and `file:line`, the first trap, and the search in its details. A report's compact `catalog` block (`coveragePercent`,
`crashes`, `traps`, `firstCrash`, `firstTrap`, and `reach`, the lines per reach label) counts before its full fields. The source column links the legacy Groovy and converted `.tease` files,
which `catalog` hard-links under `source/` next to the page; earlier versions that the unit's `unit.json` lists under
`earlierVersions` appear in a collapsed section with links to their original Groovy. A Pin button keeps favourites and lists them at the
top: on the server with `serve-catalog --pins`, else in `localStorage`; the server starts from the first browser's
`localStorage` pins.

## Branch explorer

```sh
# from sexscript-importer/, after npm run build:typescript in the repository root:
node tools/explore.ts [--budget-seconds 60] [--budget-ops N] [--max-states 20000] [--store-mb N] [--seed 1] [--workers 1|2] \
  [--until-stalled] [--corpus <corpus-dir> [--rounds N]] [--[no-]cells] [--[no-]later] [--[no-]compared-answers] \
  [--[no-]realign] [--[no-]progress-leads] [--[no-]conjunctive] [--[no-]guidance] [--[no-]random-choices] \
  [--[no-]quit-anywhere] <unit-dir>... --out <dir>
node tools/explore.ts --replay <dir>/<unit>.json (--crash N | --trap N | --way N | --error)
```

`explore` plays each package headlessly in the real runtime, without the Player, through every branch it can reach
within the budget, and replaces playing converted packages by hand to find crashes. `src/explorer.ts` runs the inputs,
`src/explorer-search.ts` searches, and `src/explorer-analysis.ts` reads the plan for directed search. Each pending
action is a branch point. The options are every button and choice option; for a form, its starting values, each toggle
switched (and all on, all off), each other option of a cycle, each typed field at its bounds, and cancel where the
form offers it; and the default answer of a typed ask with boundary values of its type: `0`, `1`, `-1`, `1000000` (and
`0.5` for `askNumber`), the text `x`, and dates and times at both ends of a day or year. Each constant that the code
compares with near the ask adds a candidate, or `c - 1`, `c`, and `c + 1` for a number. With compared answers (on by
default, off with `--no-compared-answers`), a text or number ask is also answered with the values, in the state at the ask, of what the code compares its answer
with (a variable, or a property, index, or sum of variables, found through the data flow), such as the line a script
asks the player to type: three at most, and `v - 1`, `v`, and `v + 1` for a number `v`; and directed search (below)
also answers asks whose prompt the code computes (`askText "Type: ${line}"`), which it otherwise leaves out. A button whose result the
script keeps (`(showButton …) / 1 s`, `beg < 15 s`) can also be pressed after the player thinks for just over each
compared number of seconds or duration (60 s without one), or of the value in the state that the time is compared with
(`(showButton …) / 1 s > count`). So can any button between two clock reads whose difference a condition compares
with a constant (`took = getTimestamp().toSeconds() - start` after it, then `took < 5`), just past that constant. Waiting for the next deadline (a timer, a timeout, or the end of awaited media), and
each shown permanent button, are options too. Media loads succeed with one second per pass, `takePhoto` finds no
camera, `askImage` gets one stored image, pacing is instant, and the clock starts at 2026-10-02 12:00 UTC. The first
session starts with empty storage. A later session starts from the storage an explored state left, as the player's
next session would after playing to that point: a few from completed sessions, and chains toward stored values that
conditions need (below). The explorer never makes up a stored value.

With `--until-stalled`, a run has no work budget: it goes on while it makes progress and stops on its own, with a
time cap (two hours unless `--budget-seconds` is given) and no state limit unless `--max-states` is given. Progress is
a step that runs new code, takes a condition way no step took, or comes closer to a comparison a way play has not taken needs (a
variable's closest state, or a stored value's session chain, below). The run stops when it made no progress for a
window of operations: 20,000 plus 20 per coverable line, or three times the longest stretch without progress that
progress still ended, whichever is more, so a small script finishes soon and a run that found something after a long
stretch keeps looking as long again. New cells (below) are counted but do not hold a run up: cells of counters keep
coming long after anything else does. Directed search looks again every quarter window, and the window starts after
a corpus replay. `search.audit` says how the run ended: `complete` (nothing left to try, and no line or missed way of
unknown reach), `stalled` (no progress for the window, or nothing left to try with code of unknown reach), `spiral` (a stall in which one place took at least half of the
expansions since the last progress: the place and its prompt, a problem of the explorer), or `capped` (a cap came
first); with the window at the end, the last progress, the longest stretch without progress, and the progress by
kind. The summary has a line for it, and the missed ways the run was working toward (below) say what it would need.

States are deduplicated by a hash of the snapshot that leaves out what no script can observe: event sequence numbers,
the next free IDs, and the last settlement record. The runtime's own IDs (actions, scopes, call frames, timers, media,
buttons) are renumbered by rank, because only their equality and order matter. The clock and the random state stay
in. The search first expands directed states (below), then states whose step reached new instructions in any
session, then, earlier sessions first, states that look new apart from clock, random state, and settled handles (their
loop key), and then the repeats, least repeated first; play goes before clock states (below), and the newest state
first. The search ranks states by cells (`--no-cells` switches this off). A cell is where a state waits (its pending action, the return
points of its calls, and the pass of each `for` and `repeat` loop, except for a state that, after a hundred waits in a
row, still has nothing to do but wait: its passes are time going by, not places the player chooses) with the bucket of
each value that conditions compare
with constants: each variable and stored key (also through the data flow, each key a key template matches apart) a
comparison reads, or its length, bucketed as unset, `null`, `true` or `false`, a compared text or other text, or a
number's or duration's place among its compared constants (below, at, between, or above them). A step that shows such
a value, or a change of one, for the first time counts as reaching new instructions, and among the other states those
of the cells expanded least go first, before the loop key, and of those the states last queued when their cell was
expanded least, the ones that waited longest. A cell groups states coarsely: a condition that computes
with a value (`n + 1 == 3`) can still tell states of one cell apart. A loop that keeps making states no condition
tells apart, such as a counter no condition reads, so no longer takes most of the search; the report's `search.cells`
counts the slots, cells, values, and changes found. Waiting states keep their tagged snapshots (below): the JSON's
exact bytes packed with zstd level 1, after the first eight with a dictionary made of those, and the tag (up to an
eighth of the memory, from 256 MiB to 4 GiB, or `--store-mb N`; a state whose snapshot was dropped is replayed from an
ancestor; `search.store` has the limit, the peak, and the drops). The search stops
when every state is expanded and directed search has nothing left to try, or at the time, work, or state budget.
`--budget-ops N` is a work budget of N runtime operations per unit (fresh sessions, runs, inputs, and automatic
answers, the corpus replay's included), checked before each step: a step that started finishes, so a run can go over N
by the operations of its last step. With it the time budget applies only when `--budget-seconds` is given, and directed
search looks again every tenth of the work budget instead of every tenth of the time; without an explicit time budget,
a run's length and result then do not depend on the machine's load.

Directed search looks at each condition that a step reached but left only one way. A flow-insensitive data flow over
the plan's names finds what the condition reads: an ask's answer (also through helper functions and stored answers), a
stored value (also by a key template such as `"script${i}.time"`; one whose computed parts are constants at the
condition, such as the argument of `has(KNIFE)` for a helper `has(name)` that loads `"toys.${name}"`, also in a helper
it passes `name` to, is the one key it names), the clock, or a variable the code assigns. Its
comparisons with constants give the values that take the missed way. An ask is answered again with them on the path of
the step that first evaluated the condition, and the rest of that path is replayed; the values also become answers of
that ask wherever the search meets it. For a stored value, sessions are chained: when an explored state left storage
that satisfies the condition, a session starts from it and replays that path; otherwise a session starts from the
storage closest to it and replays a route: the inputs of a session seen to bring the value closer from storage that
already had it (up to 1,000 inputs; sessions with the same inputs are one route). The goal is the way with the least
work in all, the sessions it takes times their work, so the route repeated is the one with the most progress per
runtime operation over whole sessions, their starts included: as the session it comes from did, then as its replays
measure it. A long session that moves the value by five can beat a short one that moves it by one. Every eighth session
replays another of the routes kept (eight at most) instead, each in turn in the order they were found, as effects
depend on the state and a route that was worse can become better. Each session is real play from the storage the one
before it left, and the next starts at once while sessions get closer (100 sessions at most). After one that does not,
the routes not replayed since the last closer value are tried, the best first; a route that twice in a row brings the
value no closer is dropped. The chain then waits until play leaves a closer storage. A session from storage without
the value is no route, as repeating it cannot bring the value further. When no explored session gets there, the way
stays `unknown` with the reason, such as `needs score > 100; best reached: score = 37 after 37 sessions`. The report
gives each chain that started sessions with its way (`chains`): its sessions, the closest value, its result (`reached`,
storage that `holds` the value without the way reached, `queued` at the run's end, the session `limit`, or `stopped`),
the route it repeats, the routes it replayed (for each its first inputs and end, its inputs, its replays and those that
came no closer, and its progress per 1,000 operations), and its last switches between routes, with why;
`summary.md` lists the chains with the most sessions. For the clock, without forward time
(below), the player continues at other wall clock times (times of day, weekdays, later dates) before that step, as a
real player's time varies; a step after that is a clock step. An answer attempt's states share the first place for 20
expansions in all, until the condition takes the missed way (a session chain goes on from the storage it reached
instead), and play states that bring a variable the code counts or sets closer to the comparison share it for 40 (a
comparison of two values, such as `reps >= target`, measures the difference of a variable the code counts from the
other side, a variable or a stored value with a literal key, against 0; with progress leads, on by default and off
with `--no-progress-leads`, an expansion in that first place that brings a state closer again does not count, so a
loop that needs many rounds is followed to the constant, while one that gets no closer uses its 40 up); clock states
take only their attempt's own steps and otherwise come after all play states.
With conjunctive steering (on by default, off with `--no-conjunctive`), a way that needs all parts of its condition
(`a >= 5 and b <= 6` true, an `or` false) is steered by the condition's branch distance instead of each part's
closeness: a state is closer when fewer of the parts it can read are unsatisfied, or as many but nearer in sum (an `or`
the way needs either part of takes the nearer part), and a session chain toward a stored value of the condition also
counts how far its parts on other keys are.
With `--guidance`, a static map of the plan steers too: its control flow (conditions, calls and returns, file
transfers, the blocks a timer, cue, or button sets up; constant conditions cut; a session's end leading to the next
session's start) gives each instruction the number of decisions (conditions and prompts, a next session as three) to
the largest region of code play has not reached yet (of at least ten instructions), measured again at each analysis.
A step that brings a state nearer to that region shares a lead toward it, as closeness to a comparison does, for 40
expansions; once the region is reached or its lead spent, the next largest region not tried yet is. It is off by
default: on the units measured it gained nothing. Directed work (attempts and expansions in the first place) takes at
most a third of all runtime operations (fresh sessions, runs, inputs, and automatic answers), a deterministic measure
of what steps cost. Without depth phases, starting next visits takes at most another third, apart from it, from the
storage of the first ten completed sessions, and a session number goes before the next one in the search order.

Effect ranking (`--effect-ranking`, opt-in, with cells) ranks a play state's cell by the runtime operations its
expansions took per productive one (a step that reached new code, a cell, slot value or change not seen before, or came
closer to a comparison a missed way needs) instead of by how many expansions it had: a cell whose expansions cost much
and find little waits, a cheap one or one that keeps finding something comes back sooner, and a new cell still comes
first. On a focused gate (3 seeds, gate budgets; jewell 6) against the explorer without it, it gained BreatheAcademy
69.5% → 73.5%, Toy 80.0% → 81.6%, Domme3 50.1% → 50.4% and jewell 47.0% → 47.4%, and lost DisciplineClinic 20.8% →
20.3% and ToyExpanded 40.8% → 40.2%. It is opt-in because a loop the player cannot leave is unproductive by nature and
its states wait longer, so traps are found less often: jewell's `cumEdging.tease:32` in 0 of 6 seeds instead of 2
(`trainEnema.tease:65` in 2 of 6 either way). Content behind a long automatic chain (Domme3's 300 strokes) stays
unreached either way.

Depth phases (`--depth-phases`, opt-in) let the search decide how play work goes to session numbers, the depth of a
session from a new player's first. Each depth's work (its play and directed work, and the next sessions it starts) and
gain (the lines and condition ways any of its steps reach first) are measured as the run goes. The first session goes
first. The next depth opens when the deepest open one levels off, its gain per operation in the last quarter of its own
work and in the quarter before both at most half its average, or has nothing left; only a depth that reached something
new opens another, and only when a session of it left storage to start from (a completed one's; with
`--quit-anywhere`, any). States whose step reached new code go first in any open depth, as without phases. Apart from
those, a newly opened depth first gets an eighth of the play work of the depth before it; then the open depth with the
most gain per operation in the last quarter of its work gets play, and an eighth of play goes to the other open depths
in turn, the one explored least first, so that an earlier depth gets work back when it gains again. A depth starts a
next session when none of its open states reached new code, from storage a session of the depth before left: the one
with the most compared values (each compared key's value bucket, as cells read them) no session of that depth started
from yet, and while the depth has open states only one that adds such a value. Directed work and random outcomes keep
their shares. The report gives, per session number, when it opened and its play work, gain, and next sessions
(`search.phases`).

They are opt-in because they cost units whose first session still gains at gate budgets. On the 13-unit gate (3 seeds,
gate budgets), the first version gained where a first session levels off early (DisciplineClinic +4.5 points,
BreatheAcademy +3.2), but its second session opened on an early lull in the first: jewell lost its trap loops and 2.3
points, and Domme3 and ToyExpanded 0.8. Two tuning rounds followed, on a focused gate of those four units (3 seeds;
jewell 6), measured against the explorer without phases (DisciplineClinic 20.8%, Domme3 50.1%, ToyExpanded 40.8%, jewell
47.0% with a trap loop found in 5 of 6 seeds):

- Levelling off over two quarter-windows instead of one, and an eighth of the work for a newly opened depth instead of
  a quarter: DisciplineClinic 23.6% (one seed lost the gain, as its second session opened late), Domme3 50.1%,
  ToyExpanded 40.0%, jewell 46.0% with a trap loop in 2 of 6 seeds. The second session's play now gained well in jewell,
  but its first session lost more, also through directed search, which the rates did not count.
- Rates from all of a depth's work and gain, directed search included, as described above: DisciplineClinic 25.2%,
  Domme3 50.1%, ToyExpanded 39.4%, jewell 46.5% with a trap loop in 2 of 6 seeds.

The second round keeps DisciplineClinic's gain and Domme3's coverage, but jewell still finds its trap loops less often,
so phases stay opt-in.

With random choices (on by default; `--no-random-choices` switches them off), random outcomes are choices too
(`docs/RUNTIME.md#controlled-randomness`): sessions let the explorer decide the draws that pick what happens (`chance`,
random integers, picks from a collection, weighted picks, tag queries, and glob file transfers), which run naturally
unless it chooses. A step also offers the other outcomes of
the first four draws it made (`randomDrawAlternatives`: all of a small support, 16 representative ones of a large one;
at most three per draw, each outcome of a draw site once per waiting place and input) as steps with the same input and
that outcome chosen, also after directed steps. Those steps and the expansions of the states after them take at most a
sixteenth of all runtime operations while other states are open, checked before each input (a state cut short goes on
later with the inputs it has not tried), and all of them when none is; they can cost much more than other steps. Such
states are apart from play's, also where the runtime state is the same, with their own loop keys and cell expansions,
so that they do not move play states back; they give no leads, time steps, directed attempts, or storage for next
visits, and a way only they reached stays a goal of directed search. A path records only the outcomes it
chose, one per draw, as the `random` list of the input during which they were drawn (draw ID, site, and outcome), so
repros, the corpus, and `--replay` choose them again; a replay or corpus path with chosen outcomes plays them also
without the flag, and an input whose outcomes are not all drawn and taken does not fit. Play with a chosen outcome is
play, labelled `chosen` ("play (chosen random)"): it counts toward coverage, and the reach counts, the directed ways,
and the crashes show it apart, as does a line per unit in `summary.md` with the lines, ways, and crashes only it
reached: what a player hits only with a particular run of luck.

With forward time (on by default; `--no-later` switches it off), time only goes forward and is play, as for a player
who comes back later. The explorer reads each comparison in a condition that reads the clock (`hour >= 18`,
`getTimestamp().toSeconds() - lastVisit > day`), also through variables computed from the clock in one way, helpers
that return one part of the date or time (exactly when they only return it; a helper that adjusts it is an
approximation), and functions that only compute a value (they bind, assign, branch, load, call such functions, and
return; at most 500 instructions and four calls deep), with no function singled out by name, and evaluates it in a state
at a later wall
clock, with the state's variables and stored values; a variable set once that the state has no value for yet, such as
at the start of a session, from the value it is set to (a load with a key from a variable set once to a text too). A
state that waits where such a condition was read next gets time steps: `later` inputs to just past the first moment, within 400 days, at which one of those comparisons comes out
the other way, as far as the explorer finds it: at the second, minute, hour, or day boundaries where a compared part
of the date or time changes, where compared elapsed times meet (also two arguments of a function whose result is
compared, as `compare(a, b) <= 0` changes where `a` and `b` meet), or else by sampling at doublings of a minute and
halving (the next 18:01, the next weekday, saved time plus a day and a minute, inside or past a window). Each is tried
once per cell and outcome; where the condition was first read, the state the step left, or the session start, gets
them too. Their outcomes at a state's wall clock are part of its cell, so a new outcome or change of one counts as
reaching something new. A later session starts a minute after the wall clock where the state it continues stands,
and also in the windows of every clock comparison sessions have read so far, as its first state would compute them
(a return window such as back too soon and too late, from a stored time of the last visit): just past and just before
each moment one changes, and midway between two, each once per outcome of them all, at most eight from a storage, and
again from the same storage when sessions read more comparisons later; a session chain keeps the gap of the session
it continues. A condition that compares how long the player took between two clock reads (a reaction time held in a
variable, against a constant or another value) gets no forward time: think times at the button between the reads
reach it, and coming back later changes nothing. For a clock condition the explorer cannot read in full, or reads
only through an approximate helper, it also tries a fixed ladder: continuing an hour, an evening, a night, a morning,
a day, two or three days, a week, 40 days, or 400 days later just before the step that read it, or starting that
session that much later. All these steps are play, and a path records them: its `later` inputs and each session's
start clock. A gap must be positive. Only a session that does not start after the clock where the state it continues
stands, such as one of an old corpus entry, is a clock start. The report's `search.time` counts the conditions that
read the clock, the places they were read after, and the time steps taken by states and sessions.
With `--quit-anywhere`, a player can quit at any moment, and what the session saved so far stays: next visits also
start from the storage of explored states a session did not complete, at most 20, within the next visits' share and
once per storage, one per analysis pass. The first is the one with the most stored cells no next visit started from
had: the values of the keys the script reads (those conditions compare, those loads read, and those a call gives a
function that loads its parameter), and their changes in its session; such visits get the windows of the comparisons
read so far once. They are play; a path records the earlier session up to its last input, and `--replay` says where the
player quit. The report counts them as `search.quitVisits`. It is off by default: it reaches return flows that only a
saved but uncompleted session leads to, at the cost of first-session depth on the units measured.

Coverage counts executed plan instructions and maps them to the lines they start on, as the runtime's instruction
trace reports them (`docs/RUNTIME.md#instruction-trace`): each step's executions are one `run` with
`instructionTrace: true`, and the condition ways come from the trace's branch edges. A path runs in one runtime
session (`docs/RUNTIME.md#runtime-sessions`), which keeps its state between operations: the explorer exports the state
once per step as a tagged snapshot (`exportTaggedSnapshot`: its JSON and a tag that proves this process's engine wrote
it for this plan), reads the JSON for its hash and keeps both in the snapshot store, restores a stored state once to
expand it, which the runtime does without checking it again while the tag holds and checks otherwise (a snapshot it
refuses is counted under `search.engineErrors`), and tries each input on its own copy: a fork of it for all inputs but
the last, which goes on in the restored session. `TEASESCRIPT_DIST` names another repository build with runtime sessions to load the compiler and runtime
from, for comparisons. Each line has
a label: `play` when a play step executed it, in any session; `chosen` when only play with chosen random outcomes did;
`clock` when only steps after the wall clock was set did;
`unreachable` when no execution can reach it from the session start, by an over-approximation of the plan's control
flow in which a constant condition takes only its one way; and `unknown` otherwise. A condition is constant when it is a
literal, when the compiler proves it always true or false (`TSV046`), or when it reads only stored keys whose values
this package fixes: a key no `save` of the package writes is never stored (such as legacy profile keys that other
scripts wrote), and a key that every save writes as a literal holds one of those literals or nothing. Each
unreachable range and branch states its reason. When an instruction that ran is found unreachable, the analysis missed a way and
no line is labelled `unreachable` (`staticContradictions`).

The report `<out>/<unit>.json` has these parts:

- for a unit that compiles, a `catalog` block for the importer catalog's Explorer column: `coveragePercent` by play,
  the counts of `crashes` and `traps`, `firstCrash` (`code`, `path`, `line`, `message`, and `chosen` when only play
  with chosen random outcomes reached it) and `firstTrap` (`location`) or `null`, and `reach`, the coverable lines by
  label (`play`, `chosen` with random choices, `clock`, `unreachable`, `unknown`);
- per file: the lines that hold instructions, the ones play visited, the percentage, and the other line ranges with
  their label;
- each condition and loop that play reached but left only one way, with its source, the missed way, its first line,
  what it depends on (`dependsOn`: variables, stored keys, asks, the clock), the directed attempts, its label, and the
  reason, when known; `behindLines`, the coverable lines no state ran that the missed way leads to through code no state
  ran (a call goes into its function and on after it; a return, an end, or a transfer to a computed destination stops
  the count); `parts`, one per comparison and value source the way needs (also from the earlier conditions of its
  `else if` chain, which must not hold): `met` when some explored state or stored value satisfied it (not necessarily
  together with the other parts), `unmet` with the closest one, or `unmeasured`; `best`, what keeps the way closed as
  far as measured: of the condition's own unmet parts, the furthest from holding when the way needs all of them, the
  nearest when any one would do, and none when they combine both ways; and `case` for a `switch` case, whose condition
  text is its pattern. A variable is read in the innermost running call of the condition's function, over the
  top-level variables of its file, as a value of the compared constant's type; for two values, `needs` shows their
  difference (`reps - target >= 0`), read there when both sides are numbers, or both booleans; its closest state
  counts from when the condition became a target, with its value (for two values, the difference), its session, the
  operations done when a state first came that close, and `trend` (`improving` when a state beat the first one watched
  and did so in the last quarter of the run's operations, else `flat`). For a stored value, it is the closest storage
  a state left;
- `directed`: the condition ways directed search aimed at and reached, by label, by what they depend on, how (a
  directed attempt or the search), and in how many sessions, each with its shortest path, which `--way` replays;
- one crash per runtime failure code and source span, with the shortest path found from the start (a play one when
  there is), and whether that path set the clock or chose a random outcome;
- the traps;
- the end states: `completed` (exit), `failed`, `stuck`, and `open` when the budget ran out;
- in `search`, what stopped it (`exhausted`, `budget` for time, `operations` for work, or `maxStates`), the runtime
  operations, the elapsed and CPU time, and `expansionsByPrompt`: the five places where the most expanded states
  waited (the `path:line` of their pending action, with its prompt), their share of all expansions, how many of those
  were `productive` (a step from them reached new instructions, a cell or slot value or change of value not seen
  before, or a state closer to a directed comparison), and their `kind`: a `spiral` when fewer than half were
  productive, such as a loop that changes nothing any condition reads, worth checking before raising the budget; else
  a `hub` when steps by two or more inputs were productive, such as a menu many paths pass; else a `progressing loop`,
  one input taken again and again with something new each time, such as a counter that moves toward a compared
  constant.

A path has the inputs of each session: the earlier sessions (`earlier`), each from the storage the one before it left,
and the last one, with its start clock when that is not the play one. `summary.md` has one table row per unit, and
per unit the missed ways with the most lines behind them: what each needs, and why play did not get there (the closest
state to the comparison it needs, still improving or not, the reason directed search knows, or what it depends on).
Per session number, the depth of a session from a new player's first (`search.bySession`), the report gives what that
depth added: its sessions started and completed, the runtime operations its sessions ran (each operation goes to the
session whose runtime ran it, replays of evicted states included), the lines it reached first and how many of them in
the last quarter of those operations (its marginal gain), the condition ways it took first, and its states or stored
values that came closer to what a missed way needs. `coverage.bySession` gives the lines only a first session ran, such
as an intro, and the lines no first session ran, by the smallest session number that ran them and per file; these are
observed, so a line first run in a later session may still be reachable in a first one. `summary.md` shows both.
`--replay` plays the path of a crash, trap, or reached way again with the run's seed, prints the transcript of its last
session, and for a crash exits 0 only when the same failure returns. A
runtime operation that throws, such as one whose event sequence runs out (`TSR101`), or a stored state the runtime
refuses to restore, is no crash of the package: it ends that runtime session, the search goes on from the state before
the input, and the report counts these under `search.engineErrors` with the path of the first, which `--error` replays
(a refused state by restoring the state the path reaches).

A trap is a loop the player cannot leave by the inputs tried. Explored states are grouped by loop key. A group
escapes when one of its states ended (completed or failed), or when none of its states was fully expanded, so its
future is unknown. A group that leads to an escaping group escapes too. Each strongly connected part of the
remaining groups that no explored input leaves is one trap. A state where the player can do nothing and nothing
happens is a `stuck` trap. A loop that waits for a word or number the candidates miss, or for a clock time, is also
reported as a trap.

With `--corpus`, a run starts where earlier runs ended. `<corpus-dir>/<unit>.json` holds input lists only: each entry
is a seed and a path from the start, with its earlier sessions. The run first replays the entries of its seed through
the search's own steps, each session from the storage the one before it left, which rebuilds the coverage, the storage
sessions left, and the states; an input is applied to a state once. The search then goes on with the rest of the
budget, and states the replay went on from, which an earlier run expanded, come after all others. An entry is `stale`
from the first input that no longer fits the pending action (another option or button label, another kind of ask,
another deadline) or that the runtime rejects; it is replayed up to there. With realignment (on by default, off with
`--no-realign`), a replay of a corpus entry or of a directed attempt's path goes on instead: with the input that fits there (the option or button with the same
label, the wait there is), with a later input of the path that fits (skipping up to 8), or with the only button there
is (up to 8), and the report's `corpus.realigned` counts the entries that needed it; the path a report keeps is the
inputs actually applied. The goals of a condition after `else` then also include the earlier conditions of its chain
taking their other way, and a session chain measures how close a storage is by those too. At the end the corpus is written back
minimized: the paths to the crashes and traps, then, by greedy set cover over lines and condition ways (play and clock
apart), paths of steps that covered one first, until they cover all the run covered, without one that the others cover;
entries of another seed, and those the budget left unreplayed, stay as they are. The report's `corpus` block has the
entries loaded, replayed, stale, and written, the replay's steps and time, the play coverage at the start (from the
corpus) and at the end, and the file's size. The file also records the `contentHash` and seed of the run that wrote it
and whether that run was exhausted; a unit exhausted with the same content and seed is skipped. `--rounds N` explores
the units in N rounds: the first with the budgets, each later one with twice the budgets before and only the units
not exhausted yet. Directed attempts and session chains start over in each run; what they reached comes back with the
corpus.

The defaults suit a shared machine: one worker, and two at most (one unit per process); run it under `nice`. A run's
memory is mostly the snapshot store (up to its limit) and what it keeps per state, a few KB; `explore` lets V8 grow
its heap by a fifth at a time (`--heap-growing-percent=20`, where this Node has the flag) instead of up to four times
what a collection keeps, which otherwise left more than a third of a long run's memory unused.

To compare a change to the explorer with the explorer before it (a gate), explore the same units with the same work
budget and seeds with both, and compare the reports:

```sh
node tools/explore-compare.ts <base-out> <candidate-out> [--favourite <unit>]... [--no-lines] > gate.md
```

Each folder holds the reports of one run, or one subfolder per seed (`s1/`, `s2/`, ...). The first table has the
coverage by seed, how the search stopped, states per second, and the gate: a unit fails when the candidate's mean is
more than 1 pp below the base's lowest, when a seed the base exhausted is not exhausted at least as well, or when a crash
or trap the base found is missing (with how many base seeds found it). Which deep loops and crashes a seed reaches
varies: a trap or crash the base found in one seed of three is a weak signature, so before a change is held for it, run
more seeds of that unit on both sides (seeds 4 to 6) and compare how often each side finds it; the change passes when the
candidate finds it about as often as the base. A net change can hide a loss elsewhere, so the second table counts the lines and
condition ways each side visited and the other did not, per seed, and the lines consistently lost or gained (visited by
one side in at least two thirds of the seeds and by the other in none), with their files and ranges and the search
figures that help explain them (states, sessions, time steps, quit visits, traps, open states, the top hotspot). A
`--favourite` unit with consistently lost lines is marked `EXPLAIN`; lines first-ever reached (by a candidate seed and by
no base seed) are counted and listed too. Lines are counted from compiling each unit, as the explorer counts them. A
last table shows progress without new lines: for each way both sides missed with a measured part (the target report's
`best`), the closest any seed of each side came, with how many ways came closer or went further and the top examples,
such as "needs `visits >= 20`: 3 → 12".

To gate a change aimed at one class of problem on the units of that class (plus a few controls, at a larger budget),
`tools/explore-tags.ts <unit-dir>...` tags units from their compiled plans: `clock-saves` (saves a value read from the
clock), `session-counters` (saves a stored key from its own load), `random` (100 or more random draw sites per thousand
lines), `typed-asks` (compares a typed answer with a constant), and `large` (5,000 or more coverable lines);
`--class <tag>` prints the folders of the units with that tag. Run the full gate as well before a push.

Known limits:

- Content behind a long automatic chain (a loop of waits with nothing else to do, past a hundred waits) waits longer:
  such a chain's passes share a cell, so they no longer look new, and each pass of a hundred waits is one more
  expansion, while a cell of a large unit gets one or two at gate budgets. Seen in Domme3 (`spanking.tease` 858–873,
  after `spank(…, 300, 0.5)`, at least 300 waits with a sound each) and once in BreatheAcademy (the ending after its long
  countdown, now reached in every seed). Three ways to go through such chains sooner were measured and dropped:
  - walking a chain to its end within one expansion (at most 20 passes of 100 waits): every expansion into a
    punishment paid the whole chain, up to about 8,000 operations, and DisciplineClinic fell to 29.7% and
    BreatheAcademy to 73.3%;
  - giving a chain's states the cell of the state that entered it: the passes still count as that cell's expansions, so
    the chain sinks after a pass or two (Domme3 858–873 not reached; BreatheAcademy −1.6 points);
  - following a chain at once, pass after pass, within a sixteenth of all operations: only for chains a step entered
    with new code, it never followed Domme3's, as `spank()` is code every punishment shares; for every chain, it reached
    Domme3 858–873 in two of three seeds, with Domme3's coverage unchanged, but cost DisciplineClinic 57 lines
    consistently (`Punish.tease` 5471–5501, behind its own punishment chains) and jewell 0.7 points.
- A step settles at most 1,000 automatic operations (`MAX_AUTO_OPERATIONS`). An automatic run longer than that, such as
  more than a thousand camera requests in a row, ends the step with the request still pending, and the state is
  reported as stuck although settling could go on.

## Tests

```sh
node --test tests/*.test.ts
```

`tests/fixtures/conversion/` pairs real Groovy inputs with the expected `.tease` output; that output must compile with
the TeaseScript compiler, as the `main.tease` of a project with a stub for each file it transfers to.
`tests/fixtures/conversion-accepted/` holds output converted with `--accepted`, which uses accepted but not yet
implemented TeaseScript (`showPopup`, `openUrl`, `chooseFile`); it must compile once those capabilities
are replaced by placeholder calls. Both groups must also run to the
end in the runtime smoke run. These tests skip with a stated reason when Java/Groovy or the repository build is
unavailable.
