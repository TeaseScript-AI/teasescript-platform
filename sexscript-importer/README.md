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
node src/cli.ts convert [--accepted[=forms]] /path/to/script.groovy > script.tease
node src/cli.ts convert-package [--compile] [--accepted[=forms]] /path/to/legacy/scripts /path/to/output
node src/cli.ts report [--compile | --run] [--accepted[=forms]] /path/to/legacy/scripts > report.json
node src/cli.ts inventory /path/to/legacy/scripts > inventory.json
```

`convert-package` writes text `.tease` files only; it never copies legacy media, JARs, or archives. The package starts
at `main.tease` (ADR 0022): the only script in the package root becomes it, also in a package with a single script, and
a root with several scripts gets a generated menu over them. With `--compile`, the generated files compile as one
project, so transfers and global functions resolve across files. Functions several scripts share become `global function`s in a generated `helpers.tease`
(#570). Package-local
auxiliary Groovy classes (such as `Domme3Class`) are migration input: their transitively used methods are embedded as
ordinary TeaseScript functions so the result depends on neither Groovy nor the old runtime. `report` and `inventory`
accept `.groovy` files, directories, or parser JSON; inputs of one invocation form one package.

`report` compiles the package as one project (`compileProject`); a file is compiler-clean when the project reports no
error for it. `report --run` also smoke-runs the project in the real runtime, which follows the transfers between files
itself: from `main.tease`, then each runnable script no run reached in isolation (with empty storage, so a failure there
can come from missing setup). A file that is not compiler-clean becomes a stub in the run's project, and a run that
reaches it ends as `blocked`. Answers are deterministic: buttons are pressed, each visit of a choice takes the next
option, text and number inputs cycle through fixed values, `takePhoto()` returns null as in a Player without a camera,
and time and media advance in simulation; the wall clock starts at 2026-10-02 12:00 UTC and follows that time. Accepted
forms selected with `--accepted` use host stand-ins with the same answer rotation. A run proves one path executes;
`stepLimit` is inconclusive (for example a loop that waits until the typed text matches), while `TSR037` means the work
between two events exceeds the product's instruction budget, which fails in the Player too.
With a single directory argument, the sibling `images/` folder holds the package's images.

Accepted TeaseScript that `main` does not implement yet becomes a workaround in implemented TeaseScript, marked with a
`// NOTE` at every site, so that converted packages play natively: `askBooleans` a yes/no choice per item and a
confirmation, `showPopup` the message and an OK button, `openUrl` the link in the chat and a button, legacy `getFile`
a cancelled `chooseFile()`, and a legacy count of the images in a package folder the counts of the package's images at
conversion time. `--accepted` (every form) or `--accepted=askBooleans,showPopup,openUrl,chooseFile` emits the accepted
forms instead, for when `main` implements them; the report then compiles and runs them through host stand-ins.

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

## Tests

```sh
node --test tests/*.test.ts
```

`tests/fixtures/conversion/` pairs real Groovy inputs with the expected `.tease` output; that output must compile with
the TeaseScript compiler, as the `main.tease` of a project with a stub for each file it transfers to.
`tests/fixtures/conversion-accepted/` holds output converted with `--accepted`, which uses accepted but not yet
implemented TeaseScript (`showPopup`, `askBooleans`, `openUrl`, `chooseFile`); it must compile once those capabilities
are replaced by placeholder calls. Both groups must also run to the
end in the runtime smoke run. These tests skip with a stated reason when Java/Groovy or the repository build is
unavailable.
