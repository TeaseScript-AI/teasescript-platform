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
- `"keepParagraphs": { "reason": "…" }` beside `"patches"` keeps each text with blank lines as one message for the
  whole unit, where its blank lines are layout, such as ASCII art, tables, or stat blocks, that the converter does not
  recognize as such (see COMPATIBILITY-GAPS.md). Conversion then passes `--keep-paragraphs` to `convert-package`.

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
end, stop during play, do not start, are not played in the Player, are blocked by unbuilt commands, are verified, or
are owner-approved, and the explorer results. Each table row shows the `---` header of `main.tease`, or of the first script that a generated
`main.tease` menu goes to: title (the Player link), author, keywords, and description. The status column takes, in
this order, the owner-approved list (the first column of the Markdown table in `--approved`), the verified copy, the
Player check of the current files, or else the compiler and the report's smoke run. A `partly converted` mark counts
unconverted code, and a grey `older conversion` mark shows the latest Player check of files the importer has converted
again since, which the summary counts apart; click a status for details. The explorer column shows the latest [`explore`](#branch-explorer)
report of the current files from the `--explorer` folders (`<unit>.json` or `<unit>/<unit>.json`), for a verified
copy else of the unit's newer conversion, marked so, else the latest report of other files, marked stale: line coverage and the numbers of crashes and traps, with the first crash's code
and `file:line`, the first trap, and the search in its details. A report's compact `catalog` block (`coveragePercent`,
`crashes`, `traps`, `firstCrash`, `firstTrap`, and `reach`, the lines per reach label) counts before its full fields. The source column links the legacy Groovy and converted `.tease` files,
which `catalog` hard-links under `source/` next to the page; earlier versions that the unit's `unit.json` lists under
`earlierVersions` appear in a collapsed section with links to their original Groovy. A Pin button keeps favourites in `localStorage` and lists
them at the top.

## Branch explorer

