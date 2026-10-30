// node tests/families/check.mjs [area...] [--list]
// Checks every generator against the evidence run it reproduces (its `recorded` export, #1446): its sources at its
// default sizes, as the runner reads them, each with the globals it runs with, together with the inputs the record drops
// are exactly the run's (`recorded.sources` of them, `recorded.sha256` over their sorted keys), and none dropped is left
// in. A source repeated (a shape whose text does not depend on its size, as in the recorded run) is counted, not a
// difference. Prints one JSON line per generator that differs (`--list`: per generator, with its commands and the count
// and set key of its sources, which a new generator's record takes from its run) and a total; exits 1 when any differs.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setKey, sourceKey, sourcesOf } from "./sources.mjs";

const AREAS = ["copies", "joins", "messages", "property", "rings", "stops"];
const args = process.argv.slice(2);
const list = args.includes("--list");
const areas = args.filter((arg) => arg !== "--list");
const root = path.dirname(fileURLToPath(import.meta.url));
const total = { generators: 0, sources: 0, repeated: 0, dropped: 0, differ: 0 };
for (const area of areas.length > 0 ? areas : AREAS) {
  const folder = path.join(root, area);
  for (const name of readdirSync(folder)
    .filter((file) => file.endsWith(".mjs"))
    .sort()) {
    const generator = await import(pathToFileURL(path.join(folder, name)).href);
    const recorded = generator.recorded;
    const problems = [];
    const keys = sourcesOf(generator).map(sourceKey);
    const own = new Set(keys);
    if (recorded === undefined) problems.push("no recorded run");
    else {
      total.repeated += keys.length - own.size;
      const dropped = (recorded.dropped ?? []).map(([key]) => key);
      const kept = dropped.filter((key) => own.has(key)).length;
      if (kept > 0) problems.push(`${kept} dropped inputs present`);
      const run = new Set([...own, ...dropped]);
      if (run.size !== recorded.sources)
        problems.push(`${run.size} sources, the run's ${recorded.sources}`);
      if (setKey(run) !== recorded.sha256) problems.push("a source set other than the run's");
      total.sources += own.size;
      total.dropped += dropped.length;
    }
    total.generators += 1;
    if (problems.length > 0) total.differ += 1;
    if (problems.length > 0 || list)
      console.log(
        JSON.stringify({
          generator: `${area}/${name}`,
          sources: own.size,
          ...(problems.length > 0 ? { problems } : {}),
          ...(list ? { sha256: setKey(own), commands: recorded?.commands } : {}),
        }),
      );
  }
}
console.log(JSON.stringify(total));
process.exitCode = total.differ === 0 ? 0 : 1;
