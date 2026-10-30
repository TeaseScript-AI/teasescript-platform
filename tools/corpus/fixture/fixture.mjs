// The type-core fixture's distinct sources (tests/fixtures/type-core/cells.jsonl, read by this tree's own reader, so the
// tree must be built), as the g3-probe kit's `fixture` takes them, with its globals: the fixture as an area of the corpus
// runner (#1507), which the stored baseline runs (`tools/corpus/baseline.sh`)
import { readFixture } from "../../../dist/tests/helpers/type-core-fixture.js";

export const globals = ["hostValue", "hostOther", "hostInit"];
const seen = new Set();
export const cases = [];
for (const { name, files } of readFixture()) {
  const key = JSON.stringify(files);
  if (seen.has(key)) continue;
  seen.add(key);
  cases.push([`fixture:${name}`, files.map(({ path, source }) => ({ path, source }))]);
}
