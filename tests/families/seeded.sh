#!/bin/bash
# bash tests/families/seeded.sh pair|mutant: a central-queue job's batch of `seeded.mjs`, one item per line of
# $SX_ITEMS, "<first seed> <count>", each item's lines in $SX_OUT/seeds-<first seed>.jsonl (README "A seeded family").
# pair: the base tree against the head tree ($SX_TREE_base, $SX_TREE_head: `--commit base=… --commit head=…`).
# mutant: the head tree ($SX_TREE_head) against the head's checkout with the patch applied ($SX_CHECKOUT, `--checkout
# <head> --patch <file>`), first proved the head with that patch applied as the queue applies it (`mutant-proof.mjs`,
# which applies it again to a fresh worktree of the head; its proof in $SX_OUT/mutant.json; a patch the head does not
# take exits 2, a checkout that differs 1), then built.
here=$(cd "$(dirname "$0")" && pwd)
node --version > "$SX_OUT/node.txt"
case "$1" in
pair) base=$SX_TREE_base head=$SX_TREE_head ;;
mutant)
  base=$SX_TREE_head head=$SX_CHECKOUT
  TMPDIR=${SX_SCRATCH:-${TMPDIR:-/tmp}} node "$here/mutant-proof.mjs" "$SX_CHECKOUT" "$SX_IN/patch-main.diff" \
    > "$SX_OUT/mutant.json" 2> "$SX_OUT/mutant.err" < /dev/null || { rc=$?; cat "$SX_OUT/mutant.err" >&2; exit "$rc"; }
  cat "$SX_OUT/mutant.err" >&2
  (cd "$SX_CHECKOUT" && npm run -s build:typescript) > "$SX_OUT/build.log" 2>&1 || {
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
