#!/bin/bash
# bash tests/families/seeded.sh pair: a central-queue job's batch of `seeded.mjs`, one item per line of $SX_ITEMS,
# "<first seed> <count>", the base tree against the head tree ($SX_TREE_base, $SX_TREE_head: `--commit base=…
# --commit head=…`), each item's lines in $SX_OUT/seeds-<first seed>.jsonl (README "A seeded family").
[ "$1" = pair ] || { echo "usage: bash tests/families/seeded.sh pair" >&2; exit 2; }
base=$SX_TREE_base head=$SX_TREE_head
here=$(cd "$(dirname "$0")" && pwd)
node --version > "$SX_OUT/node.txt"
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
