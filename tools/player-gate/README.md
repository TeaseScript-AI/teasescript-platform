# The L5 activation gate kit

The kit measures what the L5 gate's cost report needs to decide whether the Player's engine moves into its Worker. It
runs real browsers and the Pixel 4a, outside CI, and never sets a threshold. It changes no product file. It measures:

- the production Player builds it is given;
- gate variants of those builds, made by `variants/vite.config.mjs`: an `instrumented` bridge seam on both backends,
  and `delayed` replies at 0, 50 or 250 ms;
- the bridge page (`bridge/`), which runs the real engine Worker entry and the in-process backend below the Player.

Playwright is loaded from the package.json that `PLAYWRIGHT_PACKAGE` names. Without it, or without a phone, the kit
exits 2.

## Validation (#2122)

Every value a cell reports derives from records that passed the kit's shared validation; a sample that fails makes its
cell incomplete and is never a value in a median. Every cell stays labelled `measured, unvalidated` until #2122 closes.

- **One parse.** `report.mjs` parses each row once (`lib/records.mjs`) against its scenario's closed shape
  (`lib/row-shapes.mjs`). Every path is declared, with its type and domain. An undeclared path, a missing required
  value, a wrong type or a number outside its domain fails the result section that owns it. Clock readings and recorded
  durations lie in [0, 2^53 − 1] ms, so no difference, sum or median over them overflows. The row's own summaries are
  not copied. Its cached flags and outcomes are kept apart and only compared.
- **Validated copies, read strictly.** The derivations read only those copies, through `lib/evidence.mjs`'s strict
  reader: `nullable` and its `NULLABLE` list for a value that may be absent, `span` for an interval, and a write
  refused. `buildReport` takes no row the parser did not make, so no derivation can reach a raw row, whatever form a
  read takes.
- **Each scenario's parts** (`validate.mjs` `PARTS`) check their order relations and the evidence a trial needs before
  they derive. Examples: each reply after its request, a tap's handler after its event, a keep trial's hiding, a
  transaction's end with its outcome.
- **Three cells per scenario**, each its own failure boundary:
  - the timing cell (`ms`, `boolean`): the only one in the headline, the summary (`--json`) and the R0 comparison;
  - `<cell> / bytes and counts`;
  - `<cell> / cross-clock`: the signed differences between the page's clock and the Worker's, its sign kept.

  A section's failure fails the cells whose fields read it, and no other.
- **A measured failure is a value** (`cells.mjs`): a pass/fail scenario's failing run is its result, with its finding.

The validation is of the records. It does not prove that a derivation pairs the right records or computes the right
formula. Four things stay trusted code, reviewed and covered by the kit's tests rather than checked:

- which records a derivation pairs, and its formula;
- a derivation that swallows a reader error;
- which of two fields of one type a value comes from;
- a derivation that reaches records through anything but its arguments (a file read, a global).

Pass or fail is derived from primary records, never from a cached flag:

- the smoke's pass comes from its exit status;
- the demo's pass comes from its errors and turns;
- a keep trial's outcome comes from its lifecycle and transactions;
- a byte request's phase comes from its start against the cold page's mark, not its cached phase flag;
- a cached flag that disagrees with its records is a problem.

## Files

- **`drive.mjs`** runs one scenario in one engine, for one build or an interleaved pair. It writes one JSON line per
  sample with its raw records. The scenarios:
  - `session`: cold open to playable, the first save, cold-load bytes and heap; reload and Continue; turns and the
    final heap. On the CDP engines it also counts bytes on a second cold page. The byte page may be loaded twice,
    cold, when CDP leaves a request open on the first; each cell shows how many were discarded. The timing page never
    is.
  - `sessionInstrumented`;
  - `aa`: the full probe's incremental cost beyond the shared observer, over the cold interval;
  - `taps` and `bridgeTaps`: CDP touches every 16 ms while the start page loads or a script is prepared, on Chromium
    and the Pixel;
  - `bridge`;
  - the hidden-page keep: `keepHandler` on the desktop, `keepCompletion` and `keepDurable` on the Pixel;
  - `demo`.
- **`validate.mjs`** derives every field again from a row's validated records, scenario by scenario and part by part,
  and checks each value against its unit's domain.
- **`report.mjs`** prints the cost report: `node tools/player-gate/report.mjs --phase r0|r1 --artifacts FILE
ROWS.jsonl...`. Beside each number it writes the conditions it depends on. The report is incomplete (exit 1) in any
  of these cases:
  - a required cell has no samples, or for `aa` lacks either arm;
  - a cell has a failing sample;
  - there is no artifact inventory.
- **`cells.mjs`** decides every cell: required, or excluded with its reason.
- **`artifacts.mjs`** lists a build's files with raw, gzip and brotli sizes, each marked eager, lazy or Worker.
- **`inputs.mjs`** writes the bridge page's inputs from a built tree: a package's project and its plan text.

Every number names its route (the full Player compiles source; plan text exists only on the bridge page), its backend
and its cohort:

- headline numbers come from unmodified builds with the passive probe;
- the instrumented variant and the bridge page are diagnostics;
- taps are an active-input cohort.

## Running R0

Each step runs through the queue; nothing runs on the LXC except the Pixel, which runs on the LXC under the phone lock.

- **Desktop, one engine at a time.** On the desktop worker, `sx-job submit --host desktop --mem 4G --checkout <head>
--in r0.sh -- bash -c 'bash "$SX_IN/r0.sh" <engine>'` runs for `chromium`, then `firefox`, then `webkit`. One
  engine at a time keeps their measurements off each other's load.
  - `r0.sh` builds the bridge page, the instrumented variant and the bridge inputs.
  - It then runs every R0 scenario of that engine.
  - Its Chromium run also packs the gate tree (`gate-tree.tgz`) for the Pixel.
- **The Pixel.** Unpack that tree and run the Pixel script from the LXC under
  `flock ~/opt/phone-bench/phone.lock`. It sets `PIXEL_SERIAL` from `connect.sh`, opens Chrome and forwards
  `localabstract:chrome_devtools_remote`, then runs `drive.mjs --engine pixel` for each phone scenario.
- **The delayed smoke.** The delayed smoke job builds the `delayed` variant at 0, 50 and 250 ms into the checkout and
  runs `tools/player-browser-smoke.mjs` unchanged.
- **The report.** Run `artifacts.mjs` on the tree's `dist/player-app`, then `report.mjs --phase r0` over every
  engine's rows. The R0 evidence is kept with its scripts under `~/work/evidence/l5-gate/r0-<head>/`.

## Recorded conditions

- Start and Continue are pressed at the first frame they are ready, with no stability wait. The enabled → input delay
  is the driver's and is reported apart. The plan's "R0 waited 50 ms" describes the earlier evidence that motivated
  this, not the current runs.
- The driver answers an image ask with Skip on every engine. It never opens a camera or a file picker.
