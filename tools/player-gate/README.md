# The L5 activation gate kit

The kit measures what the L5 gate's cost report needs to decide whether the Player's engine moves into its Worker. It
runs real browsers and the Pixel 4a, outside CI, and never sets a threshold. It changes no product file. It measures:

- the production Player builds it is given;
- gate variants of those builds, made by `variants/vite.config.mjs`: an `instrumented` bridge seam on both backends,
  and `delayed` replies at 0, 50 or 250 ms;
- the bridge page (`bridge/`), which runs the real engine Worker entry and the in-process backend below the Player.

Playwright is loaded from the package.json that `PLAYWRIGHT_PACKAGE` names. Without it, or without a phone, the kit
exits 2.

## Every value is unvalidated

The kit's values are read from its retained rows without a validation claim; the validation obligation is #2122,
before the activation PR's R1 run. Every cell in the report is labelled `measured, unvalidated`.

- **The headline.** The headline, the summary (`--json`) and the R0 comparison hold the `ms` and `boolean` fields of
  `session`, `aa`, `keepDurable`, `demo` and `delayedSmoke`: playable, A/A, the keep timings and outcomes, and the
  demo's and the smoke's pass or fail.
- **Outside the headline.** The scenarios in `UNVALIDATED` (`bridge`, `sessionInstrumented`, `taps`, `bridgeTaps`,
  `keepHandler`, `keepCompletion`), every cell's `bytes` and `count` fields (`<cell> / bytes and counts`: served bytes
  per phase, requests, heap, sizes, counts) and the artifact inventory print apart, with their known gaps under
  "Declared gaps".
- **A measured failure is a value** (`cells.mjs`): a pass/fail scenario's failing run is its result, with its finding.
- **The derivation code, where #2122 starts.**
  - `lib/evidence.mjs`'s strict reader: `strictRecord`, `nullable` and its closed `NULLABLE` list, `span` and
    `crossClock`.
  - The partition by unit in `validate.mjs`.
  - `deriveSample`'s per-cell failure boundary: a sample whose derivation fails makes its cell incomplete, and is never
    a value in a median.
  - A kit test that parses the derivations for raw row reads, reflective globals and subtractions outside `span`.

  #2122 lists what they do not yet cover, with its acceptance controls.

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
- **`validate.mjs`** derives every field again from a row's records, partitions the fields by unit, and lists
  `UNVALIDATED`.
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
