#!/bin/bash
# bash tests/families/seeded.sh pair|mutant: a central-queue job's batch of `seeded.mjs`, one item per line of
# $SX_ITEMS, "<first seed> <count>", each item's lines in $SX_OUT/seeds-<first seed>.jsonl (README "A seeded family").
# pair: the base tree against the head tree ($SX_TREE_base, $SX_TREE_head: `--commit base=… --commit head=…`).
# mutant: the unmutated head tree ($SX_TREE_head) against the mutated checkout ($SX_CHECKOUT at the head with
# `--patch`, built here); each path the patch adds, changes or removes, with its hash on both sides, goes to
# $SX_OUT/mutant.sha256, the mutant's proof. A seed whose outcome differs reaches the mutated code.
mode=$1
here=$(cd "$(dirname "$0")" && pwd)
node --version > "$SX_OUT/node.txt"
case "$mode" in
pair) base=$SX_TREE_base head=$SX_TREE_head ;;
mutant)
  base=$SX_TREE_head head=$SX_CHECKOUT
  cd "$SX_CHECKOUT" || exit 2
  # (every path the patch adds, changes or removes, a rename as both, its hash at the head and in the checkout, `absent`
  # where none: the checkout's whole change against HEAD, staged so new and removed files count alike)
  git add -A
  mapfile -t changed < <(git diff --cached --no-renames --name-only HEAD)
  [ "${#changed[@]}" -gt 0 ] || { echo "seeded.sh mutant: the checkout has no change" >&2; exit 2; }
  hash() { sha256sum | cut -c1-64; }
  for file in "${changed[@]}"; do
    before=absent after=absent
    git cat-file -e "HEAD:$file" 2> /dev/null && before=$(git show "HEAD:$file" | hash)
    [ -f "$file" ] && after=$(hash < "$file")
    printf '%s %s %s\n' "$file" "$before" "$after"
  done > "$SX_OUT/mutant.sha256"
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
