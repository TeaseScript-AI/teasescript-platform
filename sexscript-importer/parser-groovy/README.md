# Legacy Groovy parser helper

This helper parses legacy SexScript Groovy into a parser-neutral JSON tree. It is an import-time analysis tool only;
it does not execute the imported script and is not part of generated TeaseScript packages or the Player runtime.

## Why Groovy 2.5.21

The desktop SexScript distribution embeds Groovy 2.5.21. Using that parser gives the POC a concrete compatibility
baseline for the source syntax that SexScript actually accepted. The dependency is intentionally external: the old
Groovy JARs are not committed to this repository.

The parser stops at Groovy's `CONVERSION` phase. That produces AST nodes without running script code. The helper itself
still parses untrusted legacy input with an old compiler library, so a production importer should run it in an isolated
worker with CPU/memory/time limits and no ambient network or filesystem privileges beyond the import workspace.

## Run locally

The helper needs Java 17 or newer and the Groovy 2.5.21 `groovy` and `groovy-json` JARs, from a SexScript desktop
distribution (`lib/`) or Maven Central. Without explicit paths it uses the Maven local-repository layout
(`~/.m2/repository/org/codehaus/groovy/<artifact>/2.5.21/`):

```sh
export SEXSCRIPT_GROOVY_JAR=/path/to/groovy-2.5.21.jar
export SEXSCRIPT_GROOVY_JSON_JAR=/path/to/groovy-json-2.5.21.jar
```

Parse an ordinary SexScript file in its effective method-body context:

```sh
./parser-groovy/bin/export-ast.sh script-body /path/to/script.groovy
```

Parse an auxiliary Groovy class such as `Domme3Class.groovy` as a compilation unit:

```sh
./parser-groovy/bin/export-ast.sh unit /path/to/Domme3Class.groovy
```

The generated `.class` file is written under `.tmp/` and remains local.

Besides the AST, the output contains the original source text and its comments. The Groovy AST drops comments, so the
helper re-lexes the source with Groovy's own lexer; string, GString, and slashy-string contents are therefore never
mistaken for comments.