```sh
# from sexscript-importer/, after npm run build:typescript in the repository root:
node tools/explore.ts [--budget-seconds 60] [--budget-ops N] [--max-states 20000] [--seed 1] [--workers 1|2] \
  [--corpus <corpus-dir> [--rounds N]] [--[no-]cells] [--[no-]later] [--[no-]compared-answers] \
  [--[no-]realign] [--[no-]progress-leads] [--[no-]conjunctive] [--[no-]guidance] <unit-dir>... --out <dir>
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

States are deduplicated by a hash of the snapshot that leaves out what no script can observe: event sequence numbers,
the next free IDs, and the last settlement record. The runtime's own IDs (actions, scopes, call frames, timers, media,
buttons) are renumbered by rank, because only their equality and order matter. The clock and the random state stay
in. The search first expands directed states (below), then states whose step reached new instructions in any
session, then, earlier sessions first, states that look new apart from clock, random state, and settled handles (their
loop key), and then the repeats, least repeated first; play goes before clock states (below), and the newest state
first. The search ranks states by cells (`--no-cells` switches this off). A cell is where a state waits (its pending action, the return
points of its calls, and the pass of each `for` and `repeat` loop) with the bucket of each value that conditions compare
with constants: each variable and stored key (also through the data flow, each key a key template matches apart) a
comparison reads, or its length, bucketed as unset, `null`, `true` or `false`, a compared text or other text, or a
number's or duration's place among its compared constants (below, at, between, or above them). A step that shows such
a value, or a change of one, for the first time counts as reaching new instructions, and among the other states those
of the cells expanded least go first, before the loop key. A cell groups states coarsely: a condition that computes
with a value (`n + 1 == 3`) can still tell states of one cell apart. A loop that keeps making states no condition
tells apart, such as a counter no condition reads, so no longer takes most of the search; the report's `search.cells`
counts the slots, cells, values, and changes found. Waiting states keep their snapshots
as compressed JSON (up to 256 MB; a state whose snapshot was dropped is replayed from an ancestor). The search stops
when every state is expanded and directed search has nothing left to try, or at the time, work, or state budget.
`--budget-ops N` is a work budget of N runtime operations per unit (fresh sessions, runs, inputs, and automatic
answers, the corpus replay's included), checked before each step: a step that started finishes, so a run can go over N
by the operations of its last step. With it the time budget applies only when `--budget-seconds` is given, and directed
search looks again every tenth of the work budget instead of every tenth of the time; without an explicit time budget,
a run's length and result then do not depend on the machine's load.

Directed search looks at each condition that a step reached but left only one way. A flow-insensitive data flow over
the plan's names finds what the condition reads: an ask's answer (also through helper functions and stored answers), a
stored value (also by a key template such as `"script${i}.time"`), the clock, or a variable the code assigns. Its
comparisons with constants give the values that take the missed way. An ask is answered again with them on the path of
the step that first evaluated the condition, and the rest of that path is replayed; the values also become answers of
that ask wherever the search meets it. For a stored value, sessions are chained: when an explored state left storage
that satisfies the condition, a session starts from it and replays that path; otherwise a session starts from the
storage closest to it and plays again the path that led there, to raise the value once more, for as long as each
session gets closer (100 sessions at most). When no explored session gets there, the way stays `unknown` with the
reason, such as `needs score > 100; best reached: score = 37 after 37 sessions`. For the clock, without forward time
(below), the player continues at other wall clock times (times of day, weekdays, later dates) before that step, as a
real player's time varies; a step after that is a clock step. An answer attempt's states share the first place for 20
expansions in all, until the condition takes the missed way (a session chain goes on from the storage it reached
instead), and play states that bring a variable the code counts or sets closer to the comparison share it for 40 (with
progress leads, on by default and off with `--no-progress-leads`, an expansion in that first place that brings a state
closer again does not count, so a loop that needs many rounds is followed to the constant, while one that gets no
closer uses its 40 up); clock states take only their attempt's own steps and otherwise come after all play states.
With `--conjunctive`, a way that needs all parts of its condition (`a >= 5 and b <= 6` true, an `or` false) is
steered by the condition's branch distance instead of each part's closeness: a state is closer when fewer of the
parts it can read are unsatisfied, or as many but nearer in sum (an `or` the way needs either part of takes the nearer
part), and a session chain toward a stored value of the condition also counts how far its parts on other keys are.
With `--guidance`, a static map of the plan steers too: its control flow (conditions, calls and returns, file
transfers, the blocks a timer, cue, or button sets up; constant conditions cut; a session's end leading to the next
session's start) gives each instruction the number of decisions (conditions and prompts, a next session as three) to
the nearest code play has not reached yet, measured again at each analysis. Among states whose cells were expanded
as often, those that wait nearer to such code go first; the map only orders states. Directed work (attempts, next
sessions, and expansions in the first place) takes at most a third of all runtime operations (fresh sessions, runs,
inputs, and automatic answers), a deterministic measure of what steps cost.

With forward time (on by default; `--no-later` switches it off), time only goes forward and is play, as for a player
who comes back later. The explorer reads each comparison in a condition that reads the clock (`hour >= 18`,
`getTimestamp().toSeconds() - lastVisit > day`), also
through variables computed from the clock in one way and helpers that return one part of the date or time (exactly
when they only return it; a helper that adjusts it is an approximation), and evaluates it in a state at a later wall
clock, with the state's variables and stored values. A state that waits where such a condition was read next gets
time steps: `later` inputs to just past the first moment, within 400 days, at which one of those comparisons comes out
the other way, as far as the explorer finds it: at the second, minute, hour, or day boundaries where a compared part
of the date or time changes, where compared elapsed times meet, or else by sampling at doublings of a minute and
halving (the next 18:01, the next weekday, saved time plus a day and a minute, inside or past a window). Each is tried
once per cell and outcome; where the condition was first read, the state the step left, or the session start, gets
them too. Their outcomes at a state's wall clock are part of its cell, so a new outcome or change of one counts as
reaching something new. A later session starts a minute after the wall clock where the state it continues stands,
and also at the time steps of the clock conditions its first state reads; a session chain keeps the gap of the session
it continues. A condition that compares how long the player took between two clock reads (a reaction time held in a
variable, against a constant or another value) gets no forward time: think times at the button between the reads
reach it, and coming back later changes nothing. For a clock condition the explorer cannot read in full, or reads
only through an approximate helper, it also tries a fixed ladder: continuing an hour, an evening, a night, a morning,
a day, two or three days, a week, 40 days, or 400 days later just before the step that read it, or starting that
session that much later. All these steps are play, and a path records them: its `later` inputs and each session's
start clock. A gap must be positive. Only a session that does not start after the clock where the state it continues
stands, such as one of an old corpus entry, is a clock start. The report's `search.time` counts the conditions that
read the clock, the places they were read after, and the time steps taken by states and sessions.

Coverage counts executed plan instructions and maps them to the lines they start on, as the runtime's instruction
trace reports them (`docs/RUNTIME.md#instruction-trace`): each step's executions are one `run` with
`instructionTrace: true`, and the condition ways come from the trace's branch edges. A path runs in one runtime
session (`docs/RUNTIME.md#runtime-sessions`), which keeps its state between operations: the explorer exports the state
once per step, for its hash and the snapshot store, as a trusted export without the runtime's check (it keeps the
snapshot itself), restores a stored state once to expand it, which the runtime checks (a snapshot it refuses is counted
under `search.engineErrors`), and tries each input on its own copy: a fork of it for all inputs but the last, which
goes on in the restored session. `TEASESCRIPT_DIST` names another repository build with runtime sessions to load the compiler and runtime
from, for comparisons. Each line has
a label: `play` when a play step executed it, in any session; `clock` when only steps after the wall clock was set did;
`unreachable` when no execution can reach it from the session start, by an over-approximation of the plan's control
flow in which a constant condition takes only its one way; and `unknown` otherwise. A condition is constant when it is a
literal, when the compiler proves it always true or false (`TSV046`), or when it reads only stored keys whose values
this package fixes: a key no `save` of the package writes is never stored (such as legacy profile keys that other
scripts wrote), and a key that every save writes as a literal holds one of those literals or nothing. Each
unreachable range and branch states its reason. When an instruction that ran is found unreachable, the analysis missed a way and
no line is labelled `unreachable` (`staticContradictions`).

The report `<out>/<unit>.json` has these parts:

- for a unit that compiles, a `catalog` block for the importer catalog's Explorer column: `coveragePercent` by play,
  the counts of `crashes` and `traps`, `firstCrash` (`code`, `path`, `line`, `message`) and `firstTrap` (`location`)
  or `null`, and `reach`, the coverable lines by label (`play`, `clock`, `unreachable`, `unknown`);
- per file: the lines that hold instructions, the ones play visited, the percentage, and the other line ranges with
  their label;
- each condition and loop that play reached but left only one way, with its source, the missed way, its first line,
  what it depends on, the directed attempts, its label, and the reason, when known;
- `directed`: the condition ways directed search aimed at and reached, by label, by what they depend on, how (a
  directed attempt or the search), and in how many sessions, each with its shortest path, which `--way` replays;
- one crash per runtime failure code and source span, with the shortest path found from the start (a play one when
  there is), and whether that path set the clock;
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
and the last one, with its start clock when that is not the play one. `summary.md` has one table row per unit.
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
another deadline) or that the runtime rejects; it is replayed up to there. With `--realign`, a replay of a corpus entry
or of a directed attempt's path goes on instead: with the input that fits there (the option or button with the same
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
