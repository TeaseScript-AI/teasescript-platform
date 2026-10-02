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

## Current scope

The first POC will establish:

1. a stable parser-output contract with source spans;
2. a small SexScript-oriented migration IR;
3. classification of supported, helper-candidate, and warning-only constructs;
4. lowering of a representative safe subset to readable `.tease`;
5. corpus reporting for real SexScripts without executing imported scripts.

See [`docs/LEGACY-SEXSCRIPT-ANALYSIS.md`](docs/LEGACY-SEXSCRIPT-ANALYSIS.md) for the legacy runtime findings and
[`docs/POC-SCOPE.md`](docs/POC-SCOPE.md) for the implementation slice.


## Convert source directly

The POC can invoke the legacy Groovy parser itself when the external Groovy 2.5.21 JARs are available:

```sh
export SEXSCRIPT_GROOVY_JAR=/path/to/groovy-2.5.21.jar
export SEXSCRIPT_GROOVY_JSON_JAR=/path/to/groovy-json-2.5.21.jar
node src/cli.ts convert /path/to/script.groovy > script.tease
```

Convert a source tree while using package-local auxiliary Groovy classes as migration input:

```sh
node src/cli.ts convert-package /path/to/legacy/scripts /path/to/output
```

`convert-package` writes text `.tease` files only. It does not copy legacy media, JARs, ZIPs, or other binary assets.
For auxiliary helper classes, only transitively used helper functions are embedded into each generated script so the
result does not depend on Groovy or the old SexScript runtime.
