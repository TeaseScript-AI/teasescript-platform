#!/usr/bin/env bash
set -u

usage() {
  cat >&2 <<'EOF'
Usage: run-compact.sh --label LABEL --log PATH [--max-output-bytes N] -- command [args...]
EOF
  exit 2
}

label=
log=
max_output_bytes=65536
while (($#)); do
  case "$1" in
    --label)
      (($# >= 2)) || usage
      label=$2
      shift 2
      ;;
    --log)
      (($# >= 2)) || usage
      log=$2
      shift 2
      ;;
    --max-output-bytes)
      (($# >= 2)) || usage
      max_output_bytes=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "$label" && -n "$log" && $# -gt 0 ]] || usage
[[ "$max_output_bytes" =~ ^[1-9][0-9]*$ ]] || usage

mkdir -p "$(dirname "$log")"
: > "$log"

"$@" >"$log" 2>&1
status=$?
if ((status == 0)); then
  rm -f "$log"
  printf '%s: PASS\n' "$label"
  exit 0
fi

printf '%s: FAIL (exit %d)\n' "$label" "$status" >&2
printf 'command:' >&2
printf ' %q' "$@" >&2
printf '\n' >&2

bytes=$(wc -c <"$log")
if ((bytes <= max_output_bytes)); then
  cat "$log" >&2
else
  half=$((max_output_bytes / 2))
  printf '%s\n' "--- output truncated: showing first and last ${half} bytes of ${bytes}; complete log: $log ---" >&2
  head -c "$half" "$log" >&2
  printf '\n%s\n' '--- omitted middle ---' >&2
  tail -c "$half" "$log" >&2
  printf '\n%s\n' '--- end bounded excerpt ---' >&2
fi
exit "$status"
