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
- For `--compile`, `--run`, and the compiler-checked fixtures: the repository build (`npm run build:typescript` in the
  repository root), which provides the real TeaseScript compiler and runtime under `dist/`.

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
`askBooleans(message:, texts:, defaults:)`, with `cancel:` where the script tests the answers for null, as the legacy
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
node tools/convert-corpus.ts [--jobs N] [--only id,id] [--report-only] [--patches dir] /path/to/corpus external/converted
# from the repository root, after npm run build: the converted and the verified packages, then the HTTPS front
HOST=127.0.0.1 PORT=4182 PLAYGROUND_PACKAGES=$PWD/sexscript-importer/external/converted node dist/playground/server.js
HOST=127.0.0.1 PORT=4183 PLAYGROUND_PACKAGES=$PWD/sexscript-importer/external/verified node dist/playground/server.js
node sexscript-importer/tools/serve-catalog.ts --catalog sexscript-importer/external/catalog \
  --upstream http://127.0.0.1:4182 --verified-root sexscript-importer/external/verified \
  --verified-upstream http://127.0.0.1:4183 --cert cert.pem --key key.pem --port 4443 [--http-port 4180]
# from sexscript-importer/:
node tools/play-check.ts [--base https://host:4443] [--runs N] [--steps N] [--only id,id] external/converted external/play-checks
node tools/verify-package.ts --checks external/play-checks --verified external/verified --manual "<note>" external/converted <id>
node tools/catalog.ts [--player https://host:port] --play-checks external/play-checks [--explorer <dir>]... \
  --verified external/verified [--approved docs/APPROVED.md] external/converted external/catalog/index.html
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

The Player needs a secure context (HTTPS or localhost) on another machine, and the playground server serves its own
page at `/`. `serve-catalog` therefore puts the catalog page and the Player on one HTTPS origin. It serves `/` and
`/source/` itself, with the sources as UTF-8 plain text, and forwards the other GET requests to the playground server
on loopback, or, for a package with a verified copy, to the one that offers the verified copies. A self-signed
certificate works once its browser warning is accepted.

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
`compileProject` with the package images. A summary table counts the packages that convert fully, compile, play to the
end, stop during play, do not start, are not played yet, are blocked by unbuilt commands, are verified, or are
owner-approved. Each table row shows the `---` header of `main.tease`, or of the first script that a generated
`main.tease` menu goes to: title (the Player link), author, keywords, and description. The status column takes, in
this order, the owner-approved list (the first column of the Markdown table in `--approved`), the verified copy, the
Player check of the current files, or else the compiler and the report's smoke run. A `partly converted` mark counts
unconverted code; click a status for details. The explorer column shows the latest [`explore`](#branch-explorer)
report of the current files from the `--explorer` folders (`<unit>.json` or `<unit>/<unit>.json`), for a verified
copy else of the unit's newer conversion, marked so, else the latest report of other files, marked stale: line coverage and the numbers of crashes and traps, with the first crash's code
and `file:line`, the first trap, and the search in its details. A report's compact `catalog` block (`coveragePercent`,
`crashes`, `traps`, `firstCrash`) counts before its full fields. The source column links the legacy Groovy and converted `.tease` files,
which `catalog` hard-links under `source/` next to the page; earlier versions that the unit's `unit.json` lists under
`earlierVersions` appear in a collapsed section with links to their original Groovy. A Pin button keeps favourites in `localStorage` and lists
them at the top.

## Branch explorer

```sh
# from sexscript-importer/, after npm run build:typescript in the repository root:
node tools/explore.ts [--budget-seconds 60] [--max-states 20000] [--seed 1] [--workers 1|2] <unit-dir>... --out <dir>
node tools/explore.ts --replay <dir>/<unit>.json (--crash N | --trap N | --error)
```

`explore` plays each package headlessly in the real runtime (`src/explorer.ts`), without the Player, through every
branch it can reach within the budget, and replaces playing converted packages by hand to find crashes. Each pending
action is a branch point. The options are every button and choice option, a form submitted with its starting values or
cancelled where it offers that, and the default answer of a typed ask with
boundary values of its type: `0`, `1`, `-1`, `1000000` (and `0.5` for `askNumber`), the text `x`, and dates and times
at both ends of a day or year. Each constant that the code compares with near the ask adds a candidate, or `c - 1`,
`c`, and `c + 1` for a number. A button whose result the script keeps (`(showButton …) / 1 s`) can also be pressed
after the player thinks for just over each compared number of seconds (60 s without one). Waiting for the next
deadline (a timer, a timeout, or the end of awaited media), and each shown permanent button, are options too. Media
loads succeed with one second per pass, `takePhoto` finds no camera, `askImage` gets one stored image, pacing is
instant, and the clock starts at 2026-10-02 12:00 UTC with empty storage.

States are deduplicated by a hash of the snapshot that leaves out what no script can observe: event sequence numbers,
the next free IDs, and the last settlement record. The runtime's own IDs (actions, scopes, call frames, timers, media,
buttons) are renumbered by rank, because only their equality and order matter. The clock and the random state stay
in. The search first expands states whose step reached new instructions, then states that look new apart from clock,
random state, and settled handles (their loop key), and then the repeats, least repeated first; within each group
the newest state goes first. It stops when every state is expanded, or at the time or state budget.

Coverage counts executed plan instructions and maps them to the lines they start on. Steps run instruction by
instruction with `executeInstruction` to record them. After 200 instructions in a row that were all reached before,
a step finishes with `run` and the rest of the product's instruction budget. What the step executes after that point
is not recorded: its lines can show as unvisited, and its conditions as left only one way although play took both
(for example the code after a long setup loop). Each operation copies and checks the whole snapshot, so this
recording is what limits the speed on large packages, and on packages with large lists or dicts in their state.

The report `<out>/<unit>.json` has these parts:

- per file: the lines that hold instructions, the visited ones, the percentage, and the unvisited line ranges, each
  with a `reach` label (only `unknown` so far; `seededState` and `unreachable` are reserved);
- each condition and loop that play reached but left only one way, with its source, the missed way, and its first
  line: the targets for a directed search;
- one crash per runtime failure code and source span, with the shortest input list found from the start;
- the traps;
- the end states: `completed` (exit), `failed`, `stuck`, and `open` when the budget ran out.

`summary.md` has one table row per unit. `--replay` plays the input list of a crash or trap again with the run's seed,
prints the transcript, and for a crash exits 0 only when the same failure returns. A runtime operation that throws,
such as a runtime that rejects a snapshot it produced (`TSR101`), is no crash of the package: the report counts these
under `search.engineErrors` with the input list of the first, which `--error` replays.

A trap is a loop the player cannot leave by the inputs tried. Explored states are grouped by loop key. A group
escapes when one of its states ended (completed or failed), or when none of its states was fully expanded, so its
future is unknown. A group that leads to an escaping group escapes too. Each strongly connected part of the
remaining groups that no explored input leaves is one trap. A state where the player can do nothing and nothing
happens is a `stuck` trap. A loop that waits for a word or number the candidates miss, or for a clock time, is also
reported as a trap.

The defaults suit a shared machine: one worker, and two at most (one unit per process); run it under `nice`.

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
