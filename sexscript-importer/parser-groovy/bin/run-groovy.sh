#!/usr/bin/env bash
set -euo pipefail

# Runs Groovy code with the Groovy 2.5.21 runtime that SexScript embedded, to check legacy behavior. Groovy 2.5 can
# parse on newer Java but compiles scripts only up to Java 17, so this pins Java 17: through mise when it has
# temurin-17 installed, otherwise through SEXSCRIPT_GROOVY_JAVA (a java executable).
if (($# == 0)); then
  printf 'Usage: %s <script.groovy | -e code> [args...]\n' "$0" >&2
  exit 2
fi

maven_groovy="${HOME}/.m2/repository/org/codehaus/groovy"
SEXSCRIPT_GROOVY_JAR="${SEXSCRIPT_GROOVY_JAR:-$maven_groovy/groovy/2.5.21/groovy-2.5.21.jar}"
if [[ ! -f "$SEXSCRIPT_GROOVY_JAR" ]]; then
  printf 'Groovy 2.5.21 JAR not found: %s (set SEXSCRIPT_GROOVY_JAR)\n' "$SEXSCRIPT_GROOVY_JAR" >&2
  exit 2
fi

if [[ -n "${SEXSCRIPT_GROOVY_JAVA:-}" ]]; then
  exec "$SEXSCRIPT_GROOVY_JAVA" -cp "$SEXSCRIPT_GROOVY_JAR" groovy.ui.GroovyMain "$@"
fi
if command -v mise >/dev/null && mise where java@temurin-17 >/dev/null 2>&1; then
  exec mise exec java@temurin-17 -- java -cp "$SEXSCRIPT_GROOVY_JAR" groovy.ui.GroovyMain "$@"
fi
printf 'Java 17 not found: install it with "mise install java@temurin-17" or set SEXSCRIPT_GROOVY_JAVA.\n' >&2
exit 2
