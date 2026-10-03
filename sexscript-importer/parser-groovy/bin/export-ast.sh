#!/usr/bin/env bash
set -euo pipefail

if (($# != 2)); then
  printf 'Usage: %s <script-body|unit> <source.groovy>\n' "$0" >&2
  exit 2
fi

# Default to the standard Maven local-repository layout when the JAR paths are not set explicitly.
maven_groovy="${HOME}/.m2/repository/org/codehaus/groovy"
SEXSCRIPT_GROOVY_JAR="${SEXSCRIPT_GROOVY_JAR:-$maven_groovy/groovy/2.5.21/groovy-2.5.21.jar}"
SEXSCRIPT_GROOVY_JSON_JAR="${SEXSCRIPT_GROOVY_JSON_JAR:-$maven_groovy/groovy-json/2.5.21/groovy-json-2.5.21.jar}"
for jar in "$SEXSCRIPT_GROOVY_JAR" "$SEXSCRIPT_GROOVY_JSON_JAR"; do
  if [[ ! -f "$jar" ]]; then
    printf 'Groovy 2.5.21 JAR not found: %s (set SEXSCRIPT_GROOVY_JAR and SEXSCRIPT_GROOVY_JSON_JAR)\n' "$jar" >&2
    exit 2
  fi
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd -- "$script_dir/../.." && pwd)
build_dir="$project_dir/.tmp/parser-groovy"
source_file="$project_dir/parser-groovy/src/SexScriptAstExporter.java"

mkdir -p -- "$build_dir"

class_file="$build_dir/SexScriptAstExporter.class"
if [[ ! -f "$class_file" || "$source_file" -nt "$class_file" ]]; then
  javac \
    -cp "$SEXSCRIPT_GROOVY_JAR:$SEXSCRIPT_GROOVY_JSON_JAR" \
    -d "$build_dir" \
    "$source_file"
fi

exec java \
  -cp "$build_dir:$SEXSCRIPT_GROOVY_JAR:$SEXSCRIPT_GROOVY_JSON_JAR" \
  SexScriptAstExporter "$@"
