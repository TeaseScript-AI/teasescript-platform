#!/bin/bash
# bash tests/families/seeded.sh pair|mutant: a central-queue job's batch of `seeded.mjs`, one item per line of
# $SX_ITEMS, "<first seed> <count>", each item's lines in $SX_OUT/seeds-<first seed>.jsonl (README "A seeded family").
# pair: the base tree against the head tree ($SX_TREE_base, $SX_TREE_head: `--commit base=… --commit head=…`).
# mutant: the unmutated head tree ($SX_TREE_head) against the mutated checkout ($SX_CHECKOUT at the head with
# `--patch`, built here); each changed file's hash on both sides goes to $SX_OUT/mutant.sha256, the mutant's proof. A
# seed whose outcome differs reaches the mutated code.
mode=$1
here=$(cd "$(dirname "$0")" && pwd)
node --version > "$SX_OUT/node.txt"
case "$mode" in
pair) base=$SX_TREE_base head=$SX_TREE_head ;;
mutant)
  base=$SX_TREE_head head=$SX_CHECKOUT
  cd "$SX_CHECKOUT" || exit 2
  changed=$(git diff --name-only)
  [ -n "$changed" ] || { echo "seeded.sh mutant: the checkout has no change" >&2; exit 2; }
  for file in $changed; do
    printf '%s %s %s\n' "$file" "$(git show "HEAD:$file" | sha256sum | cut -c1-64)" "$(sha256sum < "$file" | cut -c1-64)"
  done > "$SX_OUT/mutant.sha256"
  npm run -s build:typescript > "$SX_OUT/build.log" 2>&1 || { echo "seeded.sh mutant: the build failed" >&2; exit 2; }
  ;;
*) echo "usage: bash tests/families/seeded.sh pair|mutant" >&2; exit 2 ;;
esac
mapfile -t items < "$SX_ITEMS"
fail=0
for line in "${items[@]}"; do
  read -r first count <<< "$line"
  node "$here/seeded.mjs" "$base" "$head" "$first" "$count" > "$SX_OUT/seeds-$first.jsonl" 2> "$SX_OUT/seeds-$first.err" < /dev/null
  rc=$?
  echo "$line exit=$rc" >> "$SX_OUT/items.txt"
  [ "$rc" -eq 0 ] || fail=1
done
exit "$fail"
