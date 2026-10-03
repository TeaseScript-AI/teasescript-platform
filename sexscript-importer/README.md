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

`convert-package` writes text `.tease` files only; it never copies legacy media, JARs, or archives. Package-local
auxiliary Groovy classes (such as `Domme3Class`) are migration input: their transitively used methods are embedded as
ordinary TeaseScript functions so the result depends on neither Groovy nor the old runtime. `report` and `inventory`
accept `.groovy` files, directories, or parser JSON; inputs of one invocation form one package.

`report --run` also smoke-runs the compiler-clean output in the real runtime: from each script in the package's top
directory, following script transfers with shared storage, then each runnable script no run reached in isolation (with
empty storage, so a failure there can come from missing setup). Answers are deterministic: buttons are pressed, each
visit of a choice takes the next option, text and number inputs cycle through fixed values, and time and media advance
in simulation. Pending capabilities use host stand-ins that follow the same clock and answer rotation. A run proves one
path executes; `stepLimit` is inconclusive (for example a loop that waits until the typed text matches), while
`TSR037` means the work between two events exceeds the product's instruction budget, which fails in the Player too.
With a single directory argument, that directory is the package root that script transfers are relative to.

`--proposed` (every proposal) or `--proposed=choose-lists,dictionaries,...` on `convert`, `convert-package`, and `report`
emits a working syntax for proposed TeaseScript language changes instead of reporting the construct, to measure what
they would resolve ([`docs/PROPOSED-LANGUAGE-CHANGES.md`](docs/PROPOSED-LANGUAGE-CHANGES.md)). That output is not
accepted TeaseScript: the report compiles and runs it through stand-ins in current TeaseScript, counted as `proposed
...` capabilities, and proposed media tags count the images in the package's sibling `images/` folder.

Generated files follow these conventions:

- legacy comments and paragraph breaks are kept; `setInfos()` metadata becomes a header comment;
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
the TeaseScript compiler. `tests/fixtures/conversion-accepted/` holds output that uses accepted but not yet implemented
TeaseScript; it must compile once those capabilities are replaced by placeholder calls. Both groups must also run to
the end in the runtime smoke run. These tests skip with a stated reason when Java/Groovy or the repository build is
unavailable.
