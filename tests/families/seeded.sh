#!/bin/bash
# bash tests/families/seeded.sh pair|mutant: a central-queue job's batch of `seeded.mjs`, one item per line of
# $SX_ITEMS, "<first seed> <count>", each item's lines in $SX_OUT/seeds-<first seed>.jsonl (README "A seeded family").
# pair: the base tree against the head tree ($SX_TREE_base, $SX_TREE_head: `--commit base=… --commit head=…`).
# mutant: the unmutated head tree ($SX_TREE_head) against the mutated checkout ($SX_CHECKOUT at the head with
# `--patch`, built here), which may change tracked regular files only; each one's hash on both sides goes to
# $SX_OUT/mutant.sha256, the mutant's proof. A seed whose outcome differs reaches the mutated code.
mode=$1
here=$(cd "$(dirname "$0")" && pwd)
node --version > "$SX_OUT/node.txt"
case "$mode" in
pair) base=$SX_TREE_base head=$SX_TREE_head ;;
mutant)
  base=$SX_TREE_head head=$SX_CHECKOUT
  cd "$SX_CHECKOUT" || exit 2
  # (a mutant changes the content of tracked regular files and nothing else, as the README's mutants are: any other
  # change of the checkout, an added, removed, renamed or untracked path, a link, a gitlink or a mode, is refused before
  # it runs; each changed file's hash at HEAD and in the checkout, then its path, goes to the proof, and the whole change)
  refuse() { echo "seeded.sh mutant: $1; a mutant changes tracked regular files only" >&2; exit 2; }
  hash() { sha256sum | cut -c1-64; }
  mapfile -d '' -t entries < <(git status --porcelain=v1 -z --untracked-files=all)
  [ "${#entries[@]}" -gt 0 ] || refuse "the checkout has no change"
  proof=""
  for entry in "${entries[@]}"; do
    file=${entry:3}
    [ "${entry:0:3}" = " M " ] || refuse "$(printf '%q is %s' "$file" "${entry:0:2}")"
    read -r modes < <(git diff --raw --no-renames -z -- "$file" | tr '\0' '\n' | sed -n 1p)
    [[ "$modes" =~ ^:(100644|100755)\ (100644|100755)\  ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ] ||
      refuse "$(printf '%q changes its kind or mode (%s)' "$file" "${modes:1:13}")"
    proof+=$(printf '%s %s %q' "$(git show "HEAD:$file" | hash)" "$(hash < "$file")" "$file")$'\n'
  done
  printf '%schange %s\n' "$proof" "$(git diff --binary HEAD | hash)" > "$SX_OUT/mutant.sha256"
  npm run -s build:typescript > "$SX_OUT/build.log" 2>&1 || {
    rc=$?
    echo "seeded.sh mutant: the build failed (exit $rc)" >&2
    exit "$rc"
  }
  ;;
*) echo "usage: bash tests/families/seeded.sh pair|mutant" >&2; exit 2 ;;
esac
[ -r "$SX_ITEMS" ] && mapfile -t items < "$SX_ITEMS" || { echo "seeded.sh: no readable items in \$SX_ITEMS ('$SX_ITEMS')" >&2; exit 2; }
[ "${#items[@]}" -gt 0 ] || { echo "seeded.sh: \$SX_ITEMS ('$SX_ITEMS') holds no item" >&2; exit 2; }
# (the job ends with the first failing item's own status)
status=0
for line in "${items[@]}"; do
  read -r first count <<< "$line"
  node "$here/seeded.mjs" "$base" "$head" "$first" "$count" > "$SX_OUT/seeds-$first.jsonl" 2> "$SX_OUT/seeds-$first.err" < /dev/null
  rc=$?
  echo "$line exit=$rc" >> "$SX_OUT/items.txt"
  [ "$status" -ne 0 ] || status=$rc
done
exit "$status"
