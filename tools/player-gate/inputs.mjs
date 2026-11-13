// The bridge page's inputs for each script of a packages folder, from one built tree:
// `<script>.source.json`, the project the hosted Player's package host gives `prepare` (its catalog's sources, images
// and unreadable files, `player/vue/src/packageHost.ts`), and `<script>.plan.json`, that project's canonical plan text,
// as the tree's own bridge makes it (`prepare`, then `preparePlanText` and `planText`, in-process in Node).
//   node tools/player-gate/inputs.mjs --tree DIR --packages DIR --out DIR SCRIPT...
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: { tree: { type: "string" }, packages: { type: "string" }, out: { type: "string" } },
  allowPositionals: true,
});
if (!values.tree || !values.packages || !values.out || positionals.length === 0)
  throw new Error("usage: inputs.mjs --tree DIR --packages DIR --out DIR SCRIPT...");
const tree = resolve(values.tree);
const load = (path) => import(pathToFileURL(join(tree, path)).href);
const { PackageRoot } = await load("dist/playground/package-folder.js");
const { createInProcessBackend } = await load(
  "dist/player-test-modules/tests/helpers/bridge/in-process.js",
);
mkdirSync(values.out, { recursive: true });
const root = new PackageRoot(resolve(values.packages));
const bridge = createInProcessBackend({
  commit: null,
  dirty: null,
  mode: "gate-inputs",
  appVersion: null,
});
for (const script of positionals) {
  const folder = await root.package(script);
  if (folder === null) throw new Error(`no package '${script}' in ${values.packages}`);
  const catalog = await folder.scan();
  const project = {
    files: catalog.sources,
    images: catalog.images,
    unreadableFiles: catalog.unreadable,
  };
  const prepared = (
    await bridge.client.request("prepare", { source: { kind: "source", script: project } })
  ).result;
  if (prepared.kind !== "prepared") throw new Error(`${script} does not prepare: ${prepared.kind}`);
  await bridge.client.request("preparePlanText", { plan: prepared.plan });
  const plan = (await bridge.client.request("planText", { plan: prepared.plan })).result;
  const source = JSON.stringify(project);
  writeFileSync(join(values.out, `${script}.source.json`), source);
  writeFileSync(join(values.out, `${script}.plan.json`), plan);
  console.log(
    JSON.stringify({
      script,
      sourceUnits: source.length,
      planUnits: plan.length,
      planBytes: Buffer.byteLength(plan),
    }),
  );
}
bridge.client.terminate();
