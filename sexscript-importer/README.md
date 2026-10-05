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

## Usage

```sh
node src/cli.ts convert /path/to/script.groovy > script.tease
node src/cli.ts convert-package [--compile] /path/to/legacy/scripts /path/to/output
node src/cli.ts report [--compile | --run] /path/to/legacy/scripts > report.json
node src/cli.ts inventory /path/to/legacy/scripts > inventory.json
```

`convert-package` writes text `.tease` files only; it never copies legacy media, JARs, or archives. The package starts
at `main.tease` (ADR 0022): the only script in the package root becomes it, and a root with several scripts gets a
generated menu over them. Functions several scripts share become `global function`s in a generated `helpers.tease`
(#570). Package-local
auxiliary Groovy classes (such as `Domme3Class`) are migration input: their transitively used methods are embedded as
ordinary TeaseScript functions so the result depends on neither Groovy nor the old runtime. `report` and `inventory`
accept `.groovy` files, directories, or parser JSON; inputs of one invocation form one package.

`report --run` also smoke-runs the compiler-clean output in the real runtime: from the package's `main.tease`,
following file transfers with shared storage, then each runnable script no run reached in isolation (with empty
storage, so a failure there can come from missing setup). Answers are deterministic: buttons are pressed, each
visit of a choice takes the next option, text and number inputs cycle through fixed values, and time and media advance
in simulation; the wall clock starts at 2026-10-02 12:00 UTC and follows that time. Pending capabilities use host
stand-ins with the same answer rotation. A run proves one
path executes; `stepLimit` is inconclusive (for example a loop that waits until the typed text matches), while
`TSR037` means the work between two events exceeds the product's instruction budget, which fails in the Player too.
With a single directory argument, that directory is the package root that script transfers are relative to.

`--proposed` (every proposal) or `--proposed=media-tags` on `convert`, `convert-package`, and `report`
emits a working syntax for proposed TeaseScript language changes instead of reporting the construct, to measure what
they would resolve ([`docs/PROPOSED-LANGUAGE-CHANGES.md`](docs/PROPOSED-LANGUAGE-CHANGES.md)). That output is not
accepted TeaseScript: the report compiles and runs it through stand-ins in current TeaseScript, counted as `proposed
...` capabilities, and proposed media tags count the images in the package's sibling `images/` folder.

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

A page that opens every converted package of a legacy corpus in the Player:

```sh
node tools/convert-corpus.ts [--jobs N] [--only id,id] [--report-only] /path/to/corpus external/converted
node tools/catalog.ts [--player https://host:port] external/converted external/catalog/index.html
# from the repository root, after npm run build:
HOST=127.0.0.1 PORT=4182 PLAYGROUND_PACKAGES=$PWD/sexscript-importer/external/converted node dist/playground/server.js
node sexscript-importer/tools/serve-catalog.ts --catalog sexscript-importer/external/catalog \
  --upstream http://127.0.0.1:4182 --cert cert.pem --key key.pem --port 4443 [--http-port 4180]
```

`convert-corpus` takes one corpus folder per package, each with `scripts/`, `images/`, and `sounds/`. It runs
`convert-package` on each folder whose `scripts/` holds Groovy, then `report --run`, whose JSON it keeps as
`.report.json`. Legacy scripts name media relative to `images/` and `sounds/`, and package paths start at the package
root, so both trees are hard-linked into the package root. Media are never copied, so the corpus and the output must
share one filesystem. A resource pack (a folder without scripts) is linked into each script package whose source names
one of its top media folders, narrowed to the packages that name its subfolder when any do. A package with one script
gets that script as `main.tease`, because `convert-package` writes none for a single-file package yet. Each package
folder records the conversion in `.conversion.json` and `.conversion.log`; `.conversion-summary.json` in the root
records the importer commit and the date.

`catalog` writes one HTML page and reads each package as the Player does: the playground server's package scan, then
`compileProject` with the package images. A summary table counts the packages that convert fully, compile, run to the
end, stop during the run, need unbuilt commands, or do not compile. Each table row shows the `---` header of
`main.tease`, or of the first script that a generated `main.tease` menu goes to: title (the Player link), author,
keywords, and description. The status column shows what the Player does with the package and how the report's smoke run
from `main.tease` ended, with a `partly converted` mark for unconverted code; click a status for details. The source
column links the legacy Groovy and converted `.tease` files, which `catalog` hard-links under `source/` next to the
page. A Pin button keeps favourites in `localStorage` and lists them at the top.

The Player needs a secure context (HTTPS or localhost) on another machine, and the playground server serves its own
page at `/`. `serve-catalog` therefore puts the catalog page and the Player on one HTTPS origin. It serves `/` and
`/source/` itself, with the sources as UTF-8 plain text, and forwards the other GET requests to the playground server
on loopback. A self-signed certificate works once its browser warning is accepted.

## Tests

```sh
node --test tests/*.test.ts
```

`tests/fixtures/conversion/` pairs real Groovy inputs with the expected `.tease` output; that output must compile with
the TeaseScript compiler. `tests/fixtures/conversion-accepted/` holds output that uses accepted but not yet implemented
TeaseScript, including owner-decided syntax whose implementation is still open (such as script transfers, `showPopup`,
and `askBooleans`); it must compile once those capabilities are replaced by placeholder calls. Both groups must also run to the
end in the runtime smoke run. These tests skip with a stated reason when Java/Groovy or the repository build is
unavailable.
