import { readdirSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash, readJson } from "./json.mjs";
export function directoryHash(root) {
  const entries = [];
  function walk(dir, rel = "") {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        r = rel ? `${rel}/${name}` : name,
        st = lstatSync(path);
      if (st.isDirectory()) walk(path, r);
      else if (st.isSymbolicLink()) entries.push([r, "link", readlinkSync(path)]);
      else entries.push([r, hash(readFileSync(path).toString("base64"))]);
    }
  }
  walk(root);
  return hash(entries);
}
export function verifyBuild(root, allowMismatch = false) {
  root = resolve(root);
  const stamp = readJson(join(root, "pilot-build.json"));
  if (
    stamp.schemaVersion !== 1 ||
    !(stamp.commit === null || /^([a-f0-9]{40})$/.test(stamp.commit)) ||
    !/^([a-f0-9]{40})$/.test(stamp.tree)
  )
    throw new Error("Invalid compiler build identity");
  if (directoryHash(join(root, "dist")) !== stamp.distHash)
    throw new Error("Compiled tree differs from its build seal");
  const required = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node;
  const matches = process.versions.node === required;
  if (!matches && !allowMismatch)
    throw new Error(
      `Compiler needs Node ${required}; running ${process.versions.node}. Use --allow-runtime-mismatch for compatibility evidence only.`,
    );
  return {
    ...stamp,
    executionNode: process.versions.node,
    requiredNode: required,
    runtimeMatches: matches,
    acceptanceEnvironment: matches ? "runtime-matches-unmeasured-desktop" : "compatibility-only",
  };
}
